import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob, setMediaJob, setProjectStatus, logJob } from "@/lib/jobs/db";
import {
  enqueueImageGeneration,
  enqueueImageToVideo,
  enqueueAvatar,
  enqueueRender,
} from "@/lib/jobs/queue";
import { getEnv } from "@/lib/env";
import type { SyntheticSegment, ProjectStatus } from "@/lib/types";
import { estimateSegmentCost } from "@/lib/synthetic/cost";
import { ensurePitchTimelineItem } from "@/lib/synthetic/pitch-timeline";

// Shared orchestration for the synthetic asset-generation fan-out.
//
// The planner produces synthetic_segments[]; this module fans each segment out
// to the right queue by block_type and, once every segment reaches a terminal
// state (ready/failed/skipped), materializes timeline_items and flips the
// project to ready_for_review. Each segment owns its own media_job so the
// progress screen can show per-block status and offer per-block retry.

// Map a block_type to the queue + media_job type that generates its asset.
//   avatar  -> avatar queue (HeyGen talking-head video)
//   image   -> image_gen queue (nano-banana still)
//   ai_clip -> image_to_video queue (still -> fal.ai; the processor generates
//              the still internally then animates it)
//   split_2 -> avatar queue. A split_2 needs BOTH an avatar video (left) and a
//              still (right). Routing it to a SINGLE queue keeps the segment's
//              one `status` column unambiguous — the avatar processor generates
//              the right still inline (cheap nano-banana call) before/around
//              the avatar video, so the whole block goes ready in one job
//              rather than racing two jobs against one row.
export type SegmentQueue = "image_gen" | "image_to_video" | "avatar";

export function queueForBlockType(blockType: SyntheticSegment["block_type"]): SegmentQueue {
  switch (blockType) {
    case "avatar":
    case "split_2":
      return "avatar";
    case "ai_clip":
      return "image_to_video";
    case "image":
      return "image_gen";
  }
}

/**
 * Fan out every pending segment of a project to its asset queue. Creates one
 * media_job per segment (type matches the queue) and enqueues it. Returns the
 * number of jobs enqueued. Safe to call repeatedly — only 'pending' segments
 * are dispatched, so a retry re-dispatches just the unfinished ones.
 */
export async function dispatchSegments(
  projectId: string,
  opts: {
    // Image-only regen (the bulk "images" scope): for split_2 blocks, enqueue an
    // image-only avatar job (regenerate the right still, KEEP the avatar video),
    // and SKIP pure-avatar blocks entirely (they have no image to regenerate and
    // we don't want to re-render them). avatar-queue split_2 still routes here.
    imageOnly?: boolean;
  } = {},
): Promise<number> {
  const sb = getServerSupabase();
  const { data: segs, error } = await sb
    .from("synthetic_segments")
    .select("id, block_type, status")
    .eq("project_id", projectId)
    .eq("status", "pending")
    .order("position", { ascending: true });
  if (error) throw new Error(`dispatchSegments: ${error.message}`);

  let count = 0;
  for (const seg of segs ?? []) {
    // In image-only mode, a PURE avatar block has nothing to regenerate — skip
    // it so we never re-render an avatar the client is happy with. (split_2 is
    // kept: it has a right image to regenerate.)
    if (opts.imageOnly && seg.block_type === "avatar") continue;

    const queue = queueForBlockType(seg.block_type);
    const mediaType =
      queue === "avatar" ? "avatar" : queue === "image_to_video" ? "image_to_video" : "image_gen";
    const mediaJobId = await createMediaJob({
      projectId,
      type: mediaType,
      metadata: { segmentId: seg.id, blockType: seg.block_type },
    });
    // Stamp the segment as generating + link its job so the UI can correlate.
    await sb
      .from("synthetic_segments")
      .update({ status: "generating", metadata: { mediaJobId } })
      .eq("id", seg.id);

    if (queue === "avatar") {
      // split_2 in image-only mode regenerates just the right still.
      await enqueueAvatar({ projectId, mediaJobId, segmentId: seg.id, imageOnly: opts.imageOnly && seg.block_type === "split_2" });
    } else if (queue === "image_to_video") {
      await enqueueImageToVideo({ projectId, mediaJobId, segmentId: seg.id });
    } else {
      await enqueueImageGeneration({ projectId, mediaJobId, segmentId: seg.id });
    }
    count++;
  }
  await logJob({ projectId }, "synthetic.dispatch", { enqueued: count, imageOnly: !!opts.imageOnly });
  return count;
}

// Pick the most descriptive in-progress project status from the segment mix
// still being generated, so the progress screen's headline reflects the
// dominant outstanding work.
function inProgressStatus(blockTypesPending: Set<string>): ProjectStatus {
  if (blockTypesPending.has("avatar") || blockTypesPending.has("split_2")) return "generating_avatars";
  if (blockTypesPending.has("ai_clip")) return "generating_clips";
  return "generating_images";
}

/**
 * Called by each asset processor when it finishes a segment. Checks whether the
 * whole project's asset generation has drained; if so, materializes the
 * timeline and advances to ready_for_review. Otherwise nudges the project
 * status to reflect the remaining work. Idempotent + safe under concurrency.
 */
export async function maybeFinalizeSynthetic(projectId: string): Promise<void> {
  const sb = getServerSupabase();
  const { data: segs } = await sb
    .from("synthetic_segments")
    .select("id, block_type, status, position, start_time, duration, script, image_url, video_url, right_image_url, provider")
    .eq("project_id", projectId)
    .order("position", { ascending: true });
  const all = (segs ?? []) as Array<Pick<SyntheticSegment,
    "id" | "block_type" | "status" | "position" | "start_time" | "duration" | "script" | "image_url" | "video_url" | "right_image_url" | "provider">>;
  if (all.length === 0) return;

  // Never demote a project that has already advanced PAST review. finalize runs
  // on every asset finish AND on the 5-min reconcile sweep, and its terminal
  // write (line below) is an unconditional setProjectStatus(..., "ready_for_review").
  // Once the user has clicked Render, the project moves to "rendering" and then
  // the render worker sets "completed"/"failed". A finalize firing after that —
  // e.g. the reconcile sweep, which still sees all segments ready — would clobber
  // "completed" back to "ready_for_review" (observed: project flipped completed ->
  // ready_for_review seconds after a successful render). The segments are already
  // materialized by then, so there is nothing left to finalize; bail out.
  const { data: proj } = await sb
    .from("projects")
    .select("status")
    .eq("id", projectId)
    .single();
  const POST_REVIEW: ReadonlySet<ProjectStatus> = new Set<ProjectStatus>([
    "rendering",
    "completed",
    "failed",
  ]);
  if (proj && POST_REVIEW.has(proj.status as ProjectStatus)) return;

  // Finalize ONLY when EVERY segment has reached a terminal state. A segment
  // is "still working" unless it is ready / failed / skipped — anything else
  // (pending, generating, or a transient state between a failure and its
  // retry) must block finalize. The old check only excluded pending/generating,
  // so a segment momentarily in another state slipped through and triggered a
  // premature snapshot that froze a partial timeline (the slow ai_clip/split_2
  // blocks finished hours later and were never added). See reconcile below.
  const TERMINAL = new Set(["ready", "failed", "skipped"]);
  const unfinished = all.filter((s) => !TERMINAL.has(String(s.status)));
  if (unfinished.length > 0) {
    // Still working — keep the status meaningful for the progress screen.
    await setProjectStatus(projectId, inProgressStatus(new Set(unfinished.map((s) => s.block_type))));
    return;
  }

  // Materialize timeline_items from ready segments (skipped/failed are dropped;
  // their narration time is absorbed by neighbours at render via durations).
  //
  // RECONCILE, don't skip: a prior finalize may have already materialized the
  // segments that were ready at the time. Rather than bail when timeline_items
  // exist, we insert only the ready segments not yet represented (keyed on
  // synthetic_segment_id) so late-completing segments are added. This is what
  // makes finalize idempotent AND eventually-complete instead of freezing
  // whatever was ready first.
  //
  // The in-memory "already materialized" filter below is a fast path, NOT the
  // guarantee: this function runs on every asset finish plus the reconcile
  // sweep, so two finalizes can both read the existing rows before either
  // inserts and both see a segment as missing — a read-modify-write race that
  // previously double-inserted (459 rows / ~2896s for one 303-segment / 1932s
  // project, which the render route rejected). The guarantee is the partial
  // unique index timeline_items_project_segment_uq (migration 0024): the insert
  // is an UPSERT with ignoreDuplicates, so a racing second insert of the same
  // segment is a DB-level no-op instead of a duplicate.
  const { data: existingItems } = await sb
    .from("timeline_items")
    .select("synthetic_segment_id")
    .eq("project_id", projectId);
  const alreadyMaterialized = new Set(
    (existingItems ?? [])
      .map((it) => it.synthetic_segment_id as string | null)
      .filter((v): v is string => !!v),
  );

  const ready = all.filter((s) => s.status === "ready");
  const missing = ready.filter((s) => !alreadyMaterialized.has(s.id));
  const rows = missing.map((s) => ({
    project_id: projectId,
    type: s.block_type, // 'avatar' | 'image' | 'ai_clip' | 'split_2'
    // Position is rebuilt below across the WHOLE timeline so order stays clean
    // whether this is the first finalize or a reconcile of late segments.
    position: 0,
    start_time: s.start_time,
    duration: s.duration,
    script_text: s.script,
    image_url: s.image_url,
    video_url: s.video_url,
    right_image_url: s.right_image_url,
    approved: false,
    // Real column (backs the unique index) AND the metadata key, which other
    // read paths still consult. Both carry the same id.
    synthetic_segment_id: s.id,
    metadata: { synthetic_segment_id: s.id },
  }));
  if (rows.length > 0) {
    // Insert the missing rows. We CANNOT use PostgREST's upsert onConflict here:
    // the backing unique index timeline_items_project_segment_uq (migration 0024)
    // is PARTIAL (WHERE synthetic_segment_id IS NOT NULL), and PostgREST refuses a
    // partial unique index for ON CONFLICT resolution — it throws "no unique or
    // exclusion constraint matching the ON CONFLICT specification" on every
    // row-bearing finalize. That froze projects whose FIRST row-bearing finalize
    // hit this path (no prior finalize had populated the rows, so the in-memory
    // alreadyMaterialized fast-path couldn't skip the insert). See the unstick of
    // c91311bb. The partial index still does its job at the DB level: a racing
    // concurrent finalize that inserts the same segment now fails with a unique
    // violation (23505), which we swallow as the intended no-op. Non-duplicate
    // errors still throw.
    const { error } = await sb.from("timeline_items").insert(rows);
    if (error && error.code !== "23505") {
      throw new Error(`maybeFinalizeSynthetic materialize: ${error.message}`);
    }
    // Renumber every synthetic row by its segment's planned position so the
    // timeline is contiguous and in order, even after a reconcile inserted late
    // blocks out of sequence. Segments carry the authoritative order via
    // synthetic_segments.position; map each timeline row back to it.
    const segPos = new Map(all.map((s) => [s.id, s.position]));
    const { data: items } = await sb
      .from("timeline_items")
      .select("id, synthetic_segment_id")
      .eq("project_id", projectId);
    const ordered = (items ?? [])
      .map((it) => ({
        id: it.id as string,
        segId: it.synthetic_segment_id as string | null,
      }))
      .filter((x) => x.segId && segPos.has(x.segId))
      .sort((a, b) => (segPos.get(a.segId!) ?? 0) - (segPos.get(b.segId!) ?? 0));
    for (let i = 0; i < ordered.length; i++) {
      await sb.from("timeline_items").update({ position: i }).eq("id", ordered[i].id);
    }
  }
  // Insert / reconcile the sales-pitch video block (if the project has one).
  // Runs unconditionally — even on a reconcile pass that materialized nothing
  // new — so the pitch row appears once all segments are ready regardless of
  // which finalize call drains the project. Idempotent + boundary-snapped.
  await ensurePitchTimelineItem(projectId);

  await setProjectStatus(projectId, "ready_for_review");

  // Assets are done and the timeline is materialized — kick the render if
  // auto-render is on. Deliberately AFTER ready_for_review so a refused or
  // failed auto-render leaves the project exactly where the manual flow would:
  // sitting at the review screen with a working Render button.
  await maybeAutoRender(projectId, all);

  // This project just released its generation slot — pull the next waiting
  // project in. Runs after auto-render because rendering does NOT hold a
  // generation slot (it's a different queue), so the slot is free either way.
  // Safe to call repeatedly: it no-ops when no slot is free or nothing waits.
  try {
    await promoteNextQueuedProject();
  } catch (err) {
    // Never let promotion failure fail the asset job that triggered finalize —
    // the reconcile sweep will promote on its next pass.
    await logJob({ projectId }, "synthetic.admission.promote_error", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Coarse project cost summary, reconstructed from the READY segment rows
  // (block_type + provider + duration). The per-call logProviderCall lines only
  // reach stdout, so this finalize line is the one greppable per-project total.
  // It reflects the FINAL assets, so retries are undercounted — it's a floor on
  // spend ("this project cost ~$X"), not an invoice. ai_clip is the big driver:
  // a nano-banana still + an LTX-2 clip at its duration tier.
  const byType: Record<string, { count: number; usd: number }> = {};
  let totalUsd = 0;
  for (const s of ready) {
    const usd = estimateSegmentCost(s);
    totalUsd += usd;
    const bucket = (byType[s.block_type] ??= { count: 0, usd: 0 });
    bucket.count += 1;
    bucket.usd += usd;
  }
  for (const k of Object.keys(byType)) byType[k].usd = Number(byType[k].usd.toFixed(2));

  await logJob({ projectId }, "synthetic.finalize", {
    materialized: rows.length,
    alreadyPresent: alreadyMaterialized.size,
    failed: all.filter((s) => s.status === "failed").length,
    costUsdEstimate: Number(totalUsd.toFixed(2)),
    costByBlockType: byType,
  });
}

// Statuses that mean "this project is actively generating assets" and therefore
// occupies one of the SYNTHETIC_MAX_GENERATING_PROJECTS slots.
const GENERATING_STATUSES: readonly ProjectStatus[] = [
  "generating_images",
  "generating_clips",
  "generating_avatars",
];

/**
 * How many synthetic projects are currently generating assets.
 *
 * Counts by project STATUS rather than by in-flight media_jobs on purpose: a
 * project between two segment jobs (one finished, next not yet picked up) still
 * owns its slot. Counting jobs would briefly read 0 and let an extra project in.
 */
export async function countGeneratingProjects(): Promise<number> {
  const sb = getServerSupabase();
  const { count } = await sb
    .from("projects")
    .select("id", { count: "exact", head: true })
    .eq("engine", "synthetic")
    .in("status", GENERATING_STATUSES as unknown as string[]);
  return count ?? 0;
}

/**
 * Admit a project to asset generation if there is a free slot.
 *
 * Returns true when the project was dispatched, false when it must WAIT at
 * 'plan_ready' — the same status the manual review gate uses, so a waiting
 * project still shows a working "Generate assets" button and can be started by
 * hand at any time.
 *
 * Not race-free by construction: two planners finishing in the same instant can
 * both read the same count and both admit. That overshoots by one project, not
 * by twelve, and self-corrects on the next promotion — worth far less than the
 * complexity of a distributed lock here.
 */
export async function admitProjectIfSlotFree(projectId: string): Promise<boolean> {
  const max = getEnv().SYNTHETIC_MAX_GENERATING_PROJECTS;
  const active = await countGeneratingProjects();
  if (active >= max) {
    await setProjectStatus(projectId, "plan_ready");
    await logJob({ projectId }, "synthetic.admission.queued", { active, max });
    return false;
  }

  const enqueued = await dispatchSegments(projectId);
  await setProjectStatus(projectId, enqueued > 0 ? "generating_images" : "plan_ready");
  await logJob({ projectId }, "synthetic.admission.admitted", { active, max, enqueued });
  return enqueued > 0;
}

/**
 * Promote the OLDEST waiting project into a freed slot.
 *
 * Called when a project leaves the generating states (finalize / auto-render).
 * Oldest-first (by updated_at) keeps it FIFO so a project can't starve behind
 * newer arrivals.
 *
 * A 'plan_ready' project is only a promotion candidate if it has PENDING
 * segments — a project sitting at plan_ready with everything already generated
 * would otherwise be "promoted" forever, burning a slot and blocking the queue.
 */
export async function promoteNextQueuedProject(): Promise<string | null> {
  const sb = getServerSupabase();
  const max = getEnv().SYNTHETIC_MAX_GENERATING_PROJECTS;
  const active = await countGeneratingProjects();
  if (active >= max) return null;

  const { data: waiting } = await sb
    .from("projects")
    .select("id")
    .eq("engine", "synthetic")
    .eq("status", "plan_ready")
    .order("updated_at", { ascending: true })
    .limit(20);

  for (const p of waiting ?? []) {
    const projectId = p.id as string;
    const { count } = await sb
      .from("synthetic_segments")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("status", "pending");
    if (!count || count === 0) continue; // nothing to generate; not a candidate

    const enqueued = await dispatchSegments(projectId);
    if (enqueued > 0) {
      await setProjectStatus(projectId, "generating_images");
      await logJob({ projectId }, "synthetic.admission.promoted", { active, max, enqueued });
      return projectId;
    }
  }
  return null;
}

// Render-side duration tolerance. MUST match DURATION_TOLERANCE_SECONDS in
// app/api/projects/[id]/render/route.ts — we pre-check the same gate here so a
// mismatched timeline is reported as a skipped auto-render rather than being
// enqueued and failing downstream.
const AUTO_RENDER_TOLERANCE_SECONDS = 3;

// Synthetic block types that consume voiceover time. Mirrors the render route's
// DURATION_BEARING_TYPES, restricted to the synthetic set. pitch_video is
// excluded on purpose: it plays its own audio while narration pauses, so it
// consumes video time but NOT voiceover time.
const AUTO_RENDER_DURATION_TYPES = new Set(["avatar", "ai_clip", "image", "split_2"]);

/**
 * Enqueue the render automatically once every asset is done (client request
 * 2026-08-10). Called at the tail of maybeFinalizeSynthetic, i.e. exactly when
 * the project reaches ready_for_review.
 *
 * This is a best-effort convenience, NOT a replacement for the Render button:
 * every refusal path below leaves the project at ready_for_review so the user
 * can still render manually. It never throws — an auto-render failure must not
 * fail the asset job that happened to be the last one to finish.
 *
 * Idempotency matters here: finalize runs on EVERY asset completion and on the
 * 5-min reconcile sweep, so this function is called many times per project. The
 * in-flight//existing render-job checks below are what stop it re-rendering.
 */
async function maybeAutoRender(
  projectId: string,
  segments: Array<{ status: string; block_type: string }>,
): Promise<void> {
  try {
    const env = getEnv();
    if (!env.SYNTHETIC_AUTO_RENDER) return;

    const sb = getServerSupabase();

    // 1. Clean-only gate. failed/skipped are terminal, so finalize fires for a
    // partially-broken project too; rendering that ships a video with gaps.
    const broken = segments.filter((s) => s.status !== "ready").length;
    if (broken > 0 && !env.SYNTHETIC_AUTO_RENDER_ALLOW_FAILED) {
      await logJob({ projectId }, "synthetic.auto_render.skipped", {
        reason: "segments_not_ready", broken, total: segments.length,
      });
      return;
    }

    // 2. Never render twice. Any render job for this project — queued, running,
    // or already completed — means the user either has one in flight or has a
    // finished video; a reconcile-triggered finalize must not start another.
    const { data: priorRenders } = await sb
      .from("render_jobs")
      .select("id, status")
      .eq("project_id", projectId)
      .in("status", ["queued", "running", "completed"])
      .limit(1);
    if ((priorRenders ?? []).length > 0) return;

    // 3. Pre-check the render route's duration gate. If the timeline doesn't
    // match the voiceover, the route would 400 — surface that as a loud skip
    // instead of a silent no-op, since it means a real planning/materialize bug
    // (see the duplicate-materialize and alignment-lock-in cases).
    const { data: proj } = await sb
      .from("projects")
      .select("voiceover_duration_seconds")
      .eq("id", projectId)
      .single();
    const voiceoverSeconds = Number(proj?.voiceover_duration_seconds) || 0;

    const { data: itemsRaw } = await sb
      .from("timeline_items")
      .select("id, type, duration")
      .eq("project_id", projectId);
    const items = itemsRaw ?? [];
    if (items.length === 0) {
      await logJob({ projectId }, "synthetic.auto_render.skipped", { reason: "empty_timeline" });
      return;
    }

    if (voiceoverSeconds > 0) {
      const timelineDuration = items
        .filter((it) => AUTO_RENDER_DURATION_TYPES.has(String(it.type)))
        .reduce((s, it) => s + (Number(it.duration) || 0), 0);
      const delta = Math.abs(timelineDuration - voiceoverSeconds);
      if (delta > AUTO_RENDER_TOLERANCE_SECONDS) {
        await logJob({ projectId }, "synthetic.auto_render.skipped", {
          reason: "duration_mismatch",
          timelineDuration: Math.round(timelineDuration * 10) / 10,
          voiceoverSeconds,
          delta: Math.round(delta * 10) / 10,
        });
        return;
      }
    }

    // 4. Enqueue. Mirrors the render route: a render_jobs row, a media_job that
    // references it, then onto the SYNTHETIC render queue (served by the avatar
    // worker) so it doesn't queue behind a celebrity render.
    const { data: rj, error: rjErr } = await sb
      .from("render_jobs")
      .insert({ project_id: projectId, status: "queued", progress: 0 })
      .select("id")
      .single();
    if (rjErr || !rj) {
      await logJob({ projectId }, "synthetic.auto_render.error", { err: rjErr?.message });
      return;
    }

    const mediaJobId = await createMediaJob({
      projectId, type: "render", metadata: { renderJobId: rj.id, autoRender: true },
    });
    await enqueueRender({ projectId, mediaJobId, renderJobId: rj.id }, { synthetic: true });
    await setProjectStatus(projectId, "rendering");
    await logJob({ projectId }, "synthetic.auto_render.enqueued", {
      renderJobId: rj.id, mediaJobId, blocks: items.length,
    });
  } catch (err) {
    // Never let auto-render failure fail the asset job that triggered finalize.
    await logJob({ projectId }, "synthetic.auto_render.error", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Marker merged into a segment's metadata when its asset came from the reusable
// asset library (migration 0030) instead of a fresh provider generation. The
// review screen reads segment.metadata.reused to show a "Reused" badge, so the
// user (and client) can see which assets were fetched vs generated.
export interface ReusedMarker {
  // 'exact' = normalized-prompt hash hit; 'semantic' = embedding NN hit.
  via: "exact" | "semantic";
  // cosine similarity (1 for exact hits).
  similarity: number;
  // the generated_assets row the asset was reused from.
  assetId: string;
}

// Convenience: set a segment terminal state + (optionally) its media_job.
//
// `reused`, when passed, is MERGED into the segment's metadata (preserving the
// existing keys like mediaJobId) so the review screen can badge the asset as
// reused-from-library. A read-modify-write, only performed when reused is set.
export async function finishSegment(
  segmentId: string,
  patch: Partial<Pick<SyntheticSegment, "status" | "image_url" | "video_url" | "right_image_url" | "provider" | "error">>,
  reused?: ReusedMarker,
): Promise<void> {
  const sb = getServerSupabase();

  // Version history: when this patch sets an asset URL that REPLACES a different
  // existing one (a regenerate), push the segment's CURRENT asset trio into
  // asset_history (newest last) BEFORE overwriting, so the review screen can show
  // and restore prior versions. We only read+merge when an asset field is in the
  // patch — status/error-only updates skip the extra round-trip.
  const setsAsset =
    patch.image_url !== undefined ||
    patch.video_url !== undefined ||
    patch.right_image_url !== undefined;

  const finalPatch: Record<string, unknown> = { ...patch };

  // Merge the reused marker into the segment's EXISTING metadata (which holds
  // mediaJobId from dispatchSegments) so the review screen can badge it without
  // clobbering the correlation id. Read-modify-write only when reused is set.
  if (reused) {
    const { data: curMeta } = await sb
      .from("synthetic_segments")
      .select("metadata")
      .eq("id", segmentId)
      .single();
    const existing = (curMeta?.metadata as Record<string, unknown> | null) ?? {};
    finalPatch.metadata = { ...existing, reused };
  }

  if (setsAsset) {
    const { data: cur } = await sb
      .from("synthetic_segments")
      .select("image_url, video_url, right_image_url, provider, asset_history")
      .eq("id", segmentId)
      .single();
    if (cur) {
      // Is any incoming asset url actually DIFFERENT from the current one (and
      // is there a current asset to preserve)? Only then do we archive.
      const replaces =
        (patch.image_url !== undefined && patch.image_url !== cur.image_url && cur.image_url) ||
        (patch.video_url !== undefined && patch.video_url !== cur.video_url && cur.video_url) ||
        (patch.right_image_url !== undefined && patch.right_image_url !== cur.right_image_url && cur.right_image_url);
      if (replaces) {
        const prior = {
          image_url: (cur.image_url as string | null) ?? null,
          video_url: (cur.video_url as string | null) ?? null,
          right_image_url: (cur.right_image_url as string | null) ?? null,
          provider: (cur.provider as string | null) ?? null,
          created_at: new Date().toISOString(),
        };
        const history = Array.isArray(cur.asset_history) ? cur.asset_history : [];
        finalPatch.asset_history = [...history, prior];
      }
    }
  }

  let { error } = await sb.from("synthetic_segments").update(finalPatch).eq("id", segmentId);
  // Back-compat: if the asset_history column hasn't been migrated yet, retry the
  // update WITHOUT it so generation still works (history just isn't recorded
  // until migration 0023 is applied).
  if (error && /asset_history/.test(error.message)) {
    const { asset_history: _omit, ...withoutHistory } = finalPatch;
    void _omit;
    ({ error } = await sb.from("synthetic_segments").update(withoutHistory).eq("id", segmentId));
  }
  if (error) throw new Error(`finishSegment: ${error.message}`);
}

// Re-export so processors import job helpers from one place if they prefer.
export { setMediaJob };

// Heartbeat a segment's updated_at while a long provider call runs.
//
// updated_at is only bumped by the synthetic_segments_touch trigger on an actual
// row UPDATE, and NOTHING writes the segment row during the long render await
// (LTX-2 clip ~60-95s, HeyGen render minutes). withSegmentHeartbeat wraps the
// render call and, every intervalMs, issues a no-op UPDATE that fires the touch
// trigger so updated_at stays fresh while the work is genuinely in flight — a
// live freshness signal any monitoring/tooling can rely on to tell a working
// render from a truly stuck row.
//
// NOTE: there is deliberately no automatic sweeper that flips a stale
// 'generating' segment to 'failed'. Such a sweep repeatedly false-failed avatars
// that were still rendering (a running-but-quiet job is normal during a long
// HeyGen render), surfacing a "failed" badge on a video that then completed fine.
// A genuinely orphaned spinner is cleared by the user via Regenerate instead.
export async function withSegmentHeartbeat<T>(
  segmentId: string,
  work: () => Promise<T>,
  intervalMs = 60_000,
): Promise<T> {
  const sb = getServerSupabase();
  const beat = setInterval(() => {
    // Guard on status='generating' so we never resurrect a segment that finished
    // or was swept between ticks. Best-effort: a failed beat just means this tick
    // didn't refresh updated_at; the next one will.
    void sb
      .from("synthetic_segments")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", segmentId)
      .eq("status", "generating")
      .then(() => {}, () => {});
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}

// Reset a segment for REGENERATION without losing its current asset.
//
// The old behaviour nulled image_url/video_url/right_image_url at reset time, so
// (a) the UI went blank during regen and (b) finishSegment had nothing to archive
// into asset_history — the previous version was lost. Instead we KEEP the current
// asset urls in place and only flip status + clear error. The worker's
// finishSegment then archives the still-present current asset into asset_history
// before writing the new one, and the old asset stays visible in the UI until the
// new one lands. `status` is 'pending' for batch dispatch (dispatchSegments picks
// up 'pending') or 'generating' for a single immediate re-enqueue.
export async function resetSegmentForRegen(
  segmentIds: string[],
  status: "pending" | "generating",
  // When true, ARCHIVE the current still into asset_history and then null
  // image_url/video_url so the processor generates a FRESH still from the
  // (possibly just-edited) prompt. Needed for image/ai_clip regen: a still that
  // a downstream provider content-filtered (e.g. LTX image-to-video) is otherwise
  // reused unchanged on every Retry — the image, not the prompt, is what gets
  // filtered — so it could never clear. We archive here (rather than letting
  // finishSegment do it) because nulling now would leave finishSegment nothing to
  // preserve; Restore still recovers the prior version. Default false keeps the
  // asset in place (UI stays populated during regen; finishSegment archives it).
  opts?: { clearStill?: boolean },
): Promise<void> {
  if (segmentIds.length === 0) return;
  const sb = getServerSupabase();

  if (opts?.clearStill) {
    // Archive each segment's current asset trio before clearing. Per-segment
    // because asset_history is an append and every row's history differs.
    const { data: rows } = await sb
      .from("synthetic_segments")
      .select("id, image_url, video_url, right_image_url, provider, asset_history")
      .in("id", segmentIds);
    for (const cur of rows ?? []) {
      const hasAsset = cur.image_url || cur.video_url;
      const history = Array.isArray(cur.asset_history) ? cur.asset_history : [];
      const nextHistory = hasAsset
        ? [
            ...history,
            {
              image_url: (cur.image_url as string | null) ?? null,
              video_url: (cur.video_url as string | null) ?? null,
              right_image_url: (cur.right_image_url as string | null) ?? null,
              provider: (cur.provider as string | null) ?? null,
              created_at: new Date().toISOString(),
            },
          ]
        : history;
      const patch: Record<string, unknown> = {
        status,
        error: null,
        image_url: null,
        video_url: null,
        asset_history: nextHistory,
      };
      let { error } = await sb.from("synthetic_segments").update(patch).eq("id", cur.id);
      // Back-compat: asset_history column may not be migrated yet (see finishSegment).
      if (error && /asset_history/.test(error.message)) {
        const { asset_history: _omit, ...withoutHistory } = patch;
        void _omit;
        ({ error } = await sb.from("synthetic_segments").update(withoutHistory).eq("id", cur.id));
      }
      if (error) throw new Error(`resetSegmentForRegen: ${error.message}`);
    }
    return;
  }

  const { error } = await sb
    .from("synthetic_segments")
    .update({ status, error: null })
    .in("id", segmentIds);
  if (error) throw new Error(`resetSegmentForRegen: ${error.message}`);
}

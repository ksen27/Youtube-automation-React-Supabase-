import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob, setMediaJob, setProjectStatus, logJob } from "@/lib/jobs/db";
import {
  enqueueImageGeneration,
  enqueueImageToVideo,
  enqueueAvatar,
} from "@/lib/jobs/queue";
import type { SyntheticSegment, ProjectStatus } from "@/lib/types";
import { estimateSegmentCost } from "@/lib/synthetic/cost";

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

// Metadata flag stamped on the single sales-pitch timeline_item so we can find
// (and not duplicate) it across finalize re-runs. The row has no
// synthetic_segment_id, so this is its only stable identity.
const PITCH_TIMELINE_FLAG = "pitch_video";

/**
 * Insert (or re-position) the sales-pitch video as a single timeline_item near
 * the project's pitch_video_insert_seconds mark, SNAPPED to the nearest segment
 * boundary so it never cuts an avatar part mid-sentence — and, when that
 * boundary falls between the two visual pieces of one time-split sentence,
 * pushed forward past the sentence so the pitch always starts after a full
 * sentence (client 2026-07-03).
 *
 * Idempotent: keyed on metadata.kind === 'pitch_video', so repeated finalize
 * calls update the one row rather than inserting duplicates. After placing the
 * pitch row it renumbers EVERY timeline row (synthetic segments + the pitch row)
 * to contiguous integer positions in timeline order, since the pitch row carries
 * no synthetic_segment_id and is therefore invisible to the segment-only
 * renumber in maybeFinalizeSynthetic.
 *
 * The pitch block is non-voiceover-bearing: it consumes video time but the
 * narration pauses over it (handled in the render route's duration guard +
 * renderProcessor's audio splice). Its duration is the probed/uploaded length,
 * falling back to 0 only when unknown (the render worker re-probes the real
 * file regardless).
 */
export async function ensurePitchTimelineItem(projectId: string): Promise<void> {
  const sb = getServerSupabase();

  const { data: proj } = await sb
    .from("projects")
    .select("pitch_video_url, pitch_video_duration_seconds, pitch_video_insert_seconds")
    .eq("id", projectId)
    .single();
  if (!proj?.pitch_video_url) return; // no pitch video on this project

  const insertAt = Number(proj.pitch_video_insert_seconds);
  const insertSeconds = Number.isFinite(insertAt) && insertAt > 0 ? insertAt : 180;
  const pitchDuration = Number(proj.pitch_video_duration_seconds) || 0;

  // Pull current synthetic timeline rows in order. We rebuild their start_times
  // from the durations rather than trusting the (planner-relative) start_time
  // column, because the renderer's effective cut is duration-driven.
  const { data: rowsRaw } = await sb
    .from("timeline_items")
    .select("id, position, duration, synthetic_segment_id, metadata, script_text")
    .eq("project_id", projectId)
    .order("position", { ascending: true });
  const rows = rowsRaw ?? [];

  // Separate the segment rows (everything with a segment id) from any existing
  // pitch row. We re-place the pitch row among the segment rows below.
  const segmentRows = rows.filter((r) => !!r.synthetic_segment_id);
  const existingPitch = rows.find(
    (r) => ((r.metadata ?? {}) as Record<string, unknown>).kind === PITCH_TIMELINE_FLAG,
  );
  if (segmentRows.length === 0) return; // nothing to anchor against yet

  // Cumulative start time of each segment row; snap to the boundary whose start
  // is nearest to insertSeconds. boundaryIndex is the number of segment rows
  // that play BEFORE the pitch (so the pitch row sits between segmentRows[bi-1]
  // and segmentRows[bi]).
  let cum = 0;
  let boundaryIndex = segmentRows.length; // default: append after the last row
  let bestDelta = Infinity;
  for (let i = 0; i < segmentRows.length; i++) {
    const delta = Math.abs(cum - insertSeconds);
    if (delta < bestDelta) {
      bestDelta = delta;
      boundaryIndex = i;
    }
    cum += Number(segmentRows[i].duration) || 0;
  }
  // Also consider the very end boundary (after the last row) — covers the rare
  // case the whole video is barely longer than insertSeconds.
  if (Math.abs(cum - insertSeconds) < bestDelta) {
    boundaryIndex = segmentRows.length;
  }

  // SENTENCE GUARD (client 2026-07-03): a long sentence is time-split by the
  // planner into TWO timeline rows (two visuals, one continuous narration), and
  // both pieces keep the parent's full script. A boundary BETWEEN those pieces
  // is therefore mid-sentence — the narration pauses for the pitch and the
  // sentence resumes after it, which sounds broken. Detect it by adjacent rows
  // carrying identical non-empty script_text, and push the pitch FORWARD to the
  // first boundary after the sentence completes.
  const isMidSentence = (i: number): boolean => {
    if (i <= 0 || i >= segmentRows.length) return false;
    const prev = ((segmentRows[i - 1].script_text as string | null) ?? "").trim();
    const next = ((segmentRows[i].script_text as string | null) ?? "").trim();
    return prev.length > 0 && prev === next;
  };
  const rawBoundaryIndex = boundaryIndex;
  while (isMidSentence(boundaryIndex)) boundaryIndex++;

  // Upsert the pitch row.
  const pitchPayload = {
    project_id: projectId,
    type: PITCH_TIMELINE_FLAG,
    position: 0, // set by the renumber below
    start_time: insertSeconds,
    duration: pitchDuration,
    script_text: null,
    image_url: null,
    video_url: proj.pitch_video_url,
    right_image_url: null,
    approved: true, // not a per-row reviewed asset; pre-approved like the intro
    synthetic_segment_id: null,
    metadata: { kind: PITCH_TIMELINE_FLAG, insert_seconds: insertSeconds },
  };
  let pitchId: string | null = existingPitch?.id ?? null;
  if (existingPitch) {
    await sb.from("timeline_items").update(pitchPayload).eq("id", existingPitch.id);
  } else {
    const { data: inserted, error } = await sb
      .from("timeline_items")
      .insert(pitchPayload)
      .select("id")
      .single();
    if (error) throw new Error(`ensurePitchTimelineItem insert: ${error.message}`);
    pitchId = inserted?.id ?? null;
  }

  // Renumber every row to contiguous integers in timeline order, splicing the
  // pitch row in at boundaryIndex. Segment rows keep their relative order.
  const orderedIds: string[] = [];
  for (let i = 0; i < segmentRows.length; i++) {
    if (i === boundaryIndex && pitchId) orderedIds.push(pitchId);
    orderedIds.push(segmentRows[i].id as string);
  }
  if (boundaryIndex >= segmentRows.length && pitchId) orderedIds.push(pitchId);

  for (let i = 0; i < orderedIds.length; i++) {
    await sb.from("timeline_items").update({ position: i }).eq("id", orderedIds[i]);
  }

  await logJob({ projectId }, "synthetic.pitch_video.placed", {
    insertSeconds,
    snappedBoundaryIndex: boundaryIndex,
    // Non-zero shift = the nearest boundary was inside a time-split sentence
    // and the pitch was pushed forward past it (sentence guard).
    sentenceGuardShift: boundaryIndex - rawBoundaryIndex,
    snapDeltaSeconds: Math.round(bestDelta * 100) / 100,
    pitchDurationSeconds: pitchDuration,
    totalRows: orderedIds.length,
  });
}

// Convenience: set a segment terminal state + (optionally) its media_job.
export async function finishSegment(
  segmentId: string,
  patch: Partial<Pick<SyntheticSegment, "status" | "image_url" | "video_url" | "right_image_url" | "provider" | "error">>,
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
// THE PROBLEM THIS FIXES
// ----------------------
// sweepStalledSegments (worker/reconcile.ts) treats a 'generating' segment whose
// updated_at predates SEGMENT_STALE_MS as dead and marks it
// "stalled — generation did not complete". But updated_at is only bumped by the
// synthetic_segments_touch trigger on an actual row UPDATE, and NOTHING writes the
// segment row during the long render await (LTX-2 clip ~60-95s, HeyGen render
// minutes). So a segment that is ALIVE and rendering goes quiet on updated_at and,
// once a deep serial backlog pushes its total in-flight time past the cutoff, the
// sweeper false-fails it even though generation is working. (See the band-aid in
// avatarProcessor: "a slow-but-alive HeyGen render can complete AFTER the sweeper
// wrote a 'stalled' error" — this removes the race instead of papering over it.)
//
// withSegmentHeartbeat wraps the render call and, every intervalMs, issues a
// no-op UPDATE that fires the touch trigger so updated_at stays fresh while the
// work is genuinely in flight. A segment that is actually stuck stops
// heartbeating and is still swept correctly.
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
): Promise<void> {
  if (segmentIds.length === 0) return;
  const sb = getServerSupabase();
  const { error } = await sb
    .from("synthetic_segments")
    .update({ status, error: null })
    .in("id", segmentIds);
  if (error) throw new Error(`resetSegmentForRegen: ${error.message}`);
}

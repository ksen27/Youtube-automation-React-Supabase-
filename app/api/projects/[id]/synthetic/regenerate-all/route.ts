import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { checkProjectEngine, setProjectStatus } from "@/lib/jobs/db";
import { dispatchSegments, resetSegmentForRegen } from "@/worker/processors/synthetic/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bulk "Regenerate all" for the review screen. Resets the targeted segments
// back to 'pending' (clearing prior asset urls + errors), then fans them ALL
// out at once via dispatchSegments — the worker then renders them in PARALLEL
// up to IMAGE_GEN_CONCURRENCY, instead of the user clicking Retry per row.
//
// Body: { scope?: "failed" | "stuck" | "incomplete" | "images" | "all" }  (default "failed")
//   failed     -> only segments whose status is 'failed'
//   stuck      -> segments stuck at 'generating' whose LATEST linked media_job is
//                 already terminal (failed/completed) — a dead render that will
//                 never advance the segment (e.g. an avatar whose retries all
//                 exhausted against a saturated HeyGen pool). Unlike "incomplete"
//                 this deliberately EXCLUDES generating segments with a live
//                 (queued/running) job, so a legitimately in-flight render is
//                 never clobbered.
//   incomplete -> failed + anything not yet 'ready' (failed/pending/generating),
//                 useful to kick a batch that stalled mid-run.
//   images     -> EVERY image-bearing block (image / ai_clip / split_2),
//                 regardless of status. Used to re-test a prompt change (e.g. a
//                 new STYLE_PROMPT) on an EXISTING project without re-planning
//                 or making a new project. Avatars are left untouched — the
//                 client is happy with them and re-rendering them is slow/costly.
//   all        -> every segment, any status, including avatars.
const Body = z.object({
  scope: z.enum(["failed", "stuck", "incomplete", "images", "all"]).optional(),
});

// Block types that produce a generated IMAGE (and so are affected by an image
// prompt / STYLE_PROMPT change). avatar is excluded — it is HeyGen-driven and
// carries no image prompt.
const IMAGE_BLOCK_TYPES = ["image", "ai_clip", "split_2"] as const;

// A media_job that can no longer advance its segment. queued/running jobs are
// still live (a legitimately in-flight render, kept fresh by withSegmentHeartbeat)
// and must NOT be treated as stuck.
const TERMINAL_JOB_STATUSES = new Set(["failed", "completed"]);

// Resolve the ids of segments stuck at 'generating' whose LATEST linked
// media_job is terminal — a render that died (all retries exhausted, e.g. a
// saturated HeyGen pool) or completed without flipping the segment to 'ready'.
// A generating segment with a live (queued/running) job, or with NO job at all
// (about to be dispatched), is left alone.
async function selectStuckSegmentIds(projectId: string): Promise<string[]> {
  const sb = getServerSupabase();
  // Both reads are PAGED. An unbounded PostgREST select is clipped at
  // max-rows (1000) with no error, and ascending order means the rows dropped
  // are the NEWEST — exactly the ones that say whether a segment is still live.
  // On a 3,116-job project that made every recently-requeued segment look
  // stuck, so this scope reset and re-dispatched blocks already mid-render.
  const [segRes, jobRes] = await Promise.all([
    fetchAllRows((from, to) =>
      sb.from("synthetic_segments").select("id", { count: "exact" })
        .eq("project_id", projectId).eq("status", "generating")
        .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) =>
      sb.from("media_jobs").select("status, metadata, created_at", { count: "exact" })
        .eq("project_id", projectId)
        .order("created_at", { ascending: true }).order("id", { ascending: true })
        .range(from, to)),
  ]);
  // A partial read is worse than no read here: a half-drained job list makes
  // live segments look job-less or dead, and this scope RESETS what it selects.
  // Fail loudly instead of resetting a set derived from incomplete data.
  const readErr = segRes.error ?? jobRes.error;
  if (readErr) throw new Error(`selectStuckSegmentIds: ${readErr.message}`);

  const generatingIds = segRes.data.map((s) => s.id);
  if (generatingIds.length === 0) return [];

  // Latest job per segment (jobs are asc by created_at, so the last write wins).
  const latestBySegment = new Map<string, string>();
  for (const j of jobRes.data) {
    const segId = (j.metadata as { segmentId?: string } | null)?.segmentId;
    if (segId) latestBySegment.set(segId, j.status);
  }

  return generatingIds.filter((segId) => {
    const jobStatus = latestBySegment.get(segId);
    // Only stuck if there IS a job and it's terminal. No job → not yet
    // dispatched (a fresh regen), leave it for the normal flow.
    return jobStatus !== undefined && TERMINAL_JOB_STATUSES.has(jobStatus);
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const eng = await checkProjectEngine(id, "synthetic");
  if (!eng.ok) {
    return eng.status === 404
      ? NextResponse.json({ error: "project not found" }, { status: 404 })
      : NextResponse.json({ error: "not an AI Avatar (synthetic) project" }, { status: 400 });
  }

  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "invalid input", issues: body.error.flatten() }, { status: 400 });
  }
  const scope = body.data.scope ?? "failed";

  const sb = getServerSupabase();

  // The "stuck" scope is special: it can't be expressed as a status filter
  // alone. A stuck segment is 'generating' AND its latest linked media_job is
  // terminal — a dead render that will never advance it. Resolve those ids by
  // cross-referencing media_jobs.
  let ids: string[];
  if (scope === "stuck") {
    ids = await selectStuckSegmentIds(id);
  } else {
    // Build the target query. status-based scopes filter on status; the
    // prompt-retest scopes ("images"/"all") ignore status and instead target by
    // block type so a READY segment is re-generated too (that's the whole point —
    // re-run already-good blocks against the new prompt).
    //
    // Built per PAGE rather than once: the read is paged (an unbounded select
    // stops at PostgREST's max-rows, so on a long project "regenerate all" would
    // quietly reset only the first 1000 blocks while reporting the whole set),
    // and a PostgREST builder carries its own range — it cannot be re-ranged.
    const pageQuery = (from: number, to: number) => {
      let query = sb.from("synthetic_segments")
        .select("id", { count: "exact" }).eq("project_id", id);
      if (scope === "images") {
        query = query.in("block_type", IMAGE_BLOCK_TYPES as unknown as string[]);
      } else if (scope === "all") {
        // no extra filter — every segment
      } else {
        const statuses = scope === "incomplete"
          ? ["failed", "pending", "generating"]
          : ["failed"];
        query = query.in("status", statuses);
      }
      return query.order("id", { ascending: true }).range(from, to);
    };

    // Reset the targeted segments to 'pending' and clear prior asset state so
    // dispatchSegments (which only picks up 'pending') re-enqueues them. We also
    // drop any timeline_items materialized from a prior run for these segments.
    const { data: targets, error: selErr } = await fetchAllRows(pageQuery);
    if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });
    ids = targets.map((t) => t.id);
  }
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, enqueued: 0, note: "nothing to regenerate" }, { status: 200 });
  }

  // Reset to 'pending' so dispatchSegments re-enqueues them. For image/ai_clip
  // blocks a full regen must DROP the cached still (clearStill) so a fresh one is
  // generated from the current prompt — otherwise a provider-content-filtered
  // still (e.g. LTX image-to-video) is re-sent unchanged on every retry and never
  // clears. clearStill archives the old asset first (Restore still works). We do
  // NOT clear for avatar/split_2 (their asset is a HeyGen render we keep), nor for
  // the "images" scope (imageOnly dispatch keeps split_2's avatar video). Other
  // block types keep their asset visible until the new one lands.
  try {
    if (scope === "images") {
      await resetSegmentForRegen(ids, "pending");
    } else {
      // Paged for the same max-rows reason: a truncated read here would leave
      // the tail of a long selection without clearStill, so those blocks would
      // be re-sent to the provider with the very still that failed.
      const { data: typed, error: typeErr } = await fetchAllRows((from, to) =>
        sb.from("synthetic_segments")
          .select("id, block_type", { count: "exact" })
          .in("id", ids)
          .order("id", { ascending: true })
          .range(from, to));
      if (typeErr) throw new Error(typeErr.message);
      const clearIds = typed
        .filter((s) => s.block_type === "image" || s.block_type === "ai_clip")
        .map((s) => s.id);
      const keepIds = ids.filter((i) => !clearIds.includes(i));
      await resetSegmentForRegen(clearIds, "pending", { clearStill: true });
      await resetSegmentForRegen(keepIds, "pending");
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  for (const segId of ids) {
    await sb
      .from("timeline_items")
      .delete()
      .eq("project_id", id)
      .contains("metadata", { synthetic_segment_id: segId });
  }

  // Fan everything out at once — the worker renders them concurrently. For the
  // "images" scope, split_2 blocks regenerate ONLY their right still (the avatar
  // video is kept) and pure-avatar blocks are skipped entirely.
  const enqueued = await dispatchSegments(id, { imageOnly: scope === "images" });
  if (enqueued > 0) await setProjectStatus(id, "generating_images");

  return NextResponse.json({ ok: true, enqueued }, { status: 202 });
}

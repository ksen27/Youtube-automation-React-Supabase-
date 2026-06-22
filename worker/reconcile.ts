// Reconciles BullMQ terminal failures and orphaned "running" jobs back into
// the media_jobs table.
//
// THE PROBLEM THIS FIXES
// ----------------------
// The only code that writes a terminal status (completed/failed) into a
// media_jobs row is the processor body itself (see clipProcessor.ts et al).
// If a job dies BEFORE reaching that terminal write — a stalled lock, an OOM
// kill, a Fly machine eviction mid-job — the row is frozen at
// status="running", progress=5 forever. The UI's per-step aggregate
// (processing-screen.tsx → aggregateState) treats any "running" row as an
// in-flight step, so the whole pipeline stays stuck on "Generate clips" and
// the user can never advance to matching. This actually happened: a clip job
// exhausted its 3 BullMQ attempts (each dying at progress=5) and left an
// orphan that blocked the project.
//
// THE FIX (two layers)
// --------------------
//  1. markJobFailed() — wired to the worker's on("failed") event. When BullMQ
//     has exhausted all retries (attemptsMade >= attemptsAllowed) it flips the
//     matching media_jobs row to "failed". Because jobId === mediaJobId, the
//     mapping is direct.
//  2. sweepStalledJobs() — a periodic safety net for the case where the
//     "failed" event never fires (hard kill, machine eviction). Any media_jobs
//     row stuck "running"/"queued" whose updated_at hasn't moved past the lock
//     window is marked "failed". The media_jobs_touch trigger keeps updated_at
//     fresh on every setMediaJob write, so a live job is never swept.
//
// After marking a clip/download job failed, both paths call maybeEnqueueMatch
// so the pipeline still advances on whatever succeeded — otherwise marking the
// orphan failed would just swap a "stuck running" UI for a "stuck failed" UI.

import { getServerSupabase } from "@/lib/supabase/server";
import { logJob } from "@/lib/jobs/db";
import { maybeEnqueueMatch } from "./processors/_shared";
import { maybeFinalizeSynthetic } from "./processors/synthetic/_shared";

// Marks a single media_jobs row failed if it is not already in a terminal
// state. Idempotent — safe to call from the failed-event handler even if a
// later retry already wrote a terminal status. Returns the project_id + type
// so the caller can advance the pipeline.
async function failJobRow(
  mediaJobId: string,
  reason: string,
): Promise<{ projectId: string; type: string } | null> {
  const sb = getServerSupabase();
  const { data: row } = await sb
    .from("media_jobs")
    .select("id, project_id, type, status")
    .eq("id", mediaJobId)
    .single();
  if (!row) return null;
  // Don't clobber a row that already reached a terminal state — the processor
  // may have finished a successful retry after the earlier attempt's failed
  // event fired.
  if (row.status === "completed" || row.status === "failed") return null;

  const { error } = await sb
    .from("media_jobs")
    .update({ status: "failed", error: reason })
    .eq("id", mediaJobId)
    // Guard against a race where the processor flips to completed between our
    // read and write: only transition rows still in a non-terminal state.
    .in("status", ["queued", "running"]);
  if (error) {
    await logJob({ jobId: mediaJobId, projectId: row.project_id },
      "reconcile.fail_row.error", { err: error.message });
    return null;
  }
  return { projectId: row.project_id, type: row.type };
}

// Called from the worker's on("failed") handler. Only acts once BullMQ has
// exhausted all retries — a job that will be retried is left alone so its
// next attempt can still succeed.
export async function markJobFailedIfExhausted(
  mediaJobId: string | undefined,
  attemptsMade: number,
  attemptsAllowed: number,
  errMessage: string,
): Promise<void> {
  if (!mediaJobId) return;
  if (attemptsMade < attemptsAllowed) return; // more retries pending

  const res = await failJobRow(mediaJobId, errMessage.slice(0, 500));
  if (!res) return;
  await logJob({ jobId: mediaJobId, projectId: res.projectId },
    "reconcile.marked_failed", { source: "failed_event", type: res.type });

  // Keep the pipeline moving on whatever succeeded. maybeEnqueueMatch is a
  // no-op unless this was the last blocking download/clip job.
  if (res.type === "clip" || res.type === "download") {
    await maybeEnqueueMatch(res.projectId);
  }
}

// Periodic safety net. Finds media_jobs rows stuck "running" (or "queued")
// whose updated_at predates the stall cutoff and marks them failed. This is
// the layer that catches hard kills where on("failed") never fired.
//
// staleMs MUST exceed the worker's lockDuration (currently 15 min) plus a
// margin, or we'd kill jobs that are legitimately mid-await on a long ffmpeg /
// yt-dlp call (those only heartbeat updated_at between awaits).
export async function sweepStalledJobs(staleMs: number, onlyTypes?: string[]): Promise<number> {
  const sb = getServerSupabase();
  // Compute the cutoff without Date.now() arithmetic surprises — a plain ISO
  // string comparison in the query.
  const cutoff = new Date(Date.now() - staleMs).toISOString();

  // When the worker is engine-scoped (WORKER_ROLE), only sweep its own job
  // types — otherwise the celebrity worker could false-kill a slow-but-alive
  // avatar job the synthetic worker is actively running (and vice versa).
  let query = sb
    .from("media_jobs")
    .select("id, project_id, type")
    .in("status", ["running", "queued"])
    .lt("updated_at", cutoff);
  if (onlyTypes && onlyTypes.length > 0) {
    query = query.in("type", onlyTypes);
  }
  const { data: stalled, error } = await query;
  if (error) {
    await logJob({}, "reconcile.sweep.query_error", { err: error.message });
    return 0;
  }
  if (!stalled || stalled.length === 0) return 0;

  const touchedProjects = new Map<string, Set<string>>(); // projectId -> types
  for (const row of stalled) {
    const res = await failJobRow(row.id, "stalled — no progress past lock window");
    if (!res) continue;
    await logJob({ jobId: row.id, projectId: res.projectId },
      "reconcile.marked_failed", { source: "stall_sweep", type: res.type });
    if (!touchedProjects.has(res.projectId)) touchedProjects.set(res.projectId, new Set());
    touchedProjects.get(res.projectId)!.add(res.type);
  }

  // Advance the pipeline once per affected project.
  for (const [projectId, types] of touchedProjects) {
    if (types.has("clip") || types.has("download")) {
      await maybeEnqueueMatch(projectId);
    }
  }
  return touchedProjects.size;
}

// Periodic safety net for ORPHANED SEGMENTS. A synthetic_segments row is
// stamped status="generating" when its job is dispatched; the UI shows a
// spinner for it. If the worker then dies / the session expires / the job is
// lost, the segment row is frozen at "generating" forever — a dead spinner the
// user can't clear (only "Regenerate" re-dispatches, but the row never flips to
// "failed" on its own). This sweeper flips such stale rows to "failed" so the
// UI shows a retryable failure instead of an endless spinner.
//
// The synthetic_segments_touch trigger keeps updated_at fresh on every write,
// so a segment a worker is actively updating is never swept. staleMs must
// exceed the longest legitimate quiet window between segment writes during a
// real generation (HeyGen renders can take minutes) plus a margin.
export async function sweepStalledSegments(staleMs: number): Promise<number> {
  const sb = getServerSupabase();
  const cutoff = new Date(Date.now() - staleMs).toISOString();

  const { data: stalled, error } = await sb
    .from("synthetic_segments")
    .select("id, project_id, metadata")
    .eq("status", "generating")
    .lt("updated_at", cutoff);
  if (error) {
    await logJob({}, "reconcile.segment_sweep.query_error", { err: error.message });
    return 0;
  }
  if (!stalled || stalled.length === 0) return 0;

  // A segment is stamped 'generating' the moment it is DISPATCHED, but with a
  // serial queue (AVATAR_CONCURRENCY=1, ~5min/HeyGen render) a segment can sit
  // QUEUED behind many others for far longer than staleMs before its job even
  // starts. Its updated_at never moves while queued (nothing writes the row), so
  // the naive cutoff would false-fail avatars that are simply waiting their turn
  // — exactly the 2026-06-21 mass-sweep (38 segments killed mid-run).
  //
  // So before sweeping, look up each segment's linked media_job: if the job is
  // still 'queued' (never started), the segment is WAITING, not stalled — skip
  // it. Only sweep segments whose job is actually 'running' (started but went
  // quiet past the cutoff = genuinely stuck) or whose job is missing/terminal
  // (orphaned — the spinner can never clear on its own).
  const jobIds = stalled
    .map((s) => ((s.metadata ?? {}) as Record<string, unknown>).mediaJobId as string | undefined)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const jobStatusById = new Map<string, string>();
  if (jobIds.length > 0) {
    const { data: jobRows } = await sb
      .from("media_jobs")
      .select("id, status")
      .in("id", jobIds);
    for (const j of jobRows ?? []) jobStatusById.set(j.id as string, j.status as string);
  }

  const projects = new Set<string>();
  let skippedQueued = 0;
  for (const seg of stalled) {
    const jobId = ((seg.metadata ?? {}) as Record<string, unknown>).mediaJobId as string | undefined;
    const jobStatus = jobId ? jobStatusById.get(jobId) : undefined;
    // Still waiting in the queue — not stalled. Leave it for its turn.
    if (jobStatus === "queued") {
      skippedQueued++;
      continue;
    }
    const { error: upErr } = await sb
      .from("synthetic_segments")
      .update({ status: "failed", error: "stalled — generation did not complete" })
      .eq("id", seg.id)
      .eq("status", "generating"); // guard against a concurrent finish
    if (upErr) continue;
    await logJob({ projectId: seg.project_id, sourceId: seg.id },
      "reconcile.segment_stall_swept", { segmentId: seg.id, jobStatus: jobStatus ?? "none" });
    projects.add(seg.project_id);
  }
  if (skippedQueued > 0) {
    await logJob({}, "reconcile.segment_sweep.skipped_queued", { count: skippedQueued });
  }

  // Let the synthetic pipeline finalize on whatever succeeded (drops failed
  // segments, materializes the timeline) so a stuck project can still advance.
  for (const projectId of projects) {
    await maybeFinalizeSynthetic(projectId).catch(() => {});
  }
  return projects.size;
}

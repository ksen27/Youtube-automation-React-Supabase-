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

// Periodic safety net. Finds media_jobs rows stuck "running" whose updated_at
// predates the stall cutoff and marks them failed. This is the layer that
// catches hard kills where on("failed") never fired.
//
// We sweep ONLY "running" — NOT "queued". A queued media_job is one the worker
// has not started yet; with a SERIAL queue (AVATAR_CONCURRENCY=1, ~2 min/render)
// the avatar queue can be far deeper than staleMs, so a job at the back waits >45
// min before its turn — through no fault of its own. The old query swept "queued"
// too, which false-failed those still-waiting avatar jobs in a burst
// (reconcile.marked_failed source:stall_sweep type:avatar ×N) even while
// generation was working. A truly orphaned enqueue (worker died before picking it
// up) is BullMQ's responsibility — its stalled-job check re-delivers it — not this
// DB sweep's. So queued jobs are left alone.
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
    .eq("status", "running")
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

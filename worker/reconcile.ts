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
import { getQueue, QUEUE_NAMES } from "@/lib/jobs/queue";
import { maybeEnqueueMatch } from "./processors/_shared";
import { dispatchSegments, promoteNextQueuedProject } from "./processors/synthetic/_shared";
import { getEnv } from "@/lib/env";

// Reconcile a synthetic SEGMENT stuck at 'generating' when its media_job died
// without reaching the processor's own terminal write.
//
// THE GAP THIS CLOSES: the segment's status='failed' write lives ONLY inside
// the processor body (imageGenProcessor / imageToVideoProcessor / avatarProcessor
// finishSegment). If the job is hard-killed (OOM, machine eviction) the processor
// never runs that line, so failJobRow flips the media_job to 'failed' but the
// synthetic_segments row stays 'generating' — and the review screen (which polls
// the SEGMENT status) spins forever. This flips the linked segment to 'failed'
// too, turning an infinite spinner into a visible Regenerate button.
//
// Safe against the false-fail hazard called out in _shared.ts: we do NOT sweep
// segments by staleness. This fires ONLY once the media_job itself is failed,
// which the job sweep already gates on the 45-min stale window WITH heartbeats
// (withSegmentHeartbeat) keeping live renders fresh — so a segment that is still
// rendering is never touched. The status='generating' guard also stops us
// resurrecting a segment that finished or was already reset for regen.
async function reconcileSegmentForFailedJob(
  mediaJobId: string,
  metadata: unknown,
  reason: string,
): Promise<void> {
  const segmentId = (metadata as { segmentId?: string } | null)?.segmentId;
  if (!segmentId) return; // non-synthetic job (search/download/clip/render) — no segment
  const sb = getServerSupabase();
  const { error } = await sb
    .from("synthetic_segments")
    .update({ status: "failed", error: reason })
    .eq("id", segmentId)
    // Only reconcile a segment still in flight. A 'ready' segment (job died AFTER
    // the segment succeeded) or one already reset to 'pending'/'generating' for a
    // fresh regen must not be clobbered.
    .eq("status", "generating");
  if (error) {
    await logJob({ jobId: mediaJobId },
      "reconcile.segment.error", { err: error.message, segmentId });
  }
}

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
    .select("id, project_id, type, status, metadata")
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
  // Also reconcile the linked synthetic segment so a dead image/clip/avatar job
  // doesn't leave the segment spinning at 'generating' forever (no-op for
  // non-synthetic job types, which carry no segmentId).
  await reconcileSegmentForFailedJob(mediaJobId, row.metadata, reason);
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

// Periodic safety net for a DIFFERENT orphan than sweepStalledJobs catches: a
// synthetic segment stuck at 'generating' whose media_job is ALREADY terminal
// 'failed'. This happens when the processor marked its OWN job failed (e.g. the
// provider rejected a celebrity-name prompt — "69labs image: job FAILED") but
// the paired segment status='failed' write did NOT land (a crash between the two
// writes, or a segment planned before the reconcile fix shipped). Neither of the
// two existing paths reaches it: failJobRow early-returns on an already-terminal
// job, and sweepStalledJobs only looks at 'running' jobs. So the review screen —
// which polls the SEGMENT status — spins forever on a job that died long ago.
//
// We reconcile ONLY segments whose LATEST linked media_job is 'failed'. A segment
// with a live (queued/running) job is left alone — that's a normal in-flight
// render, guarded by withSegmentHeartbeat, and must never be false-failed (the
// hazard _shared.ts warns about). Copies the job's error onto the segment so the
// UI shows the real reason, then the user can Regenerate.
export async function sweepOrphanedSegments(): Promise<number> {
  const sb = getServerSupabase();
  const { data: segs, error } = await sb
    .from("synthetic_segments")
    .select("id, project_id")
    .eq("status", "generating");
  if (error) {
    await logJob({}, "reconcile.segment_sweep.query_error", { err: error.message });
    return 0;
  }
  if (!segs || segs.length === 0) return 0;

  let fixed = 0;
  for (const seg of segs) {
    // The most recent media_job for this segment. If it's still queued/running,
    // the segment is legitimately in flight — skip it.
    const { data: jobs } = await sb
      .from("media_jobs")
      .select("id, status, error")
      .contains("metadata", { segmentId: seg.id })
      .order("updated_at", { ascending: false })
      .limit(1);
    const job = jobs?.[0];
    if (!job || job.status !== "failed") continue;

    const reason = (job.error ?? "generation failed").slice(0, 300);
    const { error: updErr } = await sb
      .from("synthetic_segments")
      .update({ status: "failed", error: reason })
      .eq("id", seg.id)
      // Re-check status in the write so we never clobber a segment that started a
      // fresh regen between our read and this update.
      .eq("status", "generating");
    if (updErr) {
      await logJob({ projectId: seg.project_id }, "reconcile.segment_sweep.error",
        { err: updErr.message, segmentId: seg.id });
      continue;
    }
    fixed++;
    await logJob({ jobId: job.id, projectId: seg.project_id },
      "reconcile.marked_failed", { source: "segment_orphan_sweep", segmentId: seg.id });
  }
  return fixed;
}

// Periodic safety net for a ZOMBIE RENDER — a render_jobs row frozen at
// 'queued'/'running' whose BullMQ job will never advance it again.
//
// THE GAP THIS CLOSES: render_jobs is written ONLY by renderProcessor itself
// (running at the top, completed/failed at the bottom). Nothing else in the
// codebase ever touches it — not failJobRow, not sweepStalledJobs. So if the
// processor dies before ANY of those writes land, the row stays 'queued'
// forever. This actually happened (2026-08-04): a synthetic render's very first
// write — setMediaJob(..., "running") — hit a Supabase 522 outage, so the job
// threw at line 1 and even its own catch-block's "failed" write went to the
// dead DB. Both the render_jobs and media_jobs rows were left at 'queued' with
// updated_at never moving, while the BullMQ job exhausted its retries and
// landed in the failed set.
//
// The damage is that POST /render refuses a NEW render while any render_jobs row
// for the project is queued/running — so the project can never be rendered again
// ("render already in progress" on every click), with no UI path out.
// sweepStalledJobs can't reach it either: the media_job was 'queued', and that
// sweep deliberately skips 'queued' rows.
//
// WHY WE ASK BULLMQ RATHER THAN SWEEP ON AGE: a render legitimately sits queued
// for hours behind other renders (concurrency 1 per machine), so any age-based
// rule would false-fail a render that is merely waiting its turn. The queue is
// the authority on whether the job can still run: a job in the failed set, or
// gone from Redis entirely, will never advance the row again. Anything still
// waiting/active/delayed is left strictly alone.
//
// Both render queues are probed regardless of this worker's role — the lookup is
// read-only, Redis is shared, and render_jobs carries no queue discriminator.
const RENDER_ZOMBIE_GRACE_MS = 5 * 60_000; // don't inspect a just-created row

// What the queue says about a render's BullMQ job. Returns null when the job is
// still able to advance (waiting/active/delayed/…) — i.e. do not touch the row.
async function deadRenderReason(mediaJobId: string): Promise<string | null> {
  for (const name of [QUEUE_NAMES.render, QUEUE_NAMES.renderSynthetic] as const) {
    const job = await getQueue(name).getJob(mediaJobId);
    if (!job) continue;
    const state = await job.getState();
    if (state === "failed") {
      return (job.failedReason || "render job failed").slice(0, 500);
    }
    if (state === "completed") {
      // Finished but never recorded a result — its terminal DB write was lost.
      // Nothing will retry it, so free the project to render again.
      return "render finished without recording a result";
    }
    return null; // waiting / active / delayed / prioritized — still live
  }
  // In neither queue: never enqueued (the route died between the insert and the
  // enqueue) or evicted from Redis. Either way no job will ever run it.
  return "render job is not in any queue";
}

export async function sweepZombieRenderJobs(): Promise<number> {
  const sb = getServerSupabase();
  const cutoff = new Date(Date.now() - RENDER_ZOMBIE_GRACE_MS).toISOString();

  const { data: rows, error } = await sb
    .from("render_jobs")
    .select("id, project_id")
    .in("status", ["queued", "running"])
    .lt("updated_at", cutoff);
  if (error) {
    await logJob({}, "reconcile.render_sweep.query_error", { err: error.message });
    return 0;
  }
  if (!rows || rows.length === 0) return 0;

  let fixed = 0;
  for (const rj of rows) {
    // The media_job the queue keys on: jobId === mediaJobId by design, and the
    // render route stamps the render_job id into its metadata.
    const { data: jobs } = await sb
      .from("media_jobs")
      .select("id")
      .eq("project_id", rj.project_id)
      .eq("type", "render")
      .contains("metadata", { renderJobId: rj.id })
      .limit(1);
    const mediaJobId = jobs?.[0]?.id as string | undefined;

    const reason = mediaJobId
      ? await deadRenderReason(mediaJobId)
      : "no media_job was ever created for this render";
    if (!reason) continue; // job is still live — leave it alone

    const { error: updErr } = await sb
      .from("render_jobs")
      .update({ status: "failed", error: reason })
      .eq("id", rj.id)
      // Re-check in the write so a render that started between our read and here
      // (or one a retry just completed) is never clobbered.
      .in("status", ["queued", "running"]);
    if (updErr) {
      await logJob({ projectId: rj.project_id }, "reconcile.render_sweep.error",
        { err: updErr.message, renderJobId: rj.id });
      continue;
    }
    // Keep the paired media_job consistent — it's the row the progress UI reads,
    // and sweepStalledJobs won't touch it while it sits at 'queued'. Idempotent.
    if (mediaJobId) await failJobRow(mediaJobId, reason);
    fixed++;
    await logJob({ jobId: mediaJobId, projectId: rj.project_id },
      "reconcile.marked_failed", { source: "render_zombie_sweep", renderJobId: rj.id, reason });
  }
  return fixed;
}

// Periodic safety net for STRANDED segments — the opposite orphan from the two
// sweeps above. Those handle segments that were dispatched (a media_job exists)
// but got stuck; THIS handles segments that were NEVER dispatched at all.
//
// THE GAP THIS CLOSES: dispatchSegments() fans a project's segments out in a
// SYNCHRONOUS per-segment loop inside the POST /generate-assets HTTP request
// (create media_job → flip segment to 'generating' → enqueue, ~3 awaited
// round-trips each). On a large project (hundreds of blocks) that request can
// die partway — a serverless/HTTP timeout or a transient blip — after enqueuing
// only the first N. The segments it reached run to completion; the REST stay
// 'pending' with NO media_job forever, and the project sits in generating_*
// with a permanent spinner (observed 2026-07-14: a 283-block project stranded
// at 66 ready / 217 pending, every media_job completed, worker idle). Neither
// job sweep touches these — there is no media_job to sweep — and the segment
// sweep only looks at 'generating' rows.
//
// dispatchSegments is idempotent (it only picks up 'pending' segments), so the
// recovery is simply to re-run it. We gate carefully to avoid re-dispatching a
// project that is still legitimately mid-dispatch:
//   - only projects in a generating_* status (asset generation is supposed to
//     be in flight);
//   - only when the project has NO live (queued/running) asset media_job — a
//     live job means dispatch is either still running or genuinely working, so
//     we leave it alone (mirrors the /generate-assets 409 guard);
//   - only projects whose pending segments have been stranded a while
//     (updated_at older than a grace window) so a dispatch loop actively
//     mid-flight is never pre-empted.
const STRANDED_GRACE_MS = 10 * 60_000; // 10 min since the pending row last moved

export async function sweepUndispatchedSegments(): Promise<number> {
  const sb = getServerSupabase();
  const cutoff = new Date(Date.now() - STRANDED_GRACE_MS).toISOString();

  // Candidate projects: currently generating assets AND holding at least one
  // 'pending' segment that has sat untouched past the grace window.
  const { data: stranded, error } = await sb
    .from("synthetic_segments")
    .select("project_id, projects!inner(status)")
    .eq("status", "pending")
    .lt("updated_at", cutoff)
    .in("projects.status", ["generating_images", "generating_clips", "generating_avatars"]);
  if (error) {
    await logJob({}, "reconcile.undispatched_sweep.query_error", { err: error.message });
    return 0;
  }
  if (!stranded || stranded.length === 0) return 0;

  const projectIds = [...new Set(stranded.map((r) => r.project_id as string))];
  let redispatched = 0;
  for (const projectId of projectIds) {
    // A live asset job means dispatch is still running OR generation is genuinely
    // in flight — leave it alone (same guard as POST /generate-assets). Only a
    // project whose asset jobs have ALL drained (or none exist) is truly stranded.
    const { data: open } = await sb
      .from("media_jobs").select("id")
      .eq("project_id", projectId)
      .in("type", ["image_gen", "image_to_video", "avatar"])
      .in("status", ["queued", "running"]).limit(1);
    if ((open ?? []).length > 0) continue;

    const enqueued = await dispatchSegments(projectId).catch(async (e) => {
      await logJob({ projectId }, "reconcile.undispatched_sweep.dispatch_error",
        { err: (e as Error).message });
      return 0;
    });
    if (enqueued > 0) {
      redispatched++;
      await logJob({ projectId }, "reconcile.undispatched_sweep.redispatched", { enqueued });
    }
  }
  return redispatched;
}

// Admission-control safety net (SYNTHETIC_MAX_GENERATING_PROJECTS).
//
// Projects over the cap wait at 'plan_ready' and are normally promoted by
// maybeFinalizeSynthetic when a slot frees. Two things can break that chain and
// leave the whole queue deadlocked — every waiting project stuck forever:
//   1. The promoting call itself died (worker killed mid-finalize, deploy).
//   2. A project is wedged in generating_* holding a slot it will never release
//      (its jobs are all terminal but finalize never ran to completion).
// Case 2 is already repaired by sweepUndispatchedSegments / the segment sweeps,
// which flip such a project out of generating_*; this sweep then fills the slot.
//
// So this is a pure top-up: if fewer projects are generating than the cap and
// something is waiting, promote. Idempotent and cheap — promoteNextQueuedProject
// re-checks the count itself and no-ops when there is no room.
export async function sweepAdmissionSlots(): Promise<number> {
  let promoted = 0;
  // Bounded loop: fill at most the whole cap in one sweep, so a long backlog
  // drains over successive ticks rather than in one burst.
  for (let i = 0; i < getEnv().SYNTHETIC_MAX_GENERATING_PROJECTS; i++) {
    const id = await promoteNextQueuedProject().catch(async (e) => {
      await logJob({}, "reconcile.admission_sweep.error", { err: (e as Error).message });
      return null;
    });
    if (!id) break;
    promoted++;
  }
  return promoted;
}

/* eslint-disable no-console */
// Standalone BullMQ worker process. Run with `pnpm worker` (or `npm run worker`).
// Uses tsx for TS execution. Loads env from .env files via dotenv if present.

// Load env from .env.local first (Next.js convention), then fall back to .env.
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { Worker, DelayedError, type Job } from "bullmq";
import { QUEUE_NAMES, getRedisConnection, closeAllQueues } from "@/lib/jobs/queue";
import { getEnv } from "@/lib/env";
import { isPoolBusyError } from "@/lib/synthetic/heygen-errors";

import { processSearchJob }     from "./processors/searchProcessor";
import { processDownloadJob }   from "./processors/downloadProcessor";
import { processClipJob }       from "./processors/clipProcessor";
import { processMatchJob }      from "./processors/matchProcessor";
import { processRenderJob }     from "./processors/renderProcessor";
import { processScriptClipJob } from "./processors/scriptClipProcessor";
// --- synthetic engine processors (migration 0020) ---
import { processTtsJob }              from "./processors/synthetic/ttsProcessor";
import { processSyntheticPlannerJob } from "./processors/synthetic/plannerProcessor";
import { processImageGenJob }         from "./processors/synthetic/imageGenProcessor";
import { processImageToVideoJob }     from "./processors/synthetic/imageToVideoProcessor";
import { processAvatarJob }           from "./processors/synthetic/avatarProcessor";
import { markJobFailedIfExhausted, sweepStalledJobs } from "./reconcile";
import { sweepRenderCache } from "./processors/renderCache";
import { sweepKeepAlive } from "@/lib/synthetic/heygen-auth";
import { closeWarmSession, warmAccountIds, activeAccountIds } from "@/lib/synthetic/heygen-session";
import { claimedAccountIds } from "@/lib/synthetic/heygen-accounts";

const env = getEnv();
const concurrency = env.WORKER_CONCURRENCY;
const downloadConcurrency = env.DOWNLOAD_CONCURRENCY;

// BullMQ job lock / stalled window. Must exceed the longest a single job can run
// without the lock being renewed. The avatar worst case (a wrong-orientation
// render polled to budget, then a rotated re-render) stacks two ~11-min HeyGen
// renders on ONE job — past the old 15-min ceiling, which tripped a stalled
// re-delivery. 25 min covers it; see the per-worker comment below for detail.
const LOCK_DURATION_MS = 25 * 60_000; // 25 min

console.log(JSON.stringify({
  ts: new Date().toISOString(),
  msg: "worker.starting",
  concurrency,
  downloadConcurrency,
}));

const workers: Worker[] = [];

export interface JobAttemptInfo {
  attemptsMade: number;     // 1-indexed for the current run
  attemptsAllowed: number;  // total attempts BullMQ will make
}

// POOL-WAIT parameters (client 2026-07-07). A clip with no free browser account
// waits POOL_WAIT_INTERVAL_MS between re-checks, up to POOL_WAIT_MAX_CYCLES times,
// then flips to the API. The 30-min ceiling reuses HEYGEN_API_SWITCH_AFTER_MINUTES
// so all three "when to switch to API" numbers live in one place.
const POOL_WAIT_INTERVAL_MS = env.HEYGEN_POOL_WAIT_INTERVAL_SECONDS * 1000;
const POOL_WAIT_MAX_CYCLES = env.HEYGEN_POOL_WAIT_MAX_CYCLES;
const POOL_WAIT_MAX_MS = env.HEYGEN_API_SWITCH_AFTER_MINUTES * 60_000;

// Fields we stash on the avatar job's data across re-deliveries to implement the
// wait loop (BullMQ preserves job.data through moveToDelayed).
interface PoolWaitState {
  poolWaitCycles?: number; // how many times this clip has waited on a busy pool
  poolWaitStartMs?: number; // wall-clock (ms) of the FIRST wait, for the 30-min rule
  forceApi?: boolean; // set once threshold is crossed → generateAvatar goes API-only
}

/**
 * Handle a PoolBusyError (every account busy). Returns true if the job was
 * re-queued (either to wait again, or flipped to force-API) so the caller should
 * treat this run as "not a failure"; false if the clip has already been forced to
 * the API and STILL couldn't produce output — i.e. a genuine failure to surface.
 *
 * The wait threshold is OR'd, per the client rule: switch to the API once EITHER
 * POOL_WAIT_MAX_CYCLES wait cycles have elapsed OR 30 min has passed since the
 * clip first started waiting.
 */
async function handlePoolBusy(job: Job, name: string, token?: string): Promise<boolean> {
  const state = (job.data ?? {}) as PoolWaitState & Record<string, unknown>;

  // Without a processing token we cannot moveToDelayed — fail rather than crash the
  // worker loop. Should not happen (BullMQ supplies it), but guard defensively.
  if (!token) return false;

  // If we already forced the API on the previous run and are STILL here with a
  // PoolBusyError, the API path was unusable (flag off / not audio-driven) — stop
  // waiting and let it fail so the clip surfaces its error instead of looping.
  if (state.forceApi) return false;

  const now = Date.now();
  const startMs = state.poolWaitStartMs ?? now;
  const cycles = (state.poolWaitCycles ?? 0) + 1;
  const elapsedMs = now - startMs;

  const cyclesHit = POOL_WAIT_MAX_CYCLES > 0 && cycles >= POOL_WAIT_MAX_CYCLES;
  const timeHit = POOL_WAIT_MAX_MS > 0 && elapsedMs >= POOL_WAIT_MAX_MS;

  if (cyclesHit || timeHit) {
    // Threshold reached → flip the clip to the API on its NEXT run. Persist
    // forceApi + reset so generateAvatar skips the pool and renders via the API.
    await job.updateData({ ...state, forceApi: true, poolWaitCycles: cycles, poolWaitStartMs: startMs });
    console.log(JSON.stringify({
      ts: new Date().toISOString(), queue: name, jobId: job.id, msg: "avatar.pool_wait.switch_api",
      cycles, elapsedMinutes: Math.round(elapsedMs / 60_000),
      reason: cyclesHit ? `waited ${cycles} cycle(s) (>= ${POOL_WAIT_MAX_CYCLES})` : `waited ${Math.round(elapsedMs / 60_000)} min (>= ${env.HEYGEN_API_SWITCH_AFTER_MINUTES})`,
    }));
    // Re-run promptly (short delay) so the API attempt starts without another full
    // wait interval.
    await job.moveToDelayed(now + 1_000, token);
    throw new DelayedError();
  }

  // Under threshold → wait another interval and re-check the pool.
  await job.updateData({ ...state, poolWaitCycles: cycles, poolWaitStartMs: startMs });
  console.log(JSON.stringify({
    ts: new Date().toISOString(), queue: name, jobId: job.id, msg: "avatar.pool_wait.retry",
    cycles, waitSeconds: Math.round(POOL_WAIT_INTERVAL_MS / 1000), elapsedMinutes: Math.round(elapsedMs / 60_000),
  }));
  await job.moveToDelayed(now + POOL_WAIT_INTERVAL_MS, token);
  throw new DelayedError();
}

function startWorker<T>(
  name: string,
  handler: (data: T, attempt: JobAttemptInfo) => Promise<void>,
  c: number
): Worker {
  const w = new Worker<T>(name, async (job, token) => {
    const t0 = Date.now();
    const attempt: JobAttemptInfo = {
      attemptsMade: (job.attemptsMade ?? 0) + 1,
      attemptsAllowed: job.opts?.attempts ?? 1,
    };
    console.log(JSON.stringify({ ts: new Date().toISOString(), queue: name, jobId: job.id, msg: "job.start", attempt, data: job.data }));
    // LOCK RENEWAL (defence-in-depth). BullMQ auto-renews a job's lock at
    // lockDuration/2 from inside the worker, but that single renewal command can
    // be DROPPED when the Fly Redis proxy recycles the connection mid-flight
    // (the ~10-20 min ECONNRESET cycle this file's connection options fight). If
    // a renewal is lost and the next auto-renew is a full lockDuration/2 away,
    // the lock can lapse on a long (multi-render, ~30 min) avatar job — and the
    // stalled-job check then RE-DELIVERS the same job id, which re-renders an
    // already-finished avatar (the never-clearing-spinner bug). So we add our own
    // independent extendLock heartbeat on a TIGHTER interval: a single dropped
    // tick is recovered by the next one well before the lock expires.
    const renewMs = Math.floor(LOCK_DURATION_MS / 4);
    const renew = setInterval(() => {
      // job.extendLock(token, duration). The processing token the worker assigned
      // to this run lives on job.token; without it extendLock can't authenticate.
      const token = (job as { token?: string }).token;
      if (!token) return;
      // A failed tick is harmless — the next one (renewMs later) renews well
      // before the lock's full LOCK_DURATION_MS expiry.
      void job.extendLock(token, LOCK_DURATION_MS).catch(() => {});
    }, renewMs);
    try {
      await handler(job.data, attempt);
      console.log(JSON.stringify({ ts: new Date().toISOString(), queue: name, jobId: job.id, msg: "job.done", ms: Date.now() - t0 }));
    } catch (e) {
      // POOL CONTENTION WAIT (client 2026-07-07). A PoolBusyError means every
      // HeyGen account is BUSY rendering another clip — NOT that this clip failed.
      // Rather than burn a BullMQ attempt, RE-DELAY the job so the clip WAITS in
      // the queue for an account to free up (a browser render is ~150s, so one
      // usually frees within a wait cycle → the clip then renders on the cheap
      // browser path). Only after the client's threshold — POOL_WAIT_MAX_CYCLES
      // wait cycles OR HEYGEN_API_SWITCH_AFTER_MINUTES elapsed — do we flip the job
      // to force the API. moveToDelayed + DelayedError re-queues WITHOUT counting a
      // failed attempt, so pool contention never exhausts a clip's retries.
      if (isPoolBusyError(e)) {
        // handlePoolBusy either throws DelayedError (job re-queued to wait or to
        // force the API next run — BullMQ must see that error to honor the delay)
        // or returns false, meaning the API was already forced and still produced
        // nothing → fall through and fail the clip like any other error.
        await handlePoolBusy(job, name, token);
        // Returned without throwing → treat as a genuine failure below.
      }
      console.error(JSON.stringify({ ts: new Date().toISOString(), queue: name, jobId: job.id, msg: "job.failed", attempt, err: (e as Error).message, ms: Date.now() - t0 }));
      throw e;
    } finally {
      clearInterval(renew);
    }
  }, {
    connection: getRedisConnection(),
    concurrency: c,
    // Polling tuning — cuts idle Redis traffic ~5× without affecting job
    // pickup latency (the blocking pop wakes the instant a job arrives).
    // drainDelay: 30 is BullMQ's hard maximum.
    drainDelay: 30,
    // lockDuration must exceed the longest blocking subprocess we await.
    // The processor only heartbeats between awaits, so a single ffmpeg or
    // yt-dlp call that runs longer than lockDuration trips "stalled more
    // than allowable limit" and BullMQ re-queues the job.
    //
    // 25 minutes covers two stacked worst cases:
    //   - the render queue's final concat (100+ item timeline + voiceover + bg
    //     music in one ffmpeg pass), 8–12 min on shared-CPU Fly machines; and
    //   - an avatar job whose FIRST HeyGen render came back wrong-orientation
    //     (~11 min polled to the render budget) then rotated and rendered AGAIN
    //     (~11 min) — ~22 min on one job, which the old 15 min ceiling tripped
    //     into a stalled RE-DELIVERY that re-rendered an already-ready avatar.
    // The explicit extendLock heartbeat above is the primary guard; this ceiling
    // is the backstop. With ffmpeg's hard timeout at 240s and yt-dlp at 300s, the
    // smaller queues (clip/download/match/search) never approach this window.
    stalledInterval: LOCK_DURATION_MS,
    lockDuration: LOCK_DURATION_MS,
  });

  // Transient Redis disconnects (ECONNRESET, ETIMEDOUT) get auto-recovered
  // by ioredis; logging them as errors creates noise that looks like real
  // worker failures. Demote those to a single-line info log; everything else
  // still goes to stderr so it shows up in `fly logs` filters.
  w.on("error", (err) => {
    const m = (err as Error).message || "";
    const isTransient = /ECONNRESET|ETIMEDOUT|EPIPE|read ECONNRESET/i.test(m);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      queue: name,
      msg: isTransient ? "worker.redis_transient" : "worker.error",
      err: m,
    });
    if (isTransient) console.log(line); else console.error(line);
  });
  w.on("failed", (job, err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), queue: name, jobId: job?.id, msg: "job.failed.event", err: err.message }));
    // BullMQ has finished its own bookkeeping; if this was the LAST retry the
    // media_jobs row would otherwise be frozen at running/p=5 forever (the
    // processor body never reached its terminal write). Reconcile it to
    // failed so the UI's per-step aggregate can advance instead of hanging
    // the whole project on "Generate clips". jobId === mediaJobId by design.
    if (!job) return;
    void markJobFailedIfExhausted(
      job.id,
      (job.attemptsMade ?? 0) + 1,
      job.opts?.attempts ?? 1,
      err.message,
    ).catch((e) =>
      console.error(JSON.stringify({ ts: new Date().toISOString(), queue: name, jobId: job?.id, msg: "reconcile.failed_event.error", err: (e as Error).message })),
    );
  });
  return w;
}

// WORKER_ROLE selects which engine's queues this process serves, so the
// celebrity and AI-avatar engines can run on SEPARATE Fly machines (the avatar
// one can auto-stop when idle). 'all' (default) keeps the single-worker setup.
const role = env.WORKER_ROLE;
const runSourced = role === "all" || role === "sourced";
const runSynthetic = role === "all" || role === "synthetic";
console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "worker.role", role, runSourced, runSynthetic }));

if (runSourced) {
  workers.push(startWorker(QUEUE_NAMES.search,     processSearchJob,     1));
  workers.push(startWorker(QUEUE_NAMES.download,   processDownloadJob,   downloadConcurrency));
  workers.push(startWorker(QUEUE_NAMES.clip,       processClipJob,       concurrency));
  workers.push(startWorker(QUEUE_NAMES.match,      processMatchJob,      1));
  workers.push(startWorker(QUEUE_NAMES.render,     processRenderJob,     1));
  // script_clip jobs share the same proxy-rotated yt-dlp pipeline as the
  // source-pool downloads, so they tolerate the same level of parallelism.
  workers.push(startWorker(QUEUE_NAMES.scriptClip, processScriptClipJob, downloadConcurrency));
}

if (runSynthetic) {
  // --- synthetic engine queues (migration 0020). Separate workers + per-queue
  // concurrency so the synthetic pipeline never contends with the sourced one.
  // avatar stays at 1: each HeyGen browser session is heavy and account
  // rotation is serial. ---
  workers.push(startWorker(QUEUE_NAMES.tts,              processTtsJob,              env.TTS_CONCURRENCY));
  workers.push(startWorker(QUEUE_NAMES.syntheticPlanner, processSyntheticPlannerJob, env.SYNTHETIC_PLANNER_CONCURRENCY));
  workers.push(startWorker(QUEUE_NAMES.imageGeneration,  processImageGenJob,         env.IMAGE_GEN_CONCURRENCY));
  workers.push(startWorker(QUEUE_NAMES.imageToVideo,     processImageToVideoJob,     env.IMAGE_TO_VIDEO_CONCURRENCY));
  workers.push(startWorker(QUEUE_NAMES.avatar,           processAvatarJob,           env.AVATAR_CONCURRENCY));
  // Synthetic renders run HERE (on the avatar worker) rather than on the sourced
  // render slot, so an avatar render and a celebrity render proceed in parallel.
  // Concurrency 1: a render is a heavy multi-core FFmpeg job — one at a time per
  // machine (same as the sourced render slot). The processor is shared.
  workers.push(startWorker(QUEUE_NAMES.renderSynthetic,  processRenderJob,           1));
}

// Periodic stall sweeper — the safety net for the case where on("failed")
// never fires (hard OOM kill, Fly machine eviction). Any media_jobs row stuck
// running/queued past the lock window gets marked failed and the pipeline is
// re-advanced. The cutoff is lockDuration (15 min) + a 5 min margin so a job
// legitimately mid-await on a long ffmpeg/yt-dlp call is never swept — those
// only heartbeat updated_at between awaits.
const SWEEP_INTERVAL_MS = 5 * 60_000;
// Stall cutoff. Must exceed the longest gap a LIVE job can go without touching
// updated_at. The render's merge/concat stage is a sequence of long single
// ffmpeg passes (image xfades + the final whole-video concat); on a big
// project that whole stretch can run 20-30 min. The render processor now emits
// touchMediaJob() heartbeats around each of those passes, but we still keep a
// generous cutoff as defence-in-depth: 45 min comfortably covers the largest
// observed single pass while a truly-dead job is still cleaned up well before
// the BullMQ retry/visibility windows matter. (Was lockDuration + 5 min = 20
// min, which false-killed a slow-but-alive 430-clip render.)
const SWEEP_STALE_MS = 45 * 60_000; // 45 min
// Each worker sweeps ONLY the job types it processes, so an engine-scoped
// worker can't false-kill the other engine's in-flight jobs. 'all' passes
// undefined → sweeps everything (single-worker setup, unchanged).
const SOURCED_TYPES = ["search", "download", "clip", "match", "render", "script_clip", "analyze"];
// "render" is in BOTH lists: the media_jobs type is "render" regardless of which
// queue ran it, so the synthetic worker must sweep its own stalled renders too.
const SYNTHETIC_TYPES = ["tts", "plan_synthetic", "image_gen", "image_to_video", "avatar", "render"];
const sweepTypes =
  role === "sourced" ? SOURCED_TYPES : role === "synthetic" ? SYNTHETIC_TYPES : undefined;
const sweepTimer = setInterval(() => {
  void sweepStalledJobs(SWEEP_STALE_MS, sweepTypes)
    .then((n) => {
      if (n > 0) console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "reconcile.sweep.done", projectsAffected: n }));
    })
    .catch((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), msg: "reconcile.sweep.error", err: (e as Error).message })));
  // Render-cache reaping applies to ANY worker that runs renders. Both roles do
  // now: sourced renders celebrity videos, synthetic renders avatar videos on the
  // avatar worker's own /data volume — so each must reap its own stale cache.
  if (!runSourced && !runSynthetic) return;
  // Reap render-cache entries from abandoned/failed projects so the resume
  // cache doesn't grow unbounded on the /data volume. Live renders refresh
  // their dir mtime as they write clips, so this only removes stale orphans.
  void sweepRenderCache()
    .then((n) => {
      if (n > 0) console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "render_cache.sweep.done", removed: n }));
    })
    .catch((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), msg: "render_cache.sweep.error", err: (e as Error).message })));
}, SWEEP_INTERVAL_MS);
// Don't keep the process alive solely for the sweep timer.
sweepTimer.unref?.();

// Server-side HeyGen keep-alive. Refreshes the shared account pool's sessions
// on a slow timer so they don't lapse on HeyGen's idle TTL — the fix that keeps
// end users (who never touch a CLI) from hitting "no available accounts". Only
// the avatar/synthetic worker runs this (it's the host with browser automation
// and the one that owns HeyGen). A confirmed-expired session is flagged
// needs_reauth so the admin is alerted; transient blips don't penalize.
const KEEPALIVE_INTERVAL_MS = Math.max(5, env.HEYGEN_KEEPALIVE_MINUTES) * 60_000;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
if (runSynthetic) {
  // Kick once shortly after boot (don't wait a full interval), then on the timer.
  const runKeepAlive = () => {
    // Refresh only the IDLE accounts. Opening a second concurrent HeyGen browser
    // for an account that a render is using — from the same exit IP — is the
    // concurrent-session activity that trips Cloudflare into wiping the composer
    // page mid-job (observed: keepalive fired ~1min after boot, on top of a live
    // render, and the next jobs failed blank_composer).
    //
    // With a multi-account pool we can no longer just bail when ANY render is in
    // flight — that would starve the sweep whenever the pool is busy, and other
    // idle accounts still need their TTL kept warm. Instead we skip the exact SET
    // of in-use accounts, built from three independent signals so none can slip
    // through a timing gap:
    //   - claimedAccountIds(): the DB lease — authoritative "a job holds this
    //     account right now", set the instant claimAccount() runs (covers the gap
    //     before the warm browser is even built);
    //   - warmAccountIds(): accounts with a live warm browser in the pool;
    //   - activeAccountIds(): accounts with a render in flight this instant.
    void (async () => {
      const skip = new Set<string>([...warmAccountIds(), ...activeAccountIds()]);
      for (const id of await claimedAccountIds().catch(() => new Set<string>())) skip.add(id);
      return sweepKeepAlive({ skipAccountIds: skip });
    })()
      .then((r) => {
        if (r.refreshed + r.expired + r.errors > 0) {
          console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "heygen.keepalive.done", ...r }));
        }
      })
      .catch((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), msg: "heygen.keepalive.error", err: (e as Error).message })));
  };
  const kickoff = setTimeout(runKeepAlive, 60_000);
  kickoff.unref?.();
  keepAliveTimer = setInterval(runKeepAlive, KEEPALIVE_INTERVAL_MS);
  keepAliveTimer.unref?.();
}

async function shutdown(signal: string) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "worker.shutdown", signal }));
  clearInterval(sweepTimer);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  // Order matters: close workers first so they finish their current job and
  // stop polling, then close the Queue/QueueEvents objects, then quit the
  // shared Redis connection. Quitting Redis first would race in-flight
  // BullMQ commands and leave the AOF without a clean shutdown marker —
  // which is exactly what makes the next boot's replay window long.
  await Promise.all(workers.map((w) => w.close()));
  // Workers are now idle — tear down the warm HeyGen browser/context (kept alive
  // and reused across avatar jobs). Safe only after jobs stopped. Never throws.
  await closeWarmSession().catch(() => {});
  await closeAllQueues();
  await getRedisConnection().quit();
  process.exit(0);
}
process.on("SIGINT",  () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

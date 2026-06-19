/* eslint-disable no-console */
// Standalone BullMQ worker process. Run with `pnpm worker` (or `npm run worker`).
// Uses tsx for TS execution. Loads env from .env files via dotenv if present.

// Load env from .env.local first (Next.js convention), then fall back to .env.
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { Worker } from "bullmq";
import { QUEUE_NAMES, getRedisConnection, closeAllQueues } from "@/lib/jobs/queue";
import { getEnv } from "@/lib/env";

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
import { markJobFailedIfExhausted, sweepStalledJobs, sweepStalledSegments } from "./reconcile";
import { sweepRenderCache } from "./processors/renderCache";

const env = getEnv();
const concurrency = env.WORKER_CONCURRENCY;
const downloadConcurrency = env.DOWNLOAD_CONCURRENCY;

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

function startWorker<T>(
  name: string,
  handler: (data: T, attempt: JobAttemptInfo) => Promise<void>,
  c: number
): Worker {
  const w = new Worker<T>(name, async (job) => {
    const t0 = Date.now();
    const attempt: JobAttemptInfo = {
      attemptsMade: (job.attemptsMade ?? 0) + 1,
      attemptsAllowed: job.opts?.attempts ?? 1,
    };
    console.log(JSON.stringify({ ts: new Date().toISOString(), queue: name, jobId: job.id, msg: "job.start", attempt, data: job.data }));
    try {
      await handler(job.data, attempt);
      console.log(JSON.stringify({ ts: new Date().toISOString(), queue: name, jobId: job.id, msg: "job.done", ms: Date.now() - t0 }));
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), queue: name, jobId: job.id, msg: "job.failed", attempt, err: (e as Error).message, ms: Date.now() - t0 }));
      throw e;
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
    // 15 minutes covers the render queue's worst case: the final concat
    // re-encodes a 100+ item timeline plus voiceover + bg music in a
    // single ffmpeg call, which on shared-CPU Fly machines can take 8–12
    // minutes during which nothing else awaits. With ffmpeg's hard
    // timeout at 240s and yt-dlp at 300s, the smaller queues
    // (clip/download/match/search) never approach this lock window;
    // they just inherit the safer ceiling.
    stalledInterval: 900_000,
    lockDuration: 900_000,
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
const SYNTHETIC_TYPES = ["tts", "plan_synthetic", "image_gen", "image_to_video", "avatar"];
const sweepTypes =
  role === "sourced" ? SOURCED_TYPES : role === "synthetic" ? SYNTHETIC_TYPES : undefined;
// Orphaned-segment cutoff. A synthetic_segments row stuck "generating" past
// this is treated as dead and flipped to "failed" so the UI shows a retryable
// failure instead of an endless spinner. Must exceed the longest legit quiet
// window during a real avatar generation (HeyGen render timeout ~10 min + the
// per-step nav timeouts) plus margin. 25 min is safely past a healthy run.
const SEGMENT_STALE_MS = 25 * 60_000; // 25 min
const sweepTimer = setInterval(() => {
  void sweepStalledJobs(SWEEP_STALE_MS, sweepTypes)
    .then((n) => {
      if (n > 0) console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "reconcile.sweep.done", projectsAffected: n }));
    })
    .catch((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), msg: "reconcile.sweep.error", err: (e as Error).message })));
  // Synthetic workers also sweep orphaned "generating" segments (stuck spinners).
  if (runSynthetic) {
    void sweepStalledSegments(SEGMENT_STALE_MS)
      .then((n) => {
        if (n > 0) console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "reconcile.segment_sweep.done", projectsAffected: n }));
      })
      .catch((e) => console.error(JSON.stringify({ ts: new Date().toISOString(), msg: "reconcile.segment_sweep.error", err: (e as Error).message })));
  }
  // Render-cache reaping only applies to the render worker (sourced/all); the
  // avatar worker has no /data render cache.
  if (!runSourced) return;
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

async function shutdown(signal: string) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "worker.shutdown", signal }));
  clearInterval(sweepTimer);
  // Order matters: close workers first so they finish their current job and
  // stop polling, then close the Queue/QueueEvents objects, then quit the
  // shared Redis connection. Quitting Redis first would race in-flight
  // BullMQ commands and leave the AOF without a clean shutdown marker —
  // which is exactly what makes the next boot's replay window long.
  await Promise.all(workers.map((w) => w.close()));
  await closeAllQueues();
  await getRedisConnection().quit();
  process.exit(0);
}
process.on("SIGINT",  () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

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
  w.on("failed", (job, err) => console.error(JSON.stringify({ ts: new Date().toISOString(), queue: name, jobId: job?.id, msg: "job.failed.event", err: err.message })));
  return w;
}

workers.push(startWorker(QUEUE_NAMES.search,     processSearchJob,     1));
workers.push(startWorker(QUEUE_NAMES.download,   processDownloadJob,   downloadConcurrency));
workers.push(startWorker(QUEUE_NAMES.clip,       processClipJob,       concurrency));
workers.push(startWorker(QUEUE_NAMES.match,      processMatchJob,      1));
workers.push(startWorker(QUEUE_NAMES.render,     processRenderJob,     1));
// script_clip jobs share the same proxy-rotated yt-dlp pipeline as the
// source-pool downloads, so they tolerate the same level of parallelism.
// downloadConcurrency keeps the marker batch from saturating residential
// proxies during a heavy ingest of a script-doc with many title cards.
workers.push(startWorker(QUEUE_NAMES.scriptClip, processScriptClipJob, downloadConcurrency));

async function shutdown(signal: string) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "worker.shutdown", signal }));
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

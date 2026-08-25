import { Queue, QueueEvents } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { getEnv } from "@/lib/env";

export const QUEUE_NAMES = {
  search: "video-automation-search",
  download: "video-automation-download",
  clip: "video-automation-clip",
  match: "video-automation-match",
  render: "video-automation-render",
  // Synthetic (AI-avatar) renders run on a SEPARATE queue from the sourced
  // render queue so the avatar worker can serve them on its own machine. This
  // lets a celebrity render and an avatar render run AT THE SAME TIME instead of
  // queuing behind the celebrity worker's single render slot. Same payload +
  // same processor (processRenderJob) — only the queue (and thus the consuming
  // machine) differs. Routed by engine in enqueueRender.
  renderSynthetic: "video-automation-render-synthetic",
  // One job per script-doc marker that has a youtube_url. Runs in parallel
  // because each marker is independent (different sources, no shared
  // local-state). Lives on its own queue rather than reusing `download` so
  // bursts of script_clip jobs from a doc with many title cards don't
  // starve the source-pool downloads the matcher depends on.
  scriptClip: "video-automation-script-clip",
  // --- synthetic engine queues (migration 0020). Separate from the sourced
  // queues so the two engines never contend for the same workers and the
  // sourced pipeline's behaviour is unchanged. ---
  tts:              "video-automation-tts",
  syntheticPlanner: "video-automation-synthetic-planner",
  imageGeneration:  "video-automation-image-generation",
  imageToVideo:     "video-automation-image-to-video",
  avatar:           "video-automation-avatar",
  // AI-generated sales-pitch video (migration 0026). Its own queue so a pitch
  // build (which drives a browser + a HeyGen render) runs alongside the main
  // asset fan-out on the avatar worker without contending for the avatar slot.
  pitchGen:         "video-automation-pitch-gen",
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface SearchJobData    { projectId: string; mediaJobId: string; }
export interface DownloadJobData  { projectId: string; mediaJobId: string; youtubeVideoId: string; youtubeUrl: string; title?: string | null; }
export interface ClipJobData      { projectId: string; mediaJobId: string; videoSourceId: string; }
export interface MatchJobData     { projectId: string; mediaJobId: string; }
export interface RenderJobData    { projectId: string; mediaJobId: string; renderJobId: string; }
// One job per script-doc marker that has a youtube_url. The processor
// looks up the marker row by markerId to read its URL + window + kind so
// the queued payload stays small (no need to re-pickle URLs on retry).
export interface ScriptClipJobData { projectId: string; mediaJobId: string; markerId: string; }

// --- synthetic engine job payloads ---
// Each stays small: the processor re-reads the project / segment row by id, so
// retries never depend on stale data pickled into the queue payload.
// voiceoverOnly: regenerate JUST the master voiceover + realignment and STOP —
// do NOT enqueue the planner (which would wipe + rebuild synthetic_segments).
// Used by the "Regenerate voiceover" action on a project whose assets are
// already generated (e.g. to replace a corrupted 69labs voiceover) so the 200+
// existing images/clips/avatars are preserved.
export interface TtsJobData              { projectId: string; mediaJobId: string; voiceoverOnly?: boolean; }
export interface SyntheticPlannerJobData { projectId: string; mediaJobId: string; }
// One job per synthetic_segments row. segmentId is the unit of work; the
// processor reads its block_type, prompts and timings from the row.
export interface ImageGenerationJobData  { projectId: string; mediaJobId: string; segmentId: string; }
export interface ImageToVideoJobData     { projectId: string; mediaJobId: string; segmentId: string; }
// imageOnly: for a split_2 block, regenerate ONLY the right-half image and KEEP
// the existing avatar video (no HeyGen re-render). Used by "Regenerate image"
// and the bulk "images" scope so re-testing image prompts never re-renders the
// (slow, costly) avatar. Ignored for non-split_2 blocks.
// forceApi + poolWait* are set by the avatar worker across re-deliveries while a
// clip WAITS for a free HeyGen account (pool contention); see worker/index.ts
// handlePoolBusy. forceApi tells generateAvatar to skip the browser pool and
// render via the HeyGen API once the wait threshold is crossed.
export interface AvatarJobData           { projectId: string; mediaJobId: string; segmentId: string; imageOnly?: boolean; forceApi?: boolean; poolWaitCycles?: number; poolWaitStartMs?: number; }
// AI-generated sales-pitch video (standalone Sales Pitch tool, migration 0029).
// Keyed by a pitch_videos row id (NOT a project). Small payload: the processor
// re-reads all inputs off the pitch_videos row, so a retry never depends on
// stale data pickled here.
export interface PitchGenJobData         { pitchVideoId: string; }

// Idle BullMQ workers sit on a long blocking BRPOP. Two distinct teardown
// causes, depending on how a process reaches Redis:
//   * COLOCATED (celebrity worker → localhost): idle TCP sockets get torn down
//     by the network layer after a few minutes. keepAlive every 30s prevents it.
//   * PUBLIC PROXY (avatar worker is a SEPARATE Fly app, and the Vercel app):
//     these reach Redis at video-automation-worker.fly.dev:6379 THROUGH Fly's
//     edge proxy, which forcibly RECYCLES long-lived connections every ~10-20
//     min ("Fly Proxy process shutting down" → read ECONNRESET). keepAlive can't
//     stop this — the proxy drops it regardless. The fix is to RECOVER FAST:
//     treat ECONNRESET/EPIPE as immediately retryable and reconnect without a
//     ready-check stall, so a recycled connection is back in milliseconds rather
//     than seconds. Otherwise the worker spends its time reconnecting (6 queue
//     connections all storming) instead of pulling jobs.
const REDIS_BASE_OPTIONS = {
  maxRetriesPerRequest: null, // BullMQ requirement on shared connections.
  // Skip the post-connect INFO round-trip. With a flaky proxy that ready-check
  // is an extra RTT that can itself fail mid-handshake, stretching recovery.
  enableReadyCheck: false,
  keepAlive: 30_000,
  // Keep the connect attempt itself snappy so a recycled socket fails fast and
  // retries fast rather than hanging on a dead proxy handle.
  connectTimeout: 10_000,
  // Tight reconnect backoff: 50ms → cap 1s. Proxy recycles are frequent, so we
  // want the worker back on Redis almost immediately, not on a multi-second ramp.
  retryStrategy: (times: number) => Math.min(times * 50, 1000),
  // Reconnect immediately on the errors the Fly proxy produces when it recycles
  // a connection (ECONNRESET / EPIPE / "Connection is closed"), plus the boot
  // AOF-replay (LOADING) and failover (READONLY) cases. Returning 2 also
  // RESENDS the in-flight command on the new connection so a BRPOP that died
  // mid-recycle doesn't silently drop.
  reconnectOnError: (err: Error) =>
    /READONLY|LOADING|ECONNRESET|EPIPE|Connection is closed|ETIMEDOUT/i.test(err.message) ? 2 : false,
} as const;

// Managed Redis (Upstash / Fly Redis) uses rediss:// (TLS). ioredis auto-enables
// TLS from the rediss:// scheme, but we pass an explicit tls block so SNI is set
// from the host — some managed providers reject TLS without it. For plain
// redis:// (the self-hosted box) this stays undefined and nothing changes.
function tlsOptions(url: string): { tls?: { servername?: string } } {
  if (!/^rediss:\/\//i.test(url)) return {};
  try {
    return { tls: { servername: new URL(url).hostname } };
  } catch {
    return { tls: {} };
  }
}

let connection: Redis | null = null;
export function getRedisConnection(): Redis {
  if (connection) return connection;
  const url = getEnv().REDIS_URL;
  connection = new IORedis(url, { ...REDIS_BASE_OPTIONS, ...tlsOptions(url) });
  return connection;
}

// One-off clients for ad-hoc Redis ops (e.g. health pings).
export function newRedisClient(): Redis {
  const url = getEnv().REDIS_URL;
  return new IORedis(url, { ...REDIS_BASE_OPTIONS, ...tlsOptions(url) });
}

const queues = new Map<QueueName, Queue>();
export function getQueue<T = unknown>(name: QueueName): Queue<T> {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 200, age: 3600 * 24 * 3 },
        removeOnFail: { count: 200, age: 3600 * 24 * 7 },
      },
    });
    queues.set(name, q);
  }
  return q as Queue<T>;
}

const events = new Map<QueueName, QueueEvents>();
export function getQueueEvents(name: QueueName): QueueEvents {
  let e = events.get(name);
  if (!e) {
    e = new QueueEvents(name, { connection: getRedisConnection() });
    events.set(name, e);
  }
  return e;
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all([
    ...Array.from(queues.values()).map((q) => q.close()),
    ...Array.from(events.values()).map((e) => e.close()),
  ]);
  queues.clear();
  events.clear();
}

// Convenience enqueue helpers
export async function enqueueSearch(data: SearchJobData) {
  return getQueue<SearchJobData>(QUEUE_NAMES.search).add("search", data, { jobId: data.mediaJobId });
}
export async function enqueueDownload(data: DownloadJobData) {
  return getQueue<DownloadJobData>(QUEUE_NAMES.download).add("download", data, { jobId: data.mediaJobId });
}
export async function enqueueClip(data: ClipJobData) {
  return getQueue<ClipJobData>(QUEUE_NAMES.clip).add("clip", data, { jobId: data.mediaJobId });
}
export async function enqueueMatch(data: MatchJobData) {
  return getQueue<MatchJobData>(QUEUE_NAMES.match).add("match", data, { jobId: data.mediaJobId });
}
// `synthetic: true` routes the render to the synthetic render queue, which the
// avatar worker serves on its own machine — so an avatar render runs in parallel
// with a celebrity render instead of waiting behind the sourced render slot. The
// payload and processor are identical; only the target queue differs. Defaults
// to the sourced queue when omitted (the caller passes project.engine).
export async function enqueueRender(data: RenderJobData, opts?: { synthetic?: boolean }) {
  const queue = opts?.synthetic ? QUEUE_NAMES.renderSynthetic : QUEUE_NAMES.render;
  return getQueue<RenderJobData>(queue).add("render", data, { jobId: data.mediaJobId });
}
export async function enqueueScriptClip(data: ScriptClipJobData) {
  return getQueue<ScriptClipJobData>(QUEUE_NAMES.scriptClip).add("script_clip", data, { jobId: data.mediaJobId });
}

// --- synthetic engine enqueue helpers ---
// jobId === mediaJobId throughout (same invariant as the sourced queues): it
// dedupes accidental double-enqueues and lets reconcile.ts map a BullMQ job id
// straight back to its media_jobs row. Each synthetic asset job owns its own
// media_job, so segment-level jobs are still uniquely keyed.
export async function enqueueTts(data: TtsJobData) {
  return getQueue<TtsJobData>(QUEUE_NAMES.tts).add("tts", data, { jobId: data.mediaJobId });
}

// Drop a job from Redis given its media_job id (jobId === mediaJobId). Marking
// the Postgres row 'failed' does NOT stop the queued/retrying BullMQ job — it
// keeps running and, for TTS, submits the same text+voice to 69labs as the
// replacement job, so one of the two dies on a 409 DUPLICATE_TTS_IN_PROGRESS.
// Callers that supersede a job must remove it here as well. Best-effort: a job
// that is already gone, or currently ACTIVE (BullMQ refuses to remove a locked
// job), is not an error — the processor's superseded-row guard catches that
// case on its next attempt.
export async function removeQueuedJob(queue: keyof typeof QUEUE_NAMES, mediaJobId: string): Promise<boolean> {
  try {
    const job = await getQueue(QUEUE_NAMES[queue]).getJob(mediaJobId);
    if (!job) return false;
    await job.remove();
    return true;
  } catch {
    return false;
  }
}
export async function enqueueSyntheticPlanner(data: SyntheticPlannerJobData) {
  return getQueue<SyntheticPlannerJobData>(QUEUE_NAMES.syntheticPlanner).add("plan_synthetic", data, { jobId: data.mediaJobId });
}
export async function enqueueImageGeneration(data: ImageGenerationJobData) {
  return getQueue<ImageGenerationJobData>(QUEUE_NAMES.imageGeneration).add("image_gen", data, { jobId: data.mediaJobId });
}
// BullMQ priority bounds. Lower value = served earlier; 0 means "unprioritized"
// and lands in the plain wait LIST instead of the prioritized ZSET.
const BULLMQ_MAX_PRIORITY = 2 ** 21 - 1;
// Minute zero for the clip-queue priority scale. Only the DIFFERENCE matters,
// so any fixed past instant works; this one keeps the numbers inside the
// 2^21 ceiling until ~2030, when the scale needs re-basing (clamped below, so
// the failure mode past that date is "everything ties at 1", not a crash).
const PRIORITY_EPOCH_MS = Date.UTC(2026, 0, 1);

// Clip-queue priority, ordered by DISPATCH RECENCY — the most recently
// enqueued work is served first.
//
// The clip queue is one FIFO shared by every project, so blocks you dispatch
// now sit behind every block of every project queued before them: hundreds of
// jobs and many hours, most of it for videos already abandoned or left
// half-done. Priority puts the work you just asked for at the front.
//
// Recency of DISPATCH, not of the project row. Ranking by project created_at
// was the obvious first guess and it is wrong: a video created yesterday that
// you came back to today is the one you are waiting on, yet it sorts behind a
// project created this morning and abandoned an hour later. When a batch was
// dispatched is what actually tracks attention. It also needs no project
// lookup — the caller is dispatching right now, so the default argument is
// already the right answer.
//
// TRADEOFF, deliberate: strict recency, NOT round-robin fairness. A project
// that keeps losing to newer dispatches can starve indefinitely. That is right
// while your attention is on the current video, but an old backlog only drains
// once new work stops. Re-dispatching a stalled project (Retry all) re-stamps
// it as recent and pulls it back to the front, which is the intended escape.
//
// IMPORTANT: a priority is only honoured against OTHER prioritized jobs.
// moveToActive drains the unprioritized wait list FIRST and consults the
// prioritized set only when wait is empty, so a job enqueued with a priority
// goes BEHIND any already-waiting unprioritized job. An existing backlog must
// be migrated with scripts/prioritize-clip-queue.ts or this ranks nothing.
export function queuePriority(dispatchedAt: string | Date = new Date()): number {
  const ms = new Date(dispatchedAt).getTime();
  if (!Number.isFinite(ms)) return BULLMQ_MAX_PRIORITY; // unknown time sorts last
  const minutes = Math.floor((ms - PRIORITY_EPOCH_MS) / 60_000);
  // Invert: a LATER dispatch yields a SMALLER number, i.e. higher priority.
  return Math.min(BULLMQ_MAX_PRIORITY, Math.max(1, BULLMQ_MAX_PRIORITY - minutes));
}

export async function enqueueImageToVideo(
  data: ImageToVideoJobData,
  opts: { priority?: number } = {},
) {
  return getQueue<ImageToVideoJobData>(QUEUE_NAMES.imageToVideo).add("image_to_video", data, {
    jobId: data.mediaJobId,
    // Omitted rather than passed as 0: an explicit 0 is BullMQ's "no priority"
    // and would drop the job into the wait list, ahead of every prioritized one.
    ...(opts.priority ? { priority: opts.priority } : {}),
  });
}
export async function enqueueAvatar(data: AvatarJobData) {
  return getQueue<AvatarJobData>(QUEUE_NAMES.avatar).add("avatar", data, { jobId: data.mediaJobId });
}
export async function enqueuePitchGen(data: PitchGenJobData) {
  // jobId = the pitch_videos row id (the standalone tool has no media_job): it
  // dedupes double-enqueues and maps a BullMQ job straight back to its row.
  return getQueue<PitchGenJobData>(QUEUE_NAMES.pitchGen).add("pitch_gen", data, { jobId: data.pitchVideoId });
}

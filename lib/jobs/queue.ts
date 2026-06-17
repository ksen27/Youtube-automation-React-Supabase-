import { Queue, QueueEvents } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { getEnv } from "@/lib/env";

export const QUEUE_NAMES = {
  search: "video-automation-search",
  download: "video-automation-download",
  clip: "video-automation-clip",
  match: "video-automation-match",
  render: "video-automation-render",
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
export interface TtsJobData              { projectId: string; mediaJobId: string; }
export interface SyntheticPlannerJobData { projectId: string; mediaJobId: string; }
// One job per synthetic_segments row. segmentId is the unit of work; the
// processor reads its block_type, prompts and timings from the row.
export interface ImageGenerationJobData  { projectId: string; mediaJobId: string; segmentId: string; }
export interface ImageToVideoJobData     { projectId: string; mediaJobId: string; segmentId: string; }
export interface AvatarJobData           { projectId: string; mediaJobId: string; segmentId: string; }

// Idle BullMQ workers sit on a long blocking BRPOP. On Fly, idle TCP sockets
// to the colocated Redis get torn down by the network layer after a few
// minutes — surfacing as intermittent "read ECONNRESET" worker.error logs
// even though ioredis silently reconnects. Enabling TCP keepalive every 30s
// keeps the socket warm so the disconnect never happens.
const REDIS_BASE_OPTIONS = {
  maxRetriesPerRequest: null, // BullMQ requirement on shared connections.
  enableReadyCheck: true,
  keepAlive: 30_000,
  // Cap reconnect backoff at 2s. Default ramps to 2s after ~10 tries anyway;
  // setting it explicitly means a Fly deploy / machine restart gets workers
  // back on Redis within seconds of it being reachable, rather than waiting
  // out the default cold-start ramp.
  retryStrategy: (times: number) => Math.min(times * 100, 2000),
  // Force a fresh connection when Redis answers but rejects commands —
  // happens during the AOF-replay window on boot (LOADING) and during a
  // failover (READONLY). ioredis would otherwise hold the broken socket
  // until the next command attempt, surfacing as a stuck worker.
  reconnectOnError: (err: Error) => /READONLY|LOADING/.test(err.message),
} as const;

let connection: Redis | null = null;
export function getRedisConnection(): Redis {
  if (connection) return connection;
  connection = new IORedis(getEnv().REDIS_URL, REDIS_BASE_OPTIONS);
  return connection;
}

// One-off clients for ad-hoc Redis ops (e.g. health pings).
export function newRedisClient(): Redis {
  return new IORedis(getEnv().REDIS_URL, REDIS_BASE_OPTIONS);
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
export async function enqueueRender(data: RenderJobData) {
  return getQueue<RenderJobData>(QUEUE_NAMES.render).add("render", data, { jobId: data.mediaJobId });
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
export async function enqueueSyntheticPlanner(data: SyntheticPlannerJobData) {
  return getQueue<SyntheticPlannerJobData>(QUEUE_NAMES.syntheticPlanner).add("plan_synthetic", data, { jobId: data.mediaJobId });
}
export async function enqueueImageGeneration(data: ImageGenerationJobData) {
  return getQueue<ImageGenerationJobData>(QUEUE_NAMES.imageGeneration).add("image_gen", data, { jobId: data.mediaJobId });
}
export async function enqueueImageToVideo(data: ImageToVideoJobData) {
  return getQueue<ImageToVideoJobData>(QUEUE_NAMES.imageToVideo).add("image_to_video", data, { jobId: data.mediaJobId });
}
export async function enqueueAvatar(data: AvatarJobData) {
  return getQueue<AvatarJobData>(QUEUE_NAMES.avatar).add("avatar", data, { jobId: data.mediaJobId });
}

import { Queue, QueueEvents } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { getEnv } from "@/lib/env";

export const QUEUE_NAMES = {
  search: "video-automation-search",
  download: "video-automation-download",
  clip: "video-automation-clip",
  match: "video-automation-match",
  render: "video-automation-render",
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface SearchJobData    { projectId: string; mediaJobId: string; }
export interface DownloadJobData  { projectId: string; mediaJobId: string; youtubeVideoId: string; youtubeUrl: string; title?: string | null; }
export interface ClipJobData      { projectId: string; mediaJobId: string; videoSourceId: string; }
export interface MatchJobData     { projectId: string; mediaJobId: string; }
export interface RenderJobData    { projectId: string; mediaJobId: string; renderJobId: string; }

let connection: Redis | null = null;
export function getRedisConnection(): Redis {
  if (connection) return connection;
  // BullMQ requires { maxRetriesPerRequest: null } on the shared ioredis instance.
  connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

// One-off clients for ad-hoc Redis ops (e.g. health pings).
export function newRedisClient(): Redis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
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

import type { Worker } from "bullmq";
import { buildContainer, loadEnv } from "@ebook/config";
import { getRedisConnection } from "@/lib/jobs/queue";
import { buildWorkers } from "./processors";

/**
 * Boots the ebook-generator pipeline's 18 stage workers.
 *
 * Kept behind a function (rather than running at import time) so worker/index.ts
 * can import it lazily — a `sourced` or `synthetic` machine must never construct
 * this container, which requires ANTHROPIC_API_KEY / YOUTUBE_API_KEY and would
 * otherwise crash a process that has no business running books.
 *
 * The Redis connection is the app's SHARED one (lib/jobs/queue.ts), not a second
 * client — see packages/ebook-infra/queue/connection.ts for why that matters on
 * Fly's proxy.
 */
export async function buildEbookWorkers(): Promise<Worker[]> {
  const env = loadEnv();
  const container = buildContainer(env);
  const connection = getRedisConnection();
  return buildWorkers(connection, container);
}

import type { Redis } from 'ioredis';
import { getRedisConnection as getSharedConnection } from '@/lib/jobs/queue';

/**
 * Shared ioredis connection for BullMQ.
 *
 * PORT NOTE: upstream this built its own `new Redis(url, { maxRetriesPerRequest:
 * null })`. In this app it delegates to lib/jobs/queue.ts instead, so the ebook
 * queues ride the SAME tuned connection as the video engines. That matters — the
 * shared options carry production fixes a bare client does not have:
 *   * the avatar worker and Vercel reach Redis THROUGH Fly's edge proxy, which
 *     recycles long-lived connections every ~10-20 min; `reconnectOnError`
 *     returns 2 so an in-flight BRPOP is RESENT rather than silently dropped,
 *   * a 50ms→1s reconnect ramp and `enableReadyCheck: false` so a recycled
 *     socket is back in milliseconds,
 *   * explicit TLS SNI for rediss:// managed Redis.
 * Reintroducing a second, untuned connection here would drop ebook jobs on every
 * proxy recycle and add another connection to the storm.
 *
 * The `url` parameter is kept for signature compatibility with the upstream
 * callers but is IGNORED — the shared factory reads REDIS_URL from lib/env.ts,
 * which is the single source of truth for this app.
 */
export function getRedisConnection(_url?: string): Redis {
  return getSharedConnection();
}

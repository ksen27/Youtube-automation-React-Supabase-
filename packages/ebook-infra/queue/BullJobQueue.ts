import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobQueue, QueueName, EnqueueOptions } from '@ebook/core';
import { QUEUE_NAMES, QUEUE_CONFIG, redisQueueName } from './queues';

/**
 * BullMQ reserves `:` for its own Redis key namespacing and rejects any custom
 * job ID containing it ("Custom Id cannot contain :"). Our use cases build
 * deterministic, colon-delimited IDs for dedup; collapse `:` to `-` at this
 * single boundary so the IDs stay deterministic (same input → same ID, so dedup
 * is preserved) while satisfying BullMQ. Callers keep their readable `:`
 * convention, and the worker reads back this same value via `job.opts.jobId`,
 * keeping the idempotency ledger consistent.
 */
function toBullJobId(jobId: string): string {
  return jobId.replace(/:/g, '-');
}

/** BullMQ rejects priorities above 2^21-1; stay well inside that. */
const MAX_PRIORITY = 1_000_000;

/** Fair-share counters are per book run — drop them well after a run can finish. */
const FAIRNESS_TTL_SECONDS = 172_800; // 48h

/** BullMQ-backed implementation of the JobQueue port used by use cases. */
export class BullJobQueue implements JobQueue {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly redis: Redis) {
    for (const name of QUEUE_NAMES) {
      // Keyed by the DOMAIN name, constructed with the PREFIXED Redis name —
      // see redisQueueName() for why the two differ.
      this.queues.set(name, new Queue(redisQueueName(name), { connection: redis }));
    }
  }

  /**
   * Fair-share scheduling across concurrently-running books.
   *
   * BullMQ orders the prioritized set by (priority, insertion), so handing each
   * project's Nth job in a queue the priority N interleaves projects round-robin
   * instead of first-come-first-served. Without this, one book that fans out 50
   * video jobs (or 14 chapters) puts every one of them ahead of a book submitted
   * a second later, which then waits for the whole fan-out to drain.
   *
   * The counter is per (queue, project) so each stage starts a project back at 1
   * — a project can't accumulate a penalty across stages. If Redis hiccups we
   * fall back to plain FIFO rather than failing the enqueue.
   */
  private async fairPriority(queue: QueueName, projectId: string | undefined): Promise<number> {
    if (!projectId) return 1;
    // Namespaced away from the video engines' keys on this shared Redis.
    const key = `ebook:fair:${queue}:${projectId}`;
    try {
      const seq = await this.redis.incr(key);
      await this.redis.expire(key, FAIRNESS_TTL_SECONDS);
      return Math.min(seq, MAX_PRIORITY);
    } catch {
      return 1;
    }
  }

  async enqueue<T extends Record<string, unknown>>(
    queue: QueueName,
    payload: T,
    options: EnqueueOptions,
  ): Promise<void> {
    const q = this.queues.get(queue);
    if (!q) throw new Error(`Unknown queue: ${queue}`);
    const projectId = typeof payload.projectId === 'string' ? payload.projectId : undefined;
    await q.add(queue, payload, {
      jobId: toBullJobId(options.jobId), // deterministic → dedup (`:` → `-` for BullMQ)
      attempts: options.attempts ?? QUEUE_CONFIG[queue].attempts,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: false, // keep for dead-letter inspection / retry endpoint
      // Every job carries a priority so they all live in the prioritized set —
      // BullMQ drains the unprioritized wait list first, so mixing the two would
      // let any priority-less job jump the whole fair-share ordering.
      priority: await this.fairPriority(queue, projectId),
      ...(options.delayMs ? { delay: options.delayMs } : {}),
    });
  }

  async failedStages(projectId: string): Promise<QueueName[]> {
    const stages: QueueName[] = [];
    for (const [name, q] of this.queues) {
      const failed = await q.getFailed(0, 1000);
      if (failed.some((job) => job.data?.projectId === projectId)) stages.push(name);
    }
    return stages;
  }

  async retryFailed(projectId: string): Promise<number> {
    let retried = 0;
    for (const q of this.queues.values()) {
      const failed = await q.getFailed(0, 1000);
      for (const job of failed) {
        if (job.data?.projectId !== projectId) continue;
        await job.retry(); // moves the job back to waiting with its original payload
        retried += 1;
      }
    }
    return retried;
  }

  async drain(projectId: string): Promise<number> {
    let removed = 0;
    for (const q of this.queues.values()) {
      // Only not-yet-running states; active jobs are left to finish (then become no-ops).
      const pending = await q.getJobs(['waiting', 'delayed', 'paused', 'prioritized'], 0, 1000);
      for (const job of pending) {
        if (job.data?.projectId !== projectId) continue;
        await job.remove();
        removed += 1;
      }
    }
    return removed;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

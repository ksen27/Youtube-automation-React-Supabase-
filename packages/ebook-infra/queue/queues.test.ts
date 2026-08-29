import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES, QUEUE_CONFIG, queueRuntimeConfig, redisQueueName } from './queues';

/**
 * The regression these guard against cost a production 500.
 *
 * `QUEUE_NAMES` used to be written out by hand alongside QUEUE_CONFIG. Because
 * a `QueueName[]` annotation accepts a SUBSET of the union, three queues added
 * to the union and to QUEUE_CONFIG never reached the array — everything
 * type-checked, BullJobQueue registered no Queue for them, and the first
 * enqueue threw "Unknown queue" from a route running in production.
 *
 * The list is derived now, so these assert the property rather than the list.
 */
describe('queue registry', () => {
  it('registers a queue for every configured name', () => {
    expect([...QUEUE_NAMES].sort()).toEqual(Object.keys(QUEUE_CONFIG).sort());
  });

  it('has a runtime config for every registered queue', () => {
    for (const name of QUEUE_NAMES) {
      const config = queueRuntimeConfig(name);
      expect(config.concurrency, `${name} concurrency`).toBeGreaterThan(0);
      expect(config.attempts, `${name} attempts`).toBeGreaterThan(0);
    }
  });

  it('includes the reference and brief queues the upload path enqueues to', () => {
    // Named explicitly: these are the three that were missing, and the ones a
    // future hand-edit would be most likely to drop again.
    expect(QUEUE_NAMES).toContain('reference-ingest');
    expect(QUEUE_NAMES).toContain('reference-extract');
    expect(QUEUE_NAMES).toContain('book-brief');
  });

  it('namespaces every queue so it cannot collide with the video engines', () => {
    // The ebook queues share one Redis with the video products, where names like
    // `export` are a live hazard.
    for (const name of QUEUE_NAMES) {
      expect(redisQueueName(name)).toMatch(/^video-automation-ebook-/);
    }
  });
});

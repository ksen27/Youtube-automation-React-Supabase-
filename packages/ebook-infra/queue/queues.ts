import type { QueueName } from '@ebook/core';

export const QUEUE_NAMES: QueueName[] = [
  'channel-ingest',
  'video-data',
  'transcript-fetch',
  'whisper-transcribe',
  'video-summarize',
  'analyze-comments',
  'knowledge-base',
  'book-strategy',
  'outline-generate',
  'chapter-research',
  'chapter-generate',
  'polish-book',
  'polish-chapter',
  'extra-content',
  'ebook-assemble',
  'export',
  'landing-page',
  'landing-template',
  'checkout-product',
];

/**
 * Prefix applied to the BullMQ/Redis queue name — NOT to the domain `QueueName`.
 *
 * This app runs the video engines on the SAME Redis instance, where every queue
 * is already namespaced (`video-automation-search`, `video-automation-render`,
 * …; see lib/jobs/queue.ts). The ebook queues arrived bare, and names like
 * `export` are generic enough to be a live hazard in a shared instance.
 *
 * The prefix is applied at the BullMQ boundary ONLY — `redisQueueName()` is used
 * where a Queue/Worker/QueueEvents is constructed. The domain `QueueName` values
 * stay exactly as they were, because they are also the `job_runs.queue` ledger
 * key and appear in stored idempotency records; renaming those would orphan
 * every existing row and break `failedStages()` / retry.
 */
export const EBOOK_QUEUE_PREFIX = 'video-automation-ebook-';

/** Domain queue name → the Redis key BullMQ actually uses. */
export function redisQueueName(name: QueueName): string {
  return `${EBOOK_QUEUE_PREFIX}${name}`;
}

/** Per-queue worker settings — concurrency, rate limits, retry attempts. */
export interface QueueConfig {
  concurrency: number;
  attempts: number;
  limiter?: { max: number; duration: number };
}

export const QUEUE_CONFIG: Record<QueueName, QueueConfig> = {
  'channel-ingest': { concurrency: 5, attempts: 5 },
  'video-data': { concurrency: 10, attempts: 5 },
  // Parallel again: the proxy pool rotates a distinct starting IP per video, so
  // concurrent downloads spread across proxies instead of hammering one. Keep
  // concurrency <= the number of working proxies so each lands on its own IP.
  'transcript-fetch': { concurrency: 6, attempts: 4 },
  // Audio download + Whisper transcription, the slowest per-video stage. Bounded
  // by the Whisper API and worker CPU/network (not the Anthropic tier), so raised
  // modestly rather than to the chapter-queue levels.
  'whisper-transcribe': { concurrency: 4, attempts: 3 },
  // Per-video summary (Haiku — cheap, fast, high tier limits). Raised so a large
  // channel's videos summarize in parallel rather than draining at 50/min.
  'video-summarize': { concurrency: 16, attempts: 4, limiter: { max: 200, duration: 60_000 } },
  // Per-video comment analysis — fanned out one job per video; raised alongside
  // summarize so the per-video AI phase isn't the throughput floor on Tier 3+.
  'analyze-comments': { concurrency: 16, attempts: 4, limiter: { max: 150, duration: 60_000 } },
  // One call per book (concurrency parallelizes across projects, not within one),
  // so leave as-is — raising it wouldn't speed a single run.
  'knowledge-base': { concurrency: 4, attempts: 4 },
  'book-strategy': { concurrency: 4, attempts: 4 },
  'outline-generate': { concurrency: 4, attempts: 4 },
  // Per-chapter research (Sonnet) — raised alongside the chapter queues so a
  // whole book's research fans out at once on Tier 3+.
  'chapter-research': { concurrency: 16, attempts: 4, limiter: { max: 100, duration: 60_000 } },
  // Drafting runs on Sonnet (fast, high tier limits). Tier 3+: let all chapters
  // of a typical book draft at once so the stage collapses to ~one chapter's latency.
  'chapter-generate': { concurrency: 16, attempts: 3, limiter: { max: 100, duration: 60_000 } },
  // Controller only — fans out one polish-chapter job per chapter; no LLM call here.
  'polish-book': { concurrency: 4, attempts: 3 },
  // The actual per-chapter polishing LLM work (Opus) — parallelized, was a serial
  // loop. Limiter a touch lower than drafting since Opus tier limits are tighter.
  'polish-chapter': { concurrency: 16, attempts: 3, limiter: { max: 80, duration: 60_000 } },
  'extra-content': { concurrency: 3, attempts: 3, limiter: { max: 30, duration: 60_000 } },
  'ebook-assemble': { concurrency: 4, attempts: 3 },
  export: { concurrency: 3, attempts: 3 },
  // One Opus call plus a Netlify deploy, once per book. Two attempts only: the
  // failure modes here (bad checkout URL, missing Netlify token) are not the
  // kind that a retry fixes, and the book itself is already finished either way.
  'landing-page': { concurrency: 3, attempts: 2 },
  // One at a time: each run holds a Chromium instance with a full page and six
  // full-height screenshots in memory. Two attempts, because the common failure
  // is a slow template rather than an unusable one.
  'landing-template': { concurrency: 1, attempts: 2 },
  // Serial, and ONE attempt only.
  //
  // Serial because every run drives a logged-in browser against a single Payhip
  // account: two at once is a session two tabs are fighting over, and it looks
  // exactly like the automated abuse the account would be flagged for.
  //
  // One attempt because this queue CREATES something, and BullMQ cannot tell a
  // run that failed before publishing from one that failed after. A blind retry
  // of the latter lists the book on the store twice, which costs the seller a
  // duplicate product and a refund. The adapter retries internally where it can
  // still see which side of the publish it is on; past that boundary a human
  // decides.
  'checkout-product': { concurrency: 1, attempts: 1 },
};

/**
 * Scale factor applied to every queue's concurrency, via EBOOK_CONCURRENCY_SCALE.
 *
 * WHY (port note): the numbers above were tuned for DEDICATED worker pods on an
 * Anthropic Tier 3+ account, and sum to ~135 concurrent jobs. In this app the
 * ebook worker may share a machine with the video engines, whose entire pipeline
 * runs at ~13 (WORKER_CONCURRENCY 2, IMAGE_GEN 4, AVATAR 1, …). Booting 135
 * slots beside that would starve the renders it shares CPU, memory and network
 * with.
 *
 * Scaling — rather than rewriting the table — keeps the RATIOS the upstream
 * authors tuned (chapter fan-out wide, whisper narrow, landing-template serial)
 * while letting one env var fit the whole pipeline to the box it lands on. Every
 * queue keeps a floor of 1, so no stage is ever switched off by scaling.
 *
 * Default 0.25 → ~34 total, a reasonable co-tenant. Set it to 1 on a dedicated
 * ebook machine (WORKER_ROLE=ebook) to get the upstream throughput back.
 */
function concurrencyScale(): number {
  const raw = Number(process.env.EBOOK_CONCURRENCY_SCALE ?? '0.25');
  return Number.isFinite(raw) && raw > 0 ? raw : 0.25;
}

/**
 * The per-queue settings a worker should actually boot with — QUEUE_CONFIG with
 * the scale factor applied. Workers must use THIS, not QUEUE_CONFIG directly.
 */
export function queueRuntimeConfig(name: QueueName): QueueConfig {
  const base = QUEUE_CONFIG[name];
  return {
    ...base,
    concurrency: Math.max(1, Math.round(base.concurrency * concurrencyScale())),
  };
}

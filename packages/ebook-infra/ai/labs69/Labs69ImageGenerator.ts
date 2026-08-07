import { Result, type ImageGenerator, type GeneratedImage, type Logger } from '@ebook/core';
import type { ProxyRotator } from '../../net/ProxyRotator';

/** No-op logger so the adapter still works if constructed without one. */
const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NOOP_LOGGER;
  },
};

/**
 * Image generator backed by the 69labs API (default model "nano-banana-2";
 * overridable via LABS69_IMAGE_MODEL). Used ONLY for the in-chapter
 * illustrations; the cover uses OpenAI gpt-image-1.
 *
 * 69labs generation is asynchronous, so one call to `generate` runs the whole
 * job lifecycle behind the synchronous port:
 *   1. POST /api/v1/images/generate          → { id, queuePosition }
 *   2. poll GET /api/v1/images/status/:id     → until status === "COMPLETED"
 *   3. GET  /api/v1/images/download/:id        → 302 → presigned URL → raw bytes
 *
 * img-flux occasionally returns a TRANSIENT job failure ("This job failed to
 * complete. Please try again.") — a fresh, identical request then succeeds — so
 * a FAILED/ERROR job (and network/5xx blips) is retried a few times. Genuinely
 * non-retryable outcomes (CANCELLED, a 4xx like an invalid aspect ratio, or a
 * timeout) fail fast. After exhausting retries we return Result.fail and the
 * caller skips that one illustration (generation is best-effort).
 *
 * PROXY: 69labs fails jobs that originate from datacenter/cloud IPs (e.g. Railway)
 * — the request enqueues but the job ends FAILED. When a ProxyRotator is supplied,
 * each attempt's whole lifecycle (enqueue → poll → download) runs through the next
 * residential proxy in the pool, presenting a residential IP so the job completes.
 * A failed attempt retries on a different proxy.
 */
export class Labs69ImageGenerator implements ImageGenerator {
  private static readonly BASE = 'https://69labs.vip/api/v1/images';
  private static readonly MAX_ATTEMPTS = 3;

  constructor(
    private readonly apiKey: string,
    private readonly model = 'nano-banana-2',
    // Poll fairly tightly: img-flux finishes in ~10s, so a long interval would add
    // noticeable dead time after the image is already ready.
    private readonly pollIntervalMs = 1200,
    private readonly timeoutMs = 180_000,
    private readonly logger: Logger = NOOP_LOGGER,
    // When set, route requests through these residential proxies (rotated per
    // attempt) so 69labs sees a residential — not datacenter — origin IP.
    private readonly proxies?: ProxyRotator,
  ) {}

  static fromApiKey(apiKey: string, model?: string, logger?: Logger, proxies?: ProxyRotator): Labs69ImageGenerator {
    return new Labs69ImageGenerator(apiKey, model, undefined, undefined, logger ?? NOOP_LOGGER, proxies);
  }

  async generate(input: { prompt: string; size?: string }): Promise<Result<GeneratedImage>> {
    if (!this.apiKey) return Result.fail('LABS69_API_KEY is not configured');

    // One proxy-bound fetch per attempt, rotated, so a flagged IP is retried on a
    // different one. With no proxies configured this is just the direct fetch.
    const fetches = this.proxies?.orderedFetches() ?? [globalThis.fetch];

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= Labs69ImageGenerator.MAX_ATTEMPTS; attempt++) {
      const doFetch = fetches[(attempt - 1) % fetches.length]!;
      const outcome = await this.runOnce(input, attempt, doFetch);
      if (outcome.ok) return Result.ok(outcome.image);
      lastError = outcome.error;
      if (!outcome.retryable) {
        this.logger.debug('69labs: permanent failure, not retrying', { attempt, error: outcome.error });
        return Result.fail(outcome.error); // permanent — don't waste attempts
      }
      this.logger.warn('69labs: image attempt failed', { attempt, maxAttempts: Labs69ImageGenerator.MAX_ATTEMPTS, error: outcome.error });
      if (attempt < Labs69ImageGenerator.MAX_ATTEMPTS) await sleep(1000);
    }
    return Result.fail(`69labs failed after ${Labs69ImageGenerator.MAX_ATTEMPTS} attempts (last: ${lastError})`);
  }

  /** One full enqueue → poll → download cycle, classified as retryable or not. */
  private async runOnce(
    input: { prompt: string; size?: string },
    attempt: number,
    doFetch: typeof globalThis.fetch,
  ): Promise<{ ok: true; image: GeneratedImage } | { ok: false; retryable: boolean; error: string }> {
    const auth = { Authorization: `Bearer ${this.apiKey}` };
    const startedAt = Date.now();
    try {
      // 1) Enqueue the job.
      const body: Record<string, unknown> = { prompt: input.prompt, model: this.model };
      const aspectRatio = aspectRatioFor(input.size);
      if (aspectRatio) body.aspectRatio = aspectRatio;

      const enqueue = await doFetch(`${Labs69ImageGenerator.BASE}/generate`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!enqueue.ok) {
        // 5xx / 429 are transient; other 4xx (e.g. invalid aspect ratio) are permanent.
        const retryable = enqueue.status >= 500 || enqueue.status === 429;
        return { ok: false, retryable, error: `69labs generate ${enqueue.status}: ${(await safeText(enqueue)).slice(0, 300)}` };
      }
      const job = (await enqueue.json()) as { id?: string; queuePosition?: number };
      if (!job.id) return { ok: false, retryable: true, error: '69labs generate returned no job id' };
      this.logger.debug('69labs: job enqueued', { jobId: job.id, queuePosition: job.queuePosition, model: this.model, attempt });

      // 2) Poll until the job reaches a terminal state.
      const deadline = Date.now() + this.timeoutMs;
      let status = '';
      let format = 'png';
      while (Date.now() < deadline) {
        await sleep(this.pollIntervalMs);
        const res = await doFetch(`${Labs69ImageGenerator.BASE}/status/${job.id}`, { headers: auth });
        if (!res.ok) {
          // 5xx AND 429 are transient — the job is still running, we're just being
          // throttled or hitting a blip, so keep polling instead of abandoning a
          // job that's likely about to complete. For 429 honor Retry-After so we
          // back off the shared-key rate limit rather than hammering it.
          if (res.status >= 500) continue;
          if (res.status === 429) {
            await sleep(retryAfterMs(res) || this.pollIntervalMs);
            continue;
          }
          return { ok: false, retryable: false, error: `69labs status ${res.status}` };
        }
        const data = (await res.json()) as { status?: string; userMessage?: string; outputMetadata?: { format?: string } };
        status = (data.status ?? '').toUpperCase();
        if (data.outputMetadata?.format) format = data.outputMetadata.format;
        if (status === 'COMPLETED') break;
        // Transient provider failure → a fresh job usually succeeds, so retry it.
        // 69labs reports the real reason (content policy, billing, prompt rejection)
        // in `userMessage` — surface it so the failure isn't opaque in the logs.
        if (status === 'FAILED' || status === 'ERROR') {
          const reason = data.userMessage ? `: ${data.userMessage}` : '';
          return { ok: false, retryable: true, error: `69labs job ${status.toLowerCase()}${reason}` };
        }
        // Cancellation is intentional — never retry.
        if (status === 'CANCELLED' || status === 'CANCELED') return { ok: false, retryable: false, error: '69labs job cancelled' };
      }
      if (status !== 'COMPLETED') return { ok: false, retryable: false, error: '69labs job timed out' };

      // 3) Download the output. The endpoint 302-redirects to a presigned URL;
      // fetch follows it (and drops the bearer header cross-origin, which the
      // presigned URL doesn't need).
      const dl = await doFetch(`${Labs69ImageGenerator.BASE}/download/${job.id}`, { headers: auth, redirect: 'follow' });
      if (!dl.ok) return { ok: false, retryable: dl.status >= 500 || dl.status === 429, error: `69labs download ${dl.status}` };
      const bytes = new Uint8Array(await dl.arrayBuffer());
      this.logger.debug('69labs: job completed', { jobId: job.id, ms: Date.now() - startedAt, bytes: bytes.length });
      return { ok: true, image: { bytes, contentType: normalizeContentType(dl.headers.get('content-type'), format) } };
    } catch (e) {
      // Network/transport errors are transient → retryable.
      return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a `Retry-After` header (delta-seconds form) into ms; 0 if absent/unparseable. */
function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  if (!header) return 0;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Map a legacy "WxH" size hint to a 69labs aspect-ratio string. Illustrations
 * always request landscape (1536x1024 → 16:9), which every 69labs model we use
 * supports. NOTE: img-flux (Flux Schnell) ONLY accepts 16:9 among our ratios, so
 * if switching back to it, keep illustrations landscape or it rejects the request.
 */
function aspectRatioFor(size?: string): string | null {
  const m = size ? /^(\d+)x(\d+)$/.exec(size) : null;
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w > h) return '16:9'; // landscape (illustrations)
  if (h > w) return '9:16'; // portrait
  return '1:1';
}

/** Prefer the download's own content-type; fall back to the job's reported format. */
function normalizeContentType(header: string | null, format: string): string {
  if (header && header.startsWith('image/')) return header;
  const f = format.toLowerCase();
  return f === 'jpg' || f === 'jpeg' ? 'image/jpeg' : `image/${f || 'png'}`;
}

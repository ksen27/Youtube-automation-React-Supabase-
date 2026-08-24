import { getEnv } from "@/lib/env";
import { fetchOrThrow, withHttpRetry } from "@/lib/synthetic/http";
import { withAccountSlot } from "@/lib/synthetic/rate-limit";

// OpenAI direct — LAST-RESORT image fallback behind ai33.pro and 69labs.
//
// Client direction 2026-08-24: when both resellers are down, generate straight
// from OpenAI rather than failing the segment. The orchestration (chain order,
// failover) lives in lib/synthetic/sixtynine-labs.ts, same as the other two
// providers; this module is only the wire layer.
//
// WHY THIS IS NOT THE 2026-08-15 GEMINI/FAL MISTAKE. That chain was removed
// because it silently substituted FLUX, a DIFFERENT-LOOKING model, so a provider
// outage surfaced as an unexplained style regression instead of a failure.
// gpt-image-2 is available on the official API (verified 2026-08-24 against
// GET /v1/models: gpt-image-2, gpt-image-2-2026-04-21), which is precisely what
// makes this fallback safe — ai33 and 69labs are RESELLERS of this same model,
// so going direct changes the vendor and the price, not the picture. Keep
// OPENAI_IMAGE_MODEL pointed at whatever AI33_IMAGE_MODEL /
// SIXTYNINE_LABS_IMAGE_MODEL run; pointing it at a different family is what
// would re-create the old bug.
//
// Wire contract differs from BOTH resellers in a way that shapes this file:
// theirs are async task APIs (submit -> poll -> download a URL), this one is a
// SINGLE synchronous call that returns base64 in the response body. So there is
// no task id, and therefore no resume pointer — a timed-out generation here is
// simply lost, not resumable. That is why it sits LAST in the chain: it is the
// only provider that cannot recover a paid-for render across a retry.

const OPENAI_ACCOUNT_ID = "openai";

function cfg() {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured (openai image provider)");
  return {
    key: env.OPENAI_API_KEY,
    base: env.OPENAI_BASE_URL.replace(/\/$/, ""),
    model: env.OPENAI_IMAGE_MODEL,
    quality: env.OPENAI_IMAGE_QUALITY,
    size: env.OPENAI_IMAGE_SIZE,
    concurrency: env.OPENAI_IMAGE_CONCURRENCY,
    timeoutMs: env.OPENAI_IMAGE_TIMEOUT_SECONDS * 1000,
  };
}

/**
 * True when OpenAI is keyed AND enabled as a fallback. Unkeyed or disabled, it
 * drops out of the chain entirely and the behaviour is exactly as before it
 * existed — the same contract isAi33Configured() has.
 */
export function isOpenAiImageConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.OPENAI_API_KEY) && env.SYNTHETIC_IMAGE_OPENAI_FALLBACK;
}

export interface GenerateOpenAiImageOptions {
  model?: string;
  quality?: string;
  size?: string;
  // Wall clock for the one call, armed once the slot is held — queueing is not
  // charged to it, matching the ai33 / 69labs contract.
  generationTimeoutMs?: number;
  acquireTimeoutMs?: number;
}

interface OpenAiImageResponse {
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string; code?: string; type?: string };
}

/**
 * Generate one still. The prompt must ALREADY carry its style text — a drop-in
 * for generateAi33Image / generate69labsImage.
 */
export async function generateOpenAiImage(
  prompt: string,
  opts: GenerateOpenAiImageOptions = {},
): Promise<{ image: Buffer; contentType: string }> {
  const c = cfg();

  return await withAccountSlot(
    OPENAI_ACCOUNT_ID,
    c.concurrency,
    async () => {
      const ac = new AbortController();
      const ms = opts.generationTimeoutMs;
      const timer = ms
        ? setTimeout(
            () => ac.abort(new Error(`openai: image generation deadline exceeded after ${ms}ms`)),
            ms,
          )
        : undefined;
      timer?.unref?.();
      const signal = ms ? ac.signal : undefined;

      try {
        // Only ONE attempt beyond the first. Unlike the resellers there is no
        // task id to resume, so every retry here is a fresh BILLED render — the
        // reason this is 2 and not the 3-4 a free-to-retry API would justify.
        const res = await withHttpRetry(
          "openai.image.generate",
          () =>
            fetchOrThrow(`${c.base}/v1/images/generations`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${c.key}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: opts.model || c.model,
                prompt,
                size: opts.size || c.size,
                // NEVER omit. Leaving quality unset bills at the model default,
                // which is not the cheap end — the explicit client direction on
                // 2026-08-24 was lowest quality because this path is the
                // expensive one (no reseller margin, retail per-image price).
                quality: opts.quality || c.quality,
                n: 1,
              }),
              timeoutMs: c.timeoutMs,
              signal,
            }),
          { attempts: 2, baseMs: 2000, signal },
        );

        const parsed = (await res.json()) as OpenAiImageResponse;
        const b64 = parsed.data?.[0]?.b64_json;
        if (!b64) {
          // A moderation refusal arrives as a 400 that fetchOrThrow already
          // threw, so this is the "200 with nothing in it" case.
          throw new Error(
            `openai image: response carried no image data${
              parsed.error?.message ? ` (${parsed.error.message})` : ""
            }`,
          );
        }
        return { image: Buffer.from(b64, "base64"), contentType: "image/png" };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    { acquireTimeoutMs: opts.acquireTimeoutMs },
  );
}

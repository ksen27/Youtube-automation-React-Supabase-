import { GoogleGenAI } from "@google/genai";
import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { getEnv } from "@/lib/env";
import { getRedisConnection } from "@/lib/jobs/queue";

// Gemini text-to-image provider — the still-image FALLBACK used when the 69labs
// (nano-banana) pool is exhausted, in place of fal.ai FLUX.
//
// WHY Gemini instead of fal.ai: 69labs resells Google's "nano-banana" image
// model. Calling Gemini's own image model directly produces the SAME look as a
// 69labs still (fal.ai FLUX reads visibly different), so a fallback no longer
// changes the video's visual style — it just moves off the credit/slot-limited
// 69labs accounts onto Google billing. Drop-in for generateNanoBananaImage:
// prompt already carries the STYLE_PROMPT; returns the same shape.
//
// WHY the proxy: the Gemini IMAGE API is geo-restricted. From lhr (London,
// where the workers run) and the UK/EU generally it returns 400 "User location
// is not supported for the API use". So the request must egress through a proxy
// whose exit IP is in a supported region (US). We scope an undici ProxyAgent to
// JUST this call (the @google/genai SDK uses Node's global fetch and exposes no
// per-request dispatcher), then restore the previous global dispatcher so no
// other outbound traffic is affected.

export interface GenerateGeminiImageResult {
  image: Buffer;
  contentType: string;
  provider: "gemini_image";
}

// Gate: fallback runs on Gemini only when explicitly enabled AND a key is set.
// When off (or unkeyed), generateImage keeps the fal.ai fallback.
export function isGeminiImageConfigured(): boolean {
  const env = getEnv();
  return env.GEMINI_IMAGE_ENABLED && Boolean(env.GEMINI_API_KEY);
}

// Turn a single `ip:port:user:pass` entry into a proxy URL. Reuses the
// Webshare-style format the yt-dlp / HeyGen pools already use. Returns null when
// the entry is empty or malformed so the caller can decide (direct egress).
function proxyUrlFrom(entry: string | undefined): string | null {
  const line = entry?.trim();
  if (!line) return null;
  const [host, port, user, pass] = line.split(":");
  if (!host || !port) return null;
  if (user && pass) {
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return `http://${host}:${port}`;
}

// Resolve the proxy to route the image call through: GEMINI_IMAGE_PROXY if set,
// else the FIRST entry of YTDLP_PROXIES (only helps if those are US IPs). null =
// egress directly (only works when the worker itself is in a supported region).
function resolveProxyUrl(): string | null {
  const env = getEnv();
  const explicit = proxyUrlFrom(env.GEMINI_IMAGE_PROXY);
  if (explicit) return explicit;
  const firstPoolEntry = env.YTDLP_PROXIES?.split(/[\n,]/)[0];
  return proxyUrlFrom(firstPoolEntry);
}

// ---------------------------------------------------------------------------
// Monthly budget guard (client cost-control request, 2026-07-22). The Gemini
// fallback exists for OUTAGES of the 69labs pool; when 69labs runs out of
// credits for days, the fallback silently absorbs the ENTIRE image volume onto
// Google billing. The client asked for a hard ceiling (~300 images/month) with
// a warning, so a credit lapse can never again turn into an unbounded Gemini
// bill. Cluster-wide via the shared Redis; only successful generations consume
// budget (a failed call refunds its reservation).
// ---------------------------------------------------------------------------

function budgetKey(): string {
  // Calendar-month bucket, e.g. gemini_image:budget:2026-07.
  return `gemini_image:budget:${new Date().toISOString().slice(0, 7)}`;
}

export interface GeminiImageBudgetStatus {
  used: number;
  cap: number;
  // used >= 80% of the cap — surface an amber warning in the UI.
  warning: boolean;
  // Cap reached — the Gemini fallback now refuses; further 69labs-pool
  // failures fail the image instead of billing Google.
  exhausted: boolean;
}

// Read-only view of the month's fallback budget for the UI (dashboard banner).
// Null when Redis is unreachable or unconfigured (e.g. web app without
// REDIS_URL) — callers should render nothing rather than a wrong number. The
// short timeout keeps a slow Redis from delaying page render.
export async function getGeminiImageBudgetStatus(): Promise<GeminiImageBudgetStatus | null> {
  const cap = getEnv().GEMINI_IMAGE_MONTHLY_CAP;
  try {
    const redis = getRedisConnection();
    const raw = await Promise.race([
      redis.get(budgetKey()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("redis timeout")), 1500),
      ),
    ]);
    const used = Math.max(0, Number(raw ?? 0) || 0);
    return {
      used,
      cap,
      // cap = 0 means the operator deliberately disabled the fallback — that's
      // config, not an incident, so neither flag fires (no permanent banner).
      warning: cap > 0 && used >= Math.ceil(cap * 0.8),
      exhausted: cap > 0 && used >= cap,
    };
  } catch {
    return null;
  }
}

// Reserve one image from the monthly budget. Throws (blocking the fallback)
// when the cap is reached; logs loudly from 80% of the cap onward. Fails OPEN
// on a Redis error — if Redis is down the queue itself is down, so the guard
// rather than the pipeline should be the thing that degrades.
async function reserveGeminiImageBudget(cap: number): Promise<(() => Promise<void>) | null> {
  const key = budgetKey();
  let used: number;
  try {
    const redis = getRedisConnection();
    used = await redis.incr(key);
    // First reservation of the month creates the key; expire it well past the
    // month's end so stale buckets clean themselves up.
    if (used === 1) await redis.expire(key, 60 * 60 * 24 * 45);
    if (used > cap) {
      await redis.decr(key);
      console.error(JSON.stringify({
        msg: "gemini.image.budget_exhausted",
        cap,
        note: "monthly Gemini image fallback cap reached — falling through to fal.ai/error; top up 69labs credits or raise GEMINI_IMAGE_MONTHLY_CAP",
      }));
      throw new Error(
        `gemini image fallback: monthly cap reached (${cap} images) — top up 69labs credits or raise GEMINI_IMAGE_MONTHLY_CAP`,
      );
    }
    if (used >= Math.ceil(cap * 0.8)) {
      console.warn(JSON.stringify({
        msg: "gemini.image.budget_warning",
        used,
        cap,
        note: "approaching the monthly Gemini image fallback cap",
      }));
    }
  } catch (e) {
    if ((e as Error).message?.includes("monthly cap reached")) throw e;
    console.warn(JSON.stringify({
      msg: "gemini.image.budget_check_failed",
      note: "Redis unavailable; proceeding WITHOUT budget enforcement",
      err: (e as Error).message?.slice(0, 150),
    }));
    return null;
  }
  // Refund hook for the caller: a failed generation isn't billed by Google, so
  // it shouldn't consume budget either.
  return async () => {
    try {
      await getRedisConnection().decr(key);
    } catch {
      // Refund is best-effort; an unrefunded failure only makes the cap
      // slightly more conservative, never less safe.
    }
  };
}

/**
 * Generate a 16:9 still from a text prompt via Gemini's image model, egressing
 * through a supported-region proxy. Throws on any failure (unconfigured key, no
 * image part, safety block, geo-block) so the caller can surface the real
 * reason. The prompt should already carry the style prompt — this mirrors
 * 69labs' generateNanoBananaImage output.
 */
export async function generateGeminiImage(prompt: string): Promise<GenerateGeminiImageResult> {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured (gemini image fallback)");

  // Monthly cost guard: throws at the cap (caller falls through to fal.ai or
  // surfaces the 69labs error). The refund puts the reservation back if the
  // generation below fails — only billed successes consume budget.
  const refund = await reserveGeminiImageBudget(env.GEMINI_IMAGE_MONTHLY_CAP);

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  // Route ONLY this call through the proxy: swap the global undici dispatcher
  // for a ProxyAgent, then restore the prior one in finally so concurrent
  // outbound requests from other modules aren't affected. (The SDK offers no
  // per-request dispatcher hook, so a scoped global swap is the clean option.)
  const proxyUrl = resolveProxyUrl();
  const prevDispatcher = proxyUrl ? getGlobalDispatcher() : null;
  if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));

  try {
    const response = await ai.models.generateContent({
      model: env.GEMINI_IMAGE_MODEL,
      contents: prompt,
      config: {
        // Ask for image bytes back. Some image models also emit a text part
        // (a caption / refusal), so we scan every part for the image below.
        responseModalities: ["IMAGE"],
        // Match the synthetic canvas; the renderer crops/letterboxes anyway.
        imageConfig: { aspectRatio: "16:9" },
      },
    });

    // Read the first inline image part. Path:
    // candidates[0].content.parts[].inlineData ({ data: base64, mimeType }).
    // No image part is usually a safety block or text-only refusal — surface
    // the text so the log shows why.
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const inline = part.inlineData;
      if (inline?.data) {
        return {
          image: Buffer.from(inline.data, "base64"),
          contentType: inline.mimeType || "image/png",
          provider: "gemini_image",
        };
      }
    }

    const textPart = parts.map((p) => p.text).filter(Boolean).join(" ").slice(0, 200);
    const blockReason = response.promptFeedback?.blockReason;
    throw new Error(
      `gemini image: no image in response${blockReason ? ` (blocked: ${blockReason})` : ""}${
        textPart ? ` :: ${textPart}` : ""
      }`,
    );
  } catch (e) {
    // A failed call isn't billed — return its reservation to the monthly budget.
    if (refund) await refund();
    throw e;
  } finally {
    if (prevDispatcher) setGlobalDispatcher(prevDispatcher);
  }
}

import { GoogleGenAI } from "@google/genai";
import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { getEnv } from "@/lib/env";

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
  } finally {
    if (prevDispatcher) setGlobalDispatcher(prevDispatcher);
  }
}

import { GoogleGenAI } from "@google/genai";
import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { getEnv } from "@/lib/env";

// Prompt embeddings for the reusable asset library (migration 0030).
//
// Turns a clean semantic image/animation prompt into a 768-dim vector via
// Gemini's text-embedding model so lib/synthetic/asset-library.ts can run
// cosine nearest-neighbour matching in pgvector. Reuses GEMINI_API_KEY and the
// SAME supported-region proxy egress as the Gemini image fallback
// (lib/synthetic/gemini-image.ts) — Gemini API access is geo-restricted the
// same way from the lhr workers, and the @google/genai SDK exposes no
// per-request dispatcher, so we scope a global undici swap to just this call.
//
// Failure policy: embedding is a COST OPTIMIZATION, never a dependency. Every
// caller treats a null return as "no embedding available" and proceeds —
// lookups fall through to fresh generation, indexing stores the row without a
// vector (backfillable later). This module therefore returns null instead of
// throwing.

// Duplicated from gemini-image.ts deliberately (both are ~6 lines): turn a
// single `ip:port:user:pass` Webshare-style entry into a proxy URL.
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

// Resolve the proxy to route the embedding call through. ONLY an explicit
// GEMINI_IMAGE_PROXY (a supported-region, e.g. US, exit IP) is used — we do NOT
// fall back to the YTDLP_PROXIES pool the way gemini-image.ts does. Those are
// UK residential proxies tuned for yt-dlp; they cannot reach the geo-restricted
// Gemini API and their use here surfaced as "fetch failed / Request was
// cancelled" on every embedding. When GEMINI_IMAGE_PROXY is unset we egress
// DIRECTLY: that works from any supported region (local dev, a US worker). The
// lhr workers, where Gemini IS geo-blocked, must set GEMINI_IMAGE_PROXY to a US
// proxy (the same one the image fallback already needs there).
function resolveProxyUrl(): string | null {
  return proxyUrlFrom(getEnv().GEMINI_IMAGE_PROXY);
}

export function isEmbeddingConfigured(): boolean {
  return Boolean(getEnv().GEMINI_API_KEY);
}

/**
 * Embed a prompt into a vector of ASSET_LIBRARY_EMBED_DIMS floats. Returns
 * null on ANY failure (unconfigured key, geo-block, quota, malformed response)
 * so the asset-library caller degrades to generate-fresh / index-without-vector
 * instead of failing the segment.
 */
export async function embedPrompt(text: string): Promise<number[] | null> {
  const env = getEnv();
  const trimmed = text.trim();
  if (!env.GEMINI_API_KEY || !trimmed) return null;

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  // Scope the proxy to this call only (see gemini-image.ts for the rationale).
  const proxyUrl = resolveProxyUrl();
  const prevDispatcher = proxyUrl ? getGlobalDispatcher() : null;
  if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));

  try {
    const res = await ai.models.embedContent({
      model: env.ASSET_LIBRARY_EMBED_MODEL,
      contents: trimmed,
      config: {
        // Retrieval-style task: prompts are matched against stored prompts of
        // the same kind, so symmetric SEMANTIC_SIMILARITY is the right mode.
        taskType: "SEMANTIC_SIMILARITY",
        outputDimensionality: env.ASSET_LIBRARY_EMBED_DIMS,
      },
    });
    const values = res.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length !== env.ASSET_LIBRARY_EMBED_DIMS) {
      console.warn(JSON.stringify({
        msg: "asset_library.embed_bad_shape",
        got: Array.isArray(values) ? values.length : typeof values,
        want: env.ASSET_LIBRARY_EMBED_DIMS,
      }));
      return null;
    }
    return values;
  } catch (e) {
    console.warn(JSON.stringify({
      msg: "asset_library.embed_failed",
      err: (e as Error).message?.slice(0, 200),
    }));
    return null;
  } finally {
    if (prevDispatcher) setGlobalDispatcher(prevDispatcher);
  }
}

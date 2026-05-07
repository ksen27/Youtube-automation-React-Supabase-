// Wikipedia image fetcher. Free, no API key needed, no rate limits in
// practice. Best for named people, places, and well-known events — these
// usually have a Wikipedia page with an `originalimage` (the page's main
// photo, typically a portrait or location shot).
//
// Why this is the preferred first source:
//   - Public domain or Creative Commons by Wikipedia policy
//   - High-quality, often professionally shot
//   - No clickbait overlays, no watermarks
//   - Stable URLs (don't disappear like random web images)

import { getEnv } from "@/lib/env";

export interface WikipediaImageResult {
  url: string;
  width: number;
  height: number;
  pageUrl: string;
  pageTitle: string;
}

/**
 * Fetch the page summary for a query and return its main image if present.
 * Returns null when no page matches OR the page exists but has no image.
 */
export async function fetchWikipediaImage(query: string): Promise<WikipediaImageResult | null> {
  const env = getEnv();
  const timeoutMs = env.HTTP_DOWNLOAD_TIMEOUT_SECONDS * 1000;
  // Wikipedia REST API: /api/rest_v1/page/summary/{title} returns the page's
  // lead image as `originalimage`. URL-encoded query, spaces → underscores
  // for canonical title matching.
  const title = encodeURIComponent(query.trim().replace(/\s+/g, "_"));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "video-automation/1.0 (image-fetch)" },
    });
    if (!r.ok) return null;
    const json = await r.json() as {
      type?: string;
      originalimage?: { source?: string; width?: number; height?: number };
      content_urls?: { desktop?: { page?: string } };
      title?: string;
    };
    // Disambiguation pages don't have a useful image; skip them.
    if (json.type === "disambiguation") return null;
    const img = json.originalimage;
    if (!img?.source) return null;
    return {
      url: img.source,
      width: img.width ?? 0,
      height: img.height ?? 0,
      pageUrl: json.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${title}`,
      pageTitle: json.title ?? query,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

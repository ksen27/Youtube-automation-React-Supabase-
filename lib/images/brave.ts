// Brave Image Search fetcher. Requires:
//   BRAVE_SEARCH_API_KEY  — get one at https://api-dashboard.search.brave.com/
//
// Free tier: 1 query/sec, 2000/month. Paid tiers start at $3 per 1000.
//
// Endpoint docs:
//   https://api-dashboard.search.brave.com/app/documentation/image-search/get-started
//
// Brave's image search has broader coverage than Google CSE for general
// queries (events, scenes, concepts) — Google CSE tends to return UI/branded
// imagery skewed by SEO. We try Brave first and fall back to Google CSE.

import { getEnv } from "@/lib/env";

export interface BraveImageResult {
  url: string;
  width: number;
  height: number;
  thumbnailUrl: string;
  contextUrl: string;     // page where the image appears
  mime: string;
}

const ENDPOINT = "https://api.search.brave.com/res/v1/images/search";

export async function fetchBraveImage(query: string): Promise<BraveImageResult | null> {
  const all = await fetchBraveImages(query, 1);
  return all[0] ?? null;
}

// Returns up to `max` valid image results for the query. Used by the project-
// level image pool builder which needs multiple distinct images per entity to
// fill many image blocks without repeating the same picture.
export async function fetchBraveImages(query: string, max: number = 5): Promise<BraveImageResult[]> {
  const env = getEnv();
  if (!env.BRAVE_SEARCH_API_KEY) return [];
  const timeoutMs = env.HTTP_DOWNLOAD_TIMEOUT_SECONDS * 1000;
  // Brave allows up to 100 per page; we cap at 50 to stay polite.
  const requested = Math.min(50, Math.max(1, max));

  const params = new URLSearchParams({
    q: query,
    count: String(requested),
    safesearch: "strict",
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${ENDPOINT}?${params}`, {
      signal: ctrl.signal,
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY,
      },
    });
    if (!r.ok) return [];
    const json = await r.json() as {
      results?: Array<{
        url?: string;            // page URL where the image was found
        title?: string;
        source?: string;
        thumbnail?: { src?: string };
        properties?: {
          url?: string;          // direct image URL
        };
        // Width/height live under `properties` on some shapes and at the top
        // level on others; read both.
        width?: number;
        height?: number;
      }>;
    };
    const out: BraveImageResult[] = [];
    const seenUrls = new Set<string>();
    for (const item of json.results ?? []) {
      const link = item.properties?.url;
      if (!link) continue;
      if (seenUrls.has(link)) continue;
      const w = item.width ?? 0;
      const h = item.height ?? 0;
      // Skip only when dimensions are reported and clearly too small. Brave
      // often omits them — accept the result rather than dropping silently.
      if (w && h && (w < 400 || h < 300)) continue;
      const lower = link.toLowerCase();
      const mime = lower.endsWith(".png")
        ? "image/png"
        : lower.endsWith(".webp")
          ? "image/webp"
          : lower.endsWith(".gif")
            ? "image/gif"
            : "image/jpeg";
      out.push({
        url: link,
        width: w,
        height: h,
        thumbnailUrl: item.thumbnail?.src ?? link,
        contextUrl: item.url ?? "",
        mime,
      });
      seenUrls.add(link);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

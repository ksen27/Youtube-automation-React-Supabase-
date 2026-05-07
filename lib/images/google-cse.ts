// Google Custom Search image fetcher. Requires:
//   GOOGLE_SEARCH_API_KEY  — Cloud Console API key with Custom Search enabled
//   GOOGLE_SEARCH_CX       — Programmable Search Engine ID
//
// Free quota: 100 queries/day. Paid: $5 per 1000 queries.
//
// Rights filter is set to `cc_publicdomain|cc_attribute|cc_sharealike` —
// returns images publishers have tagged as licensed for reuse. Not a legal
// shield (publishers mistag), but better than no filter.

import { getEnv } from "@/lib/env";

export interface GoogleCseImageResult {
  url: string;
  width: number;
  height: number;
  thumbnailUrl: string;
  contextUrl: string;     // page where the image appears
  mime: string;
}

const ENDPOINT = "https://www.googleapis.com/customsearch/v1";

export async function fetchGoogleImage(query: string): Promise<GoogleCseImageResult | null> {
  const all = await fetchGoogleImages(query, 1);
  return all[0] ?? null;
}

// Returns up to `max` valid image results for the query. Used by the project-
// level image pool builder which needs multiple distinct images per entity to
// fill many image blocks without repeating the same picture.
export async function fetchGoogleImages(query: string, max: number = 5): Promise<GoogleCseImageResult[]> {
  const env = getEnv();
  if (!env.GOOGLE_SEARCH_API_KEY || !env.GOOGLE_SEARCH_CX) return [];
  const timeoutMs = env.HTTP_DOWNLOAD_TIMEOUT_SECONDS * 1000;
  const requested = Math.min(10, Math.max(1, max));

  const params = new URLSearchParams({
    key: env.GOOGLE_SEARCH_API_KEY,
    cx: env.GOOGLE_SEARCH_CX,
    q: query,
    searchType: "image",
    safe: "high",
    imgSize: "large",
    // Filter to images that publishers tagged as licensed for reuse.
    rights: "cc_publicdomain|cc_attribute|cc_sharealike",
    num: String(requested),
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${ENDPOINT}?${params}`, { signal: ctrl.signal });
    if (!r.ok) return [];
    const json = await r.json() as {
      items?: Array<{
        link?: string;
        mime?: string;
        image?: {
          width?: number;
          height?: number;
          thumbnailLink?: string;
          contextLink?: string;
        };
      }>;
    };
    const out: GoogleCseImageResult[] = [];
    const seenUrls = new Set<string>();
    for (const item of json.items ?? []) {
      if (!item.link) continue;
      if (seenUrls.has(item.link)) continue;
      const w = item.image?.width ?? 0;
      const h = item.image?.height ?? 0;
      if (w < 400 || h < 300) continue;     // too small to scale to 1280x720
      out.push({
        url: item.link,
        width: w,
        height: h,
        thumbnailUrl: item.image?.thumbnailLink ?? item.link,
        contextUrl: item.image?.contextLink ?? "",
        mime: item.mime ?? "image/jpeg",
      });
      seenUrls.add(item.link);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

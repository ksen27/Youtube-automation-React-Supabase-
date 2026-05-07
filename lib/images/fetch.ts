// Image-fetch orchestrator. Tries sources in priority order:
//   1. Wikipedia (free, copyright-clean, best for named people/places)
//   2. Google Custom Search (rights-filtered, broad coverage)
//
// YouTube thumbnails were previously the last-resort fallback but produced
// low-quality, off-topic results (clickbait overlays, random channels) that
// shipped into the final video. They've been removed; if Wikipedia + Google
// CSE both fail for a query, the caller should leave the image block blank.
//
// Two callers exist:
//   - fetchImage(query)       — returns the single best image (legacy callers)
//   - fetchImages(query, n)   — returns up to N distinct images (used to build
//                                a project-level pool when each image must
//                                appear at most once across the timeline).

import { fetchWikipediaImage } from "./wikipedia";
import { fetchGoogleImage, fetchGoogleImages } from "./google-cse";

export type ImageSource = "wikipedia" | "google_cse";

export interface FetchedImage {
  url: string;
  source: ImageSource;
  width?: number;
  height?: number;
  contextUrl?: string;     // page where the image originally appears
  attribution?: string;    // human-readable source credit
}

export interface FetchOptions {
  // Entity type hint — e.g. "celebrity" prefers Wikipedia first; "event"
  // tends to do better with Google CSE. Lower-cased string, free-form.
  entityType?: string;
}

export async function fetchImage(query: string, opts: FetchOptions = {}): Promise<FetchedImage | null> {
  const q = query.trim();
  if (!q) return null;

  if (isLikelyWikipediaQuery(q, opts.entityType)) {
    const wiki = await fetchWikipediaImage(q);
    if (wiki) {
      return {
        url: wiki.url,
        source: "wikipedia",
        width: wiki.width,
        height: wiki.height,
        contextUrl: wiki.pageUrl,
        attribution: `Wikipedia: ${wiki.pageTitle}`,
      };
    }
  }

  const cse = await fetchGoogleImage(q);
  if (cse) {
    return {
      url: cse.url,
      source: "google_cse",
      width: cse.width,
      height: cse.height,
      contextUrl: cse.contextUrl,
      attribution: cse.contextUrl ? `via ${new URL(cse.contextUrl).hostname}` : "Google",
    };
  }

  return null;
}

// Pull up to `max` distinct images for the query. Wikipedia contributes at
// most one (the page's lead image); Google CSE contributes the remainder.
// Returned in priority order — Wikipedia first when present, then CSE.
// Deduped by URL.
export async function fetchImages(
  query: string,
  max: number,
  opts: FetchOptions = {},
): Promise<FetchedImage[]> {
  const q = query.trim();
  if (!q || max <= 0) return [];
  const out: FetchedImage[] = [];
  const seenUrls = new Set<string>();

  if (isLikelyWikipediaQuery(q, opts.entityType)) {
    const wiki = await fetchWikipediaImage(q);
    if (wiki) {
      out.push({
        url: wiki.url,
        source: "wikipedia",
        width: wiki.width,
        height: wiki.height,
        contextUrl: wiki.pageUrl,
        attribution: `Wikipedia: ${wiki.pageTitle}`,
      });
      seenUrls.add(wiki.url);
    }
  }

  if (out.length < max) {
    const cseImages = await fetchGoogleImages(q, max - out.length);
    for (const cse of cseImages) {
      if (seenUrls.has(cse.url)) continue;
      out.push({
        url: cse.url,
        source: "google_cse",
        width: cse.width,
        height: cse.height,
        contextUrl: cse.contextUrl,
        attribution: cse.contextUrl ? `via ${new URL(cse.contextUrl).hostname}` : "Google",
      });
      seenUrls.add(cse.url);
      if (out.length >= max) break;
    }
  }

  return out;
}

// Wikipedia pages are organized by canonical entity names. A query like
// "courtroom drama" or "shop interior" will 404; "Princess Diana" or
// "Buckingham Palace" will hit. We do a quick heuristic check: if the
// entity type is one Wikipedia commonly indexes (people, places, named
// events, companies) AND the query is a proper noun, try Wikipedia.
function isLikelyWikipediaQuery(query: string, entityType?: string): boolean {
  // Generic concepts go straight to CSE.
  const NON_WIKI_TYPES = new Set(["concept", "topic", "scene"]);
  if (entityType && NON_WIKI_TYPES.has(entityType)) return false;

  // Heuristic: at least one capitalized word (proper noun).
  const words = query.split(/\s+/);
  const hasProper = words.some((w) => /^[A-Z][a-zA-Z]+$/.test(w));
  return hasProper;
}

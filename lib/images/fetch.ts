// Image-fetch orchestrator. Tries sources in priority order:
//   1. Wikipedia (free, copyright-clean, best for named people/places)
//   2. Brave Image Search (broad coverage, less SEO-skewed than Google)
//   3. Google Custom Search (rights-filtered fallback)
//
// YouTube thumbnails were previously the last-resort fallback but produced
// low-quality, off-topic results (clickbait overlays, random channels) that
// shipped into the final video. They've been removed; if all three sources
// fail for a query, the caller should leave the image block blank.
//
// Two callers exist:
//   - fetchImage(query)       — returns the single best image (legacy callers)
//   - fetchImages(query, n)   — returns up to N distinct images (used to build
//                                a project-level pool when each image must
//                                appear at most once across the timeline).

import { fetchWikipediaImage } from "./wikipedia";
import { fetchBraveImage, fetchBraveImages } from "./brave";
import { fetchGoogleImage, fetchGoogleImages } from "./google-cse";
import { getEnv } from "@/lib/env";

export type ImageSource = "wikipedia" | "brave" | "google_cse";

// Normalize an image URL to catch "same picture, different URL string"
// duplicates that exact-string compare misses. The most common cases:
//   - Wikipedia serves the same image at multiple thumbnail sizes:
//       /thumb/X/X/Foo.jpg/300px-Foo.jpg
//       /thumb/X/X/Foo.jpg/500px-Foo.jpg
//     Both render the same picture. We strip the size prefix to dedup.
//   - CDNs append cache-busting / sizing query strings:
//       cdn.example.com/foo.jpg?w=600
//       cdn.example.com/foo.jpg?w=1200&q=80
//     Same image. We strip the query string.
//   - Trailing slashes / hash fragments are meaningless for image identity.
// This is intentionally conservative: it won't catch the same picture
// served from two different hosts (rare), but it reliably catches the
// common collisions our search-source mix produces.
export function normalizeImageUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    // Wikipedia thumbnail path: /commons/thumb/A/AB/Filename.jpg/300px-Filename.jpg
    // → /commons/A/AB/Filename.jpg
    const m = u.pathname.match(/^(.*\/)thumb\/(.+\/[^/]+)\/\d+px-[^/]+$/);
    if (m) u.pathname = m[1] + m[2];
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    // Not a parseable URL — fall back to lowercased raw string so dedup
    // still works on identical inputs.
    return raw.toLowerCase();
  }
}

// HEAD-check a candidate image URL. Returns true if the URL is reachable
// (2xx) OR if the check is inconclusive (timeout, network error, host
// rejects HEAD with 405). Returns false ONLY when the server explicitly
// says the image is gone or forbidden (4xx other than 405, 5xx).
//
// Rationale: false negatives (rejecting a working image) hurt more than
// false positives (keeping a possibly-broken image). Wikipedia and some
// CDNs return 403/405 for HEAD requests when the underlying GET works
// fine; dropping those URLs would gut the image pool. We only drop on
// the specific failure modes that consistently produce broken thumbnails
// in the editor (404 gone, 403 hotlink-blocked for sure).
export async function validateImageUrl(url: string): Promise<boolean> {
  // Quick syntactic check — reject obvious junk before spending an HTTP RTT.
  try { new URL(url); } catch { return false; }

  const env = getEnv();
  const timeoutMs = Math.min(1500, env.HTTP_DOWNLOAD_TIMEOUT_SECONDS * 1000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "HEAD",
      signal: ctrl.signal,
      redirect: "follow",
      // Some hosts reject empty UA. Match the labeler's UA style.
      headers: { "User-Agent": "video-automation/1.0 (image-validate)" },
    });
    if (r.ok) return true;                                  // 2xx — definitely fine
    if (r.status === 405) return true;                      // HEAD not allowed — assume GET works
    if (r.status >= 400 && r.status < 500) return false;    // 4xx — gone or forbidden
    return true;                                            // 5xx / other — keep, transient
  } catch {
    // Network error, abort, DNS failure — inconclusive. Keep the URL.
    return true;
  } finally {
    clearTimeout(timer);
  }
}

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
  // Override the image-type filter at the search-engine level. "logo"
  // tightens Google CSE results to company logos / marks. Default behavior
  // (imgType=photo) excludes clipart and illustrations.
  imgType?: "photo" | "logo";
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

  const brave = await fetchBraveImage(q);
  if (brave) {
    return {
      url: brave.url,
      source: "brave",
      width: brave.width,
      height: brave.height,
      contextUrl: brave.contextUrl,
      attribution: brave.contextUrl ? `via ${new URL(brave.contextUrl).hostname}` : "Brave",
    };
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
  // Dedup by NORMALIZED url so that the same picture served at different
  // thumbnail sizes / cache-busting query strings collapses to one entry.
  // See normalizeImageUrl() for the rules. The raw URL is still what we
  // ship — normalization is only the dedup key.
  const seenNormalized = new Set<string>();
  function addUnique(img: FetchedImage): boolean {
    const key = normalizeImageUrl(img.url);
    if (seenNormalized.has(key)) return false;
    seenNormalized.add(key);
    out.push(img);
    return true;
  }

  if (isLikelyWikipediaQuery(q, opts.entityType)) {
    const wiki = await fetchWikipediaImage(q);
    if (wiki) {
      addUnique({
        url: wiki.url,
        source: "wikipedia",
        width: wiki.width,
        height: wiki.height,
        contextUrl: wiki.pageUrl,
        attribution: `Wikipedia: ${wiki.pageTitle}`,
      });
    }
  }

  // Over-fetch from Brave/CSE so the HEAD validation pass below has spare
  // candidates to fall back to when some URLs turn out to be 404/403. The
  // 2x factor is a balance: bigger means fewer "validation dropped my pool
  // size" surprises, smaller means less Brave/CSE quota burn. We cap the
  // factor at +5 absolute so a request for max=2 doesn't spend 10 quota.
  function overfetchTarget(remaining: number): number {
    return Math.min(remaining * 2, remaining + 5);
  }

  // Total pool ceiling — we collect up to this many candidates across all
  // sources, then validate and trim to `max`. Always at least `max`; the
  // overfetchTarget() margin gives the HEAD pass room to drop a few bad URLs
  // without leaving the caller short.
  const ceiling = max + (overfetchTarget(max) - max);

  if (out.length < ceiling) {
    const braveImages = await fetchBraveImages(q, ceiling - out.length);
    for (const brave of braveImages) {
      addUnique({
        url: brave.url,
        source: "brave",
        width: brave.width,
        height: brave.height,
        contextUrl: brave.contextUrl,
        attribution: brave.contextUrl ? `via ${new URL(brave.contextUrl).hostname}` : "Brave",
      });
      if (out.length >= ceiling) break;
    }
  }

  if (out.length < ceiling) {
    const cseImages = await fetchGoogleImages(q, ceiling - out.length, { imgType: opts.imgType });
    for (const cse of cseImages) {
      addUnique({
        url: cse.url,
        source: "google_cse",
        width: cse.width,
        height: cse.height,
        contextUrl: cse.contextUrl,
        attribution: cse.contextUrl ? `via ${new URL(cse.contextUrl).hostname}` : "Google",
      });
      if (out.length >= ceiling) break;
    }
  }

  // Validate URLs in parallel and keep only reachable ones, preserving
  // the original priority order (Wikipedia → Brave → CSE). validateImageUrl
  // is conservative: it drops only on confirmed 4xx (gone/forbidden) and
  // keeps URLs that fail inconclusively (timeout, network error, host
  // rejects HEAD). This filters the broken thumbnails that ship into the
  // editor (404/403 hotlink-blocked) without gutting the pool when a CDN
  // is just being slow.
  const validity = await Promise.all(out.map((img) => validateImageUrl(img.url)));
  const validated = out.filter((_, i) => validity[i]);

  return validated.slice(0, max);
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

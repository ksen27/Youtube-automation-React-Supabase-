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
import { uploadBuffer } from "@/lib/storage";
import { createHash } from "node:crypto";

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

// Download an external image server-side and re-host it on our own R2 CDN,
// returning the R2 public URL. Returns null when the source can't be fetched
// (e.g. people.com and other publisher CDNs with Akamai-grade bot protection
// that 403 every server fetch) or isn't a usable image.
//
// WHY: an image_url that points at a hotlink-protected publisher CDN fails in
// BOTH the editor preview (browser <img> blocked) AND the final render (the
// worker's server-side downloadHttp gets 403 → the block is silently dropped
// from the video — no fallback image). Re-hosting at match time means every
// image committed to the timeline lives on OUR CDN, so it always loads in the
// editor and always renders. A source that blocks this fetch is rejected here,
// before it reaches the timeline, so the matcher falls through to a different
// working image instead of shipping a gap.
//
// Idempotent by content address: the R2 key is derived from the source URL, so
// re-hosting the same image twice (across blocks / re-matches) overwrites the
// same object rather than piling up duplicates.
export async function rehostImageToR2(
  sourceUrl: string,
  projectId: string,
): Promise<string | null> {
  // Already on our CDN — nothing to do. Avoids a pointless round-trip when a
  // re-match re-processes an image that was rehosted on a previous run.
  const env = getEnv();
  if (env.R2_PUBLIC_BASE_URL && sourceUrl.startsWith(env.R2_PUBLIC_BASE_URL)) {
    return sourceUrl;
  }
  try {
    new URL(sourceUrl);
  } catch {
    return null;
  }

  const timeoutMs = Math.min(15_000, env.HTTP_DOWNLOAD_TIMEOUT_SECONDS * 1000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(sourceUrl, {
      signal: ctrl.signal,
      redirect: "follow",
      // Browser-like UA: many CDNs reject the default fetch UA but allow this.
      // (Doesn't defeat Akamai-grade protection like people.com — those simply
      // return null below and get dropped, which is the intended behaviour.)
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/png,image/*,*/*;q=0.8",
      },
    });
  } catch {
    clearTimeout(timer);
    return null;
  }
  clearTimeout(timer);

  if (!res.ok) return null;

  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
  if (buf.length === 0) return null;

  // Determine the real image type. The Content-Type header is NOT trusted on
  // its own: CDNs commonly serve valid images as binary/octet-stream
  // (purewow.com does this) or with a wrong type, which would wrongly drop a
  // perfectly good image. We sniff the magic bytes and fall back to the header.
  // If NEITHER says image, the body isn't an image (an HTML challenge page) →
  // reject so it doesn't get stored as a broken asset.
  const headerType = (res.headers.get("content-type") || "").split(";")[0].trim();
  const sniffed = sniffImageMime(buf);
  if (!sniffed && !headerType.startsWith("image/")) return null;
  const storeType = sniffed ?? headerType;

  // Pick an extension from the resolved type so the R2 object has a sensible
  // name; default to .jpg.
  const ext =
    storeType.includes("png") ? "png" :
    storeType.includes("webp") ? "webp" :
    storeType.includes("gif") ? "gif" :
    storeType.includes("avif") ? "avif" :
    "jpg";
  const hash = createHash("sha1").update(sourceUrl).digest("hex").slice(0, 24);
  const key = `projects/${projectId}/images/${hash}.${ext}`;

  try {
    const up = await uploadBuffer(buf, key, storeType);
    return up.publicUrl;
  } catch {
    return null;
  }
}

// Sniff an image's real MIME from leading magic bytes — CDNs frequently serve
// images with a generic/wrong Content-Type, so the header can't be trusted.
// Returns null when the bytes aren't a recognised image.
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return "image/avif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
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
  // Optional tokens that MUST appear in a candidate's context URL (the
  // source page hosting the image). Used to reject logo-search results
  // for "Kindigit Design" that come back as random brand logos
  // ("Strong Guard", "20 Years") — the CSE quietly substitutes a similar-
  // looking logo when it can't find the exact one. Wikipedia results
  // bypass this check (they're already entity-canonical). Empty array
  // disables the check.
  requireContextTokens?: string[];
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
  let validated = out.filter((_, i) => validity[i]);

  // Optional context-token filter. Drop candidates whose contextUrl
  // doesn't mention at least one of the required tokens (case-insensitive
  // substring match against the full URL). Wikipedia results pass
  // unconditionally — those are already entity-canonical. Empty token
  // array (or no opts) disables the filter.
  const tokens = (opts.requireContextTokens ?? [])
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);
  if (tokens.length > 0) {
    validated = validated.filter((img) => {
      if (img.source === "wikipedia") return true;
      const ctx = (img.contextUrl ?? "").toLowerCase();
      if (!ctx) return false;
      return tokens.some((t) => ctx.includes(t));
    });
  }

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

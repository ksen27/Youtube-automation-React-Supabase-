import { z } from "zod";
import { getEnv } from "@/lib/env";
import { getServerSupabase } from "@/lib/supabase/server";
import { searchYoutubeViaYtDlp } from "@/lib/media/ytdlp";

// YouTube Data API v3 wrapper.
// Quota: each search.list call is ~100 units; videos.list is 1;
// playlistItems.list is 1. API key: enable "YouTube Data API v3" at
// https://console.cloud.google.com/apis

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";

// TTL for cached search results. Footage queries are stable day-to-day, so a
// 14-day window trades a little freshness for a large quota saving on repeat
// subjects across projects.
const SEARCH_CACHE_TTL_DAYS = 14;

// Error sentinel: thrown (and detected) when the Data API returns a
// quota-exhaustion error. Callers catch this to fall back to yt-dlp search.
export class YoutubeQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YoutubeQuotaError";
  }
}

// YouTube signals quota exhaustion with HTTP 403 and a body whose reason is
// "quotaExceeded" / "dailyLimitExceeded". We match on the raw body text since
// we only have the stringified error here.
function isQuotaError(status: number, body: string): boolean {
  if (status !== 403) return false;
  const b = body.toLowerCase();
  return b.includes("quotaexceeded") || b.includes("dailylimitexceeded");
}

export interface YoutubeCandidate {
  videoId: string;
  url: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  durationSeconds: number;
  isLive: boolean;
  privacyStatus: string;
  // Aspect ratio of the source video, derived from the largest available
  // thumbnail (high > standard > maxres > medium > default). Horizontal
  // landscape 16:9 ≈ 1.78; YouTube Shorts and vertical TikTok cross-posts
  // ≈ 0.56. `null` when no thumbnail dimensions were returned (legacy
  // uploads or older API responses) — the ranker treats null as "unknown
  // orientation, allow" so we don't false-positive on the few cases where
  // dimensions are missing.
  aspectRatio: number | null;
}

export interface SearchInput {
  query: string;
  maxResults?: number;
  relevanceLanguage?: string;
  // When set, restricts the search to a single channel (YouTube's native
  // `channelId` filter on search.list). This is how the subject-centric
  // pipeline searches reference channels FIRST: run the subject queries
  // scoped to each reference channel before ever touching open YouTube.
  channelId?: string;
}

const SearchItemSchema = z.object({
  id: z.object({
    kind: z.string(),
    videoId: z.string().optional(),
  }),
  snippet: z.object({
    title: z.string(),
    description: z.string().optional().default(""),
    channelId: z.string(),
    channelTitle: z.string(),
    liveBroadcastContent: z.string().optional(),
  }),
});

// Lightweight result for the FAST manual-search path: snippet-only, no
// videos.list hydration. A search picker only needs a thumbnail, title, and
// channel — duration/privacy/aspect are resolved later at add-time.
export interface FastSearchResult {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  channelId: string;
  thumbnailUrl: string;
}

// search.list snippet carries thumbnails directly — we read the medium/high
// thumbnail off it so the fast path needs zero extra calls.
const FastSearchItemSchema = z.object({
  id: z.object({ kind: z.string(), videoId: z.string().optional() }),
  snippet: z.object({
    title: z.string(),
    channelId: z.string(),
    channelTitle: z.string(),
    thumbnails: z.object({
      default: z.object({ url: z.string().optional() }).optional(),
      medium: z.object({ url: z.string().optional() }).optional(),
      high: z.object({ url: z.string().optional() }).optional(),
    }).optional(),
  }),
});

// FAST search for the in-app manual picker. ONE search.list call (no videos.list
// hydration, no per-channel loop). Renders thumbnails straight from the search
// snippet, so it's near-instant — matching a typical "type and see results"
// picker. Quota: ~100 units per call. Falls back to yt-dlp on quota exhaustion.
export async function searchYoutubeFast(query: string, maxResults = 24): Promise<FastSearchResult[]> {
  const env = getEnv();
  if (!env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY not configured");
  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(Math.min(50, Math.max(1, maxResults))),
    relevanceLanguage: "en",
    safeSearch: "moderate",
    videoEmbeddable: "true",
    key: env.YOUTUBE_API_KEY,
  });
  const r = await fetch(`${SEARCH_URL}?${params}`);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    if (isQuotaError(r.status, txt)) {
      // Quota out — fall back to yt-dlp scrape (no hydration; build thumb URL).
      const scraped = await searchYoutubeViaYtDlp(query, maxResults).catch(() => []);
      return scraped.map((s) => ({
        videoId: s.videoId,
        url: `https://www.youtube.com/watch?v=${s.videoId}`,
        title: s.title,
        channelTitle: s.channelTitle ?? "",
        channelId: s.channelId ?? "",
        thumbnailUrl: `https://i.ytimg.com/vi/${s.videoId}/mqdefault.jpg`,
      }));
    }
    throw new Error(`YouTube search failed: ${r.status} ${txt.slice(0, 300)}`);
  }
  const json = await r.json();
  const out: FastSearchResult[] = [];
  for (const raw of json.items ?? []) {
    const safe = FastSearchItemSchema.safeParse(raw);
    if (!safe.success) continue;
    if (safe.data.id.kind !== "youtube#video" || !safe.data.id.videoId) continue;
    const id = safe.data.id.videoId;
    const thumbs = safe.data.snippet.thumbnails;
    const thumbnailUrl =
      thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url ||
      `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    out.push({
      videoId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: safe.data.snippet.title,
      channelTitle: safe.data.snippet.channelTitle,
      channelId: safe.data.snippet.channelId,
      thumbnailUrl,
    });
  }
  return out;
}

// YouTube's thumbnail object always mirrors the source video's aspect ratio:
// horizontal 16:9 video → horizontal thumbnail; vertical 9:16 Short → vertical
// thumbnail. We capture `high` and `maxres` because the smaller default/medium
// thumbnails are often padded/letterboxed and don't preserve the source ratio
// faithfully. width/height are reported as numbers when present, but the API
// occasionally omits them for legacy uploads — both are optional.
const ThumbnailSchema = z.object({
  url: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const VideoItemSchema = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string(),
    description: z.string().optional().default(""),
    channelId: z.string(),
    channelTitle: z.string(),
    liveBroadcastContent: z.string().optional(),
    thumbnails: z.object({
      default: ThumbnailSchema.optional(),
      medium: ThumbnailSchema.optional(),
      high: ThumbnailSchema.optional(),
      standard: ThumbnailSchema.optional(),
      maxres: ThumbnailSchema.optional(),
    }).optional(),
  }),
  contentDetails: z.object({
    duration: z.string(),
  }),
  status: z.object({
    privacyStatus: z.string().optional(),
  }).optional(),
});

// Fetch full metadata for a single YouTube videoId. Used by the
// "add source by URL" endpoint when the user pastes a YouTube link in
// the analyze picker — we skip the search.list step (we already know
// the id) and go straight to videos.list to hydrate snippet + duration
// + privacy + thumbnails. Returns null when the id doesn't resolve to
// a public video (deleted / private / blocked-in-country / Shorts).
//
// The shape matches what searchYoutube emits so callers can pass the
// result through rankCandidate without reshaping.
export async function fetchYoutubeVideoMeta(videoId: string): Promise<YoutubeCandidate | null> {
  const env = getEnv();
  if (!env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY not configured");
  const vparams = new URLSearchParams({
    part: "snippet,contentDetails,status",
    id: videoId,
    key: env.YOUTUBE_API_KEY,
  });
  const vr = await fetch(`${VIDEOS_URL}?${vparams}`);
  if (!vr.ok) {
    const txt = await vr.text().catch(() => "");
    throw new Error(`YouTube videos.list failed: ${vr.status} ${txt.slice(0, 300)}`);
  }
  const vjson = await vr.json();
  const item = (vjson.items ?? [])[0];
  if (!item) return null;
  const safe = VideoItemSchema.safeParse(item);
  if (!safe.success) return null;
  return {
    videoId: safe.data.id,
    url: `https://www.youtube.com/watch?v=${safe.data.id}`,
    title: safe.data.snippet.title,
    description: safe.data.snippet.description ?? "",
    channelId: safe.data.snippet.channelId,
    channelTitle: safe.data.snippet.channelTitle,
    durationSeconds: parseISO8601Duration(safe.data.contentDetails.duration),
    isLive: safe.data.snippet.liveBroadcastContent === "live"
          || safe.data.snippet.liveBroadcastContent === "upcoming",
    privacyStatus: safe.data.status?.privacyStatus ?? "public",
    aspectRatio: pickAspectRatio(safe.data.snippet.thumbnails),
  };
}

export async function searchYoutube(input: SearchInput): Promise<YoutubeCandidate[]> {
  const env = getEnv();
  if (!env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY not configured");

  const params = new URLSearchParams({
    part: "snippet",
    q: input.query,
    type: "video",
    maxResults: String(input.maxResults ?? 15),
    relevanceLanguage: input.relevanceLanguage ?? "en",
    safeSearch: "moderate",
    videoEmbeddable: "true",
    key: env.YOUTUBE_API_KEY,
  });
  // Scope to a single channel when requested. With channelId set, YouTube
  // returns only that channel's uploads matching `q` — the basis of
  // reference-channel-first discovery.
  if (input.channelId) params.set("channelId", input.channelId);

  const r = await fetch(`${SEARCH_URL}?${params}`);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    if (isQuotaError(r.status, txt)) {
      throw new YoutubeQuotaError(`YouTube search quota exceeded: ${txt.slice(0, 200)}`);
    }
    throw new Error(`YouTube search failed: ${r.status} ${txt.slice(0, 300)}`);
  }
  const json = await r.json();
  const ids: string[] = [];
  for (const raw of json.items ?? []) {
    const safe = SearchItemSchema.safeParse(raw);
    if (!safe.success) continue;
    if (safe.data.id.kind !== "youtube#video" || !safe.data.id.videoId) continue;
    ids.push(safe.data.id.videoId);
  }
  if (!ids.length) return [];
  return hydrateVideoIds(ids);
}

// Hydrate a list of video ids to full YoutubeCandidate[] via videos.list
// (1 quota unit per call, up to 50 ids). Shared by searchYoutube and the
// yt-dlp fallback path (which only gets ids + sparse metadata from scraping
// and needs the official call for accurate duration / privacy / aspect).
// Batches into groups of 50 (the videos.list id cap).
export async function hydrateVideoIds(ids: string[]): Promise<YoutubeCandidate[]> {
  const env = getEnv();
  if (!env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY not configured");
  const out: YoutubeCandidate[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const vparams = new URLSearchParams({
      part: "snippet,contentDetails,status",
      id: batch.join(","),
      key: env.YOUTUBE_API_KEY,
    });
    const vr = await fetch(`${VIDEOS_URL}?${vparams}`);
    if (!vr.ok) {
      const txt = await vr.text().catch(() => "");
      if (isQuotaError(vr.status, txt)) {
        throw new YoutubeQuotaError(`YouTube videos.list quota exceeded: ${txt.slice(0, 200)}`);
      }
      throw new Error(`YouTube videos.list failed: ${vr.status} ${txt.slice(0, 300)}`);
    }
    const vjson = await vr.json();
    for (const raw of vjson.items ?? []) {
      const safe = VideoItemSchema.safeParse(raw);
      if (!safe.success) continue;
      out.push({
        videoId: safe.data.id,
        url: `https://www.youtube.com/watch?v=${safe.data.id}`,
        title: safe.data.snippet.title,
        description: safe.data.snippet.description ?? "",
        channelId: safe.data.snippet.channelId,
        channelTitle: safe.data.snippet.channelTitle,
        durationSeconds: parseISO8601Duration(safe.data.contentDetails.duration),
        isLive: safe.data.snippet.liveBroadcastContent === "live"
              || safe.data.snippet.liveBroadcastContent === "upcoming",
        privacyStatus: safe.data.status?.privacyStatus ?? "public",
        aspectRatio: pickAspectRatio(safe.data.snippet.thumbnails),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quota-aware cached search
// ---------------------------------------------------------------------------

// Normalize a query (+ optional channel) into a stable cache key. Lowercase +
// whitespace-collapse so "Simon Cowell  interview" and "simon cowell interview"
// share a cache row.
function cacheKeyFor(query: string, channelId?: string): string {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  return `${q}|${channelId ?? ""}`;
}

// Look up a non-expired cache row. Returns the cached candidates, or null on
// miss / expiry / error (a cache failure must never break search).
async function readSearchCache(query: string, channelId?: string): Promise<YoutubeCandidate[] | null> {
  try {
    const sb = getServerSupabase();
    const key = cacheKeyFor(query, channelId);
    const { data, error } = await sb
      .from("youtube_search_cache")
      .select("candidates, expires_at")
      .eq("cache_key", key)
      .maybeSingle();
    if (error || !data) return null;
    if (new Date(data.expires_at as string).getTime() < nowMs()) return null;
    const cands = data.candidates as unknown;
    return Array.isArray(cands) ? (cands as YoutubeCandidate[]) : null;
  } catch {
    return null;
  }
}

// Persist (upsert) search results into the cache with a fresh TTL. Best-effort:
// a write failure is logged-as-swallowed since it only costs a future cache hit.
async function writeSearchCache(
  query: string,
  channelId: string | undefined,
  candidates: YoutubeCandidate[],
  source: "api" | "ytdlp",
): Promise<void> {
  try {
    const sb = getServerSupabase();
    const key = cacheKeyFor(query, channelId);
    const expires = new Date(nowMs() + SEARCH_CACHE_TTL_DAYS * 86400_000).toISOString();
    await sb.from("youtube_search_cache").upsert(
      {
        cache_key: key,
        query: query.trim(),
        channel_id: channelId ?? null,
        candidates: candidates as unknown as object,
        source,
        expires_at: expires,
      },
      { onConflict: "cache_key" },
    );
  } catch {
    // ignore — cache is an optimization, not a correctness requirement
  }
}

// Wall-clock helper kept in one place so it's easy to stub in tests.
function nowMs(): number {
  return Date.now();
}

// Reference-channel recall via the uploads playlist (1 quota unit per 50
// videos) instead of a channel-scoped search.list (100 units). Every channel's
// uploads live in a playlist whose id is the channel id with "UC" → "UU". We
// list recent uploads cheaply, then filter client-side by the query terms.
// This makes the user's PREFERRED footage tier almost free on quota.
//
// Tradeoff vs. search.list: playlistItems returns uploads in reverse-chron
// order, not relevance order, and our client-side term filter is coarser than
// YouTube's search ranking. That's acceptable here — reference channels are
// curated, so "recent uploads matching the subject" is exactly what we want,
// and hydrateVideoIds + rankCandidate re-rank afterward.
export async function searchReferenceChannelViaPlaylist(
  channelId: string,
  query: string,
  maxResults = 25,
): Promise<YoutubeCandidate[]> {
  const env = getEnv();
  if (!env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY not configured");
  if (!/^UC[0-9A-Za-z_-]{22}$/.test(channelId)) {
    // Not a canonical channel id — can't derive the uploads playlist. Caller
    // should fall back to channel-scoped search.list.
    throw new Error(`not a canonical channel id: ${channelId}`);
  }
  const uploadsPlaylistId = "UU" + channelId.slice(2);
  const params = new URLSearchParams({
    part: "contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.min(50, Math.max(1, maxResults))),
    key: env.YOUTUBE_API_KEY,
  });
  const r = await fetch(`${PLAYLIST_ITEMS_URL}?${params}`);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    if (isQuotaError(r.status, txt)) {
      throw new YoutubeQuotaError(`playlistItems quota exceeded: ${txt.slice(0, 200)}`);
    }
    throw new Error(`playlistItems failed: ${r.status} ${txt.slice(0, 300)}`);
  }
  const json = await r.json();
  const ids: string[] = [];
  for (const item of json.items ?? []) {
    const vid = item?.contentDetails?.videoId;
    if (typeof vid === "string") ids.push(vid);
  }
  if (!ids.length) return [];
  const hydrated = await hydrateVideoIds(ids);
  // Client-side relevance filter on the channel's uploads. A reference channel
  // can cover MANY celebrities, so an OR-of-tokens filter ("david" OR
  // "walliams") leaks wrong-person uploads (a "Prince George" video whose
  // description happens to say "David"). For a multi-token query (a full name
  // like "David Walliams"), require ALL tokens present — that's a strong proxy
  // for "this upload actually names the subject". Single-token queries keep the
  // looser OR. The authoritative subject gate is still rankCandidate's
  // requireSubjectAnchor; this just avoids hydrating obvious misses.
  const tokens = tokenizeKeyword(query);
  if (tokens.length === 0) return hydrated;
  return hydrated.filter((c) => {
    const hay = `${c.title} ${c.description}`.toLowerCase();
    return tokens.length >= 2
      ? tokens.every((t) => hay.includes(t))
      : tokens.some((t) => hay.includes(t));
  });
}

// Top-level quota-aware search used by the discovery pipeline. Resolution order:
//   1. Cache hit (0 units)
//   2. Reference channel → playlistItems (~1 unit) when channelId is canonical
//      Open YouTube → search.list (100 units)
//   3. On YoutubeQuotaError from the API → yt-dlp scrape (0 units), hydrate via
//      videos.list only if quota wasn't the videos.list call that failed.
// Results are written back to the cache on every miss.
export async function searchYoutubeCached(input: SearchInput): Promise<YoutubeCandidate[]> {
  const { query, channelId, maxResults } = input;

  const cached = await readSearchCache(query, channelId);
  if (cached) return cached;

  // ----- API path -----
  try {
    let results: YoutubeCandidate[];
    if (channelId && /^UC[0-9A-Za-z_-]{22}$/.test(channelId)) {
      // Reference channel: cheap playlist recall. Fall back to channel-scoped
      // search.list if the playlist path errors for a non-quota reason.
      try {
        results = await searchReferenceChannelViaPlaylist(channelId, query, maxResults ?? 25);
      } catch (e) {
        if (e instanceof YoutubeQuotaError) throw e;
        results = await searchYoutube(input);
      }
    } else {
      results = await searchYoutube(input);
    }
    await writeSearchCache(query, channelId, results, "api");
    return results;
  } catch (e) {
    if (!(e instanceof YoutubeQuotaError)) throw e;
    // ----- Quota-exhausted fallback: yt-dlp scrape -----
    const scraped = await searchYoutubeViaYtDlp(query, maxResults ?? 15).catch(() => []);
    if (scraped.length === 0) return [];
    // Try to hydrate via videos.list (1 unit each) for accurate duration /
    // privacy / aspect. If that ALSO hits quota, synthesize minimal candidates
    // from the scraped metadata so discovery still produces something.
    const ids = scraped.map((s) => s.videoId);
    let hydrated: YoutubeCandidate[];
    try {
      hydrated = await hydrateVideoIds(ids);
    } catch {
      hydrated = scraped.map((s) => ({
        videoId: s.videoId,
        url: `https://www.youtube.com/watch?v=${s.videoId}`,
        title: s.title,
        description: "",
        channelId: s.channelId ?? "",
        channelTitle: s.channelTitle ?? "",
        durationSeconds: s.durationSeconds ?? 0,
        isLive: false,
        privacyStatus: "public",
        aspectRatio: null,
      }));
    }
    // Channel-scoped fallback can't use YouTube's native channel filter, so
    // filter to the requested channel client-side.
    const filtered = channelId ? hydrated.filter((c) => c.channelId === channelId) : hydrated;
    await writeSearchCache(query, channelId, filtered, "ytdlp");
    return filtered;
  }
}

// Pick the aspect ratio off the highest-resolution thumbnail that has
// dimensions. We prefer `maxres` > `high` > `standard` > `medium` > `default`
// — bigger thumbnails preserve the source aspect more faithfully (the
// `default` 120x90 is heavily padded for legacy reasons and can mislead).
// Returns null when no thumbnail dimensions are available; the ranker treats
// null as "unknown, allow."
function pickAspectRatio(
  thumbnails: {
    default?: { width?: number; height?: number };
    medium?: { width?: number; height?: number };
    high?: { width?: number; height?: number };
    standard?: { width?: number; height?: number };
    maxres?: { width?: number; height?: number };
  } | undefined,
): number | null {
  if (!thumbnails) return null;
  const priority = [thumbnails.maxres, thumbnails.high, thumbnails.standard, thumbnails.medium, thumbnails.default];
  for (const t of priority) {
    if (t && typeof t.width === "number" && typeof t.height === "number" && t.height > 0) {
      return t.width / t.height;
    }
  }
  return null;
}

export function parseISO8601Duration(iso: string): number {
  // Examples: PT4M30S, PT1H, PT45S
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const s = parseInt(m[3] ?? "0", 10);
  return h * 3600 + min * 60 + s;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export type IntentType = "talking_head" | "broll" | "archival";

export interface RankInput {
  candidate: YoutubeCandidate;
  mainCelebrity?: string;
  // Short forms / nicknames / company-form variants of mainCelebrity. Any of
  // these hitting a title or description still counts as a subject hit for
  // the hard-reject rule on inherited segments.
  aliases?: string[];
  // Recurring proper nouns tied to the main subject — used as secondary
  // anchors when a result's title doesn't restate the celebrity by name.
  contextTerms?: string[];
  // Short focus topic of the current segment (e.g. "lawsuit / Creative
  // Controls"). Scored separately from the broader keyword bag so a result
  // that nails the segment's specific beat outranks a generic celebrity hit.
  segmentTopic?: string;
  // The matched query string — feeds the +20 "query already anchored on the
  // subject" boost. Helps disambiguate when two candidates have similar
  // titles but came from different intents.
  matchedQuery?: string;
  // True when the segment inherited its subject from the global project
  // (i.e. the segment never re-stated the celebrity's name). For inherited
  // segments we hard-reject any candidate that doesn't mention the subject,
  // an alias, a context term, or one of segmentEntities below — generic
  // "Creative Controls company profile" is exactly the failure mode that
  // triggered this work.
  inheritedSegment?: boolean;
  // Per-segment named anchors — the people / places / events the section
  // actually mentions. Used as an additional anchor on inherited segments
  // so an event-driven section ("the BGT scandal at the London Palladium")
  // can still match results that say "Britain's Got Talent" or "London
  // Palladium" without the celebrity's name in the title. Gemini fills
  // these via analyzeSegment's people/places/events arrays; the analyze
  // route flattens and forwards them here.
  segmentEntities?: string[];
  keywords: string[];
  approvedChannelIds: Set<string>;
  blockedChannelIds: Set<string>;
  intentType?: IntentType;
  // True when this candidate came from a reference-channel-scoped search
  // (Phase A of the subject-centric pipeline). Reference channels are
  // user-curated sources of clean subject footage, so they get a large
  // bonus that lets them outrank open-YouTube fallback results even when a
  // fallback title token-matches slightly better. Distinct from
  // `approvedChannelIds` (the legacy global allowlist) so the two bonuses
  // don't silently compound; reference search sets this flag explicitly.
  referenceChannel?: boolean;
  // STRICT subject gate. When true, a candidate is rejected unless it has a
  // real subject anchor — the full subject name / a strong alias, or a context
  // term, in the title / description / channel. A lone keyword token ("david")
  // is NOT enough. This is the fix for wrong-person leakage: a user-curated
  // reference channel that ALSO covers other celebrities was leaking "Prince
  // George" / "Meghan Markle" uploads into a David Walliams pool because a
  // single common-name token satisfied the old content-signal gate. The
  // subject-first discovery pipeline sets this for every candidate; the legacy
  // per-segment path leaves it off so its keyword-driven behaviour is unchanged.
  requireSubjectAnchor?: boolean;
}

export interface RankedCandidate extends YoutubeCandidate {
  score: number;          // raw score, can be negative or above 100
  displayScore: number;   // 0–100 normalized for the UI bar
  reasons: string[];
  rejected: boolean;
  rejectReason?: string;
}

// Theoretical max raw score after the subject-centric re-tune:
//   +50 subject in title/desc/channel
//   +35 context term in title/desc
//   +25 segment topic word in title/desc
//   +20 matched query contains the subject
//   +15 channel name contains the subject (heuristic celebrity channel)
//   +60 reference channel (user-curated subject footage source)
//   +25 approved channel (legacy global allowlist)
//   +10 sweet-spot duration
//   +15 long-source bonus (talking-head, graduated up to ~20 min)
//   +20 keyword token cap (down-weighted from +40 — keywords are now a weak
//        tie-breaker, not a discovery driver)
// Total = 275. The UI bar normalises through MAX_RANK_SCORE so a reference-
// channel subject hit renders strong without every result saturating at 100.
export const MAX_RANK_SCORE = 275;

// Duration windows per intent. b-roll and archival often surface as short
// clips (30–120s) on YouTube — applying the talking-head floor would reject
// exactly the visuals we need for places, events, and historical moments.
const DURATION_WINDOWS: Record<IntentType, { min: number; max: number; sweetMin: number; sweetMax: number }> = {
  talking_head: { min: 120, max: 2100, sweetMin: 240, sweetMax: 900 },
  broll:        { min: 20,  max: 1200, sweetMin: 30,  sweetMax: 240 },
  archival:     { min: 20,  max: 1500, sweetMin: 60,  sweetMax: 600 },
};

// Stopwords + min token length keep the keyword matcher from being dominated
// by filler words ("the", "of", "and") that appear in every YouTube title.
const RANK_STOPWORDS = new Set([
  "the","a","an","of","and","or","to","in","on","for","with","at","by","from",
  "as","is","are","was","were","be","been","this","that","these","those","it",
  "its","into","about","over","after","before","early","late","new","old",
]);

export function tokenizeKeyword(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !RANK_STOPWORDS.has(t));
}

export function rankCandidate(input: RankInput): RankedCandidate {
  const c = input.candidate;
  const reasons: string[] = [];
  const intentType: IntentType = input.intentType ?? "talking_head";
  const window = DURATION_WINDOWS[intentType];

  if (input.blockedChannelIds.has(c.channelId)) {
    return { ...c, score: 0, displayScore: 0, reasons: [], rejected: true, rejectReason: "blocked channel" };
  }
  if (c.isLive) return { ...c, score: 0, displayScore: 0, reasons: [], rejected: true, rejectReason: "live broadcast" };
  if (c.privacyStatus !== "public") {
    return { ...c, score: 0, displayScore: 0, reasons: [], rejected: true, rejectReason: `privacy=${c.privacyStatus}` };
  }
  // Client requirement: YouTube Shorts and other vertical-format sources are
  // never used. The deliverable is a horizontal 16:9 video; vertical 9:16
  // footage can't be re-cut without pillarboxing or destructive cropping.
  //
  // The fundamental property is aspect ratio, not duration — a 3-minute
  // vertical TikTok cross-post is just as unusable as a 30-second Short.
  // We therefore lead with aspect ratio and use the other signals as
  // backstops for the few cases where the API doesn't return thumbnail
  // dimensions.
  //
  // Detection (any one rejects):
  //   1. Aspect ratio < 1.0 — the thumbnail is taller than wide, i.e. the
  //      source video is vertical. Real horizontal videos sit around 1.78
  //      (16:9); Shorts and vertical cross-posts sit around 0.56 (9:16).
  //      We pick 1.0 as the threshold because anything ≥ 1.0 is at least
  //      square and editable into a 16:9 frame.
  //   2. Duration > 0 and ≤ 60s — YouTube's own Shorts cap. Catches Shorts
  //      whose thumbnails were uploaded in landscape (rare but happens) or
  //      whose dimensions weren't returned.
  //   3. Title contains a "shorts" token on a token boundary, or the watch
  //      URL contains "/shorts/" — defensive catches for the long-tail of
  //      Shorts that escape both the aspect and duration heuristics.
  //
  // Aspect-ratio null (no thumbnail dimensions) is treated as "unknown,
  // allow" so we don't false-positive on legacy uploads. The duration and
  // title checks still apply.
  const SHORTS_TITLE_RE = /(^|\s|[#:/])shorts?(\s|$|[#:/!?.])/i;
  const isVerticalAspect = c.aspectRatio !== null && c.aspectRatio < 1.0;
  const isShortDuration = c.durationSeconds > 0 && c.durationSeconds <= 60;
  const isShortByTitleOrUrl = SHORTS_TITLE_RE.test(c.title) || c.url.includes("/shorts/");
  if (isVerticalAspect || isShortDuration || isShortByTitleOrUrl) {
    const reason =
      isVerticalAspect ? `vertical video (aspect=${c.aspectRatio!.toFixed(2)})` :
      isShortDuration ? `youtube short (${c.durationSeconds}s)` :
      "youtube short (title/url)";
    return {
      ...c, score: 0, displayScore: 0, reasons: [],
      rejected: true,
      rejectReason: reason,
    };
  }
  if (c.durationSeconds < window.min) {
    return { ...c, score: 0, displayScore: 0, reasons: [], rejected: true, rejectReason: `too short for ${intentType}` };
  }
  if (c.durationSeconds > window.max) {
    return { ...c, score: 0, displayScore: 0, reasons: [], rejected: true, rejectReason: `too long for ${intentType}` };
  }

  let score = 0;
  const titleLower = c.title.toLowerCase();
  const descLower = c.description.toLowerCase();
  const channelLower = c.channelTitle.toLowerCase();
  const matchedQueryLower = (input.matchedQuery ?? "").toLowerCase();

  // Subject hit (+50), matched on a WORD BOUNDARY (not raw substring).
  //
  // GENERAL rule (no hardcoded name lists): only a MULTI-WORD full name is a
  // safe standalone anchor. A bare single-token name is never trusted as an
  // anchor by itself, because a single token collides with everyone who shares
  // it — "william" matches "William Shatner", "dave" matches any Dave. This
  // holds for ANY project, not just specific names. The full name ("Prince
  // William", "Dave Kindig") is required for the title/desc anchor; single-word
  // sources are caught instead by the thumbnail/clip face-check, which judges
  // by the actual person rather than the name string.
  //
  // Word-boundary matching additionally prevents substring collisions
  // ("williamsburg" never matches "william").
  const subjectLower = input.mainCelebrity?.toLowerCase().trim() ?? "";
  const aliasLowers = (input.aliases ?? [])
    .map((a) => a.toLowerCase().trim())
    .filter((a) => a && a !== subjectLower);
  const allVariants = subjectLower ? [subjectLower, ...aliasLowers] : aliasLowers;
  // Multi-word variants only — single bare tokens are not safe anchors.
  const subjectVariants = allVariants.filter((v) => v.includes(" "));
  // Word-boundary matcher: the variant must appear as whole word(s).
  function hitsAsWord(hay: string, needle: string): boolean {
    if (!needle) return false;
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\W)${esc}(\\W|$)`, "i").test(hay);
  }
  const subjectHit = subjectVariants.find((v) =>
    hitsAsWord(titleLower, v) || hitsAsWord(descLower, v) || hitsAsWord(channelLower, v)
  );
  if (subjectHit) {
    score += 50;
    reasons.push(`subject:${subjectHit}`);
  }

  // Context-term hit (+35 once). Context terms are recurring proper nouns tied
  // to the subject — "Kindig It Design", "Bitchin Rides", "Britain's Got
  // Talent". They're the secondary anchor when a result doesn't restate the
  // celebrity by name.
  //
  // Normalize curly vs straight apostrophes on BOTH sides — YouTube titles
  // often use the typographic apostrophe ('Britain's Got Talent') while our
  // context terms come from Gemini as plain ASCII. Without normalization a
  // valid match like "Britain's Got Talent" silently misses.
  function normApostrophes(s: string): string {
    return s.replace(/[''`]/g, "'");
  }
  const titleNorm = normApostrophes(titleLower);
  const descNorm = normApostrophes(descLower);
  const contextLowers = (input.contextTerms ?? [])
    .map((t) => normApostrophes(t.toLowerCase().trim()))
    .filter((t) => t && !subjectVariants.includes(t));
  const contextHit = contextLowers.find((t) => titleNorm.includes(t) || descNorm.includes(t));
  if (contextHit) {
    score += 35;
    reasons.push(`context:${contextHit}`);
  }

  // Segment-topic word hit (+25). We tokenise the topic phrase the same way
  // we tokenise keywords so "lawsuit / Creative Controls" lights up against
  // a title containing "lawsuit" without needing exact-string match.
  const topicTokens = tokenizeKeyword(input.segmentTopic ?? "");
  const topicHit = topicTokens.find((t) => titleLower.includes(t) || descLower.includes(t));
  if (topicHit) {
    score += 25;
    reasons.push(`topic:${topicHit}`);
  }

  // Matched query contained the subject (+20). Captures the "this candidate
  // came from a subject-anchored search" signal independently from whether
  // the title itself restates the name.
  if (subjectLower && matchedQueryLower.includes(subjectLower)) {
    score += 20;
    reasons.push("query contains subject");
  }

  // Channel name looks like the subject's own channel (+15). Catches
  // celebrity-owned and topic-specific channels (e.g. "Kindig It Design",
  // "Margot Robbie Fan Channel") even when the individual title is sparse.
  if (subjectVariants.some((v) => channelLower.includes(v))) {
    score += 15;
    reasons.push("channel matches subject");
  }

  // Tokenize keywords across the whole bag, dedupe, then count distinct token
  // hits. Substring-matching the full keyword string ("Princess Diana Prince
  // Charles wedding early royal life") never matched real titles, so kwHits
  // stayed at 0 and ranking collapsed to the duration tie-breaker.
  const tokenSet = new Set<string>();
  for (const kw of input.keywords) for (const t of tokenizeKeyword(kw)) tokenSet.add(t);
  // Don't double-count tokens that are part of the subject/aliases/context
  // we already scored above — they would otherwise compound the +50/+35 hit.
  for (const v of [...subjectVariants, ...contextLowers]) {
    for (const t of tokenizeKeyword(v)) tokenSet.delete(t);
  }
  let titleHits = 0;
  let descHits = 0;
  for (const t of tokenSet) {
    if (titleLower.includes(t)) { titleHits++; reasons.push(`title:${t}`); }
    else if (descLower.includes(t)) { descHits++; reasons.push(`desc:${t}`); }
  }
  // Subject-first re-tune: keyword/script tokens are now a weak tie-breaker,
  // not a driver. We discover footage by SUBJECT, not by sentence wording, so
  // the keyword contribution is capped low (was +40, now +20) and per-token
  // weights are halved (3/1 vs 6/2). A result still needs ≥1 content signal
  // (subject / context / segment-entity / keyword) to survive, but a pile of
  // generic keyword hits can no longer outweigh a real subject match.
  score += Math.min(titleHits * 3 + descHits * 1, 20);

  // Reference-channel bonus (+60). The dominant signal after the subject
  // anchor itself: a user added this channel precisely because it produces the
  // clean, on-style footage we want. Big enough that a reference-channel
  // result beats an open-YouTube fallback with the same subject hit.
  if (input.referenceChannel) {
    score += 60;
    reasons.push("reference channel");
  }

  const approvedChannelHit = input.approvedChannelIds.has(c.channelId);
  if (approvedChannelHit) {
    score += 25;
    reasons.push("approved channel");
  }

  // Sweet spot varies by intent type.
  if (c.durationSeconds >= window.sweetMin && c.durationSeconds <= window.sweetMax) {
    score += 10;
    reasons.push(`sweet-spot duration (${intentType})`);
  }

  // Longer-source preference (talking-head only). The client's reference
  // channels are full of 15-25 min interviews/episodes — exactly the footage
  // we want, because one long source yields MANY distinct clips and keeps the
  // per-source duration high. The old flat +10 sweet-spot (capped at 15 min)
  // gave a 4-minute clip the same credit as a 22-minute interview, so short
  // clips were winning selection slots and the total selected duration came
  // out small. Reward duration above the sweet-spot floor on a graduated
  // curve (up to +15 at ~20 min) so a substantial source outranks a sliver of
  // the same subject. b-roll / archival are intentionally excluded — those
  // intents legitimately surface as short cutaways.
  if (intentType === "talking_head" && c.durationSeconds > window.sweetMin) {
    const overMinutes = (c.durationSeconds - window.sweetMin) / 60;
    const lengthBonus = Math.min(15, Math.round(overMinutes * 1.0));
    if (lengthBonus > 0) {
      score += lengthBonus;
      reasons.push(`long-source +${lengthBonus} (${Math.round(c.durationSeconds / 60)}min)`);
    }
  }

  // Penalize obvious junk. (#shorts handled earlier as a hard reject; this
  // covers compilations and ranking-style videos that don't yield clean
  // single-subject cuts.) The subject-first redesign added the editorial
  // formats the client explicitly flagged as low-value source material —
  // fan edits, reaction/commentary videos, top-N listicles, and slideshows.
  // These are heuristics on the title token; a strong subject hit elsewhere
  // can still keep a borderline title in the pool, but the penalty is large
  // enough that a "Simon Cowell reaction compilation" loses to a clean
  // "Simon Cowell interview".
  // Multi-word / unambiguous phrases: plain substring match is safe.
  for (const bad of [
    "compilation",
    "funniest moments",
    "tier list",
    "fan edit",
    "fan-edit",
    "fanedit",
    "fancam",
    "reacts to",
    "commentary",
    "top 10",
    "top10",
    "top ten",
    "slideshow",
  ]) {
    if (titleLower.includes(bad)) { score -= 20; reasons.push(`-junk:${bad}`); }
  }
  // Short ambiguous tokens that need a word boundary so we don't penalise
  // "credited"/"edition"/"meditation" (edit) or "creaction" etc. \b on each
  // side keeps the match to the standalone word.
  for (const bad of ["reaction", "edit", "explained"]) {
    if (new RegExp(`\\b${bad}\\b`, "i").test(titleLower)) {
      score -= 20;
      reasons.push(`-junk:${bad}`);
    }
  }
  // Penalise titles that scream "unrelated product / tutorial / company
  // profile" — these are the exact failure modes the user flagged (iPhone
  // Creative Controls tutorials, "Creative Power Controls (Company Profile)"
  // explainer diagrams). The penalty is heavy enough to outweigh the +25
  // segment-topic hit so a tutorial that happens to share a word with the
  // segment doesn't slip through.
  for (const bad of ["company profile", "how to disable", "how to enable", "how to use", "tutorial", "app review", "product review"]) {
    if (titleLower.includes(bad) && !subjectHit) { score -= 30; reasons.push(`-offtopic:${bad}`); }
  }

  // Hard reject for INHERITED segments that come back with zero subject /
  // alias / context / segment-entity anchor in the result. Inherited
  // segments are the ones where the section never re-stated the subject's
  // name; the only way to keep them on-topic is to demand the result
  // mentions the subject (or one of the section's named entities)
  // somewhere. Without this rule, a section about a lawsuit pulls
  // "iPhone Creative Controls tutorial" — the matched query tokens align
  // but nothing in the result is about the subject.
  const segmentEntityLowers = (input.segmentEntities ?? [])
    .map((t) => normApostrophes(t.toLowerCase().trim()))
    .filter((t) => t.length >= 3 && !subjectVariants.includes(t));
  const segmentEntityHit = segmentEntityLowers.find(
    (t) => titleNorm.includes(t) || descNorm.includes(t),
  );
  if (segmentEntityHit && !contextHit && !subjectHit) {
    // Treat a segment-entity hit as a secondary anchor (slightly weaker
    // than a context-term hit because segment entities are scoped to one
    // section, not the whole project).
    score += 20;
    reasons.push(`segment_entity:${segmentEntityHit}`);
  }
  if (input.inheritedSegment && !subjectHit && !contextHit && !segmentEntityHit) {
    return { ...c, score: 0, displayScore: 0, reasons, rejected: true, rejectReason: "inherited segment without subject/context anchor" };
  }

  // STRICT subject gate (subject-first discovery). The result MUST name the
  // subject (full name / strong alias) or a context term — a lone keyword
  // token isn't enough. This is what stops wrong-person leakage from
  // many-celebrity reference channels. The reference-channel +60 bonus does
  // NOT exempt a result from this check; a "reference" upload of the wrong
  // person is exactly what we're rejecting.
  if (input.requireSubjectAnchor && !subjectHit && !contextHit && !segmentEntityHit) {
    return { ...c, score: 0, displayScore: 0, reasons, rejected: true, rejectReason: "no subject anchor (wrong person / off-topic)" };
  }

  // Require at least one real content signal. Duration alone (+10) used to
  // wave through tourist clips and unrelated paparazzi videos because the
  // ranker had nothing else to weigh — they passed the duration window and
  // rendered as "100" in the UI. Approved channel counts as a signal too.
  const hasContentSignal = !!subjectHit || !!contextHit || !!segmentEntityHit || !!topicHit || titleHits > 0 || descHits > 0 || approvedChannelHit;
  if (!hasContentSignal) {
    return { ...c, score: 0, displayScore: 0, reasons, rejected: true, rejectReason: "no keyword or subject match" };
  }

  // Normalize for the UI bar. Clamp to [0, 100] so the rare junk-penalized
  // negative score and the (very rare) over-max score still render sanely.
  const displayScore = Math.max(0, Math.min(100, Math.round((score / MAX_RANK_SCORE) * 100)));

  return { ...c, score, displayScore, reasons, rejected: false };
}

// ---------------------------------------------------------------------------
// Approved source videos (cross-project memory — Phase 3 search tier)
// ---------------------------------------------------------------------------

// Normalize an entity value into the cross-project lookup key. Lowercase +
// whitespace-collapse so "Simon Cowell" and "simon  cowell" map to one row.
export function entityKeyFor(entityValue: string): string {
  return entityValue.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ApprovedSourceVideo {
  youtubeVideoId: string;
  url: string | null;
  title: string | null;
  channelId: string | null;
  channelTitle: string | null;
  durationSeconds: number | null;
}

// Look up previously-approved source videos for a set of entity values. Used as
// the second discovery tier (between reference channels and open YouTube): a
// video the user approved for "Simon Cowell" in an earlier project is seeded as
// a top candidate in a new Simon Cowell project at ZERO API cost. Dedupes by
// videoId across entities; ordered by approved_count desc (most-trusted first).
export async function loadApprovedSourceVideos(entityValues: string[]): Promise<ApprovedSourceVideo[]> {
  const keys = Array.from(new Set(entityValues.map(entityKeyFor).filter(Boolean)));
  if (keys.length === 0) return [];
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("approved_source_videos")
    .select("youtube_video_id, url, title, channel_id, channel_title, duration_seconds, approved_count")
    .in("entity_key", keys)
    .order("approved_count", { ascending: false });
  if (error) throw new Error(`approved sources: ${error.message}`);
  const seen = new Set<string>();
  const out: ApprovedSourceVideo[] = [];
  for (const r of data ?? []) {
    if (!r.youtube_video_id || seen.has(r.youtube_video_id)) continue;
    seen.add(r.youtube_video_id);
    out.push({
      youtubeVideoId: r.youtube_video_id,
      url: r.url ?? null,
      title: r.title ?? null,
      channelId: r.channel_id ?? null,
      channelTitle: r.channel_title ?? null,
      durationSeconds: r.duration_seconds ?? null,
    });
  }
  return out;
}

// Record that the user approved a source video for an entity. Upserts on
// (entity_key, youtube_video_id), bumping approved_count on repeat approvals so
// the most-trusted sources surface first in future lookups. Best-effort: a
// write failure is surfaced to the caller (route) but should not block the
// user's approval action.
export async function recordApprovedSource(params: {
  entityValue: string;
  entityType?: string | null;
  video: ApprovedSourceVideo;
  fromProjectId?: string | null;
}): Promise<void> {
  const sb = getServerSupabase();
  const entity_key = entityKeyFor(params.entityValue);
  if (!entity_key || !params.video.youtubeVideoId) return;
  // Read current count to bump it (Supabase has no atomic increment in the JS
  // client without an RPC; a read-then-write race only undercounts trust, which
  // is harmless for ranking).
  const { data: existing } = await sb
    .from("approved_source_videos")
    .select("approved_count")
    .eq("entity_key", entity_key)
    .eq("youtube_video_id", params.video.youtubeVideoId)
    .maybeSingle();
  const nextCount = ((existing?.approved_count as number | undefined) ?? 0) + 1;
  const { error } = await sb.from("approved_source_videos").upsert(
    {
      entity_key,
      entity_type: params.entityType ?? null,
      youtube_video_id: params.video.youtubeVideoId,
      url: params.video.url,
      title: params.video.title,
      channel_id: params.video.channelId,
      channel_title: params.video.channelTitle,
      duration_seconds: params.video.durationSeconds,
      approved_from_project_id: params.fromProjectId ?? null,
      approved_count: nextCount,
    },
    { onConflict: "entity_key,youtube_video_id" },
  );
  if (error) throw new Error(`record approved source: ${error.message}`);
}

// A reference channel the subject-centric pipeline searches first, ordered by
// `priority` (lower runs first). Only enabled, approved rows with a channelId
// are eligible.
export interface ReferenceChannel {
  channelId: string;
  channelTitle: string | null;
  priority: number;
}

// Load enabled reference channels in search order (priority asc, then oldest
// first as a stable tie-breaker). These are the channels Phase A of the search
// processor scopes its subject queries to before any open YouTube fallback.
export async function loadReferenceChannels(): Promise<ReferenceChannel[]> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("channel_rules")
    .select("channel_id, channel_title, priority, created_at")
    .eq("rule", "approved")
    .eq("enabled", true)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Reference channels: ${error.message}`);
  const out: ReferenceChannel[] = [];
  for (const r of data ?? []) {
    if (!r.channel_id) continue;
    out.push({ channelId: r.channel_id, channelTitle: r.channel_title ?? null, priority: r.priority ?? 100 });
  }
  return out;
}

// Resolve a user-pasted channel reference (a /channel/UC… URL, an @handle, a
// /c/ or /user/ vanity URL, or a bare handle) to its canonical channelId +
// title. Returns null when nothing resolves. Used by the settings UI when a
// user adds a reference channel — we store the resolved UC… id, never the
// raw handle, because search.list's channelId filter only accepts UC ids.
export async function resolveChannel(ref: string): Promise<{ channelId: string; channelTitle: string } | null> {
  const env = getEnv();
  if (!env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY not configured");
  const raw = ref.trim();
  if (!raw) return null;

  // 1) Already a canonical channel id (UC… , 24 chars) or /channel/UC… URL.
  const channelIdMatch = raw.match(/(UC[0-9A-Za-z_-]{22})/);
  if (channelIdMatch) {
    const params = new URLSearchParams({ part: "snippet", id: channelIdMatch[1], key: env.YOUTUBE_API_KEY });
    const r = await fetch(`${CHANNELS_URL}?${params}`);
    if (r.ok) {
      const json = await r.json();
      const item = (json.items ?? [])[0];
      if (item) return { channelId: item.id, channelTitle: item.snippet?.title ?? raw };
    }
  }

  // 2) Handle (@name) — channels.list supports forHandle directly.
  const handleMatch = raw.match(/@([A-Za-z0-9._-]+)/) ?? (/^[A-Za-z0-9._-]+$/.test(raw) ? [raw, raw] : null);
  if (handleMatch) {
    const params = new URLSearchParams({ part: "snippet", forHandle: handleMatch[1], key: env.YOUTUBE_API_KEY });
    const r = await fetch(`${CHANNELS_URL}?${params}`);
    if (r.ok) {
      const json = await r.json();
      const item = (json.items ?? [])[0];
      if (item) return { channelId: item.id, channelTitle: item.snippet?.title ?? raw };
    }
  }

  // 3) Last resort — search.list for the name and take the top channel hit.
  // Covers legacy /c/ and /user/ vanity URLs that have no handle.
  const q = raw.replace(/https?:\/\/(www\.)?youtube\.com\/(c\/|user\/)?/i, "").replace(/@/, "");
  const params = new URLSearchParams({
    part: "snippet", q, type: "channel", maxResults: "1", key: env.YOUTUBE_API_KEY,
  });
  const r = await fetch(`${SEARCH_URL}?${params}`);
  if (r.ok) {
    const json = await r.json();
    const item = (json.items ?? [])[0];
    const id = item?.id?.channelId;
    if (id) return { channelId: id, channelTitle: item.snippet?.title ?? raw };
  }
  return null;
}

export async function loadChannelRules(): Promise<{ approved: Set<string>; blocked: Set<string> }> {
  const sb = getServerSupabase();
  const { data, error } = await sb.from("channel_rules").select("channel_id, rule");
  if (error) throw new Error(`Channel rules: ${error.message}`);
  const approved = new Set<string>();
  const blocked = new Set<string>();
  for (const r of data ?? []) {
    if (!r.channel_id) continue;
    if (r.rule === "approved") approved.add(r.channel_id);
    else if (r.rule === "blocked") blocked.add(r.channel_id);
  }
  return { approved, blocked };
}

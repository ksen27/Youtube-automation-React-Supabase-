import { z } from "zod";
import { getEnv } from "@/lib/env";
import { getServerSupabase } from "@/lib/supabase/server";

// YouTube Data API v3 wrapper.
// Quota: each search.list call is ~100 units; videos.list is 1.
// API key: enable "YouTube Data API v3" at https://console.cloud.google.com/apis

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

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

  const r = await fetch(`${SEARCH_URL}?${params}`);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
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

  // Hydrate with full duration / privacy info
  const vparams = new URLSearchParams({
    part: "snippet,contentDetails,status",
    id: ids.join(","),
    key: env.YOUTUBE_API_KEY,
  });
  const vr = await fetch(`${VIDEOS_URL}?${vparams}`);
  if (!vr.ok) {
    const txt = await vr.text().catch(() => "");
    throw new Error(`YouTube videos.list failed: ${vr.status} ${txt.slice(0, 300)}`);
  }
  const vjson = await vr.json();
  const out: YoutubeCandidate[] = [];
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
  return out;
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
}

export interface RankedCandidate extends YoutubeCandidate {
  score: number;          // raw score, can be negative or above 100
  displayScore: number;   // 0–100 normalized for the UI bar
  reasons: string[];
  rejected: boolean;
  rejectReason?: string;
}

// Theoretical max raw score after the subject-anchor refactor:
//   +50 subject in title/desc/channel
//   +35 context term in title/desc
//   +25 segment topic word in title/desc
//   +20 matched query contains the subject
//   +15 channel name contains the subject (heuristic celebrity channel)
//   +25 approved channel
//   +10 sweet-spot duration
//   +40 keyword token cap (unchanged)
// Total = 220. The UI bar normalises through MAX_RANK_SCORE so a +50/+20 hit
// still renders as a healthy bar without saturating.
export const MAX_RANK_SCORE = 220;

// Duration windows per intent. b-roll and archival often surface as short
// clips (30–120s) on YouTube — applying the talking-head floor would reject
// exactly the visuals we need for places, events, and historical moments.
const DURATION_WINDOWS: Record<IntentType, { min: number; max: number; sweetMin: number; sweetMax: number }> = {
  talking_head: { min: 120, max: 1500, sweetMin: 240, sweetMax: 900 },
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

  // Subject + alias hit (+50). An alias hitting the title counts as a subject
  // anchor — "Kindig" in a title is just as strong a signal as "Dave Kindig"
  // for a project anchored on Dave Kindig.
  const subjectLower = input.mainCelebrity?.toLowerCase().trim() ?? "";
  const aliasLowers = (input.aliases ?? [])
    .map((a) => a.toLowerCase().trim())
    .filter((a) => a && a !== subjectLower);
  const subjectVariants = subjectLower ? [subjectLower, ...aliasLowers] : aliasLowers;
  const subjectHit = subjectVariants.find((v) =>
    titleLower.includes(v) || descLower.includes(v) || channelLower.includes(v)
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
  score += Math.min(titleHits * 6 + descHits * 2, 40);

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

  // Penalize obvious junk. (#shorts handled earlier as a hard reject; this
  // covers compilations and ranking-style videos that don't yield clean
  // single-subject cuts.)
  for (const bad of ["compilation", "funniest moments", "tier list"]) {
    if (titleLower.includes(bad)) { score -= 10; reasons.push(`-junk:${bad}`); }
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

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

const VideoItemSchema = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string(),
    description: z.string().optional().default(""),
    channelId: z.string(),
    channelTitle: z.string(),
    liveBroadcastContent: z.string().optional(),
  }),
  contentDetails: z.object({
    duration: z.string(),
  }),
  status: z.object({
    privacyStatus: z.string().optional(),
  }).optional(),
});

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
    });
  }
  return out;
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

// Theoretical max raw score: 40 (celebrity) + 40 (token cap) + 25 (approved
// channel) + 10 (sweet-spot duration). Used to normalize for the UI so a
// duration-only +10 hit doesn't render as a full bar.
export const MAX_RANK_SCORE = 115;

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
  if (c.durationSeconds < window.min) {
    return { ...c, score: 0, displayScore: 0, reasons: [], rejected: true, rejectReason: `too short for ${intentType}` };
  }
  if (c.durationSeconds > window.max) {
    return { ...c, score: 0, displayScore: 0, reasons: [], rejected: true, rejectReason: `too long for ${intentType}` };
  }

  let score = 0;
  const titleLower = c.title.toLowerCase();
  const descLower = c.description.toLowerCase();

  const celebrityHit = !!(
    input.mainCelebrity && titleLower.includes(input.mainCelebrity.toLowerCase())
  );
  if (celebrityHit) {
    score += 40;
    reasons.push("title contains main celebrity");
  }

  // Tokenize keywords across the whole bag, dedupe, then count distinct token
  // hits. Substring-matching the full keyword string ("Princess Diana Prince
  // Charles wedding early royal life") never matched real titles, so kwHits
  // stayed at 0 and ranking collapsed to the duration tie-breaker.
  const tokenSet = new Set<string>();
  for (const kw of input.keywords) for (const t of tokenizeKeyword(kw)) tokenSet.add(t);
  // Don't double-count tokens that are part of the celebrity name we already
  // scored above.
  if (input.mainCelebrity) {
    for (const t of tokenizeKeyword(input.mainCelebrity)) tokenSet.delete(t);
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

  // Penalize obvious junk
  for (const bad of ["#shorts", "compilation", "funniest moments", "tier list"]) {
    if (titleLower.includes(bad)) { score -= 10; reasons.push(`-junk:${bad}`); }
  }

  // Require at least one real content signal. Duration alone (+10) used to
  // wave through tourist clips and unrelated paparazzi videos because the
  // ranker had nothing else to weigh — they passed the duration window and
  // rendered as "100" in the UI. Approved channel counts as a signal too.
  const hasContentSignal = celebrityHit || titleHits > 0 || descHits > 0 || approvedChannelHit;
  if (!hasContentSignal) {
    return { ...c, score: 0, displayScore: 0, reasons, rejected: true, rejectReason: "no keyword or celebrity match" };
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

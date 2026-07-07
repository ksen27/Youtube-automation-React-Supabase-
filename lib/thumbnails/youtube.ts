// Resolve a user-supplied reference into an image URL for Pikzels.
//
// The user can paste a YouTube video URL (watch / youtu.be / shorts / embed)
// OR already have a direct image URL (e.g. an uploaded reference re-hosted to
// R2). YouTube exposes each video's thumbnail at a stable path derived from the
// video id, so we never call the YouTube API — we just build the URL.

import { getEnv } from "@/lib/env";

// Prefer maxres; YouTube serves hqdefault for every video but maxresdefault
// only exists when the uploader supplied a high-res custom thumbnail. Pikzels
// just needs a fetchable style reference, and hqdefault (480x360) is always
// present, so we use it as the safe default. Callers wanting the sharpest
// available can swap to maxresdefault at their own risk of a 404.
export function youtubeThumbnailUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

// Extract the 11-char video id from any common YouTube URL shape. Returns null
// when the string isn't a recognizable YouTube URL (so the caller can treat it
// as a direct image URL instead).
export function extractYouTubeId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;

  // Bare 11-char id.
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }

  const host = u.hostname.replace(/^www\./, "");
  const idRe = /^[a-zA-Z0-9_-]{11}$/;

  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return idRe.test(id) ? id : null;
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    // watch?v=<id>
    const v = u.searchParams.get("v");
    if (v && idRe.test(v)) return v;
    // /shorts/<id> , /embed/<id> , /v/<id>
    const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
  }

  return null;
}

// Turn one raw reference input into an image URL for Pikzels. A YouTube URL
// becomes its thumbnail URL; anything else is assumed to already be a direct
// image URL (http/https) and passed through. Returns null for empty/garbage.
export function resolveReferenceUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;

  const ytId = extractYouTubeId(s);
  if (ytId) return youtubeThumbnailUrl(ytId);

  // Direct image URL (uploaded reference re-hosted to R2, or a pasted image).
  if (/^https?:\/\//i.test(s)) return s;

  return null;
}

// ---------------------------------------------------------------------------
// Channel thumbnails — the input to style analysis
// ---------------------------------------------------------------------------

export interface ChannelThumbnails {
  channelId: string;
  channelTitle: string;
  // Thumbnail image URLs of the channel's recent uploads, newest-first.
  thumbnailUrls: string[];
}

// The YouTube Data API key the /thumbnails feature uses. Prefers the DEDICATED
// thumbnail key (YOUTUBE_API_KEY_THUMBNAILS) — put it in a separate Google
// Cloud project for its own 10,000/day quota so channel analysis never eats the
// celebrity video engine's YouTube quota — and falls back to the shared
// YOUTUBE_API_KEY when the dedicated one isn't set.
function thumbnailYoutubeKey(): string {
  const env = getEnv();
  const key = env.YOUTUBE_API_KEY_THUMBNAILS || env.YOUTUBE_API_KEY;
  if (!key) throw new Error("No YouTube API key configured (YOUTUBE_API_KEY_THUMBNAILS or YOUTUBE_API_KEY)");
  return key;
}

// Resolve a pasted YouTube CHANNEL url/@handle to its canonical UC… id + title.
// Self-contained (uses the thumbnail key, not the video engine) so the /thumbnails
// feature has its own quota. Order: explicit /channel/UC… id -> @handle
// (forHandle) -> name search (last resort, 100 units). Returns null if nothing
// resolves. channels.list / search.list are 1 / 100 units respectively.
async function resolveChannelForThumbnails(
  ref: string,
): Promise<{ channelId: string; channelTitle: string } | null> {
  const key = thumbnailYoutubeKey();
  const raw = ref.trim();
  if (!raw) return null;
  const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
  const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

  // 1) Canonical channel id (UC…, 24 chars) or /channel/UC… URL.
  const idMatch = raw.match(/(UC[0-9A-Za-z_-]{22})/);
  if (idMatch) {
    const p = new URLSearchParams({ part: "snippet", id: idMatch[1], key });
    const r = await fetch(`${CHANNELS_URL}?${p}`);
    if (r.ok) {
      const item = ((await r.json()).items ?? [])[0];
      if (item) return { channelId: item.id, channelTitle: item.snippet?.title ?? raw };
    }
  }
  // 2) @handle — channels.list supports forHandle directly (1 unit).
  const handleMatch = raw.match(/@([A-Za-z0-9._-]+)/) ?? (/^[A-Za-z0-9._-]+$/.test(raw) ? [raw, raw] : null);
  if (handleMatch) {
    const p = new URLSearchParams({ part: "snippet", forHandle: handleMatch[1], key });
    const r = await fetch(`${CHANNELS_URL}?${p}`);
    if (r.ok) {
      const item = ((await r.json()).items ?? [])[0];
      if (item) return { channelId: item.id, channelTitle: item.snippet?.title ?? raw };
    }
  }
  // 3) Last resort — name search (100 units). Covers legacy /c/ and /user/ URLs.
  const q = raw.replace(/https?:\/\/(www\.)?youtube\.com\/(c\/|user\/)?/i, "").replace(/@/, "");
  const p = new URLSearchParams({ part: "snippet", q, type: "channel", maxResults: "1", key });
  const r = await fetch(`${SEARCH_URL}?${p}`);
  if (r.ok) {
    const item = ((await r.json()).items ?? [])[0];
    const id = item?.id?.channelId;
    if (id) return { channelId: id, channelTitle: item.snippet?.title ?? raw };
  }
  return null;
}

// Resolve a pasted YouTube CHANNEL url/@handle to its canonical id, then pull
// the thumbnail urls of its most recent uploads — the sample Gemini analyzes to
// learn the channel's thumbnail style. Uses the dedicated thumbnail key and the
// cheap uploads-playlist recall (~1 quota unit for the playlist), so a normal
// @handle/channel-URL analyze costs only a couple of units.
//
// `count` caps how many thumbnails we collect (client wants ~5–10). We derive
// each thumbnail from its videoId at a stable, always-present resolution
// (hqdefault) so a missing maxres never leaves a gap. Throws when the channel
// can't be resolved or has no uploads.
export async function fetchChannelThumbnails(
  channelInput: string,
  count = 10,
): Promise<ChannelThumbnails> {
  const key = thumbnailYoutubeKey();
  const resolved = await resolveChannelForThumbnails(channelInput);
  if (!resolved) {
    throw new Error(`Could not resolve a YouTube channel from: "${channelInput.slice(0, 80)}"`);
  }
  if (!/^UC[0-9A-Za-z_-]{22}$/.test(resolved.channelId)) {
    throw new Error(`Resolved a non-canonical channel id for "${channelInput.slice(0, 80)}"`);
  }

  // Every channel's uploads live in a playlist whose id is the channel id with
  // "UC" → "UU". playlistItems.list is 1 unit for up to 50 items.
  const uploadsPlaylistId = "UU" + resolved.channelId.slice(2);
  const PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";
  const p = new URLSearchParams({
    part: "contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.min(50, Math.max(count, count + 5))),
    key,
  });
  const r = await fetch(`${PLAYLIST_ITEMS_URL}?${p}`);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Could not list channel uploads (${r.status}): ${txt.slice(0, 200)}`);
  }
  const json = await r.json();
  const urls: string[] = [];
  for (const item of json.items ?? []) {
    const vid = item?.contentDetails?.videoId;
    if (typeof vid === "string") urls.push(youtubeThumbnailUrl(vid));
    if (urls.length >= Math.max(1, count)) break;
  }
  if (urls.length === 0) {
    throw new Error(`Channel "${resolved.channelTitle}" has no usable recent uploads to learn a style from.`);
  }
  return {
    channelId: resolved.channelId,
    channelTitle: resolved.channelTitle,
    thumbnailUrls: urls,
  };
}

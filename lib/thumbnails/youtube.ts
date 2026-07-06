// Resolve a user-supplied reference into an image URL for Pikzels.
//
// The user can paste a YouTube video URL (watch / youtu.be / shorts / embed)
// OR already have a direct image URL (e.g. an uploaded reference re-hosted to
// R2). YouTube exposes each video's thumbnail at a stable path derived from the
// video id, so we never call the YouTube API — we just build the URL.

import { resolveChannel, searchReferenceChannelViaPlaylist } from "@/lib/youtube/search";

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

// Resolve a pasted YouTube CHANNEL url/@handle to its canonical id, then pull
// the thumbnail urls of its most recent uploads — the sample Gemini analyzes to
// learn the channel's thumbnail style. Reuses the video engine's channel
// resolver + cheap uploads-playlist recall (~1 quota unit), so this costs
// almost nothing on quota.
//
// `count` caps how many thumbnails we collect (client wants ~5–10). We fetch
// via the uploads playlist and derive each thumbnail from its videoId at a
// stable, always-present resolution (hqdefault) so a missing maxres never
// leaves a gap. Throws when the channel can't be resolved or has no uploads.
export async function fetchChannelThumbnails(
  channelInput: string,
  count = 10,
): Promise<ChannelThumbnails> {
  const resolved = await resolveChannel(channelInput);
  if (!resolved) {
    throw new Error(`Could not resolve a YouTube channel from: "${channelInput.slice(0, 80)}"`);
  }
  const uploads = await searchReferenceChannelViaPlaylist(
    resolved.channelId,
    // Empty query -> no client-side term filter; we want the channel's most
    // recent uploads regardless of topic (the style is topic-independent).
    "",
    Math.min(50, Math.max(count, count + 5)),
  );
  const urls = uploads
    .map((v) => youtubeThumbnailUrl(v.videoId))
    .slice(0, Math.max(1, count));
  if (urls.length === 0) {
    throw new Error(`Channel "${resolved.channelTitle}" has no usable recent uploads to learn a style from.`);
  }
  return {
    channelId: resolved.channelId,
    channelTitle: resolved.channelTitle,
    thumbnailUrls: urls,
  };
}

// Shared synthetic-engine constants.

// Appended to EVERY image prompt (nano-banana / Flux) so generated stills share
// the client's required "candid documentary" look instead of a studio-render
// aesthetic. Per spec — do not edit without client sign-off.
export const STYLE_PROMPT =
  "Candid video frame grab, mid-range consumer camera quality, slightly " +
  "compressed JPEG artifact look, natural daylight or golden hour lighting, " +
  "handheld camera feel with subtle motion softness, authentic documentary " +
  "style, no studio lighting, real-world environment, slightly overexposed " +
  "highlights, muted earthy color grading, shallow depth of field on subject, " +
  "background slightly out of focus, grainy texture consistent with 1080p " +
  "video still, no filters, unposed candid moment. " +
  // Client requirement (2026-06): every still must be ONE single full-frame
  // photo of ONE subject — nano-banana was drawing multi-subject COLLAGES
  // (e.g. a calendar next to a garden path) that read as a "split image" in
  // the right half of split_2 blocks, and was burning TEXT/captions/numbers
  // into frames (e.g. calendar dates, "cook rice"). Both are forbidden here.
  "A SINGLE photograph of ONE subject filling the whole frame — NOT a collage, " +
  "NOT a split-screen, NOT a grid, NOT a diptych or triptych, NOT multiple " +
  "panels or side-by-side images, NO borders or dividing lines between scenes. " +
  "Absolutely NO text, NO captions, NO subtitles, NO letters, NO numbers, " +
  "NO words, NO watermark, NO logo, NO signage, NO calendar, NO labels of any kind.";

/** Append the mandatory style prompt to a base image prompt. */
export function withStylePrompt(basePrompt: string): string {
  const base = basePrompt.trim().replace(/[.,\s]+$/, "");
  return `${base}. ${STYLE_PROMPT}`;
}

// Output canvas for the synthetic engine (matches the sourced render).
export const SYNTHETIC_WIDTH = 1280;
export const SYNTHETIC_HEIGHT = 720;
export const SYNTHETIC_FPS = 30;

// R2 key prefixes for synthetic assets, kept together so storage layout is
// easy to audit / sweep. {projectId} is substituted by callers.
export const r2Keys = {
  masterVoiceover: (projectId: string) => `synthetic/${projectId}/master_voiceover.mp3`,
  segmentImage: (projectId: string, segmentId: string) =>
    `synthetic/${projectId}/images/${segmentId}.jpg`,
  segmentRightImage: (projectId: string, segmentId: string) =>
    `synthetic/${projectId}/images/${segmentId}_right.jpg`,
  segmentVideo: (projectId: string, segmentId: string) =>
    `synthetic/${projectId}/clips/${segmentId}.mp4`,
  // Avatar (or split_2 left-half) video. An optional `version` suffix makes a
  // REGENERATE write to a NEW URL instead of overwriting the same key. Without
  // it, the new render reused the same URL and the CDN/browser kept serving the
  // STALE cached copy — so a regenerated avatar showed the OLD video (old aspect
  // ratio / duration) until the cache expired. A fresh URL has nothing cached to
  // serve. The DB row stores this exact URL, so the app always points at the new
  // file. Omit `version` for the legacy stable key (back-compat).
  avatarVideo: (projectId: string, segmentId: string, version?: string | number) =>
    version != null && `${version}` !== ""
      ? `synthetic/${projectId}/avatars/${segmentId}_${version}.mp4`
      : `synthetic/${projectId}/avatars/${segmentId}.mp4`,
  avatarShot: (projectId: string, segmentId: string, label: string) =>
    `synthetic/${projectId}/heygen-shots/${segmentId}_${label}.png`,
  // Cached audio slice uploaded to HeyGen for an avatar part. Keyed by the
  // spoken WINDOW (start/end, ms) as well as the segment so a TIMING EDIT or a
  // re-aligned voiceover produces a NEW key — the old cached slice is never
  // reused for a changed window. Lets a regenerate skip re-downloading the full
  // master voiceover and re-cutting when the window is unchanged.
  avatarAudioSlice: (projectId: string, segmentId: string, startMs: number, endMs: number) =>
    `synthetic/${projectId}/avatar-audio/${segmentId}_${startMs}_${endMs}.mp3`,
};

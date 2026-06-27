// Shared synthetic-engine constants.

// Appended to EVERY image prompt (nano-banana / Flux) so generated stills share
// the client's required "regular person filmed it on their phone" look instead
// of a polished cinema / stock-photo aesthetic. Per spec — do not edit without
// client sign-off.
//
// Realism fix (client requirement 2026-06): the previous style produced
// gorgeous-but-fake frames — shallow depth of field, dreamy background bokeh,
// golden-hour grade — which read as professional stock footage / a CGI render,
// NOT as someone filming their own garden on a phone. The client wants the
// "own vlog" feel. So we now push the OPPOSITE of cinematic: a smartphone has a
// tiny sensor, so EVERYTHING is in focus (deep depth of field, no creamy bokeh),
// the light is flat/even/ambient (no cinematic golden-hour rim light), framing
// is plain and a little imperfect, and the overall look is an ordinary,
// authentic phone snapshot — real, not arty. Keep it clean (not ugly/blurry),
// just unmistakably amateur-real rather than produced.
export const STYLE_PROMPT =
  "Amateur smartphone photo taken by an ordinary person, candid phone snapshot " +
  "of a real everyday scene, shot on a typical mobile phone camera. " +
  // Realism via LOWER quality (client requirement 2026-06): our stills read as
  // AI precisely because they are TOO clean / TOO sharp / TOO perfect. Real phone
  // footage has imperfections AI generators don't add by default. So deliberately
  // degrade toward authentic low-fi capture — a slightly grainy, soft, compressed
  // real photo, NOT a pristine render. Moderate, not broken: still readable.
  "Slightly low quality like a real phone video frame grab: visible digital " +
  "sensor noise and fine grain, mild softness and lack of perfect sharpness, " +
  "light JPEG / video compression artifacts, slightly imperfect exposure with " +
  "mildly blown highlights and a little muddy shadow detail, subtle handheld " +
  "motion softness. NOT crisp, NOT pristine, NOT high-resolution studio quality, " +
  "NOT clean — an ordinary, slightly rough real-camera capture. " +
  "EVERYTHING in focus front to back (deep depth of field, large in-focus area " +
  "like a phone lens) — NO shallow depth of field, NO blurred or creamy bokeh " +
  "background, NO cinematic background blur. Flat, even, natural ambient daylight " +
  "(overcast or plain daylight) — NOT golden hour, NOT dramatic rim light, NOT " +
  "moody cinematic lighting, no lens flare. Plain, slightly imperfect handheld " +
  "framing, ordinary realistic colors (NOT a stylized cinematic color grade), " +
  "real-world clutter and texture, unposed and unedited. Looks like a normal " +
  "person's phone photo, NOT professional photography, NOT " +
  "stock footage, NOT a cinema shot, NOT a CGI render, no filters. " +
  // Client requirement (2026-06): every still must be ONE single full-frame
  // photo of ONE subject — nano-banana was drawing multi-subject COLLAGES
  // (e.g. a calendar next to a garden path) that read as a "split image" in
  // the right half of split_2 blocks. The collage ban is unconditional; the
  // TEXT/label/logo ban is split out below so product lines can opt out.
  "A SINGLE photograph of ONE subject filling the whole frame — NOT a collage, " +
  "NOT a split-screen, NOT a grid, NOT a diptych or triptych, NOT multiple " +
  "panels or side-by-side images, NO borders or dividing lines between scenes.";

// The no-text / no-logo ban, split OUT of STYLE_PROMPT so it can be suppressed
// for product/brand lines (client sign-off 2026-06 to relax the blanket ban).
// nano-banana otherwise burns stray TEXT/captions/numbers (calendar dates,
// "cook rice") into frames, so this stays on for every NON-product still.
const NO_TEXT_RULE =
  "Absolutely NO text, NO captions, NO subtitles, NO letters, NO numbers, " +
  "NO words, NO watermark, NO logo, NO signage, NO calendar, NO labels of any kind.";

// When a product line opts out of the text ban we still don't want a wall of
// stray text — only the product's own real packaging/label/logo, nothing else.
const PRODUCT_TEXT_RULE =
  "The product's real packaging, label, or brand/company logo MAY appear ON the " +
  "product itself (this is a product shot). Do NOT add any OTHER text, captions, " +
  "subtitles, watermarks, or unrelated signage anywhere else in the frame.";

// Heuristic: a composed prompt is a "product line" when it asks to show a
// product / packaging / label / logo (the planner's PRODUCT_BRAND_RULE leads
// these with a "product shot" shotType and names the packaging). We key off the
// prompt text so no extra column has to thread from planner → processor.
const PRODUCT_LINE_RE = /\b(product shot|packaging|label|logo|brand|bag of|bottle of)\b/i;
export function isProductPrompt(prompt: string): boolean {
  return PRODUCT_LINE_RE.test(prompt);
}

/**
 * Append the mandatory style prompt to a base image prompt. For product/brand
 * lines (isProductPrompt) the blanket no-text ban is swapped for the narrower
 * PRODUCT_TEXT_RULE so the product's own label/logo can show; every other still
 * keeps the strict no-text ban.
 */
export function withStylePrompt(basePrompt: string): string {
  const base = basePrompt.trim().replace(/[.,\s]+$/, "");
  const textRule = isProductPrompt(base) ? PRODUCT_TEXT_RULE : NO_TEXT_RULE;
  return `${base}. ${STYLE_PROMPT} ${textRule}`;
}

// Output canvas for the synthetic engine (matches the sourced render).
export const SYNTHETIC_WIDTH = 1280;
export const SYNTHETIC_HEIGHT = 720;
export const SYNTHETIC_FPS = 30;

// R2 key prefixes for synthetic assets, kept together so storage layout is
// easy to audit / sweep. {projectId} is substituted by callers.
export const r2Keys = {
  masterVoiceover: (projectId: string) => `synthetic/${projectId}/master_voiceover.mp3`,
  // Image / clip keys take an optional `version` suffix so a REGENERATE writes a
  // NEW file instead of overwriting the previous one — keeping prior versions in
  // R2 so the review screen can show + restore them (mirrors avatarVideo). Omit
  // version for the legacy stable key (back-compat with assets generated before
  // versioning; their history simply starts from the next regenerate).
  segmentImage: (projectId: string, segmentId: string, version?: string | number) =>
    version != null && `${version}` !== ""
      ? `synthetic/${projectId}/images/${segmentId}_${version}.jpg`
      : `synthetic/${projectId}/images/${segmentId}.jpg`,
  segmentRightImage: (projectId: string, segmentId: string, version?: string | number) =>
    version != null && `${version}` !== ""
      ? `synthetic/${projectId}/images/${segmentId}_right_${version}.jpg`
      : `synthetic/${projectId}/images/${segmentId}_right.jpg`,
  segmentVideo: (projectId: string, segmentId: string, version?: string | number) =>
    version != null && `${version}` !== ""
      ? `synthetic/${projectId}/clips/${segmentId}_${version}.mp4`
      : `synthetic/${projectId}/clips/${segmentId}.mp4`,
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

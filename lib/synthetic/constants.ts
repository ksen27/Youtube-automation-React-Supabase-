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

// ---------------------------------------------------------------------------
// ACTION CLIPS (client direction 2026-08-17, Loom + chat).
// ---------------------------------------------------------------------------
// The client's ask: a clip must show a PERSON PERFORMING THE ACTION the
// voiceover is describing (stirring, pouring milk into a bowl) — "human
// movement, actions in the clips, not just random zoom".
//
// This REVERSES the 2026-06-28 direction, which forbade motion outright, and
// the reversal is only safe because the two complaints are about DIFFERENT
// THINGS MOVING:
//   - June 2026: the CAMERA moved (pans, push-ins with shake/blur cues) and the
//     footage read as blurry and jumpy. That is still rejected.
//   - August 2026: the SUBJECT doesn't move, so every clip is a zoom on a
//     photo. That is what we are fixing now.
// So the rule is: LOCK THE CAMERA OFF COMPLETELY, and let ONLY THE PERSON move.
// A static frame of someone pouring milk satisfies both — it is unmistakably an
// action, with zero camera motion to blur. Confirmed 2026-08-17 against test
// renders on both clip engines (LTX-2 and 69labs Veo 3.1 Lite).
//
// Keep the low-fi cues: an action clip still has to match the surrounding
// footage's amateur-phone texture, or the moving shots stand out as the
// polished ones.
export const ACTION_CLIP_RULE =
  "Show the PERSON PERFORMING THE ACTION — a single, clearly readable everyday " +
  "human action carried through the whole shot (hands doing the thing the " +
  "narration describes: pouring, stirring, lifting, wiping, planting). " +
  "The CAMERA IS COMPLETELY STILL AND LOCKED OFF on a tripod — absolutely NO " +
  "camera movement of any kind: no push-in, no zoom, no pan, no tilt, no " +
  "tracking, no orbit, no camera shake. ONLY THE PERSON AND THE OBJECTS THEY " +
  "TOUCH MOVE; the framing never changes. " +
  // SPEED, 2026-08-22. Was "Natural real-time speed — NOT slow motion, NOT sped
  // up". Client on a real 720p test clip: "the video is quick movement so some
  // issue is happend / pls generate the slow movement clip". This REVERSES the
  // 2026-08-17 wording; the two asks are about different things and both hold:
  // that one banned SLOW-MOTION-AS-AN-EFFECT (a stylised ramp), this one asks
  // for the action itself to be performed unhurriedly. "Not sped up" is kept for
  // that reason.
  "The movement is SLOW, calm and deliberate — unhurried, gentle and gradual, " +
  "carried smoothly through the whole shot; no sudden, rushed or jerky motion, " +
  "NOT sped up, no dramatic or cinematic movement, no motion blur on the camera. " +
  // HAND CONSISTENCY, 2026-08-22. Client: "the hands(right and left) is
  // different with each other". The library's negative prompt already covers
  // "disfigured hands / wrong hand count", but only WITHIN a frame — it says
  // nothing about hands mutating BETWEEN frames, which is the actual artifact.
  // Stating the invariant positively works better than another negative.
  "The SAME TWO HANDS stay consistent from the first frame to the last — " +
  "identical shape, size, skin tone and five fingers each; the hands never " +
  "swap, morph, duplicate or change. " +
  "Handheld phone video look, slightly low quality and grainy like a real home " +
  "vlog clip — not smooth, not cinematic, no colour grading, no on-screen text.";

// Negative prompt for the clip lane.
//
// WHY WE OVERRIDE THE LIBRARY DEFAULT: diffusers' DEFAULT_NEGATIVE_PROMPT
// suppresses "grainy texture, excessive noise, low contrast, washed out colors"
// — which is a direct fight with ACTION_CLIP_RULE above, where the house style
// asks for exactly that low-fi vlog texture. Our prompt was asking for grain
// while the negative prompt removed it. It also lacks any between-frame hand
// terms. This list keeps the useful structural negatives, drops the ones that
// fight the style, and adds the hand/speed artifacts the client reported.
export const CLIP_NEGATIVE_PROMPT =
  "blurry, out of focus, distorted proportions, deformed facial features, " +
  "extra limbs, disfigured hands, wrong hand count, mismatched hands, " +
  "hands changing shape, morphing fingers, extra fingers, missing fingers, " +
  "left and right hand swapping, warping hands, hands that do not match each " +
  "other, fast motion, sped up, rushed movement, jerky movement, sudden " +
  "movement, jittery movement, camera shake, camera movement, zoom, pan, tilt, " +
  "unnatural transitions, 3D CGI look, cartoonish rendering, uncanny valley " +
  "effect, on-screen text";

// The animation prompt used when a block has no per-block one of its own (the
// planner failed to write one, or the block was promoted to ai_clip by a later
// balance/quota pass). Generic on purpose: it must read as an action on ANY
// scene, since we don't know what the still shows here.
export const DEFAULT_ACTION_ANIMATION_PROMPT =
  "The person in the frame continues the everyday action they are already doing, " +
  "carrying it through naturally from start to finish. " +
  ACTION_CLIP_RULE;

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

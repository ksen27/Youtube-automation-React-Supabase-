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
  "Show the SUBJECT PERFORMING THE ACTION the narration describes — one " +
  "clearly readable action carried through the whole shot. " +
  // 2026-08-25: this used to read "hands doing the thing the narration
  // describes", which is why every clip came back as disembodied hands. Where
  // there is a person, show the person doing it; hands alone are one option
  // among many, not the house style.
  "When a person is in the scene, show THE PERSON doing it — their body and " +
  "posture in frame, working — not a close-up of hands alone. Hands-only " +
  "framing is allowed when the action genuinely is a pair of hands at work, " +
  "never as the default. When no person is in the scene, the thing itself " +
  "moves and NO hands, arms or people enter the frame at any point. " +
  "The CAMERA IS COMPLETELY STILL AND LOCKED OFF on a tripod — absolutely NO " +
  "camera movement of any kind: no push-in, no zoom, no pan, no tilt, no " +
  "tracking, no orbit, no camera shake. ONLY THE PERSON AND THE OBJECTS THEY " +
  "TOUCH MOVE; the framing never changes. " +
  // SPEED, revised 2026-08-25. The 2026-08-22 wording ("The movement is SLOW,
  // calm and deliberate") was written for the client's "pls generate the slow
  // movement clip" note, and it overshot: paired with the negative prompt's
  // "sudden movement / rushed movement" terms, a LOCKED-OFF camera and a 4s
  // clip, nothing in frame was left allowed to move at a visible rate. Clips
  // came back reading as stills, which is the 2026-08-17 complaint ("human
  // movement, actions in the clips, not just random zoom") all over again from
  // the other direction.
  //
  // What the client reported on 2026-08-22 is SMEAR, not speed — and smear is
  // fought by the artifact terms in CLIP_NEGATIVE_PROMPT (smearing, ghosting,
  // motion smear, trailing artifacts), which is where that fight belongs. So: a
  // steady natural pace, plus an explicit requirement that the action READS —
  // it has to start and finish inside the clip.
  "NEVER a product-turntable shot: the object must not spin, rotate, revolve or orbit on its own, and the frame must not circle around it. A thing rotating in space is stock-video filler and is rejected on sight. " +
  // SLOW, take two (client 2026-08-26, repeating the 2026-08-22 ask). The first
  // attempt failed because it slowed the PACE while leaving the ACTION large:
  // told to do a whole task slowly inside 4 seconds, the model either rushed it
  // or moved almost nothing, and the clips read as stills. The fix is to slow
  // the pace AND shrink the action, so a small movement has the whole clip to
  // travel a visible distance. "Unhurried but clearly visible" is the wording
  // that survived on AMBIENT_MOTION_ANIMATION_PROMPT through that revert.
  // SLOW, take three (client 2026-08-27: scrolling their timeline saying
  // "Image. Image. Image." at clips that were technically animated).
  //
  // Take one (2026-08-22) slowed the PACE and was reverted for producing
  // stills. Take two (2026-08-26) slowed the pace AND told the model to pick a
  // SMALL movement, on the theory that a small movement has time to complete.
  // That was worse, and measurably so: of 78 clips in a shipped project, 97%
  // carried a dampening word and 59% named no travelling action at all --
  // "slowly adjusts a dial", "gently places a sample in a bag". A small slow
  // movement behind a locked-off camera for four seconds is a photograph.
  //
  // The mistake both times was treating this as a question of SPEED. It is a
  // question of DISTANCE: how much of the frame changes between the first
  // frame and the last. A hand crossing the frame at an ordinary pace reads as
  // video; a fingertip rotating a dial does not, at any speed.
  "SOMETHING MUST TRAVEL. The clip has FOUR SECONDS and a camera that never " +
  "moves, so the only thing that can tell a viewer this is video and not a " +
  "photograph is a subject that visibly CROSSES THE FRAME. Choose an action " +
  "with real distance in it: someone walking in or out, a hand carrying " +
  "something from one side to the other, a lid coming off, a drawer pulled " +
  "open, liquid pouring, a door swinging, a vehicle moving through, a person " +
  "turning fully to face the camera, an object being lifted clear and set down " +
  "somewhere else. " +
  "THE TEST, and it is the client's own: if the first frame and the last frame " +
  "could be mistaken for the same photograph, the clip has FAILED. A fingertip " +
  "turning a dial, a hand resting on a surface, someone shifting their weight, " +
  "eyes moving, a slight adjustment — all of these fail it. " +
  "Pace is ORDINARY and natural, the speed a real person does a real thing. " +
  "Not hurried, not jerky, NOT sped up, and NOT a slow-motion effect — but do " +
  "NOT describe the action as slow, gentle, careful, deliberate or subtle " +
  "either. Those words shrink the movement until nothing happens. " +
  "No dramatic or cinematic movement, no motion blur on the camera. " +
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
  // MOTION ARTIFACTS, 2026-08-22. Client: the moving part of the clip is
  // "blur and not clear" while the rest is fine. Separate from the encoder-side
  // cause (see ENCODE_PRESET in services/ltx-selfhost/server.py): a diffusion
  // model also resolves moving regions less sharply than static ones, so name
  // the artifact directly rather than relying on the generic "blurry" above.
  "other, smearing, ghosting, motion smear, temporal flicker, warping, " +
  "melting shapes, trailing artifacts, soft or blurred hands while moving, " +
  "loss of detail during movement, " +
  // MOTION SUPPRESSION, removed 2026-08-25. This list used to carry "fast
  // motion, sped up, rushed movement, sudden movement" on top of the SLOW
  // wording in ACTION_CLIP_RULE — two independent brakes on the same pedal, and
  // between them the subject stopped moving at all. "jerky / jittery" stay:
  // those name an ARTIFACT (stepped, unstable motion), not a speed, so they
  // cost nothing that should be there.
  "jerky movement, jittery movement, stuttering motion, " +
  // Camera terms only. ACTION_CLIP_RULE locks the camera off; the SUBJECT is
  // supposed to move, so nothing here may suppress subject motion.
  "camera shake, camera movement, camera zoom, camera pan, camera tilt, " +
  // Added with the same edit: the failure this lane now has to avoid is a clip
  // indistinguishable from its own source still.
  "static frozen frame, no movement, still photograph, motionless subject, " +
  "unnatural transitions, 3D CGI look, cartoonish rendering, uncanny valley " +
  "effect, on-screen text";

// The animation prompt used when a block has no per-block one of its own (the
// planner failed to write one, or the block was promoted to ai_clip by a later
// balance/quota pass). Generic on purpose: it must read as an action on ANY
// scene, since we don't know what the still shows here.
export const DEFAULT_ACTION_ANIMATION_PROMPT =
  // "continues the action" used to invite the whole task. Naming ONE small
  // beat of it is what lets the slow pace below stay visible — see the SLOW
  // note on ACTION_CLIP_RULE.
  "The person in the frame carries on the everyday action they are already " +
  "doing, but the clip shows just ONE small, simple beat of it — a single " +
  "unhurried movement carried through from start to finish. " +
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

import { z } from "zod";
import { getEnv } from "@/lib/env";
import { withGeminiModelFallback, makeLimit } from "@/lib/ai/gemini";
import { getServerSupabase } from "@/lib/supabase/server";
import { logJob } from "@/lib/jobs/db";
import type { WordTiming } from "@/lib/ai/deepgram";
import { alignSentencesToWords } from "@/lib/ai/sentence-alignment";
import type { Sentence } from "@/lib/ai/sentences";
import type { SyntheticBlockType } from "@/lib/types";
import { type AvatarMarkRange, type AvatarModel } from "@/lib/synthetic/doc-marks";

// Synthetic timeline planner. Gemini reads the transcript and segments it into
// ordered visual blocks, choosing a block_type per the spec rules:
//   * Emotional / first-person statements      -> avatar
//   * Explanations / factual exposition         -> image
//   * Action / dynamic scenes                   -> ai_clip
//   * Mixed explanation (talk + illustrate)     -> split_2
//
// Each segment carries the narration it covers plus an imagePrompt (for
// image/ai_clip/split_2) and an animationPrompt (for ai_clip). The mandatory
// STYLE_PROMPT is appended later at image-generation time, NOT here, so the
// stored prompt stays editable on the review screen without the boilerplate.
//
// After Gemini returns segment text, we align each segment to the master
// voiceover using Deepgram word timings so start/end/duration reflect real
// spoken time (same principle as the sourced engine's sentence alignment).

const PLANNER_BLOCK_TYPES: SyntheticBlockType[] = ["avatar", "image", "ai_clip", "split_2"];

// Optional STRING field that tolerates an explicit JSON `null`. Gemini emits
// `"imagePrompt": null` (etc.) for blocks that legitimately have no value (an
// avatar block has no image prompt) and the salvage path for a MAX_TOKENS-
// truncated response also yields nulls. z.string().optional().default("") does
// NOT coerce an explicit null — it only fills a MISSING key — so a single null
// threw "Expected string, received null" and failed the ENTIRE plan (observed
// on a re-plan: 100+ salvaged segments rejected wholesale). nullish + a
// null->"" transform makes these fields accept null and normalize it to "".
const optString = () =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? "");

const GeminiSegmentSchema = z.object({
  blockType: z.enum(["avatar", "image", "ai_clip", "split_2"]),
  // The contiguous slice of transcript this block covers. Used to find the
  // block's spoken window in the word timings.
  script: z.string().min(1),
  imagePrompt: optString(),
  // The shot type / framing for this block's still, rotated across the video so
  // consecutive images don't all read as the same "hands-in-the-dirt close-up".
  // Drives real visual VARIETY (scale + angle) on top of the subject change. See
  // SHOT_TYPES / the shot-variety rule. Empty -> generation adds no shot hint.
  shotType: optString(),
  // A SECOND, genuinely DIFFERENT scene for the same sentence. A long sentence
  // (> SYNTHETIC_BLOCK_SPLIT_THRESHOLD) is covered by TWO visuals; without a
  // distinct prompt the second one reused imagePrompt + a weak "different angle"
  // suffix and nano-banana drew a near-clone. imagePrompt2 lets Gemini describe
  // a different subject / moment / detail OF THE SAME sentence so the two
  // visuals don't look like duplicates. Only used when the block actually splits
  // (short blocks ignore it); empty for avatar blocks.
  imagePrompt2: optString(),
  // Shot type for the SECOND visual — different from shotType so the two frames
  // of a split sentence differ in framing as well as subject.
  shotType2: optString(),
  animationPrompt: optString(),
});
const GeminiResponseSchema = z.object({
  // A global "style bible" for the whole video: the recurring subjects, setting,
  // era, and mood that every block shares. Composed in FRONT of each block's
  // scene-specific imagePrompt at persist time so adjacent blocks describing the
  // same scene generate as one continuous world instead of drifting apart.
  basePrompt: optString(),
  segments: z.array(GeminiSegmentSchema),
});

export interface PlannedSegment {
  position: number;
  blockType: SyntheticBlockType;
  startTime: number;
  endTime: number;
  duration: number;
  script: string;
  imagePrompt: string | null;
  // Shot type / framing hint for this block's still (e.g. "macro close-up",
  // "wide establishing shot", "product shot"). Rotated across blocks for visual
  // variety; folded into the composed image_prompt at persist time.
  shotType?: string | null;
  // A distinct second scene for the SAME sentence, used as the second visual's
  // prompt when a long sentence is split (see splitByDuration). Null/undefined
  // when Gemini didn't supply one — then the second visual falls back to varying
  // imagePrompt via the secondVisual nudge.
  imagePrompt2?: string | null;
  // Shot type for the SECOND visual (paired with imagePrompt2).
  shotType2?: string | null;
  animationPrompt: string | null;
  // Which HeyGen model an avatar-bearing block renders with. Set by avatar
  // marking from the doc-highlight color (red -> avatar_iv, orange ->
  // avatar_iii). Null on every non-avatar block; null on an avatar block means
  // the worker default (Avatar IV). See applyMark / coalesceAvatarSegments.
  avatarModel?: AvatarModel | null;
  // True for the SECOND visual attached to a long sentence (see
  // splitByDuration). The second visual prefers imagePrompt2; if that's absent
  // this flag tells the persist step to nudge imagePrompt to a different
  // composition/angle so the two frames aren't identical.
  secondVisual?: boolean;
  // True when this block absorbed a following short sentence
  // (mergeShortVisualSegments). Its script now covers MULTIPLE sentences but
  // its imagePrompt is still the first sentence's, so the planner regenerates
  // one combined imagePrompt for the merged script before persist.
  needsPromptRegen?: boolean;
}

// Shared single-subject / no-text rule (client requirement 2026-06). Used by
// BOTH the full planner prompt and the per-segment prompt regenerator so they
// produce identically-clean prompts. nano-banana was drawing multi-subject
// collages (read as a "split image") and burning text/captions into frames.
const SINGLE_SUBJECT_RULE =
  "SINGLE SUBJECT (critical, client requirement): the imagePrompt MUST " +
  "describe ONE single photographic scene with ONE clear subject that fills the " +
  "whole frame. NEVER describe a collage, split-screen, grid, diptych, side-by-" +
  "side comparison, before/after, or multiple separate scenes in one image, and " +
  "NEVER ask for any text, caption, label, sign, calendar, or written words in " +
  "the picture. One block = one clean single photo of one subject. " +
  "SCOPE: this rule governs the CONTENT of one generated still only — it does " +
  "NOT discourage the 'split_2' blockType. split_2 is a player-side LAYOUT " +
  "(a talking presenter beside a separate illustrative still, composited at " +
  "render time), NOT a collage drawn inside one image, so keep choosing split_2 " +
  "whenever the narration calls for it; its imagePrompt still follows this rule " +
  "(one clean single-subject still for the illustrative half). " +
  // Client requirement 2026-07 (space/Voyager regen): the model kept showing the
  // subject as a PICTURE OF A PICTURE — a galaxy on a TV/monitor mounted on a
  // wall, a scientist drawing the sun on a whiteboard, a diagram on a screen —
  // instead of the real thing. Those read as "a screen/office again", the exact
  // thing the client rejected, and the whiteboard/diagram also smuggles text
  // back in. The still must BE the scene, not a depiction of it.
  "DIRECT SCENE, NOT A DEPICTION (critical, client requirement): show the real " +
  "subject ITSELF, filling the frame as if photographed on location — NOT the " +
  "subject shown on a screen, TV, monitor, projector, phone, computer, framed " +
  "picture, poster, whiteboard, chalkboard, diagram, map, or as an illustration/" +
  "sketch/painting/hologram. For a space line show actual space (the planet, the " +
  "spacecraft, the star field), never a galaxy on a wall-mounted screen or a " +
  "scientist drawing it on a board. A screen/monitor/whiteboard may appear ONLY " +
  "when the narration is literally about that device or about someone working at " +
  "it. " +
  // Client requirement 2026-07: when the narration names a real/famous/private
  // person (e.g. "Louise Brown"), naming them in the imagePrompt makes the
  // image/video provider REFUSE or STALL the job (real-likeness hard-blocks), and
  // a named private individual's likeness is never reliably reproduced anyway. So
  // the picture prompt must describe people GENERICALLY by visual traits, never by
  // name. The SPOKEN narration keeps the name — only the imagePrompt is de-named.
  "NO REAL NAMES (critical, client requirement): NEVER put a real person's name " +
  "— famous, private, or public-figure — in the imagePrompt, and never give an " +
  "unmistakable identifying description of one specific real individual. If the " +
  "narration names someone, describe them GENERICALLY by the visual traits the " +
  "scene needs: approximate age, gender, era-appropriate clothing, setting, mood, " +
  "action. Example: NOT 'Louise Brown with her two sons' but 'an elderly woman " +
  "with two grown adult sons, smiling together in a 1970s family home, warm " +
  "nostalgic tone'. The spoken script is unchanged — the name stays in the " +
  "voiceover; only the picture prompt is de-named.";

// The video's derived niche/world. Filled by deriveVideoTopic() from the
// project title + a transcript sample so the planner prompt anchors visuals to
// the ACTUAL subject of the video (car maintenance, cooking, finance, gardening,
// …) instead of the previously-hardcoded gardening/lawn-care niche. Every field
// may be empty — when the whole topic is empty the rule builders below fall back
// to niche-neutral phrasing so nothing regresses to a fixed domain.
export interface VideoTopic {
  // Short human niche label, e.g. "automotive / DIY car maintenance".
  niche: string;
  // Recurring physical setting, e.g. "home garage / driveway, under the hood".
  setting: string;
  // A few example on-topic subjects, e.g. "spark plugs, engine bays, hand tools".
  subjectExamples: string;
  // Wider real-world context/action scenes of the niche — the subject in use or
  // in motion in its environment, e.g. "utes driving on highways, vehicles on
  // outback roads" for an engine video. Feeds the context-variety rule so the
  // visuals aren't ONLY literal close-ups of the narrated object (client
  // feedback 2026-07: an engine video should also show cars driving as B-roll).
  environmentExamples: string;
}

const EMPTY_TOPIC: VideoTopic = { niche: "", setting: "", subjectExamples: "", environmentExamples: "" };

function hasTopic(t: VideoTopic): boolean {
  return Boolean(t.niche.trim() || t.setting.trim() || t.subjectExamples.trim() || t.environmentExamples.trim());
}

// Object-first B-roll rule (client requirement 2026-06). The reference channel
// reads as the creator filming his OWN scene, not a stock library: when the
// narration names a THING, the screen shows THAT thing (script says "water" ->
// show water; "clogged gutter" -> show the gutter; "spark plug" -> show the
// plug; "engine" -> show the engine bay), NOT a person. Our earlier output
// leaned on people (an old lady / an old man / the presenter) for lines that
// were really about objects, which read as generic stock footage. So the
// DEFAULT subject is the concrete object, tool, or place the line is about —
// shoot it close, hands-on B-roll, owner's-own-project feel. Only put a PERSON
// in frame when the narration is genuinely about a person or a first-person
// action; never as filler for an object-focused line. The subject/setting
// examples are derived from the video's actual topic (VideoTopic) so this rule
// stays on-niche for ANY channel instead of the old hardcoded garden wording.
function brollObjectRule(topic: VideoTopic): string {
  const settingPhrase = topic.setting.trim()
    ? `their own ${topic.setting.trim()}`
    : "their own real setting for this video";
  const examplePhrase = topic.subjectExamples.trim()
    ? `— e.g. ${topic.subjectExamples.trim()}, a tool, water, a part, a surface, etc. —`
    : "— a tool, a part, an object, a place, etc. —";
  const brollPhrase = topic.setting.trim()
    ? `close, candid, hands-on B-roll of the real object in ${topic.setting.trim()}`
    : "close, candid, hands-on B-roll of the real object in the video's own setting";
  return (
    "B-ROLL, OBJECTS NOT PEOPLE (critical, client requirement): this is an " +
    `owner filming ${settingPhrase}, NOT a stock-photo library. When the narration ` +
    `names a concrete thing ${examplePhrase} the imagePrompt MUST show THAT thing ` +
    `as the single subject (${brollPhrase}), NOT a person. Do NOT default to ` +
    "people (no 'an elderly woman', 'a man' standing there) for lines that are " +
    "about objects — that reads as generic stock footage, which the client does " +
    "NOT want. Put a PERSON in frame ONLY when the line is genuinely about a " +
    "person or a first-person action; otherwise show the object / part / place itself."
  );
}

// Context-variety rule (client feedback 2026-07). The object-first rule above
// made every visual a literal close-up of the narrated thing — an engine video
// became wall-to-wall engine bays. The client wants the niche's WIDER world on
// screen too: the subject in use / in motion in its real environment (for an
// engine video, the vehicles those engines live in driving on real roads). The
// environment examples come from deriveVideoTopic() so this stays generic for
// any niche; when the topic is empty the phrasing stays niche-neutral.
function contextVarietyRule(topic: VideoTopic): string {
  const envPhrase = topic.environmentExamples.trim()
    ? `(e.g. ${topic.environmentExamples.trim()})`
    : "(the thing being used, driven, cooked, grown, worn… out in its real environment)";
  return (
    "CONTEXT VARIETY (critical, client requirement): do NOT make every visual a " +
    "literal close-up of the exact object the narration names — that reads as the " +
    "same shot over and over. A meaningful share of blocks (roughly one in three) " +
    "MUST instead show the niche's WIDER real-world context: the subject in use or " +
    `in motion in its environment ${envPhrase}. These context shots are on-topic ` +
    "and in-world — prefer them for imagePrompt2 second visuals, for " +
    "wide/establishing shotTypes, and for abstract or filler lines (describe the " +
    "scene as a captured moment; the camera-motion rules elsewhere still apply). " +
    "When the narration keeps returning to the same " +
    "object for several blocks in a row, break the run with a context shot rather " +
    "than another close-up of that same object. The object-first rule above still " +
    "decides the DEFAULT subject when a line names a concrete thing; this rule " +
    "supplies the variety around it."
  );
}

// Amateur-real look rule (client requirement 2026-06). Even though the phone-shot
// STYLE_PROMPT is appended at generation time, Gemini tends to slip cinematic
// words into the scene prompt ("cinematic", "shallow depth of field", "golden
// hour", "professional photo", "dramatic lighting"), which fight the amateur look
// and bring back the gorgeous-but-fake stock/CGI vibe the client rejected. Forbid
// those here so the scene prompt describes WHAT is shown, never a produced style.
function amateurLookRule(topic: VideoTopic): string {
  const wherePhrase = topic.setting.trim()
    ? `in their own ${topic.setting.trim()}`
    : "in their own real setting";
  return (
    "AMATEUR REAL LOOK (client requirement): describe the scene as if shot by an " +
    `ordinary person on a phone ${wherePhrase}. Do NOT add any cinematic, ` +
    "professional, or stock-photo styling words — NO 'cinematic', NO 'shallow depth " +
    "of field' / 'bokeh' / 'blurred background', NO 'golden hour' / 'dramatic " +
    "lighting' / 'lens flare', NO 'professional photo' / 'award-winning' / '8k'. " +
    "Just describe the real subject and setting plainly; the camera look is added " +
    "separately."
  );
}

// Shot-variety rule (client variety fix 2026-06). The footage all looked the
// same — every still was the same tight close-up — because the prompts changed
// the SUBJECT but never the FRAMING. Each block now picks a `shotType`
// (scale + angle) and consecutive blocks MUST differ, so the video reads as a
// varied edit instead of one repeated shot. shotType describes only camera
// distance/angle, NOT subject and NOT camera-look styling.
const SHOT_TYPES =
  "extreme close-up / macro detail · close-up · medium shot · wide / " +
  "establishing shot · top-down (overhead) shot · low-angle ground-level shot · " +
  "over-the-shoulder shot · product shot (an object presented on a surface)";
const SHOT_VARIETY_RULE =
  "SHOT VARIETY (critical, client requirement): vary the FRAMING across blocks so " +
  "the video is not the same shot over and over. For EVERY image/ai_clip block " +
  "pick a `shotType` from: " + SHOT_TYPES + ". Do NOT use the same shotType on " +
  "two consecutive blocks, and across any run of 4-5 blocks use several DIFFERENT " +
  "shot types — mix scales (some macro, some wide, some overhead) and angles. " +
  "Specifically do NOT default every block to the same tight close-up: only a " +
  "minority of blocks should be extreme close-ups. When a long sentence splits " +
  "into two visuals, give `shotType2` a DIFFERENT framing from `shotType` so the " +
  "two frames don't match. shotType is camera distance/angle ONLY — never put " +
  "subject or film-look words in it.";

// Product / brand exception (client requirement 2026-06, signed off to relax the
// blanket no-text / no-logo ban for product lines ONLY). When the narration is
// genuinely about a specific PRODUCT or BRAND — a named part, a bottle of oil, a
// branded tool — the client WANTS that product shown: its packaging, label, or a
// brand/company logo may appear. This overrides the otherwise-blanket "NO text /
// NO logo / NO label" rule for that one block only; every NON-product block still
// follows the no-text rule strictly.
function productBrandRule(topic: VideoTopic): string {
  const examplePhrase = topic.subjectExamples.trim()
    ? `(e.g. ${topic.subjectExamples.trim()}, a bottle or bag of a named product, a branded tool)`
    : "(e.g. a named part, a bottle or bag of a named product, a branded tool)";
  return (
    "PRODUCT / BRAND LINES (client requirement): when the narration is genuinely " +
    `about a specific product or brand ${examplePhrase}, SHOW THAT PRODUCT as the ` +
    "single subject — its packaging or label, or the product's brand/company logo, " +
    "IS allowed and wanted here (prefer a 'product shot' shotType). This is the ONLY " +
    "case where text/labels/logos are permitted. For every other (non-product) " +
    "line keep the strict no-text, no-label, no-logo rule."
  );
}

function buildPrompt(transcript: string, topic: VideoTopic = EMPTY_TOPIC): string {
  // Niche anchor. When we could derive the video's topic from the title +
  // transcript, we tell Gemini the world up front so EVERY scene stays on-theme
  // — the fix for off-topic visuals (a car video that rendered houses & lawns
  // because the planner never knew the niche). When empty, we emit a neutral
  // instruction so nothing regresses to a hardcoded domain.
  const topicBlock = hasTopic(topic)
    ? [
        `VIDEO SUBJECT / NICHE: ${topic.niche.trim() || topic.setting.trim()}.`,
        topic.setting.trim() ? `Recurring setting: ${topic.setting.trim()}.` : "",
        topic.subjectExamples.trim() ? `On-topic subjects include: ${topic.subjectExamples.trim()}.` : "",
        topic.environmentExamples.trim()
          ? `The niche's wider real-world context is ALSO in-world and on-topic: ${topic.environmentExamples.trim()}.`
          : "",
        "The basePrompt and EVERY imagePrompt MUST stay inside this world. Never",
        "introduce houses, lawns, offices, or any setting unrelated to the video's",
        "subject. When a line is abstract or has no literal scene, invent a visual",
        "from THIS niche (an on-topic object, tool, part, or place), never a",
        "generic unrelated one.",
        // When the subject's world is a remote / non-filmable place (space, the
        // deep sea, Antarctica, wilderness, ancient history), the visuals live in
        // THAT place, not at a desk. This is the fix for space/Antarctica videos
        // that collapsed to wall-to-wall 'man in an office on a computer' — an
        // office is NOT the subject's world for these topics.
        "If this subject's world is a place that cannot be filmed at home (space,",
        "the deep sea, Antarctica / the poles, wilderness, ancient history, an",
        "unexplained-mystery topic), the visuals MUST be set in THAT real world",
        "(the planets, the spacecraft, the ice, the ocean, the site) — do NOT",
        "default to a person talking at a desk, on a computer, or in an office. Show",
        "an office/desk ONLY if the narration is genuinely about office or desk work.",
        "",
      ].filter(Boolean)
    : [
        "Read the whole transcript and infer the video's SUBJECT / niche, then keep",
        "the basePrompt and EVERY imagePrompt inside that world. When a line is",
        "abstract or has no literal scene, invent a visual from the video's own",
        "subject, never a generic unrelated setting.",
        "",
      ];
  // Home is not a garden. A line about being 'home' / indoors must render the
  // INDOOR living space (kitchen, living room, bedroom, hallway, porch), never a
  // backyard, lawn, or vegetable patch — unless the narration is specifically
  // about gardening or being outdoors. This kept leaking on lifestyle/health
  // videos where frequent 'home' mentions drifted into garden footage.
  topicBlock.push(
    "IMPORTANT: 'home' / indoors means the indoor living space (kitchen, living",
    "room, bedroom, hallway) or its immediate porch/doorway — NOT a garden,",
    "backyard, lawn, or vegetable patch. Only use garden or outdoor-plant imagery",
    "when the line is specifically about gardening or being outdoors.",
    "",
  );
  return [
    ...topicBlock,
    "You are a video director planning the visual track for an AI-generated",
    "narrated video. Segment the transcript below into an ordered list of",
    "visual blocks that play in sync with the narration. Cover the ENTIRE",
    "transcript with no gaps and no overlaps — each block's `script` must be a",
    "contiguous slice of the transcript, and concatenating all blocks' script",
    "in order must reproduce the transcript.",
    "",
    "For each block choose exactly one blockType:",
    "  - avatar : emotional, personal, or first-person statements (a person",
    "             talking to camera).",
    "  - image  : explanations / factual exposition best shown with a still.",
    "  - ai_clip: action or dynamic scenes that benefit from motion.",
    "  - split_2: a talking presenter beside an illustrative image, shown",
    "             together. CHOOSE THIS BASED ON THE CONTENT: use it whenever the",
    "             narrator is personally explaining, walking through, or",
    "             commenting on something the viewer should ALSO see beside them",
    "             (e.g. 'here's what I mean…', 'look at this…', a tip the presenter",
    "             demonstrates). It is a normal, useful layout — pick it naturally",
    "             wherever it fits the script, the same way you pick image or",
    "             ai_clip. The only limit: it should not DOMINATE the video (don't",
    "             make it the majority of blocks); a varied mix of all four types",
    "             is the goal.",
    "",
    "Block sizing — ONE SENTENCE = ONE BLOCK. Each block's `script` MUST be a",
    "WHOLE sentence (or a few short, tightly-related sentences). NEVER break a",
    "single sentence across two blocks, and NEVER end a block mid-sentence /",
    "mid-clause — a block always ends at a sentence boundary (. ? !). A long",
    "sentence stays ONE block even if it runs 10-15 seconds; the system covers a",
    "long sentence with multiple visuals automatically, so you do NOT need to",
    "shorten it. Keeping the whole sentence in one block lets you describe a",
    "visual for the COMPLETE thought instead of a fragment.",
    "",
    "FIRST, read the WHOLE transcript and write a single `basePrompt`: the",
    "video's recurring visual world — the SETTING / location type, the era, and",
    "the overall mood ONLY. This is a shared style bible that every block builds",
    "on, added as trailing context to each block. Keep it SHORT (one sentence).",
    "Do NOT bake in a fixed framing or composition (do NOT say 'close-up' or",
    "one repeated shot here) and do NOT name one specific subject — the",
    "framing comes from each block's shotType and the subject from each block's",
    "imagePrompt, both of which MUST vary block to block. Do NOT include camera or",
    "film-grain styling — that is appended separately.",
    // The basePrompt is appended to EVERY block, so a drifted base poisons the
    // whole video. For a non-filmable subject (space, deep sea, Antarctica, …)
    // the model kept inventing an earthbound ROOM for the 'recurring setting' —
    // e.g. 'a 1970s NASA mission control center', 'a dim server room' — which
    // then dragged every block into that room. The recurring WORLD for these
    // subjects IS the subject's real environment, not a control room / office /
    // studio the footage is 'presented' from.
    "IMPORTANT — the basePrompt's SETTING: if this video's subject cannot be",
    "filmed in a home/office/studio (space, the deep sea, Antarctica / the poles,",
    "wilderness, ancient history, an unexplained mystery), the recurring setting",
    "MUST be that real subject world itself (e.g. for a space video: 'deep space,",
    "planets and star fields, the spacecraft among them'), NOT a mission-control",
    "room, server room, laboratory, office, or studio the subject is merely",
    "observed or narrated from. Do NOT put a control room / desk / screens in the",
    "basePrompt unless the video is literally about that room.",
    "",
    "THEN segment the transcript. For EVERY image/ai_clip/split_2 block, write a",
    "concrete `imagePrompt`: ONLY the scene-specific detail for THIS block (the",
    "action, the specific subject and composition of this moment). Do NOT repeat",
    "the basePrompt — assume it is already present. Do NOT include camera or",
    "film-grain styling.",
    "",
    "CRITICAL — the imagePrompt is a PICTURE DESCRIPTION, never the narration.",
    "NEVER copy, paraphrase, or echo the block's `script` into the imagePrompt.",
    "The script is what is SPOKEN; the imagePrompt is what is SHOWN — they are",
    "different things. Every visual block MUST have a non-empty imagePrompt that",
    "describes a real, filmable scene set in the video's world (the basePrompt).",
    "When a line is conversational, abstract, or filler (e.g. 'Be honest, I read",
    "these.', 'the August Panic Method', 'and we are going to fix it') and has no",
    "literal scene, INVENT an on-topic visual that fits the recurring world",
    "(e.g. the presenter in the relevant setting, a relevant object or B-roll of",
    "the subject) — do NOT leave imagePrompt empty and do NOT fall back to the",
    "spoken words. An empty imagePrompt is INVALID output.",
    "",
    "SECOND VISUAL — also write an `imagePrompt2` for EVERY image/ai_clip block.",
    "A long sentence is shown with TWO visuals, so imagePrompt2 is a SECOND,",
    "genuinely DIFFERENT picture of the SAME sentence — a different subject, a",
    "different moment, or a different detail of this same thought (e.g. if",
    "imagePrompt is a close-up of the main object, imagePrompt2 might show a",
    "related detail beside it, or a wide shot of the whole scene). It MUST NOT be the",
    "same scene as imagePrompt with only a reworded angle — make it a DISTINCT",
    "shot so the two visuals never look like duplicates. It follows ALL the same",
    "rules as imagePrompt (picture-not-narration, single-subject, B-roll objects,",
    "amateur look) and gets its own `shotType2` with a DIFFERENT framing than",
    "shotType. If you genuinely cannot think of a second distinct on-topic scene,",
    "you may leave it empty and the system will vary the first one.",
    "",
    SINGLE_SUBJECT_RULE,
    "",
    brollObjectRule(topic),
    "",
    contextVarietyRule(topic),
    "",
    SHOT_VARIETY_RULE,
    "",
    productBrandRule(topic),
    "",
    amateurLookRule(topic),
    "",
    "CONTINUITY (critical): when consecutive blocks describe one continuous",
    "scene, they MUST keep the SAME setting, lighting, subjects, and framing so",
    "they read as one continuous shot. Only change the visual world when the",
    "narration genuinely moves to a new scene.",
    "",
    "For ai_clip blocks also write an `animationPrompt`. The client wants the",
    "motion to be BARELY PERCEPTIBLE — an extremely slow, very slight camera",
    "push-in over an otherwise completely STILL, frozen scene. This is the",
    "reference channel's look. Do NOT describe panning, dramatic action, fast or",
    "sudden motion, camera shake, motion blur, or eventful 'something happening'",
    "in the scene — those make the footage look blurry and jumpy, which the client",
    "rejected. Default to an extremely slow, steady, minimal push-in (e.g.",
    "'extremely slow, very slight push-in, scene completely static, no shake, no",
    "motion blur'). avatar blocks need no prompts.",
    "",
    'Respond ONLY with JSON: {"basePrompt","segments":[{"blockType","script","imagePrompt","shotType","imagePrompt2","shotType2","animationPrompt"}]}',
    "",
    "TRANSCRIPT:",
    transcript.trim(),
  ].join("\n");
}

// Build the prompt for a SINGLE-segment image-prompt regeneration. Mirrors the
// scene-prompt rules of the full planner (CRITICAL picture-not-narration rule +
// the single-subject / no-text rule) but for ONE block: given this block's
// spoken `script` and the video's shared `basePrompt`, return only a fresh
// scene-specific imagePrompt. No segmentation, no JSON array.
function buildSingleSegmentPrompt(
  script: string,
  basePrompt: string,
  blockType: SyntheticBlockType,
  // Scenes the OTHER visuals of this SAME sentence already show. When this block
  // is one of several visuals covering one long sentence, we pass the prior
  // slots' prompts here so Gemini writes a GENUINELY DIFFERENT scene (different
  // subject / moment / detail) instead of a near-clone — the whole point of
  // having multiple visuals on a sentence is variety, not the same frame N times.
  avoidScenes: string[] = [],
): string {
  const wantsAnimation = blockType === "ai_clip";
  const hasAvoid = avoidScenes.filter((s) => s.trim()).length > 0;
  return [
    "You are a video director writing the visual for ONE block of an",
    "AI-generated narrated video. Below is the block's spoken narration",
    "(`script`) and the video's shared visual world (`basePrompt`).",
    "",
    "Write a concrete `imagePrompt`: ONLY the scene-specific detail for THIS",
    "block — the action, the specific subject and composition of this moment.",
    "Do NOT repeat the basePrompt (it is prepended automatically). Do NOT include",
    "camera or film-grain styling (appended separately).",
    "",
    "CRITICAL — the imagePrompt is a PICTURE DESCRIPTION, never the narration.",
    "NEVER copy, paraphrase, or echo the `script` into the imagePrompt. The script",
    "is what is SPOKEN; the imagePrompt is what is SHOWN. When the line is",
    "conversational, abstract, or filler, INVENT an on-topic visual that fits the",
    "video's world — do NOT fall back to the spoken words.",
    ...(hasAvoid
      ? [
          "",
          "DIFFERENT SCENE (critical): this sentence is shown with MULTIPLE visuals.",
          "The OTHER visuals of this same sentence ALREADY show the scene(s) listed",
          "below. Your imagePrompt MUST be a GENUINELY DIFFERENT picture of the same",
          "thought — a different subject, a different moment, or a different detail —",
          "NOT the same scene with a reworded angle. Do NOT reuse the subject or",
          "composition of any already-shown scene; the viewer must see something NEW.",
          "ALREADY-SHOWN scene(s) to avoid repeating:",
          ...avoidScenes.filter((s) => s.trim()).map((s, i) => `  ${i + 1}. ${s.trim()}`),
        ]
      : []),
    "",
    SINGLE_SUBJECT_RULE,
    "",
    // Regeneration anchors the niche via the stored basePrompt (printed below),
    // so the rule text here stays niche-neutral (EMPTY_TOPIC) — no need to
    // re-derive the topic for a single-block regen.
    brollObjectRule(EMPTY_TOPIC),
    "",
    contextVarietyRule(EMPTY_TOPIC),
    "",
    "Also pick a `shotType` (camera framing) from: " + SHOT_TYPES + ". Choose one",
    "that fits this line's subject; it is camera distance/angle ONLY, no subject or",
    "film-look words.",
    "",
    productBrandRule(EMPTY_TOPIC),
    "",
    amateurLookRule(EMPTY_TOPIC),
    "",
    wantsAnimation
      ? 'Respond ONLY with JSON: {"imagePrompt","shotType","animationPrompt"}  (animationPrompt = BARELY PERCEPTIBLE motion: an extremely slow, very slight push-in over a completely still, frozen scene. NO panning, NO sudden motion, NO camera shake, NO motion blur, NO eventful action.).'
      : 'Respond ONLY with JSON: {"imagePrompt","shotType"}',
    "",
    `basePrompt: ${basePrompt.trim() || "(none)"}`,
    "",
    "script:",
    script.trim(),
  ].join("\n");
}

const SingleSegmentSchema = z.object({
  imagePrompt: z.string().min(1),
  shotType: optString(),
  animationPrompt: optString(),
});

export interface RegeneratedPrompt {
  imagePrompt: string;        // composed WITH the base prompt in front
  animationPrompt: string | null;
}

/**
 * Regenerate the AI image prompt for a SINGLE segment (review screen:
 * "Regenerate prompt"). Re-runs Gemini for just this block's script using the
 * same single-subject / no-text rules as the full planner, and returns the
 * composed image_prompt (base prompt prepended, exactly like buildSyntheticTimeline
 * persists it). Does NOT regenerate the image — the caller persists the new
 * prompt and the user clicks Regenerate to rebuild the asset.
 */
export async function regenerateSegmentPrompt(input: {
  projectId: string;
  jobId?: string;
  script: string;
  basePrompt: string;
  blockType: SyntheticBlockType;
  // Optional scenes that OTHER visuals of this same sentence already show, so the
  // regenerated prompt is a genuinely different picture (see buildSingleSegmentPrompt).
  avoidScenes?: string[];
}): Promise<RegeneratedPrompt> {
  const { projectId, jobId, script, basePrompt, blockType, avoidScenes } = input;
  if (blockType === "avatar") {
    throw new Error("regenerateSegmentPrompt: avatar blocks have no image prompt");
  }
  if (!script.trim()) throw new Error("regenerateSegmentPrompt: empty script");

  // Parse INSIDE the model callback so a truncated / MAX_TOKENS response is
  // thrown as a retryable GEMINI_TRUNCATED error — that lets withGeminiModelFallback
  // retry and fail over to the lite model (which does NOT overrun the budget),
  // instead of a hard "returned non-JSON" throw that never retries. This was the
  // cause of the per-segment Regenerate-prompt button failing on the current
  // gemini-flash-latest while the same call succeeded on the fallback model.
  const { result: safe, model: usedModel } = await withGeminiModelFallback(
    "regenerateSegmentPrompt",
    async (model) => {
      const res = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: buildSingleSegmentPrompt(script, basePrompt, blockType, avoidScenes ?? []) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4,
          // One block's prompt is tiny (imagePrompt + optional shotType +
          // animationPrompt), but leave clear headroom so a verbose scene
          // description can't truncate mid-string.
          maxOutputTokens: 2048,
          // The current Gemini model can spend its whole output budget on
          // internal reasoning before emitting JSON (see buildSyntheticTimeline);
          // we don't need chain-of-thought to write one scene prompt.
          thinkingConfig: { thinkingBudget: 0 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      const txt = res.response.text();
      const finishReason = res.response.candidates?.[0]?.finishReason;
      let parsed: unknown;
      try {
        parsed = JSON.parse(txt);
      } catch {
        // Retryable so the fallback model gets a turn; tag carries the reason.
        throw new Error(
          `GEMINI_TRUNCATED regenerateSegmentPrompt non-JSON (finishReason=${finishReason}, chars=${txt.length}): ${txt.slice(0, 120)}`,
        );
      }
      const parsedSafe = SingleSegmentSchema.safeParse(parsed);
      if (!parsedSafe.success) {
        // A complete-but-wrong-shape response is a real schema error, not an
        // outage — do NOT tag it retryable.
        throw new Error(`regenerateSegmentPrompt: schema: ${JSON.stringify(parsedSafe.error.flatten()).slice(0, 200)}`);
      }
      return parsedSafe.data;
    },
    // SHORT primary ladder: during a broad primary 503 spike (the cause of the
    // 2026-07 planner slowdown) we don't want each of the ~74 regen calls to
    // burn ~20s exhausting the dead primary. 2 quick attempts, then fail over to
    // the healthy fallback which gets the fuller budget.
    { attempts: 2, baseMs: 800 },
    { attempts: 4, baseMs: 1500 },
  );
  if (usedModel !== getEnv().GEMINI_MODEL) {
    await logJob({ projectId, jobId }, "synthetic.prompt_regen.model_fallback", { model: usedModel });
  }

  return {
    // Compose the base in front exactly like persist does, so the stored prompt
    // carries the recurring world (composePrompt is the same helper).
    imagePrompt:
      composePrompt(basePrompt, safe.imagePrompt.trim(), safe.shotType?.trim() || null) ??
      safe.imagePrompt.trim(),
    animationPrompt: blockType === "ai_clip" ? (safe.animationPrompt?.trim() || null) : null,
  };
}

// Stamp each Gemini segment with its real spoken window from the Deepgram word
// timings. This DELEGATES to the sourced engine's battle-tested aligner
// (alignSentencesToWords) rather than re-implementing alignment here.
//
// The previous hand-rolled aligner matched only a segment's FIRST word against
// the word stream and assumed the segment occupied exactly its (paraphrased)
// token count of contiguous words. Both assumptions break on real transcripts:
// a common first word ("It", "So", "How") matched a far-later occurrence,
// jumping the cursor to the end of the audio — which (a) produced absurd
// durations for the segment that mis-matched (e.g. 50s+) and (b) stranded every
// following segment with no remaining words to match, collapsing them all to
// the 0.5s floor. alignSentencesToWords avoids this with 3-token head+tail
// brackets, number canonicalization, bounded forward search, and a desync
// sanity check that recovers instead of cascading.
function alignSegments(
  segs: Array<z.infer<typeof GeminiSegmentSchema>>,
  words: WordTiming[] | null,
  totalDuration: number,
): PlannedSegment[] {
  const out: PlannedSegment[] = [];

  if (!words || words.length === 0) {
    // No timings: distribute by word-count proportion of total duration.
    const counts = segs.map((s) => Math.max(1, s.script.trim().split(/\s+/).length));
    const totalWords = counts.reduce((a, b) => a + b, 0) || 1;
    let cursor = 0;
    segs.forEach((s, i) => {
      const dur = (counts[i] / totalWords) * totalDuration;
      out.push(mk(s, i, cursor, cursor + dur));
      cursor += dur;
    });
    return out;
  }

  // Adapt each segment to the Sentence shape the aligner expects (it only reads
  // `.text`; the other fields are inert here). The aligner returns a window per
  // segment, in order, never dropping one.
  const pseudoSentences: Sentence[] = segs.map((s) => ({
    text: s.script.trim(),
    paragraph_index: 0,
    sentence_index_in_paragraph: 0,
    is_section_first_sentence: false,
    char_offset: 0,
  }));
  const aligned = alignSentencesToWords(pseudoSentences, words);
  segs.forEach((s, i) => {
    const a = aligned[i];
    out.push(mk(s, i, a.vo_start, Math.max(a.vo_end, a.vo_start + 0.5)));
  });

  // Make the timeline continuous: snap each block's start to the previous
  // block's end and the last block's end to the audio duration.
  for (let i = 1; i < out.length; i++) {
    out[i].startTime = out[i - 1].endTime;
    // Keep end >= start after the start snap so duration never goes negative
    // (a synthesized/short window can land entirely before the prior end).
    if (out[i].endTime < out[i].startTime) out[i].endTime = out[i].startTime;
  }
  if (out.length > 0 && totalDuration > 0) out[out.length - 1].endTime = totalDuration;
  for (const seg of out) seg.duration = Math.max(0.5, seg.endTime - seg.startTime);
  return out;
}

// Prepend the video's shared style bible to a block's scene-specific prompt so
// the stored image_prompt carries the recurring world (subjects, setting, mood)
// alongside this moment's detail. Keeps adjacent same-scene blocks visually
// continuous. STYLE_PROMPT (the camera/grain look) is still appended separately
// at generation time. Returns the block prompt unchanged when there's no base,
// and the base alone when the block has no specific prompt.
// Subject-first ordering (client variety fix): image models weight the FRONT of
// the prompt most, so leading every prompt with the long shared basePrompt made
// the model lock onto the same recurring world ("hands-in-the-dirt garden") and
// IGNORE the short per-line subject — every still came out looking the same. We
// now lead with the block's SHOT TYPE + scene-specific prompt (the thing that
// actually varies) and append the basePrompt as a trailing setting/mood clause,
// so the subject and framing dominate and the world is context, not the lede.
function composePrompt(basePrompt: string, blockPrompt: string | null, shotType?: string | null): string | null {
  const base = basePrompt.trim();
  const block = (blockPrompt ?? "").trim();
  const shot = (shotType ?? "").trim();
  // Lead with the shot type when present, then the scene-specific subject.
  const lead = [shot, block].filter(Boolean).join(": ");
  if (!base) return lead || null;
  if (!lead) return base;
  // Avoid a duplicated base if a block prompt already contains it (e.g. an edited
  // row re-run through the planner).
  if (lead.toLowerCase().includes(base.toLowerCase())) return lead;
  // Subject/shot first; world as trailing context.
  return `${lead.replace(/[.\s]+$/, "")}. Setting: ${base.replace(/[.\s]+$/, "")}.`;
}

// The second visual covering a long sentence shows the SAME moment from a
// different composition so the two frames don't look like duplicates. We append
// a short variation hint to the block's own prompt (the full-sentence scene is
// unchanged). Returns the prompt untouched when this isn't a second visual.
function secondVisualPrompt(blockPrompt: string | null, isSecond?: boolean): string | null {
  if (!isSecond) return blockPrompt;
  const block = (blockPrompt ?? "").trim();
  if (!block) return block || null;
  return `${block.replace(/[.\s]+$/, "")}. Show this from a different angle and composition (alternate framing of the same scene).`;
}

function mk(
  s: z.infer<typeof GeminiSegmentSchema>,
  position: number,
  startTime: number,
  endTime: number,
): PlannedSegment {
  const isVisual = s.blockType !== "avatar";
  return {
    position,
    blockType: s.blockType,
    startTime,
    endTime,
    duration: Math.max(0.5, endTime - startTime),
    script: s.script.trim(),
    imagePrompt: isVisual ? (s.imagePrompt?.trim() || null) : null,
    shotType: isVisual ? (s.shotType?.trim() || null) : null,
    imagePrompt2: isVisual ? (s.imagePrompt2?.trim() || null) : null,
    shotType2: isVisual ? (s.shotType2?.trim() || null) : null,
    animationPrompt: s.blockType === "ai_clip" ? (s.animationPrompt?.trim() || null) : null,
  };
}

// Carve a planned segment along avatar-mark boundaries.
//
// Doc marks are sub-sentence precise: a red/orange highlight can cover only the
// FIRST half of a Gemini block (e.g. "...maintenance habit." is marked but the
// trailing "Repeat it every two to three weeks..." in the SAME block is not).
// Forcing the whole block to avatar on any overlap mislabels the unmarked tail.
//
// Instead we intersect the block's char window [origStart, origEnd) with the
// marked ranges, producing alternating marked / unmarked runs, and emit one
// sub-segment per run. The script text and the spoken-time window are carved
// proportionally by character fraction within the block — exact enough for the
// review screen (per-block script/timing stay editable), and far better than
// promoting unmarked narration to a talking-head shot.
//
// A run that covers the whole block returns the block unchanged. Sub-segments
// inherit the parent's blockType for unmarked runs (so a non-avatar block stays
// whatever Gemini/the demote step chose) and become 'avatar' for marked runs.
interface MarkRun {
  start: number; // char offset into transcript, inclusive
  end: number; // exclusive
  marked: boolean;
  model: AvatarModel | null; // the model of the range covering this run (marked runs only)
}
export function intersectRuns(
  segStart: number,
  segEnd: number,
  ranges: AvatarMarkRange[],
): MarkRun[] {
  // Collect mark boundaries strictly inside (segStart, segEnd), build runs.
  const cuts = new Set<number>([segStart, segEnd]);
  for (const r of ranges) {
    if (r.start > segStart && r.start < segEnd) cuts.add(r.start);
    if (r.end > segStart && r.end < segEnd) cuts.add(r.end);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const runs: MarkRun[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b <= a) continue;
    const mid = (a + b) / 2;
    const covering = ranges.find((r) => r.start <= mid && mid < r.end);
    const marked = !!covering;
    const model = covering?.model ?? null;
    const last = runs[runs.length - 1];
    if (last && last.marked === marked && last.model === model) {
      last.end = b; // coalesce same-type + same-model adjacent runs
    } else {
      runs.push({ start: a, end: b, marked, model });
    }
  }
  return runs;
}

// Snap avatar mark ranges OUT to whole-sentence boundaries.
//
// The Google-Doc highlight is hand-drawn, so a red span routinely starts or ends
// MID-SENTENCE (observed: a mark covering "...we had two kids, a boy and" but
// stopping just before "a girl." in the same sentence). splitByMarks honors the
// exact char boundary, so it would carve that sentence into an avatar half ("a
// boy and") and a stranded visual fragment ("a girl.") — breaking the
// ONE-SENTENCE = ONE-BLOCK rule and leaking a fragment onto the next visual
// block. The avatar marking only ever needs SENTENCE granularity (a sentence is
// either spoken by the talking head or shown as B-roll, never half-and-half), so
// before any carving we EXPAND each range to the sentences it touches: a range
// that starts inside a sentence snaps back to that sentence's start, and one that
// ends inside a sentence snaps forward to that sentence's end. Adjacent/
// overlapping ranges are then re-merged. This is what kept marks sentence-aligned
// before; carving at the raw doc offset is what regressed.
export function snapRangesToSentences(
  transcript: string,
  ranges: AvatarMarkRange[],
): AvatarMarkRange[] {
  if (ranges.length === 0) return ranges;
  // Sentence boundaries: the offset just AFTER each terminal . ! ? (plus any
  // trailing quote/bracket), i.e. where the next sentence begins. 0 and the end
  // are implicit boundaries. We snap a range start back to the boundary at or
  // before it, and a range end forward to the boundary at or after it.
  const boundaries: number[] = [0];
  const re = /[.!?]+["')\]]*\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(transcript)) !== null) {
    const b = m.index + m[0].length;
    if (b > 0 && b < transcript.length) boundaries.push(b);
  }
  boundaries.push(transcript.length);
  // boundaries is sorted & unique by construction (regex advances monotonically).
  const sentenceStartAtOrBefore = (pos: number): number => {
    let lo = 0, hi = boundaries.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid] <= pos) { ans = boundaries[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  };
  const sentenceEndAtOrAfter = (pos: number): number => {
    let lo = 0, hi = boundaries.length - 1, ans = transcript.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid] >= pos) { ans = boundaries[mid]; hi = mid - 1; }
      else lo = mid + 1;
    }
    return ans;
  };

  // A hand-drawn highlight often includes the LEADING space before a sentence
  // (range starts on " Let me..." not "Let me..."), which sits one char before
  // the real sentence-start boundary and would snap the start back a whole extra
  // sentence. Anchor the snap on the first/last NON-whitespace char of the range
  // instead, so leading/trailing spaces in the highlight don't over-expand it.
  const firstNonWs = (from: number, to: number): number => {
    let i = from;
    while (i < to && /\s/.test(transcript[i])) i++;
    return Math.min(i, to);
  };
  const lastNonWs = (from: number, to: number): number => {
    let i = to - 1;
    while (i > from && /\s/.test(transcript[i])) i--;
    return Math.max(i, from);
  };
  const snapped = ranges
    .map((r) => {
      const a = firstNonWs(r.start, r.end);
      const b = lastNonWs(r.start, r.end);
      return {
        start: sentenceStartAtOrBefore(a),
        // Snap the end forward from the last non-ws char (end is exclusive) to
        // that sentence's end. A range ending on a boundary stays put.
        end: sentenceEndAtOrAfter(b + 1),
        model: r.model,
      };
    })
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  // Re-merge adjacent/overlapping ranges produced by the expansion — but only
  // ranges of the SAME model, so a red (Avatar IV) sentence abutting an orange
  // (Avatar III) one stays two ranges driving two different models.
  const merged: AvatarMarkRange[] = [];
  for (const r of snapped) {
    const last = merged[merged.length - 1];
    if (last && r.model === last.model && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

// Split `seg` (whose transcript char window is [origStart, origEnd)) into one
// sub-segment per mark run. `position` is assigned by the caller afterward.
export function splitByMarks(
  seg: PlannedSegment,
  origStart: number,
  origEnd: number,
  ranges: AvatarMarkRange[],
  basePrompt: string = "",
): PlannedSegment[] {
  const span = origEnd - origStart;
  const runs = span > 0 ? intersectRuns(origStart, origEnd, ranges) : [];
  // Whole-block (single run) — no carving needed; just label it.
  if (runs.length <= 1) {
    const marked = runs.length === 1 ? runs[0].marked : false;
    const model = runs.length === 1 ? runs[0].model : null;
    return [applyMark(seg, marked, basePrompt, model)];
  }

  const scriptLen = seg.script.length;
  const timeSpan = seg.endTime - seg.startTime;
  const out: PlannedSegment[] = [];
  for (const run of runs) {
    const f0 = (run.start - origStart) / span;
    const f1 = (run.end - origStart) / span;
    // Carve script text on a whitespace boundary near the proportional cut so
    // we don't slice a word in half.
    const rawStart = Math.round(f0 * scriptLen);
    const rawEnd = Math.round(f1 * scriptLen);
    const cutStart = run === runs[0] ? 0 : snapToSpace(seg.script, rawStart);
    const cutEnd = run === runs[runs.length - 1] ? scriptLen : snapToSpace(seg.script, rawEnd);
    const piece = seg.script.slice(cutStart, cutEnd).trim();
    if (!piece) continue;
    const startTime = seg.startTime + f0 * timeSpan;
    const endTime = seg.startTime + f1 * timeSpan;
    const sub: PlannedSegment = {
      ...seg,
      startTime,
      endTime,
      duration: Math.max(0.5, endTime - startTime),
      script: piece,
    };
    out.push(applyMark(sub, run.marked, basePrompt, run.model));
  }
  return out.length > 0
    ? out
    : [applyMark(seg, runs.some((r) => r.marked), basePrompt, runs.find((r) => r.marked)?.model ?? null)];
}

// Round a char index to the nearest whitespace boundary in `text` so a script
// carve lands between words, not mid-word.
function snapToSpace(text: string, idx: number): number {
  if (idx <= 0) return 0;
  if (idx >= text.length) return text.length;
  if (/\s/.test(text[idx])) return idx;
  let left = idx;
  while (left > 0 && !/\s/.test(text[left - 1])) left--;
  let right = idx;
  while (right < text.length && !/\s/.test(text[right])) right++;
  // Prefer the closer boundary.
  return idx - left <= right - idx ? left : right;
}

// Avatar parts are capped at 1 min by the content rules (well under HeyGen Pro's
// 5-min limit). Shared by coalesceAvatarSegments (which LOGS a warning if a
// merged avatar passage ever exceeds it) and mergeOrphansIntoAvatar (which
// SKIPS absorbing an orphan that would push the avatar over the cap).
const AVATAR_PART_MAX_SECONDS = 60;

// Merge consecutive SHORT visual segments so no single image/clip flashes by in
// ~1-2s (client feedback 2026-06: "the image switches are too often / only one
// second in between — slow everything down, make it ~5-6s").
//
// The synthetic timeline pins every block to its sentence's real spoken window
// (alignSegments). A short sentence therefore yields a short visual: live data
// showed ~50-65% of visual blocks under 5s, in long runs of back-to-back
// flashes. The duration-split pass only ever ADDS switches (it carves LONG
// sentences into two), so nothing upstream slows the short-sentence case — that
// is what this pass fixes.
//
// Rule: walk the timeline and, whenever a SHORT image/ai_clip block (shorter
// than SYNTHETIC_BLOCK_MIN_HOLD) sits next to a same-type image/ai_clip block,
// merge it INTO the previous block — concatenating the script and extending the
// spoken window to cover both. The trigger is EITHER block being under the
// minimum, so a short block also merges back into a previous block that is
// ALREADY at/above the minimum (the goal is "no visual under the minimum", not
// "grow until reached"). Merging stops at a non-mergeable block (avatar /
// split_2 / type change) or once the combined span passes the combine ceiling
// (~2 slots' worth); a short block with no mergeable neighbor falls through to
// the avatar pass or stays a rare orphan.
//
// Per client direction (2026-06): a SHORT sentence merges with its neighbor so
// the two render as ONE combined visual unit instead of a flash. Because the
// merged block covers BOTH sentences' narration, its visual must reflect the
// COMBINED thought — so we flag every merged block (`needsPromptRegen`) and the
// planner regenerates one combined imagePrompt for the merged script.
//
// The combined window may exceed the 8s cap — when it does, splitMergedVisuals
// (run after the regen) re-splits it into N EVEN ~min-second slots so it plays
// as N visuals of ~5s each (slot 1 = combined prompt, slots 2+ = a different
// angle), NOT one over-long hold. So a 7s + 2.6s pair → two ~4.8s visuals, and a
// clip+clip = 10s → two 5s clips with motion preserved (each slot < 8s).
//
// ONLY 'image' and 'ai_clip' merge, but they merge ACROSS types (a short
// sentence must never stay a flash, even next to the other visual type). The
// merged result type comes from resolveMerge: an 'ai_clip' if EITHER side was a
// clip (preserving motion for the clip-heavy intro), otherwise an 'image'.
// Merging is tried BACKWARD (into the
// previous visual), then FORWARD (into the next, for blocks whose previous
// neighbor is a boundary), then as an AVATAR fallback. 'avatar' and 'split_2'
// are explicitly NEVER a visual-merge target: avatar parts are atomic HeyGen
// renders handled by coalesceAvatarSegments (a stranded orphan can still be
// absorbed into an adjacent avatar's audio window — see mergeOrphansIntoAvatar),
// and split_2 is a presenter-beside-still layout that holds its whole sentence.
// Both act as visual-run boundaries.
const MERGEABLE_VISUAL_TYPES = new Set<SyntheticBlockType>(["image", "ai_clip"]);

// Upper bound on a COMBINED short-sentence window before merging stops absorbing
// more. A merged block over maxHold is later re-split into even ~min-second
// slots (splitMergedVisuals), so we don't need the old 8s cap here — but we DO
// cap the combine at ~2 slots' worth so a long run of shorts doesn't fuse into
// one block that re-splits into many near-identical visuals. 2*maxHold (16s)
// re-splits into at most ~3 slots, which is plenty.
const MERGE_COMBINE_CEILING_FACTOR = 2;

// Decide whether two adjacent visual blocks can merge and, if so, the result
// type. The result is an ai_clip when EITHER side is a clip (so motion is
// preserved — each re-split slot is < maxHold, well inside LTX's range), else an
// image. We allow the combined span to exceed maxHoldSeconds (the merged block
// is re-split into even ~min-second slots afterward — client direction 2026-06:
// a 7s + 2.6s pair merges to 9.6s and shows as TWO ~4.8s visuals, not one flash
// and not a long static hold). We only refuse once the combined span passes the
// combine ceiling, to avoid fusing a long run of shorts into one block.
function resolveMerge(
  a: PlannedSegment,
  b: PlannedSegment,
  spanSeconds: number,
  maxHoldSeconds: number,
): SyntheticBlockType | null {
  if (spanSeconds > maxHoldSeconds * MERGE_COMBINE_CEILING_FACTOR) return null;
  return a.blockType === "ai_clip" || b.blockType === "ai_clip" ? "ai_clip" : "image";
}

export function mergeShortVisualSegments(
  segs: PlannedSegment[],
  minHoldSeconds: number,
  maxHoldSeconds: number,
): { segments: PlannedSegment[]; merged: number } {
  const out: PlannedSegment[] = [];
  let merged = 0;
  for (const seg of segs) {
    const prev = out[out.length - 1];
    const mergeable =
      prev != null &&
      MERGEABLE_VISUAL_TYPES.has(prev.blockType) &&
      MERGEABLE_VISUAL_TYPES.has(seg.blockType);
    // Merge when EITHER block is under the minimum hold — the goal is "no visual
    // under the minimum", not "grow blocks until they reach it". So a SHORT
    // block (seg) merges back into the previous block even if that block is
    // already >= the minimum (e.g. a 6s image followed by a 1s "She's right."
    // flash → one 7s image), and a still-short open block keeps absorbing
    // following blocks. resolveMerge decides the result type (clip if either
    // side is a clip, else image) and returns null when the merged span won't
    // fit the cap — in which case the merge is skipped, never forced into a
    // long static hold.
    const bothShortTrigger =
      mergeable && (seg.duration < minHoldSeconds || prev!.duration < minHoldSeconds);
    const resultType = bothShortTrigger
      ? resolveMerge(prev!, seg, seg.endTime - prev!.startTime, maxHoldSeconds)
      : null;
    if (resultType) {
      prev!.script = `${prev!.script} ${seg.script}`.replace(/\s+/g, " ").trim();
      prev!.endTime = seg.endTime;
      prev!.duration = Math.max(0.5, prev!.endTime - prev!.startTime);
      // Result type from resolveMerge: ai_clip (motion kept) when either side is
      // a clip, else image. The combined-prompt regen below (re)derives the
      // animationPrompt only for a clip result.
      prev!.blockType = resultType;
      if (resultType === "image") prev!.animationPrompt = null;
      // The merged block now covers two sentences — its stored prompt is the
      // FIRST sentence's only, so mark it for a combined-prompt regen.
      prev!.needsPromptRegen = true;
      merged++;
      continue;
    }
    out.push({ ...seg });
  }

  // Forward visual-merge pass. The backward pass above only folds a short block
  // into the PREVIOUS visual, so a short block whose previous neighbor is a
  // boundary (split_2 / avatar) — but whose NEXT neighbor is a mergeable
  // image/ai_clip — never got a chance to merge (e.g. split_2, then a 3s image,
  // then an ai_clip: the 3s image couldn't go back into the split_2 and the
  // backward pass never looks forward). This pass absorbs such a short block
  // into the FOLLOWING visual instead, keeping the visual-merge-first priority
  // before the avatar fallback. Same cross-type rule (result is ai_clip if
  // either side was a clip) and max-hold cap.
  const fwdMerged = mergeShortVisualsForward(out, minHoldSeconds, maxHoldSeconds);
  merged += fwdMerged;

  // Avatar-fallback pass (client direction 2026-06). A SHORT image/ai_clip that
  // still has NO mergeable visual neighbor after the passes above (e.g. one
  // stranded between a split_2 and an avatar) is absorbed into an ADJACENT
  // AVATAR block instead of staying a ~1-2s flash. We prefer a visual merge
  // first (handled above); only true orphans reach here.
  //
  // Mechanic: an avatar block is an atomic HeyGen render lip-synced to a SLICE
  // of master_voiceover.mp3 over its [startTime, endTime) window. The master
  // voiceover already contains the orphan's spoken words in that time range, so
  // we just EXTEND the avatar's window to cover the orphan (start back for an
  // orphan before the avatar, end forward for one after) — the re-sliced audio
  // then includes the orphan's line and the talking head speaks it. No new
  // visual is generated. We also append the orphan's text to the avatar script
  // so the editor row mirrors what's spoken. split_2 is still NEVER a target
  // (two render paths) — an orphan next to only a split_2 stays as-is.
  const avMerged = mergeOrphansIntoAvatar(out, minHoldSeconds);
  merged += avMerged;
  return { segments: out, merged };
}

// Absorb a SHORT image/ai_clip into the FOLLOWING image/ai_clip when it could
// not merge backward (its previous neighbor was a split_2/avatar boundary).
// Mutates `segs` in place by removing absorbed orphans and extending the next
// block's window/script back over them; returns how many were absorbed. Same
// cross-type rule as the backward pass (the merged block is an ai_clip if either
// side was a clip) and the same max-hold cap. The next block's prompt is the
// SECOND sentence's, so the merged block is flagged for a combined-prompt regen.
function mergeShortVisualsForward(
  segs: PlannedSegment[],
  minHoldSeconds: number,
  maxHoldSeconds: number,
): number {
  let absorbed = 0;
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];
    const next = segs[i + 1];
    const isShortVisual =
      MERGEABLE_VISUAL_TYPES.has(seg.blockType) && seg.duration < minHoldSeconds;
    const nextMergeable =
      next != null && MERGEABLE_VISUAL_TYPES.has(next.blockType);
    const resultType =
      isShortVisual && nextMergeable
        ? resolveMerge(seg, next, next.endTime - seg.startTime, maxHoldSeconds)
        : null;
    if (resultType) {
      next.script = `${seg.script} ${next.script}`.replace(/\s+/g, " ").trim();
      next.startTime = seg.startTime;
      next.duration = Math.max(0.5, next.endTime - next.startTime);
      next.blockType = resultType;
      if (resultType === "image") next.animationPrompt = null;
      next.needsPromptRegen = true;
      segs.splice(i, 1); // remove the orphan; the next block shifts to index i
      absorbed++;
      continue; // re-check index i (the merged block may now absorb more)
    }
    i++;
  }
  return absorbed;
}

// Absorb SHORT visual orphans (image/ai_clip under the min hold with no
// mergeable visual neighbor) into an adjacent avatar block, extending the
// avatar's spoken window to cover the orphan. Mutates `segs` in place by
// removing absorbed orphans, and returns how many were absorbed.
//
// Direction: prefer the PREVIOUS block (extend its endTime forward to the
// orphan's end) so the avatar that just finished talking simply keeps talking
// through the short line; otherwise the NEXT block (extend its startTime back to
// the orphan's start). split_2 is never a target. We respect the avatar 60s cap
// — an absorb that would push the avatar over the cap is skipped (the orphan
// stays, a rare case). The orphan's script is appended (prev) or prepended
// (next) to the avatar so the editor row mirrors the spoken audio.
function mergeOrphansIntoAvatar(segs: PlannedSegment[], minHoldSeconds: number): number {
  let absorbed = 0;
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];
    const isShortVisual =
      MERGEABLE_VISUAL_TYPES.has(seg.blockType) && seg.duration < minHoldSeconds;
    if (!isShortVisual) { i++; continue; }
    const prev = segs[i - 1];
    const next = segs[i + 1];
    const prevAvatarOk =
      prev?.blockType === "avatar" &&
      seg.endTime - prev.startTime <= AVATAR_PART_MAX_SECONDS;
    const nextAvatarOk =
      next?.blockType === "avatar" &&
      next.endTime - seg.startTime <= AVATAR_PART_MAX_SECONDS;
    if (prevAvatarOk) {
      prev.script = `${prev.script} ${seg.script}`.replace(/\s+/g, " ").trim();
      prev.endTime = seg.endTime;
      prev.duration = Math.max(0.5, prev.endTime - prev.startTime);
      segs.splice(i, 1); // remove the orphan; do not advance i
      absorbed++;
      continue;
    }
    if (nextAvatarOk) {
      next.script = `${seg.script} ${next.script}`.replace(/\s+/g, " ").trim();
      next.startTime = seg.startTime;
      next.duration = Math.max(0.5, next.endTime - next.startTime);
      segs.splice(i, 1); // remove the orphan; the avatar shifts to index i
      absorbed++;
      continue;
    }
    i++;
  }
  return absorbed;
}

// Re-split a MERGED visual block whose combined window is longer than maxHold
// into N even slots so it shows as N visuals of ~minHold each, instead of one
// over-long hold (client direction 2026-06: a 7s + 2.6s pair merges to 9.6s and
// plays as TWO ~4.8s images, "half the time each"). Mirrors splitByDuration but
// produces N EVEN slots (N = round(dur / minHold), at least 2) rather than two
// halves, and operates on the post-merge block.
//
// Only blocks flagged needsPromptRegen (i.e. blocks this pass's merge actually
// combined) are re-split here; a naturally-long Gemini block was already carved
// by the earlier duration-split pass. Slot 1 keeps the merged block's
// (regenerated, combined) prompt; slots 2+ are flagged secondVisual so persist
// appends the "different angle" variation — distinct compositions of the same
// combined thought. Each slot inherits the merged blockType (an ai_clip stays an
// ai_clip; each slot < maxHold so it's inside LTX's range, motion preserved).
// Returns a new array; positions are renumbered by the caller.
export function splitMergedVisuals(
  segs: PlannedSegment[],
  minHoldSeconds: number,
  maxHoldSeconds: number,
): { segments: PlannedSegment[]; split: number } {
  const out: PlannedSegment[] = [];
  let split = 0;
  for (const seg of segs) {
    const dur = seg.endTime - seg.startTime;
    if (!seg.needsPromptRegen || !MERGEABLE_VISUAL_TYPES.has(seg.blockType) || dur <= maxHoldSeconds) {
      out.push(seg);
      continue;
    }
    const slots = Math.max(2, Math.round(dur / minHoldSeconds));
    for (let k = 0; k < slots; k++) {
      const startTime = seg.startTime + (k * dur) / slots;
      const endTime = seg.startTime + ((k + 1) * dur) / slots;
      out.push({
        ...seg,
        startTime,
        endTime,
        duration: Math.max(0.5, endTime - startTime),
        // Slot 1 carries the combined prompt as-is; later slots show a different
        // angle/composition of the same combined thought.
        secondVisual: k > 0,
      });
    }
    split++;
  }
  return { segments: out, split };
}

// FINAL position-based image/ai_clip balance (client 2026-06-30: "first 3 min
// should be many ai_clip, after that image and ai_clip should appear NATURALLY"
// — not all-clip). Must run LAST, after all merge/split churn, because the
// short-visual merge biases every merge to ai_clip (resolveMerge returns ai_clip
// when EITHER side is a clip), which snowballed one plan to 100 clips / 15
// images. This pass is the final word on visual type:
//   * a visual block (image/ai_clip) STARTING before `clipHeavyCutoff` follows a
//     repeating run pattern of `introClipRun` clips then `introImageRun` images
//     (client 2026-07-03: all-clip intro was too expensive — wants
//     "ai clip - ai clip - image - image" for the first 3 min). introImageRun 0
//     restores the old all-clip intro.
//   * after the cutoff -> keep only a `postClipFraction` share as ai_clip,
//     spaced EVENLY across the post-cutoff visuals (every Nth), the rest demoted
//     to image. Even spacing avoids a clump of clips then a clump of stills.
// avatar / split_2 are NEVER touched (different render paths). A block flipped
// to image loses its animationPrompt (a still has no motion); a block flipped to
// ai_clip gets a null animationPrompt and the worker's default gentle push-in.
export function balanceVisualTypesByPosition(
  segs: PlannedSegment[],
  clipHeavyCutoffSeconds: number,
  postClipFraction: number,
  introClipRun: number = 2,
  introImageRun: number = 2,
): { segments: PlannedSegment[]; toClip: number; toImage: number } {
  let toClip = 0;
  let toImage = 0;
  // Index among PRE-cutoff visual blocks, used to walk the clip/image run
  // pattern (e.g. 2/2 -> clip clip image image clip clip …).
  let preIdx = 0;
  // Index among POST-cutoff visual blocks, used to space clips evenly. We keep a
  // clip when floor(i * frac) increments — a classic even-distribution stride.
  let postIdx = 0;
  const clipRun = Math.max(1, Math.floor(introClipRun));
  const imageRun = Math.max(0, Math.floor(introImageRun));
  const out = segs.map((seg) => {
    if (seg.blockType !== "image" && seg.blockType !== "ai_clip") return seg;
    const beforeCutoff = clipHeavyCutoffSeconds > 0 && seg.startTime < clipHeavyCutoffSeconds;
    let want: SyntheticBlockType;
    if (beforeCutoff) {
      want = imageRun <= 0 || preIdx % (clipRun + imageRun) < clipRun ? "ai_clip" : "image";
      preIdx++;
    } else {
      // Even-spacing decision: keep a clip when the running quota ticks up.
      const i = postIdx++;
      const shouldBeClip =
        postClipFraction >= 1
          ? true
          : postClipFraction <= 0
            ? false
            : Math.floor((i + 1) * postClipFraction) > Math.floor(i * postClipFraction);
      want = shouldBeClip ? "ai_clip" : "image";
    }
    if (want === seg.blockType) return seg;
    if (want === "ai_clip") { toClip++; return { ...seg, blockType: "ai_clip" as SyntheticBlockType }; }
    toImage++;
    return { ...seg, blockType: "image" as SyntheticBlockType, animationPrompt: null };
  });
  return { segments: out, toClip, toImage };
}

// Guarantee a MINIMUM number of split_2 blocks (client 2026-06-30: "why is
// split_2 not appeared?"). Gemini sometimes returns ZERO split_2, and nothing
// upstream can keep what was never produced — so when the final plan has fewer
// than `minKeep`, we PROMOTE evenly-spaced eligible 'image' blocks to split_2.
//
// A promoted split_2 is fully renderable: the avatar processor generates the
// talking-head LEFT half (from the project avatar image) and the still RIGHT
// half (from the block's existing image_prompt), so an 'image' with a usable
// prompt is a safe source. We promote only AFTER the clip-heavy intro cutoff
// (split_2 is a presenter-beside-still explanatory layout, not an opening-action
// shot) and space the promotions evenly across eligible blocks so they don't
// clump. avatar / ai_clip / existing split_2 are never touched. Runs LAST (after
// the visual-balance pass) so balance can't flip a promotion back to image.
export function ensureMinSplit2(
  segs: PlannedSegment[],
  minKeep: number,
  clipHeavyCutoffSeconds: number,
): { segments: PlannedSegment[]; promoted: number } {
  if (minKeep <= 0) return { segments: segs, promoted: 0 };
  const have = segs.filter((s) => s.blockType === "split_2").length;
  const need = minKeep - have;
  if (need <= 0) return { segments: segs, promoted: 0 };

  // Eligible: a plain 'image' AFTER the intro cutoff with a non-empty prompt.
  const eligibleIdx: number[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (
      s.blockType === "image" &&
      s.startTime >= clipHeavyCutoffSeconds &&
      (s.imagePrompt ?? "").trim().length > 0
    ) {
      eligibleIdx.push(i);
    }
  }
  if (eligibleIdx.length === 0) return { segments: segs, promoted: 0 };

  // Where do EXISTING split_2 already sit? Gemini routinely CLUMPS them at the
  // start or end of a video, so an even-stride pass that ignores them would pile
  // promotions on top of the existing cluster and leave the middle empty (client:
  // "split_2 should appear in the WHOLE video, not only the start or end part").
  // Instead, greedily promote the eligible image that is FARTHEST from every
  // already-split_2 block (and from every promotion so far) — a farthest-point
  // fill that spreads the COMBINED set across the whole timeline regardless of
  // where Gemini clustered. Distance is measured in block positions.
  const anchors: number[] = [];
  for (let i = 0; i < segs.length; i++) if (segs[i].blockType === "split_2") anchors.push(i);
  const take = Math.min(need, eligibleIdx.length);
  const chosen = new Set<number>();
  // If Gemini produced NO split_2 at all, seed with the eligible midpoint so the
  // first pick isn't pinned to an edge, then let the farthest-point fill spread
  // the rest around it.
  if (anchors.length === 0 && take > 0) {
    const mid = eligibleIdx[Math.floor(eligibleIdx.length / 2)];
    chosen.add(mid);
    anchors.push(mid);
  }
  while (chosen.size < take) {
    let bestIdx = -1;
    let bestDist = -1;
    for (const idx of eligibleIdx) {
      if (chosen.has(idx)) continue;
      // Distance to the nearest anchor (existing or already-chosen split_2).
      let nearest = Infinity;
      for (const a of anchors) nearest = Math.min(nearest, Math.abs(idx - a));
      if (nearest > bestDist) {
        bestDist = nearest;
        bestIdx = idx;
      }
    }
    if (bestIdx < 0) break;
    chosen.add(bestIdx);
    anchors.push(bestIdx);
  }
  let promoted = 0;
  const out = segs.map((s, i) => {
    if (!chosen.has(i)) return s;
    promoted++;
    // image -> split_2: keep script + image_prompt (becomes the right-half
    // still); a split_2 has no motion, so drop any animationPrompt.
    return { ...s, blockType: "split_2" as SyntheticBlockType, animationPrompt: null };
  });
  return { segments: out, promoted };
}

// Coalesce CONTIGUOUS avatar segments into one atomic avatar "part".
//
// The audio-driven HeyGen flow treats one Google-Doc avatar passage as a SINGLE
// unit: one sliced audio window -> one HeyGen render (lip-synced to that audio)
// -> one timeline block. But the planner upstream emits avatar narration as
// several small rows (Gemini's ~6s block sizing, plus splitByMarks carving a
// marked range that straddles multiple Gemini blocks). Left as-is, a 35s avatar
// passage would become ~6 separate HeyGen renders driven by text — exactly the
// duration-mismatch problem we're removing.
//
// So after avatar-marking we merge any run of back-to-back avatar segments into
// one: concatenate the scripts (space-joined), take the first segment's start
// and the last segment's end, and recompute the duration from that window. The
// merged row's spoken window [startTime, endTime) is what the avatar processor
// slices out of master_voiceover.mp3 and uploads to HeyGen.
//
// Non-avatar segments pass through untouched. We LOG a warning if a merged part
// ever exceeds AVATAR_PART_MAX_SECONDS rather than splitting, since by agreement
// it never should — the log surfaces a content-rule violation instead of
// silently producing an over-length HeyGen request.
export function coalesceAvatarSegments(segs: PlannedSegment[]): {
  segments: PlannedSegment[];
  merged: number;
  overLengthParts: number;
} {
  const out: PlannedSegment[] = [];
  let merged = 0;
  let overLengthParts = 0;
  for (const seg of segs) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.blockType === "avatar" &&
      seg.blockType === "avatar" &&
      // Only coalesce parts of the SAME model — an Avatar IV (red) part and an
      // Avatar III (orange) part must each render on their own model, so they
      // stay separate HeyGen renders even when contiguous.
      (prev.avatarModel ?? "avatar_iv") === (seg.avatarModel ?? "avatar_iv")
    ) {
      // Extend the open avatar part to include this segment.
      prev.script = `${prev.script} ${seg.script}`.replace(/\s+/g, " ").trim();
      prev.endTime = seg.endTime;
      prev.duration = Math.max(0.5, prev.endTime - prev.startTime);
      merged++;
      if (prev.duration > AVATAR_PART_MAX_SECONDS) overLengthParts++;
      continue;
    }
    // Start a new part (clone so we never mutate the caller's array entries).
    out.push({ ...seg });
    if (seg.blockType === "avatar" && seg.duration > AVATAR_PART_MAX_SECONDS) {
      overLengthParts++;
    }
  }
  return { segments: out, merged, overLengthParts };
}

// Cover a long VISUAL sentence with TWO visuals instead of one — WITHOUT
// cutting the sentence's script. (Client direction 2026-06.)
//
// The old behaviour sliced a long block's SCRIPT into fragments and made each
// fragment its own block. That degraded quality: every visual was then
// generated from a partial clause ("standing out there in flip-flops…") that
// Gemini reasoned about out of context, so the image/clip no longer reflected
// the whole thought. Instead we now keep ONE sentence = ONE thought: every
// sub-block carries the FULL sentence's script and its FULL-sentence prompt, so
// the visual is always generated with complete context. We split only the
// on-screen TIME, attaching a second visual to fill a long sentence so it isn't
// a static hold.
//
// Rules (per client):
//   - A sentence <= threshold (~6-8s): ONE visual, unchanged.
//   - A sentence > threshold: N EVEN slots of ~target seconds each
//     (N = round(duration / target), at least 2) — a single midpoint split left
//     a very long sentence as two halves that could STILL exceed the threshold
//     (a 26s sentence -> two 13s blocks, over the ~5-6s pacing rule and outside
//     LTX's single-generation range).
//       * ai_clip sentence  -> CLIP first (snapped to LTX's tier), then IMAGES
//         fill the remaining slots (different scenes/angles of the SAME
//         sentence). So slot 1 stays ai_clip; slots 2+ become `image`.
//       * image sentence    -> IMAGE per slot, each a different scene/angle of
//         the SAME sentence.
//       * split_2 sentence  -> left to the avatar flow (a talking presenter
//         holds the whole sentence); not time-split here.
//
// Every slot keeps the parent's FULL script. Slot 2 shows a DIFFERENT scene: it
// uses Gemini's distinct imagePrompt2 when present (a genuinely different
// subject/moment of the same sentence), and only falls back to the secondVisual
// "different angle" nudge on imagePrompt when imagePrompt2 is absent. Slots 3+
// are flagged secondVisual so the planner's distinct-scene pass regenerates a
// genuinely different composition for each (avoiding the earlier slots' scenes)
// — so no two slots render as duplicate frames.
//
// 'avatar' / 'split_2' blocks are NEVER time-split: the talking head holds for
// the whole sentence and is generated by HeyGen. `position` is reassigned by
// the caller after all splits.
export function splitByDuration(
  seg: PlannedSegment,
  targetSeconds: number,
  thresholdSeconds: number,
): PlannedSegment[] {
  if (seg.blockType === "avatar" || seg.blockType === "split_2") return [seg];
  const dur = seg.endTime - seg.startTime;
  if (dur <= thresholdSeconds || dur <= 0) return [seg];

  // N even slots of ~target seconds each, so every slot lands back inside the
  // pacing window regardless of how long the sentence runs (26s -> 4 slots of
  // 6.5s, not two 13s halves).
  const slots = Math.max(2, Math.round(dur / targetSeconds));

  // The second visual prefers Gemini's distinct imagePrompt2 (a genuinely
  // different scene of the same sentence). When present we swap it into the
  // second piece's imagePrompt and DON'T set secondVisual — no weak "different
  // angle" suffix is needed because the scene is already different. Only when
  // imagePrompt2 is missing do we fall back to flagging secondVisual so persist
  // appends the variation nudge to the (reused) first prompt.
  const applySecondScene = (piece: PlannedSegment): PlannedSegment =>
    seg.imagePrompt2
      ? { ...piece, imagePrompt: seg.imagePrompt2, shotType: seg.shotType2 ?? seg.shotType, secondVisual: false }
      : { ...piece, secondVisual: true };

  const pieces: PlannedSegment[] = [];
  for (let k = 0; k < slots; k++) {
    const startTime = seg.startTime + (k * dur) / slots;
    const endTime = seg.startTime + ((k + 1) * dur) / slots;
    let piece: PlannedSegment = {
      ...seg,
      startTime,
      endTime,
      duration: Math.max(0.5, endTime - startTime),
    };
    if (k > 0 && seg.blockType === "ai_clip") {
      // Clip first (it snaps to an LTX tier at generation time), images fill
      // the remainder. Only the clip slot carries motion — a still has none.
      piece.blockType = "image";
      piece.animationPrompt = null;
    }
    if (k === 1) piece = applySecondScene(piece);
    // Slots 3+ reuse slot 1's prompt for now; the distinct-scene pass
    // regenerates each into a genuinely different composition (avoiding the
    // earlier slots' scenes) via the secondVisual flag.
    else if (k > 1) piece = { ...piece, secondVisual: true };
    pieces.push(piece);
  }
  return pieces;
}

// Set a segment's avatar-ness. Marked -> avatar (drop visual prompts).
// Unmarked -> if it was avatar (Gemini's choice, not a real mark), demote to
// image; otherwise keep whatever non-avatar type it already had.
//
// `basePrompt` is the video's shared style bible. A demoted avatar block carried
// NO imagePrompt from Gemini (avatar blocks get none), so without a fallback its
// prompt would be empty. We fall back to the basePrompt — a real, on-style
// visual of the video's recurring world — instead of the raw narration sentence,
// which makes a poor, over-literal generation prompt.
function applyMark(
  seg: PlannedSegment,
  marked: boolean,
  basePrompt: string,
  model: AvatarModel | null = null,
): PlannedSegment {
  if (marked) {
    // Doc marks are authoritative, so the model comes from the highlight color.
    // Fall back to Avatar IV if a mark somehow arrived without a model (it
    // shouldn't — every range carries one).
    return {
      ...seg,
      blockType: "avatar",
      imagePrompt: null,
      animationPrompt: null,
      avatarModel: model ?? "avatar_iv",
    };
  }
  if (seg.blockType === "avatar") {
    return {
      ...seg,
      blockType: "image",
      imagePrompt: seg.imagePrompt || basePrompt.trim() || seg.script.slice(0, 200),
      avatarModel: null,
    };
  }
  return seg;
}

// Cap the number of split_2 blocks (client feedback 2026-06: "too many split_2
// parts"). Gemini chooses split_2 freely and overuses it (a 115-block plan came
// back 50 split_2). split_2 is a presenter-beside-still LAYOUT, not a content
// type, so an over-chosen one is safely DEMOTED to a plain 'image' covering the
// same sentence — its imagePrompt already describes a single-subject still (the
// illustrative half), which is exactly what an image block needs.
//
// Policy: keep at most `maxFraction` of total blocks as split_2 (at least 1 when
// any exist and the fraction is > 0), KEEPING the earliest in timeline order and
// demoting the rest. Earliest-kept gives an even early sprinkle rather than a
// late clump. `minGap` additionally requires at least that many blocks between
// two kept split_2 (client 2026-07: a step-by-step walkthrough section survived
// the count cap as 15+ CONSECUTIVE split_2 — an in-budget clump; the spacing
// rule breaks it up by demoting the in-between ones). A demoted block keeps its
// script + imagePrompt and just changes type (animationPrompt stays null —
// image has no motion). Mutates nothing; returns a new array. position is
// reassigned by the caller if needed.
export function capSplit2Blocks(
  segs: PlannedSegment[],
  maxFraction: number,
  minKeep: number = 0,
  minGap: number = 0,
): { segments: PlannedSegment[]; demoted: number } {
  if (maxFraction >= 1 && minGap <= 0) return { segments: segs, demoted: 0 };
  const split2Count = segs.filter((s) => s.blockType === "split_2").length;
  if (split2Count === 0) return { segments: segs, demoted: 0 };
  // Allowed count: floor(total * fraction), floored at minKeep (client: ensure a
  // few split_2 survive so the layout still appears) but never above what Gemini
  // actually produced, and at least 1 when the fraction is non-zero. When the
  // fraction is 0 we still honor minKeep so an explicit floor wins over the cap.
  const fracAllowed = maxFraction <= 0 ? 0 : Math.max(1, Math.floor(segs.length * maxFraction));
  const allowed = maxFraction >= 1 ? split2Count : Math.min(split2Count, Math.max(fracAllowed, minKeep));
  if (split2Count <= allowed && minGap <= 0) return { segments: segs, demoted: 0 };

  let kept = 0;
  let demoted = 0;
  // Index of the last KEPT split_2 — spacing is measured in block positions, so
  // "minGap 3" means at least 3 other blocks (of any type) between two split_2.
  let lastKeptIdx = -Infinity;
  const out = segs.map((s, i) => {
    if (s.blockType !== "split_2") return s;
    if (kept < allowed && i - lastKeptIdx > minGap) {
      kept++;
      lastKeptIdx = i;
      return s;
    }
    demoted++;
    // Demote to a single-subject still. imagePrompt/shotType already describe the
    // illustrative half — reuse them verbatim. No motion on an image.
    return { ...s, blockType: "image" as SyntheticBlockType, animationPrompt: null };
  });
  return { segments: out, demoted };
}

// Char index just past the FIRST sentence terminator (. ? !, optionally followed
// by a closing quote/bracket) that sits at a word boundary. -1 when the text has
// no internal sentence boundary (single sentence, or terminator only at the end).
export function firstSentenceEnd(text: string): number {
  const m = /[.?!]["')\]]?(?=\s)/.exec(text.trimEnd());
  return m ? m.index + m[0].length : -1;
}

// Cap the DURATION of a single split_2 block (client 2026-07-03: a 38s split_2).
// Gemini may lump several sentences into one split_2 block ("a few short,
// tightly-related sentences" is allowed) and split_2 is exempt from EVERY carve
// pass (the presenter half is an atomic HeyGen render), so nothing stops the
// same still from holding beside the presenter for 30s+.
//
// Policy: a split_2 longer than `maxSeconds` keeps its FIRST sentence as the
// split_2 (the layout still appears where Gemini chose it) and the remaining
// sentences become ONE plain 'image' block — which the later duration-split
// pass carves into normal ~target-second visuals like any other long image.
// Script is cut on the first sentence boundary; time is sliced proportionally
// by char count (same technique as splitByMarks). When there is no internal
// sentence boundary, or the first sentence ALONE exceeds the cap, the whole
// block is demoted to 'image' instead (nothing to carve on).
//
// Both carved pieces keep the parent's imagePrompt (which described the WHOLE
// passage) — the caller regenerates each piece's prompt for its own script via
// the returned `regen` list (non-fatal on failure, like the merge pass).
// Returns a new array; `position` is reassigned by the caller.
export function capSplit2Duration(
  segs: PlannedSegment[],
  maxSeconds: number,
): { segments: PlannedSegment[]; carved: number; demoted: number; regen: PlannedSegment[] } {
  const out: PlannedSegment[] = [];
  const regen: PlannedSegment[] = [];
  let carved = 0;
  let demoted = 0;
  if (maxSeconds <= 0) return { segments: segs, carved, demoted, regen };
  for (const seg of segs) {
    const dur = seg.endTime - seg.startTime;
    if (seg.blockType !== "split_2" || dur <= maxSeconds) {
      out.push(seg);
      continue;
    }
    const cut = firstSentenceEnd(seg.script);
    const frac = cut > 0 && cut < seg.script.length ? cut / seg.script.length : 1;
    const mid = seg.startTime + frac * dur;
    if (frac >= 1 || mid - seg.startTime > maxSeconds) {
      // Single sentence, or a first sentence that alone runs over the cap:
      // demote the whole block to a still. Its imagePrompt already describes
      // the illustrative half, and the duration-split pass paces it.
      out.push({ ...seg, blockType: "image" as SyntheticBlockType, animationPrompt: null });
      demoted++;
      continue;
    }
    const head: PlannedSegment = {
      ...seg,
      script: seg.script.slice(0, cut).trim(),
      endTime: mid,
      duration: Math.max(0.5, mid - seg.startTime),
    };
    const rest: PlannedSegment = {
      ...seg,
      blockType: "image" as SyntheticBlockType,
      animationPrompt: null,
      script: seg.script.slice(cut).trim(),
      startTime: mid,
      duration: Math.max(0.5, seg.endTime - mid),
    };
    out.push(head, rest);
    regen.push(head, rest);
    carved++;
  }
  return { segments: out, carved, demoted, regen };
}

type RawSegment = z.infer<typeof GeminiSegmentSchema>;

// Salvage a segments array from a response that JSON.parse rejected because it
// was cut off mid-stream (Gemini hit its output-token cap and never closed the
// JSON). The shape is { basePrompt, segments: [ { ...flat fields... } ] }, so a
// segment object closes when we drop from brace-depth 2 -> 1 while inside the
// segments bracket (bracket-depth 1). We truncate to the last fully-closed
// segment and re-close the array + object, recovering every complete segment
// instead of losing the whole chunk. Returns null when nothing is salvageable.
function salvageTruncatedTimeline(raw: string): unknown | null {
  let depthBrace = 0;
  let depthBracket = 0;
  let lastSafeEnd = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depthBrace++;
    else if (c === "}") {
      const before = depthBrace;
      depthBrace--;
      // Just closed a segment object: was at depth 2, now 1, inside segments[].
      if (before === 2 && depthBracket === 1) lastSafeEnd = i;
    } else if (c === "[") depthBracket++;
    else if (c === "]") depthBracket--;
  }
  if (lastSafeEnd < 0) return null;
  const trimmed = raw.slice(0, lastSafeEnd + 1) + "]}";
  try { return JSON.parse(trimmed); } catch { return null; }
}

// Split a transcript into chunks of at most maxChars, breaking only at sentence
// boundaries (. ? ! followed by whitespace) so a chunk never ends mid-sentence
// — the planner's "one sentence = one block" rule depends on whole sentences,
// and a clean boundary keeps each chunk's segments aligned to real text. A
// single sentence longer than maxChars is emitted as its own (oversized) chunk
// rather than being cut, since cutting it would violate the rule anyway.
function chunkTranscriptBySentence(transcript: string, maxChars: number): string[] {
  const text = transcript.trim();
  if (text.length <= maxChars) return [text];
  // Sentence terminators with trailing space; keep the terminator with its
  // sentence. The lookbehind-free split keeps delimiters via a capturing regex.
  const parts = text.split(/(?<=[.?!])\s+/);
  const chunks: string[] = [];
  let cur = "";
  for (const sentence of parts) {
    if (!cur) {
      cur = sentence;
    } else if (cur.length + 1 + sentence.length <= maxChars) {
      cur += " " + sentence;
    } else {
      chunks.push(cur);
      cur = sentence;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const VideoTopicSchema = z.object({
  niche: optString(),
  setting: optString(),
  subjectExamples: optString(),
  environmentExamples: optString(),
});

// Derive the video's niche/world from the project title + a leading transcript
// sample, ONCE per plan. This is the fix for off-topic visuals: the planner was
// hardcoded to a gardening/lawn-care niche, so a car-maintenance script rendered
// houses and lawns. We now infer the actual subject and thread it into every
// image prompt so the visuals stay on-theme for ANY channel. A cheap Gemini call
// (thinkingBudget:0, tiny output) — on any failure we return EMPTY_TOPIC and the
// prompt falls back to niche-neutral phrasing (no regression).
async function deriveVideoTopic(input: {
  projectId: string;
  jobId?: string;
  title: string;
  transcript: string;
}): Promise<VideoTopic> {
  const { projectId, jobId, title, transcript } = input;
  const sample = transcript.trim().slice(0, 1500);
  if (!title.trim() && !sample) return EMPTY_TOPIC;
  const prompt = [
    "You are setting up the visual world for a short narrated video. From the",
    "TITLE and the transcript SAMPLE below, infer the video's subject/niche so a",
    "downstream image generator keeps every shot on-theme.",
    "",
    "Return STRICT JSON ONLY:",
    '{"niche": "...", "setting": "...", "subjectExamples": "...", "environmentExamples": "..."}',
    "- niche: short label of the topic, e.g. \"automotive / DIY car maintenance\",",
    '  "home cooking", "personal finance".',
    "- setting: the recurring physical place the creator would film in, e.g.",
    '  "home garage / driveway, under the hood", "a home kitchen".',
    "- subjectExamples: a few concrete on-topic objects/subjects, comma-separated,",
    '  e.g. "spark plugs, engine bays, hand tools, oil, dashboards".',
    "- environmentExamples: a few WIDER real-world context scenes of this niche —",
    "  the subject in use or in motion out in its environment, NOT close-ups of",
    '  the objects, comma-separated. e.g. for an engine video: "utes driving on',
    '  highways, vehicles on outback roads, a pickup pulling into a driveway";',
    '  for a cooking video: "a family dinner table, dishes being served".',
    "The examples above are ONLY to show the format — they are illustrative and",
    "MUST NOT influence your answer. Derive every field from THIS video's title",
    "and transcript. In particular, do NOT default to gardening, lawns, a garden",
    "setting, or 'home & garden' unless the transcript is literally about",
    "gardening. 'Home' means the INDOOR living space (kitchen, living room,",
    "bedroom, hallway) and its immediate porch/doorway — it is NOT a garden,",
    "backyard, lawn, or vegetable patch. Only use garden/outdoor-plant imagery",
    "when the narration is specifically about gardening or being outdoors.",
    "For a lifestyle / health / personal-story video with no single",
    "physical craft, prefer a niche/setting drawn from what the narration actually",
    "shows (e.g. a health & wellness routine filmed around a home's kitchen,",
    "living room, and neighbourhood) rather than forcing a generic backyard.",
    "",
    "REMOTE / NON-FILMABLE SUBJECTS (important): some videos are about a world that",
    "canNOT be filmed in a home, garage, kitchen, or office — e.g. space and",
    "astronomy (planets, spacecraft, deep space), the deep ocean, Antarctica / the",
    "poles, wilderness, history / ancient sites, or unexplained-mystery / cryptid",
    "topics. For these, the `setting` and `environmentExamples` MUST be the REAL",
    "subject environment itself, NOT a person's home/office/studio. A commentary or",
    "documentary-style narration ABOUT such a subject still lives in that subject's",
    "world on screen. Examples of the CORRECT world for these: for a Voyager /",
    "space video — \"deep space, planets and their moons, the spacecraft drifting",
    "past worlds, star fields, mission control\"; for an Antarctica mystery video —",
    "\"antarctic ice and open ocean, the frozen coast, the deep sea, the creature in",
    "its habitat\". Do NOT fall back to \"a man talking at a desk / on a computer /",
    "in an office\" as the setting for these subjects — an office is only correct",
    "when the video is genuinely about office/desk work.",
    "Keep each field short (a phrase, not a sentence). No commentary.",
    "",
    `TITLE: ${title.trim() || "(none)"}`,
    "",
    "TRANSCRIPT SAMPLE:",
    sample || "(none)",
  ].join("\n");
  try {
    const { result: res } = await withGeminiModelFallback(
      "deriveVideoTopic",
      (model) =>
        model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
            maxOutputTokens: 512,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            thinkingConfig: { thinkingBudget: 0 },
          } as any,
        }),
      // Short PRIMARY ladder so a broad primary outage (whole model 503ing)
      // fails over to the healthy fallback fast instead of burning ~13s on a
      // dead model; a slightly fuller FALLBACK ladder tries harder on the model
      // that's actually answering. See withGeminiModelFallback's contract.
      { attempts: 2, baseMs: 800 },
      { attempts: 3, baseMs: 800 },
    );
    const parsed = VideoTopicSchema.safeParse(JSON.parse(res.response.text()));
    if (!parsed.success) return EMPTY_TOPIC;
    const topic: VideoTopic = {
      niche: parsed.data.niche.trim(),
      setting: parsed.data.setting.trim(),
      subjectExamples: parsed.data.subjectExamples.trim(),
      environmentExamples: parsed.data.environmentExamples.trim(),
    };
    await logJob({ projectId, jobId }, "synthetic.plan.topic_derived", {
      niche: topic.niche,
      setting: topic.setting,
      environmentExamples: topic.environmentExamples,
    });
    return topic;
  } catch (e) {
    await logJob({ projectId, jobId }, "synthetic.plan.topic_failed", {
      err: (e as Error).message?.slice(0, 200),
    });
    return EMPTY_TOPIC;
  }
}

// Run the Gemini planner for ONE transcript chunk and return its parsed
// basePrompt + raw segments. Sets thinkingBudget:0 and a generous output cap
// (the same fix proven in scoreClipsForSections): gemini-2.5-flash otherwise
// spends its whole output budget on hidden reasoning tokens and truncates the
// visible JSON. On a truncation we salvage whatever complete segments we got,
// and surface MAX_TOKENS in the error instead of the misleading "non-JSON".
async function planTranscriptChunk(
  ctx: { projectId: string; jobId?: string },
  transcript: string,
  chunkLabel: string,
  topic: VideoTopic = EMPTY_TOPIC,
): Promise<{ basePrompt: string; segments: RawSegment[] }> {
  const { result: res, model: usedModel } = await withGeminiModelFallback(
    "buildSyntheticTimeline",
    (model) =>
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: buildPrompt(transcript, topic) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.3,
          // Generous ceiling so we don't truncate from our side; finishReason
          // tells us if the model still overran. Raised from 16384 -> 32768:
          // a 14k-char chunk that segments into ~115 verbose blocks (each with
          // imagePrompt + imagePrompt2 + shotType + shotType2 + animationPrompt)
          // emitted ~62k chars of JSON and hit MAX_TOKENS at 16384, truncating
          // mid-stream (salvage recovered most, but it shouldn't truncate at
          // all). 32k tokens comfortably fits one chunk's output; gemini-2.5-
          // flash allows up to 65k. The chunker still caps INPUT size so this is
          // headroom, not a license to send the whole transcript in one call.
          maxOutputTokens: 32768,
          // gemini-2.5-flash burns its entire output budget on internal
          // reasoning before emitting any JSON, truncating the response at a
          // few hundred bytes regardless of the cap (see scoreClipsForSections).
          // We don't need chain-of-thought to segment a transcript.
          thinkingConfig: { thinkingBudget: 0 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    // Short PRIMARY ladder: when gemini-flash-latest is in a broad outage the
    // old { attempts: 6, baseMs: 2000 } ladder waited 2→6→18→54→162→486s
    // (+jitter) ≈ up to ~12 min on the DEAD primary before even reaching the
    // healthy fallback — and repeated it per chunk (the 2026-07 planner
    // slowdown). Fail over fast, then try harder on the model that's answering.
    { attempts: 2, baseMs: 1500 },
    { attempts: 5, baseMs: 1500 },
  );
  if (usedModel !== getEnv().GEMINI_MODEL) {
    await logJob(ctx, "synthetic.plan.model_fallback", { model: usedModel, chunk: chunkLabel });
  }
  const txt = res.response.text();
  const finishReason = res.response.candidates?.[0]?.finishReason;

  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    const salvaged = salvageTruncatedTimeline(txt);
    if (salvaged) {
      await logJob(ctx, "synthetic.plan.salvaged_truncated", {
        chunk: chunkLabel,
        finishReason,
        responseChars: txt.length,
      });
      parsed = salvaged;
    } else {
      throw new Error(
        `buildSyntheticTimeline: Gemini response unparseable (finishReason=${finishReason}, chars=${txt.length}, chunk=${chunkLabel}): ${txt.slice(0, 200)}`,
      );
    }
  }
  const safe = GeminiResponseSchema.safeParse(parsed);
  if (!safe.success || safe.data.segments.length === 0) {
    throw new Error(
      `buildSyntheticTimeline: schema/empty (finishReason=${finishReason}, chunk=${chunkLabel}): ${JSON.stringify(safe.success ? "empty" : safe.error.flatten()).slice(0, 300)}`,
    );
  }
  return { basePrompt: safe.data.basePrompt.trim(), segments: safe.data.segments };
}

/**
 * Run the Gemini planner and persist the result as synthetic_segments rows.
 * Returns the planned segments. Idempotent on retry: existing segments for the
 * project are cleared before reinsert so a re-planned project doesn't duplicate.
 */
export async function buildSyntheticTimeline(input: {
  projectId: string;
  jobId?: string;
  // Project title — used (with a transcript sample) to derive the video's niche
  // so every image prompt stays on-theme. Optional/empty is fine: the planner
  // then falls back to niche-neutral phrasing.
  projectTitle?: string;
  transcript: string;
  words: WordTiming[] | null;
  voiceoverDuration: number;
  // Char-ranges in `transcript` that were red/orange in the source Google Doc.
  // Any planned segment overlapping one of these is FORCED to block_type
  // 'avatar', overriding Gemini's choice. Empty when no doc marks (pasted text).
  avatarRanges?: AvatarMarkRange[];
}): Promise<PlannedSegment[]> {
  const { projectId, jobId, projectTitle, transcript, words, voiceoverDuration } = input;
  let avatarRanges = input.avatarRanges ?? [];
  if (!transcript.trim()) throw new Error("buildSyntheticTimeline: empty transcript");

  // Derive the video's niche ONCE so every chunk's basePrompt + imagePrompts
  // stay on-theme (the off-topic-visuals fix). Cheap, fault-tolerant call.
  const topic = await deriveVideoTopic({
    projectId,
    jobId,
    title: projectTitle ?? "",
    transcript,
  });

  // A long transcript makes Gemini emit a segments array that overflows its
  // output-token budget and truncates the JSON mid-stream — surfacing as the
  // misleading "Gemini returned non-JSON". So we split the transcript at
  // sentence boundaries into chunks small enough that each response fits, plan
  // each chunk in its own call, then concatenate the segments in order. A short
  // transcript yields a single chunk (one call), so this is a no-op for the
  // common case. Gemini 2.5-flash also hits intermittent 503 "high demand"
  // spikes; planTranscriptChunk waits those out (6 attempts) and falls back to
  // GEMINI_FALLBACK_MODEL before giving up, per chunk.
  const maxChars = getEnv().SYNTHETIC_PLANNER_MAX_CHARS_PER_CALL;
  const chunks = chunkTranscriptBySentence(transcript, maxChars);
  if (chunks.length > 1) {
    await logJob({ projectId, jobId }, "synthetic.plan.chunked", {
      chunks: chunks.length,
      transcriptChars: transcript.trim().length,
      maxCharsPerCall: maxChars,
    });
  }

  // basePrompt is a whole-video style bible; the first chunk reads enough of the
  // script to set it for everyone, so we adopt the first chunk's and ignore the
  // rest (they'd only describe their own slice).
  let basePrompt = "";
  const rawSegments: RawSegment[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const { basePrompt: bp, segments } = await planTranscriptChunk(
      { projectId, jobId },
      chunks[i],
      `${i + 1}/${chunks.length}`,
      topic,
    );
    if (i === 0) basePrompt = bp;
    rawSegments.push(...segments);
  }
  if (rawSegments.length === 0) {
    throw new Error("buildSyntheticTimeline: planner produced no segments");
  }

  let planned = alignSegments(rawSegments, words, voiceoverDuration);

  // Diagnostic: Gemini's RAW block-type choice, BEFORE any avatar-marking,
  // capping, promotion, or merging. This is the ground truth for "did Gemini
  // pick any split_2 at all?" — if rawSplit2 is 0, the downstream split_2 floor
  // (promotion) is what makes the layout appear; if it's non-zero but the final
  // plan has none, a later pass is consuming them.
  await logJob({ projectId, jobId }, "synthetic.plan.raw_types", {
    total: planned.length,
    byType: PLANNER_BLOCK_TYPES.reduce<Record<string, number>>((acc, t) => {
      acc[t] = planned.filter((p) => p.blockType === t).length;
      return acc;
    }, {}),
  });

  // Force avatar on segments that overlap a red/orange doc mark.
  //
  // We locate each segment's char window in the transcript so we can test it
  // against the avatar ranges. Gemini does NOT return verbatim transcript
  // slices (it normalizes punctuation/spacing), so an exact indexOf is
  // unreliable and a single miss makes the cursor drift, mis-marking every
  // following segment. Instead we map through a NORMALIZED projection: build a
  // lowercase, punctuation-stripped copy of the transcript while keeping an
  // index back to the original offsets, then find each segment's normalized
  // script within it. This tolerates Gemini's rewording and never drifts.
  if (avatarRanges.length > 0) {
    // Snap each hand-drawn doc range out to whole-sentence boundaries FIRST, so a
    // highlight that stops mid-sentence (e.g. "...a boy and" with "a girl." left
    // unmarked in the same sentence) covers the WHOLE sentence and splitByMarks
    // never strands a fragment onto the next visual block. Marking is
    // sentence-granular by design.
    const snappedRanges = snapRangesToSentences(transcript, avatarRanges);
    await logJob({ projectId, jobId }, "synthetic.plan.avatar_ranges_snapped", {
      before: avatarRanges.length,
      after: snappedRanges.length,
      markedCharsBefore: avatarRanges.reduce((a, r) => a + (r.end - r.start), 0),
      markedCharsAfter: snappedRanges.reduce((a, r) => a + (r.end - r.start), 0),
    });
    avatarRanges = snappedRanges;
    // normChars[i] = original transcript offset of the i-th normalized char.
    let normStr = "";
    const normToOrig: number[] = [];
    {
      let prevSpace = true;
      for (let i = 0; i < transcript.length; i++) {
        const ch = transcript[i].toLowerCase();
        const keep = /[a-z0-9]/.test(ch);
        if (keep) {
          normStr += ch; normToOrig.push(i); prevSpace = false;
        } else if (!prevSpace) {
          normStr += " "; normToOrig.push(i); prevSpace = true;
        }
      }
    }
    // Normalize the NEEDLE the SAME way normStr is built: lowercase, collapse
    // every run of non-alphanumerics to a single space, trim. The module-level
    // norm() strips spaces entirely, which would never match normStr (which has
    // single spaces between words) — that mismatch silently disabled all avatar
    // marking, so Gemini's own block-type choices leaked through unchanged.
    const normNeedle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    let searchFrom = 0;
    let placed = 0;
    let forced = 0;
    let unplaced = 0;
    let split = 0;
    const result: PlannedSegment[] = [];
    for (const seg of planned) {
      const needle = normNeedle(seg.script);
      if (!needle) {
        result.push(applyMark(seg, false, basePrompt));
        continue;
      }
      const at = normStr.indexOf(needle, searchFrom);
      // Whether or not we can locate the segment, doc marks are AUTHORITATIVE:
      // a segment is avatar IFF its text falls inside a marked range. So the
      // DEFAULT for any segment is "not avatar" — we only promote to avatar on
      // a confirmed overlap. A segment that can't be placed, or that Gemini
      // wrongly chose as avatar, is corrected to a non-avatar type.
      //
      // Marks are sub-segment precise: when a doc highlight covers only PART of
      // a Gemini block, we SPLIT the block at the mark boundary rather than
      // promote the whole block — so the marked half becomes avatar and the
      // unmarked half keeps its visual type.
      if (at < 0) {
        unplaced++;
        result.push(applyMark(seg, false, basePrompt));
        continue;
      }
      placed++;
      const origStart = normToOrig[at];
      const origEnd = (normToOrig[at + needle.length - 1] ?? origStart) + 1;
      // Advance the cursor only on a real match so a single miss can't strand
      // the rest. Re-anchor search from just after this match.
      searchFrom = at + needle.length;
      const pieces = splitByMarks(seg, origStart, origEnd, avatarRanges, basePrompt);
      if (pieces.length > 1) split++;
      for (const p of pieces) {
        if (p.blockType === "avatar") forced++;
        result.push(p);
      }
    }
    // Renumber positions after any splits so they stay 0..n-1 in order.
    result.forEach((p, i) => { p.position = i; });
    planned = result;
    await logJob({ projectId, jobId }, "synthetic.plan.avatar_marks", {
      ranges: avatarRanges.length,
      transcriptChars: transcript.length,
      markedChars: avatarRanges.reduce((a, r) => a + (r.end - r.start), 0),
      segmentsPlaced: placed,
      segmentsUnplaced: unplaced,
      segmentsSplit: split,
      segmentsTotal: planned.length,
      avatarForced: forced,
    });
  }

  // Avatar coalesce pass. Merge contiguous avatar segments into one atomic
  // avatar "part" so the audio-driven HeyGen flow does ONE render per Google-Doc
  // avatar passage (sliced audio upload), not one per ~6s sub-block. Runs AFTER
  // avatar-marking (so a marked range split across Gemini blocks is rejoined)
  // and BEFORE the duration-split pass (which only touches non-avatar blocks, so
  // ordering is safe either way, but coalescing first keeps positions clean).
  {
    const before = planned.length;
    const { segments, merged, overLengthParts } = coalesceAvatarSegments(planned);
    if (merged > 0) {
      segments.forEach((p, i) => { p.position = i; });
      planned = segments;
      await logJob({ projectId, jobId }, "synthetic.plan.avatar_coalesce", {
        segmentsBefore: before,
        segmentsAfter: planned.length,
        partsMerged: merged,
        overLengthParts,
      });
    }
  }

  // split_2 cap pass (client feedback 2026-06: "too many split_2 parts"). Gemini
  // over-chooses split_2; demote the excess to plain 'image' so only a small
  // share remains. Runs AFTER avatar-marking/coalescing (a doc-marked avatar is
  // never a split_2, so it's untouched) and BEFORE the clip-heavy + duration
  // passes (so a demoted image can still be promoted to ai_clip in the intro and
  // carved by duration-split like any other image).
  {
    const maxFraction = getEnv().SYNTHETIC_SPLIT2_MAX_FRACTION;
    const minGap = getEnv().SYNTHETIC_SPLIT2_MIN_GAP;
    // 10-15% BAND (client 2026-07-07). maxFraction (0.15) is the ceiling; the floor
    // is the LARGER of the fixed MIN_KEEP count and MIN_FRACTION (0.10) of total
    // blocks — so a plan with plenty of split_2 settles at ~10-15% instead of being
    // scraped to a token few, while a short video still keeps a couple when 10%
    // rounds below the fixed count. This only holds split_2 Gemini already chose
    // (the capper demotes excess, never promotes), so it's a don't-demote-below
    // floor, not a forced minimum. PRECEDENCE: the MIN_GAP spacing rule still wins
    // over the floor — a heavily CLUSTERED section can land below 10% because
    // spreading a clump matters more to the client than hitting the exact band
    // (they explicitly rejected consecutive split_2). In a normally-spread video
    // the band binds and split_2 settles at ~10-15%.
    const minFraction = getEnv().SYNTHETIC_SPLIT2_MIN_FRACTION;
    const fracFloor = minFraction > 0 ? Math.ceil(planned.length * minFraction) : 0;
    const minKeep = Math.max(getEnv().SYNTHETIC_SPLIT2_MIN_KEEP, fracFloor);
    const before = planned.filter((p) => p.blockType === "split_2").length;
    const { segments, demoted } = capSplit2Blocks(planned, maxFraction, minKeep, minGap);
    if (demoted > 0) {
      segments.forEach((p, i) => { p.position = i; });
      planned = segments;
      await logJob({ projectId, jobId }, "synthetic.plan.split2_cap", {
        maxFraction,
        minFraction,
        minKeep,
        minGap,
        split2Before: before,
        split2After: before - demoted,
        demotedToImage: demoted,
        totalBlocks: planned.length,
      });
    }
  }

  // split_2 DURATION cap (client 2026-07-03: a 38s split_2 held the same still
  // beside the presenter for 5 sentences). An over-long split_2 keeps its FIRST
  // sentence as the split_2; the remaining sentences become a plain image block.
  //
  // This runs TWICE: once here (after the count cap, before the clip-heavy +
  // duration passes, so the carved-off remainder is paced like any other long
  // image block) and once as the FINAL pass before persist. The second run is
  // required because split_2 is exempt from every carve pass (splitByDuration
  // skips it) and `ensureMinSplit2` can PROMOTE an image to split_2 AFTER this
  // early pass — a promotion the early cap never sees, which is how a 22.5s /
  // 5-sentence split_2 reached the review screen. The tag distinguishes the two
  // in the job log.
  const runSplit2DurationCap = async (tag: string) => {
    const maxSeconds = getEnv().SYNTHETIC_SPLIT2_MAX_SECONDS;
    if (maxSeconds <= 0) return;
    const { segments, carved, demoted, regen } = capSplit2Duration(planned, maxSeconds);
    if (carved === 0 && demoted === 0) return;
    // Each carved piece now covers only PART of the passage its inherited
    // imagePrompt described, so regenerate a prompt for each piece's own script.
    // A regen failure is non-fatal — the piece keeps the parent's prompt
    // (sub-optimal but renderable), the pacing win still lands.
    let regenerated = 0;
    let regenFailed = 0;
    const capLimit = makeLimit(5);
    await Promise.all(
      regen.map((p) =>
        capLimit(async () => {
          try {
            const r = await regenerateSegmentPrompt({
              projectId,
              jobId,
              script: p.script,
              basePrompt,
              blockType: p.blockType,
            });
            // Composed WITH the base in front (like the merge pass), so clear
            // shotType — persist's composePrompt sees the base already present
            // and passes it through unchanged.
            p.imagePrompt = r.imagePrompt;
            p.shotType = null;
            regenerated++;
          } catch {
            regenFailed++;
          }
        }),
      ),
    );
    segments.forEach((p, i) => { p.position = i; });
    planned = segments;
    await logJob({ projectId, jobId }, "synthetic.plan.split2_duration_cap", {
      pass: tag,
      maxSeconds,
      blocksCarved: carved,
      blocksDemoted: demoted,
      promptsRegenerated: regenerated,
      promptRegenFailed: regenFailed,
      totalBlocks: planned.length,
    });
  };
  await runSplit2DurationCap("early");

  // Clip-heavy intro pass (client requirement 2026-06). The reference channel
  // opens with mostly MOVING footage and switches to still images later to save
  // credits. Promote every 'image' block whose spoken window STARTS before
  // SYNTHETIC_CLIP_HEAVY_SECONDS to an 'ai_clip' so the opening stretch is
  // animated; blocks after the cutoff keep Gemini's choice (stills dominate).
  //
  // Runs AFTER avatar-marking and coalescing (so it never touches an avatar
  // block or overrides a doc mark — only plain 'image' blocks are promoted) and
  // BEFORE the duration-split pass (so a promoted long clip is still carved into
  // LTX-tier pieces with the usual clip-then-fill-image handling).
  //
  // A promoted block has no animationPrompt from Gemini (it was an 'image'); the
  // worker falls back to the client's default gentle pan, so we leave it null
  // here rather than inventing per-block motion text.
  {
    const cutoff = getEnv().SYNTHETIC_CLIP_HEAVY_SECONDS;
    if (cutoff > 0) {
      let promoted = 0;
      for (const seg of planned) {
        if (seg.blockType === "image" && seg.startTime < cutoff) {
          seg.blockType = "ai_clip";
          promoted++;
        }
      }
      if (promoted > 0) {
        await logJob({ projectId, jobId }, "synthetic.plan.clip_heavy_intro", {
          cutoffSeconds: cutoff,
          blocksPromoted: promoted,
        });
      }
    }
  }

  // Duration-split pass. Gemini's per-block sizing is a soft prompt hint, so
  // it routinely emits long blocks (a long sentence -> a 13-21s ai_clip). The
  // client's reference video paces every visual block at ~3-8s, and LTX-2
  // can't animate a 21s still in one call. Carve any visual block longer than
  // the threshold into ~target-second sub-blocks. Runs AFTER avatar-mark
  // splitting so a sub-block that was promoted to 'avatar' is correctly
  // exempted. Renumber positions afterward so they stay 0..n-1.
  {
    const env = getEnv();
    const target = env.SYNTHETIC_BLOCK_TARGET_SECONDS;
    const threshold = env.SYNTHETIC_BLOCK_SPLIT_THRESHOLD;
    let durSplit = 0;
    const out: PlannedSegment[] = [];
    for (const seg of planned) {
      const pieces = splitByDuration(seg, target, threshold);
      if (pieces.length > 1) durSplit++;
      out.push(...pieces);
    }
    if (out.length !== planned.length) {
      out.forEach((p, i) => { p.position = i; });
      await logJob({ projectId, jobId }, "synthetic.plan.duration_split", {
        targetSeconds: target,
        thresholdSeconds: threshold,
        blocksSplit: durSplit,
        segmentsBefore: planned.length,
        segmentsAfter: out.length,
      });
      planned = out;
    }
  }

  // Merge-short-visuals pass (client feedback 2026-06: image switches too often,
  // ~1s between — slow everything down to ~5-6s). Runs LAST of the timeline
  // passes so it is the final word on pacing: a SHORT image/ai_clip sentence is
  // merged INTO the previous same-type sentence so the two render as ONE visual
  // instead of two flashes, until each merged block reaches the minimum hold.
  // avatar and split_2 blocks are never merged. Each merged block now covers two
  // sentences, so we regenerate ONE combined imagePrompt for its merged script
  // (the stored prompt was the first sentence's only). Renumber positions
  // afterward so they stay 0..n-1.
  {
    const minHold = getEnv().SYNTHETIC_BLOCK_MIN_HOLD;
    const maxHold = getEnv().SYNTHETIC_BLOCK_SPLIT_THRESHOLD;
    if (minHold > 0) {
      const before = planned.length;
      const { segments, merged } = mergeShortVisualSegments(planned, minHold, maxHold);
      if (merged > 0) {
        // Regenerate one combined imagePrompt per merged block so the visual
        // reflects BOTH sentences, not just the first. We reuse the same
        // single-block regenerator the review screen uses. A regen failure is
        // non-fatal: we keep the first sentence's prompt (already on the row)
        // rather than failing the whole plan — the merge's pacing win still
        // lands, only that one block's prompt is sub-optimal.
        let regenerated = 0;
        let regenFailed = 0;
        // Regenerate in PARALLEL with a concurrency cap. These blocks have no
        // cross-item dependency (each mutates only its own fields), so running
        // them one-at-a-time serialized ~74 Gemini calls behind each other —
        // the dominant cost of the 2026-07 planner slowdown when 2.5-flash was
        // broadly 503ing. The limiter keeps ~5 in flight so a spike doesn't fan
        // out into its own throttle, while collapsing the wall-time ~5x.
        const mergeLimit = makeLimit(5);
        await Promise.all(
          segments
            .filter((p) => p.needsPromptRegen && p.blockType !== "avatar")
            .map((p) =>
              mergeLimit(async () => {
                try {
                  const r = await regenerateSegmentPrompt({
                    projectId,
                    jobId,
                    script: p.script,
                    basePrompt,
                    blockType: p.blockType,
                  });
                  // regenerateSegmentPrompt returns a prompt already composed WITH
                  // the base in front and the shot folded in, so clear shotType and
                  // the second-visual nudge — persist's composePrompt sees the base
                  // already present and passes it through unchanged.
                  p.imagePrompt = r.imagePrompt;
                  p.shotType = null;
                  p.secondVisual = false;
                  if (p.blockType === "ai_clip") p.animationPrompt = r.animationPrompt;
                  regenerated++;
                } catch {
                  regenFailed++;
                }
              }),
            ),
        );
        // Re-split any merged block whose combined window exceeds the cap into
        // even ~minHold slots, so a 7s + 2.6s pair plays as TWO ~4.8s visuals
        // (slot 1 = combined prompt, slots 2+ = a different angle) instead of
        // one over-long hold. Runs AFTER the regen loop so slot 1 carries the
        // combined prompt; each slot ends up < maxHold (clips stay animatable).
        const { segments: resplit, split: blocksResplit } =
          splitMergedVisuals(segments, minHold, maxHold);
        resplit.forEach((p, i) => { p.position = i; });
        planned = resplit;
        await logJob({ projectId, jobId }, "synthetic.plan.merge_short_visuals", {
          minHoldSeconds: minHold,
          maxHoldSeconds: maxHold,
          blocksMerged: merged,
          promptsRegenerated: regenerated,
          promptRegenFailed: regenFailed,
          blocksResplit,
          segmentsBefore: before,
          segmentsAfter: planned.length,
        });
      }
    }
  }

  // FINAL image/ai_clip balance by position. Runs LAST so the short-visual
  // merge's clip-bias can't undo it: before the clip-heavy cutoff visuals follow
  // the intro run pattern (default 2 clips / 2 images — client cost fix
  // 2026-07-03); after it, only a fraction stay clips (evenly spaced) and the
  // rest become stills — a natural mix instead of the all-clip snowball. split_2
  // and avatar are untouched.
  {
    const cutoff = getEnv().SYNTHETIC_CLIP_HEAVY_SECONDS;
    const postFraction = getEnv().SYNTHETIC_POST_INTRO_CLIP_FRACTION;
    const introClipRun = getEnv().SYNTHETIC_INTRO_CLIP_RUN;
    const introImageRun = getEnv().SYNTHETIC_INTRO_IMAGE_RUN;
    const { segments, toClip, toImage } = balanceVisualTypesByPosition(
      planned, cutoff, postFraction, introClipRun, introImageRun,
    );
    if (toClip > 0 || toImage > 0) {
      planned = segments;
      await logJob({ projectId, jobId }, "synthetic.plan.visual_balance", {
        clipHeavyCutoffSeconds: cutoff,
        postIntroClipFraction: postFraction,
        introClipRun,
        introImageRun,
        flippedToClip: toClip,
        flippedToImage: toImage,
        byTypeAfter: PLANNER_BLOCK_TYPES.reduce<Record<string, number>>((acc, t) => {
          acc[t] = planned.filter((p) => p.blockType === t).length;
          return acc;
        }, {}),
      });
    }
  }

  // split_2 FLOOR. Gemini sometimes returns FAR fewer split_2 than the client's
  // 10-15% band wants — on a 300-part video it routinely picks just 2-6, so the
  // layout barely appears (client: "the split count is only 2 or 10 although
  // there are 250 parts"). Promote evenly-spaced post-intro 'image' blocks up to
  // the SAME band floor the cap pass uses — max(MIN_KEEP, ceil(total *
  // MIN_FRACTION)) — so a long video reaches ~10% split_2 instead of the fixed
  // count of 2. Runs AFTER the visual balance so the balance pass can't flip a
  // promotion back to image. The cap pass (which only DEMOTES) enforces the
  // upper 15% edge; this promoter enforces the lower 10% edge. Both must use the
  // fractional floor or the band only binds from one side (the bug that let long
  // videos sit at <2% split_2).
  {
    const minFraction = getEnv().SYNTHETIC_SPLIT2_MIN_FRACTION;
    const fracFloor = minFraction > 0 ? Math.ceil(planned.length * minFraction) : 0;
    const minKeep = Math.max(getEnv().SYNTHETIC_SPLIT2_MIN_KEEP, fracFloor);
    const cutoff = getEnv().SYNTHETIC_CLIP_HEAVY_SECONDS;
    const haveBefore = planned.filter((p) => p.blockType === "split_2").length;
    const { segments, promoted } = ensureMinSplit2(planned, minKeep, cutoff);
    if (promoted > 0) {
      planned = segments;
      await logJob({ projectId, jobId }, "synthetic.plan.split2_floor", {
        minKeep,
        minFraction,
        fracFloor,
        totalBlocks: planned.length,
        split2Before: haveBefore,
        promotedFromImage: promoted,
        split2After: haveBefore + promoted,
      });
    }
  }

  // DISTINCT-SCENE pass for the EXTRA visuals of one sentence (client 2026-06-30:
  // "if several images are generated in the same sentence, the image is the same
  // now"). When a sentence is shown with MULTIPLE visuals, every slot after the
  // first is flagged `secondVisual` and, until now, reused slot 1's imagePrompt
  // with only a weak "different angle" text nudge — which nano-banana renders as a
  // near-clone (the exact failure the imagePrompt2 system documents). That nudge
  // also never covered the 3rd+ slot from splitMergedVisuals at all.
  //
  // So here, for EACH secondVisual slot, regenerate a GENUINELY DIFFERENT scene of
  // the same sentence, telling Gemini which scenes the earlier slots already show
  // (avoidScenes) so it picks a new subject/moment/detail. Slots are grouped into
  // "same sentence" runs by their identical script: a non-secondVisual anchor
  // followed by its secondVisual slots. A regen failure is non-fatal — that one
  // slot keeps the old angle-nudge prompt (set below via secondVisualPrompt at
  // persist) rather than failing the whole plan.
  {
    let distinctRegenerated = 0;
    let distinctRegenFailed = 0;
    // First collect each sentence's run of secondVisual slots (an anchor +
    // its following same-script slots). The `avoid` chaining is sequential
    // WITHIN a run (each slot avoids the earlier slots' scenes), so slots in
    // one run can't be parallelized against each other — but DIFFERENT runs
    // are independent. So we process runs in parallel with a concurrency cap
    // and keep each run's slots sequential, cutting wall-time without breaking
    // the avoid-chaining that makes the extra visuals distinct.
    const runs: { anchor: PlannedSegment; slots: PlannedSegment[] }[] = [];
    let i = 0;
    while (i < planned.length) {
      const anchor = planned[i];
      if (anchor.blockType === "avatar" || anchor.secondVisual) { i++; continue; }
      const slots: PlannedSegment[] = [];
      let j = i + 1;
      while (
        j < planned.length &&
        planned[j].secondVisual &&
        planned[j].blockType !== "avatar" &&
        planned[j].script === anchor.script
      ) {
        slots.push(planned[j]);
        j++;
      }
      if (slots.length > 0) runs.push({ anchor, slots });
      i = j > i + 1 ? j : i + 1;
    }

    const distinctLimit = makeLimit(5);
    await Promise.all(
      runs.map(({ anchor, slots }) =>
        distinctLimit(async () => {
          const avoid: string[] = [];
          const anchorScene = anchor.imagePrompt?.trim();
          if (anchorScene) avoid.push(anchorScene);
          for (const slot of slots) {
            try {
              const r = await regenerateSegmentPrompt({
                projectId,
                jobId,
                script: slot.script,
                basePrompt,
                blockType: slot.blockType,
                avoidScenes: avoid,
              });
              // regenerateSegmentPrompt returns a prompt already composed WITH the
              // base in front and the shot folded in, so clear shotType and the
              // second-visual nudge — persist's composePrompt passes it through.
              slot.imagePrompt = r.imagePrompt;
              slot.shotType = null;
              slot.secondVisual = false;
              if (slot.blockType === "ai_clip") slot.animationPrompt = r.animationPrompt;
              // The next slot of this sentence must also avoid THIS new scene.
              avoid.push(r.imagePrompt);
              distinctRegenerated++;
            } catch {
              distinctRegenFailed++;
              // Keep the existing scene in avoid so a later slot still differs from it.
              if (slot.imagePrompt?.trim()) avoid.push(slot.imagePrompt.trim());
            }
          }
        }),
      ),
    );
    if (distinctRegenerated > 0 || distinctRegenFailed > 0) {
      await logJob({ projectId, jobId }, "synthetic.plan.distinct_second_visuals", {
        regenerated: distinctRegenerated,
        regenFailed: distinctRegenFailed,
      });
    }
  }

  // FINAL split_2 DURATION cap. `ensureMinSplit2` above can promote an image to
  // split_2 AFTER the early cap ran, and split_2 is exempt from splitByDuration,
  // so a promoted long block would otherwise hold beside the presenter past the
  // cap. Re-run the cap here — a promoted split_2 that fits stays untouched; one
  // over the cap is carved (first sentence stays split_2, rest → image). Runs
  // after the distinct-scene pass so no later pass can re-lengthen a split_2.
  await runSplit2DurationCap("final");

  // Persist. Clear any prior plan first so retries don't accumulate.
  const sb = getServerSupabase();
  await sb.from("synthetic_segments").delete().eq("project_id", projectId);
  const rows = planned.map((p) => ({
    project_id: projectId,
    position: p.position,
    block_type: p.blockType,
    start_time: p.startTime,
    end_time: p.endTime,
    duration: p.duration,
    script: p.script,
    // Compose the shared base prompt in FRONT of the block's scene-specific
    // prompt so generation always carries the recurring world. avatar blocks
    // have no visual prompt (imagePrompt is null) and stay null. The SECOND
    // visual of a long sentence gets a "different angle" nudge so the two
    // frames covering one sentence aren't identical (both still derive from the
    // SAME full-sentence prompt — only the composition differs).
    image_prompt:
      p.blockType === "avatar"
        ? null
        : composePrompt(basePrompt, secondVisualPrompt(p.imagePrompt, p.secondVisual), p.shotType),
    animation_prompt: p.animationPrompt,
    // Which HeyGen model an avatar block renders with (red highlight ->
    // avatar_iv, orange -> avatar_iii). Null for every non-avatar block.
    avatar_model: p.blockType === "avatar" ? (p.avatarModel ?? "avatar_iv") : null,
    // Stash the video's recurring world on every row so the image processors
    // have a LAST-RESORT visual prompt that is on-topic — never the spoken
    // narration. A visual block should always carry a composed image_prompt
    // above, but if Gemini ever returns an empty scene AND there's no base, the
    // processor falls back to this instead of drawing the script verbatim.
    metadata: { base_prompt: basePrompt || null },
    status: "pending" as const,
  }));
  const { error } = await sb.from("synthetic_segments").insert(rows);
  if (error) throw new Error(`buildSyntheticTimeline persist: ${error.message}`);

  await logJob({ projectId, jobId }, "synthetic.plan.done", {
    segments: planned.length,
    byType: PLANNER_BLOCK_TYPES.reduce<Record<string, number>>((acc, t) => {
      acc[t] = planned.filter((p) => p.blockType === t).length;
      return acc;
    }, {}),
    voiceoverDuration,
    basePromptChars: basePrompt.length,
  });

  return planned;
}

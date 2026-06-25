import { z } from "zod";
import { getEnv } from "@/lib/env";
import { withGeminiModelFallback } from "@/lib/ai/gemini";
import { getServerSupabase } from "@/lib/supabase/server";
import { logJob } from "@/lib/jobs/db";
import type { WordTiming } from "@/lib/ai/deepgram";
import { alignSentencesToWords } from "@/lib/ai/sentence-alignment";
import type { Sentence } from "@/lib/ai/sentences";
import type { SyntheticBlockType } from "@/lib/types";
import { type AvatarMarkRange } from "@/lib/synthetic/doc-marks";

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

const GeminiSegmentSchema = z.object({
  blockType: z.enum(["avatar", "image", "ai_clip", "split_2"]),
  // The contiguous slice of transcript this block covers. Used to find the
  // block's spoken window in the word timings.
  script: z.string().min(1),
  imagePrompt: z.string().optional().default(""),
  animationPrompt: z.string().optional().default(""),
});
const GeminiResponseSchema = z.object({
  // A global "style bible" for the whole video: the recurring subjects, setting,
  // era, and mood that every block shares. Composed in FRONT of each block's
  // scene-specific imagePrompt at persist time so adjacent blocks describing the
  // same scene generate as one continuous world instead of drifting apart.
  basePrompt: z.string().optional().default(""),
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
  animationPrompt: string | null;
  // True for the SECOND visual attached to a long sentence (see
  // splitByDuration). Both visuals share the full sentence + prompt; this flag
  // tells the persist step to nudge the second one to a different
  // composition/angle so the two frames aren't identical.
  secondVisual?: boolean;
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
  "the picture. One block = one clean single photo of one subject.";

// Object-first B-roll rule (client requirement 2026-06). The reference channel
// reads as the creator filming his OWN garden, not a stock library: when the
// narration names a THING, the screen shows THAT thing (script says "water" ->
// show water; "clogged gutter" -> show the gutter; "potted geranium" -> show the
// flower; "female mosquito" -> show the mosquito), NOT a person. Our earlier
// output leaned on people (an old lady / an old man / the presenter) for lines
// that were really about objects, which read as generic stock footage. So the
// DEFAULT subject is the concrete object, plant, tool, pest, or patch of garden
// the line is about — shoot it close, hands-and-soil B-roll, owner's-own-garden
// feel. Only put a PERSON in frame when the narration is genuinely about a
// person or a first-person action; never as filler for an object-focused line.
const BROLL_OBJECT_RULE =
  "B-ROLL, OBJECTS NOT PEOPLE (critical, client requirement): this is an " +
  "owner filming his OWN garden, NOT a stock-photo library. When the narration " +
  "names a concrete thing — a plant, flower, tool, pest, water, soil, a patch " +
  "of lawn, a gutter, etc. — the imagePrompt MUST show THAT thing as the single " +
  "subject (close, candid, hands-in-the-dirt B-roll of the real object in a " +
  "real garden), NOT a person. Do NOT default to people (no 'an elderly woman', " +
  "'a man', 'a gardener' standing there) for lines that are about objects — that " +
  "reads as generic stock footage, which the client does NOT want. Put a PERSON " +
  "in frame ONLY when the line is genuinely about a person or a first-person " +
  "action; otherwise show the object / plant / place itself.";

// Amateur-real look rule (client requirement 2026-06). Even though the phone-shot
// STYLE_PROMPT is appended at generation time, Gemini tends to slip cinematic
// words into the scene prompt ("cinematic", "shallow depth of field", "golden
// hour", "professional photo", "dramatic lighting"), which fight the amateur look
// and bring back the gorgeous-but-fake stock/CGI vibe the client rejected. Forbid
// those here so the scene prompt describes WHAT is shown, never a produced style.
const AMATEUR_LOOK_RULE =
  "AMATEUR REAL LOOK (client requirement): describe the scene as if shot by an " +
  "ordinary person on a phone in their own garden. Do NOT add any cinematic, " +
  "professional, or stock-photo styling words — NO 'cinematic', NO 'shallow depth " +
  "of field' / 'bokeh' / 'blurred background', NO 'golden hour' / 'dramatic " +
  "lighting' / 'lens flare', NO 'professional photo' / 'award-winning' / '8k'. " +
  "Just describe the real subject and setting plainly; the camera look is added " +
  "separately.";

function buildPrompt(transcript: string): string {
  return [
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
    "  - split_2: mixed explanation where a talking presenter AND an",
    "             illustrative image should appear together.",
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
    "video's recurring visual world — the main recurring subjects, the setting /",
    "location type, the era, and the overall mood. This is a shared style bible",
    "that every block builds on; it is prepended to each block's imagePrompt",
    "automatically, so describe the constants here, NOT any one moment. Do NOT",
    "include camera or film-grain styling — that is appended separately.",
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
    SINGLE_SUBJECT_RULE,
    "",
    BROLL_OBJECT_RULE,
    "",
    AMATEUR_LOOK_RULE,
    "",
    "CONTINUITY (critical): when consecutive blocks describe one continuous",
    "scene, they MUST keep the SAME setting, lighting, subjects, and framing so",
    "they read as one continuous shot. Only change the visual world when the",
    "narration genuinely moves to a new scene.",
    "",
    "For ai_clip blocks also write an `animationPrompt`. The client wants GENTLE",
    "CAMERA MOTION over an otherwise STILL scene — the camera slowly pans left-to-",
    "right (or right-to-left) or slowly pushes in, while the scene itself stays",
    "essentially static. This is the reference channel's look. Do NOT describe",
    "dramatic action, fast motion, or eventful 'something happening' in the scene;",
    "default to a slow, steady camera move (e.g. 'slow horizontal pan left to",
    "right across the scene, otherwise still' or 'slow push-in, scene static').",
    "avatar blocks need no prompts.",
    "",
    'Respond ONLY with JSON: {"basePrompt","segments":[{"blockType","script","imagePrompt","animationPrompt"}]}',
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
function buildSingleSegmentPrompt(script: string, basePrompt: string, blockType: SyntheticBlockType): string {
  const wantsAnimation = blockType === "ai_clip";
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
    "",
    SINGLE_SUBJECT_RULE,
    "",
    BROLL_OBJECT_RULE,
    "",
    AMATEUR_LOOK_RULE,
    "",
    wantsAnimation
      ? 'Respond ONLY with JSON: {"imagePrompt","animationPrompt"}  (animationPrompt = GENTLE camera motion over an otherwise still scene: a slow horizontal pan or slow push-in, NOT dramatic action or eventful motion).'
      : 'Respond ONLY with JSON: {"imagePrompt"}',
    "",
    `basePrompt: ${basePrompt.trim() || "(none)"}`,
    "",
    "script:",
    script.trim(),
  ].join("\n");
}

const SingleSegmentSchema = z.object({
  imagePrompt: z.string().min(1),
  animationPrompt: z.string().optional().default(""),
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
}): Promise<RegeneratedPrompt> {
  const { projectId, jobId, script, basePrompt, blockType } = input;
  if (blockType === "avatar") {
    throw new Error("regenerateSegmentPrompt: avatar blocks have no image prompt");
  }
  if (!script.trim()) throw new Error("regenerateSegmentPrompt: empty script");

  const { result: res, model: usedModel } = await withGeminiModelFallback(
    "regenerateSegmentPrompt",
    (model) =>
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: buildSingleSegmentPrompt(script, basePrompt, blockType) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
      }),
    { attempts: 4, baseMs: 1500 },
  );
  if (usedModel !== getEnv().GEMINI_MODEL) {
    await logJob({ projectId, jobId }, "synthetic.prompt_regen.model_fallback", { model: usedModel });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.response.text());
  } catch {
    throw new Error(`regenerateSegmentPrompt: Gemini returned non-JSON: ${res.response.text().slice(0, 200)}`);
  }
  const safe = SingleSegmentSchema.safeParse(parsed);
  if (!safe.success) {
    throw new Error(`regenerateSegmentPrompt: schema: ${JSON.stringify(safe.error.flatten()).slice(0, 200)}`);
  }

  return {
    // Compose the base in front exactly like persist does, so the stored prompt
    // carries the recurring world (composePrompt is the same helper).
    imagePrompt: composePrompt(basePrompt, safe.data.imagePrompt.trim()) ?? safe.data.imagePrompt.trim(),
    animationPrompt: blockType === "ai_clip" ? (safe.data.animationPrompt?.trim() || null) : null,
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
function composePrompt(basePrompt: string, blockPrompt: string | null): string | null {
  const base = basePrompt.trim();
  const block = (blockPrompt ?? "").trim();
  if (!base) return block || null;
  if (!block) return base;
  // Avoid a duplicated base if a block prompt already starts with it (e.g. an
  // edited row re-run through the planner).
  if (block.toLowerCase().startsWith(base.toLowerCase())) return block;
  return `${base.replace(/[.\s]+$/, "")}. ${block}`;
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
    const marked = ranges.some((r) => r.start <= mid && mid < r.end);
    const last = runs[runs.length - 1];
    if (last && last.marked === marked) {
      last.end = b; // coalesce same-type adjacent runs
    } else {
      runs.push({ start: a, end: b, marked });
    }
  }
  return runs;
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
    return [applyMark(seg, marked, basePrompt)];
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
    out.push(applyMark(sub, run.marked, basePrompt));
  }
  return out.length > 0 ? out : [applyMark(seg, runs.some((r) => r.marked), basePrompt)];
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
// Non-avatar segments pass through untouched. avatar parts are capped at 1 min
// by the content rules (well under HeyGen Pro's 5-min limit); we LOG a warning
// if a merged part ever exceeds the cap rather than splitting, since by
// agreement it never should — the log surfaces a content-rule violation instead
// of silently producing an over-length HeyGen request.
const AVATAR_PART_MAX_SECONDS = 60;
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
    if (prev && prev.blockType === "avatar" && seg.blockType === "avatar") {
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
//   - A sentence > threshold: TWO visuals splitting the sentence's time in half.
//       * ai_clip sentence  -> CLIP first (snapped to LTX's tier), then an
//         IMAGE fills the leftover time after the clip ends. So piece 1 stays
//         ai_clip; piece 2 becomes an `image` (different scene/angle of the
//         SAME sentence) covering [clipEnd, sentenceEnd).
//       * image sentence    -> IMAGE first half, a SECOND image (different
//         scene/angle of the SAME sentence) the second half.
//       * split_2 sentence  -> left to the avatar flow (a talking presenter
//         holds the whole sentence); not time-split here.
//
// Both pieces keep the parent's script + imagePrompt. The SECOND piece is
// flagged (metadata.secondVisual) so the persist step / image generator can
// nudge it to a different composition rather than producing a duplicate frame.
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

  // Always exactly TWO visuals for a long sentence: the sentence is one thought,
  // so we never fragment it further than first-half / second-half.
  const mid = seg.startTime + dur / 2;

  if (seg.blockType === "ai_clip") {
    // Clip first (it snaps to an LTX tier at generation time), image fills the
    // remainder. The clip piece keeps its animationPrompt; the fill image drops
    // it (an image has no motion) and is marked as the second visual.
    const clipPiece: PlannedSegment = {
      ...seg,
      startTime: seg.startTime,
      endTime: mid,
      duration: Math.max(0.5, mid - seg.startTime),
    };
    const fillImage: PlannedSegment = {
      ...seg,
      blockType: "image",
      animationPrompt: null,
      startTime: mid,
      endTime: seg.endTime,
      duration: Math.max(0.5, seg.endTime - mid),
      secondVisual: true,
    };
    return [clipPiece, fillImage];
  }

  // image: two stills, each holding half the sentence, both from the full
  // sentence. The second is flagged so it gets a different composition/angle.
  const first: PlannedSegment = {
    ...seg,
    startTime: seg.startTime,
    endTime: mid,
    duration: Math.max(0.5, mid - seg.startTime),
  };
  const second: PlannedSegment = {
    ...seg,
    startTime: mid,
    endTime: seg.endTime,
    duration: Math.max(0.5, seg.endTime - mid),
    secondVisual: true,
  };
  return [first, second];
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
function applyMark(seg: PlannedSegment, marked: boolean, basePrompt: string): PlannedSegment {
  if (marked) {
    return { ...seg, blockType: "avatar", imagePrompt: null, animationPrompt: null };
  }
  if (seg.blockType === "avatar") {
    return {
      ...seg,
      blockType: "image",
      imagePrompt: seg.imagePrompt || basePrompt.trim() || seg.script.slice(0, 200),
    };
  }
  return seg;
}

/**
 * Run the Gemini planner and persist the result as synthetic_segments rows.
 * Returns the planned segments. Idempotent on retry: existing segments for the
 * project are cleared before reinsert so a re-planned project doesn't duplicate.
 */
export async function buildSyntheticTimeline(input: {
  projectId: string;
  jobId?: string;
  transcript: string;
  words: WordTiming[] | null;
  voiceoverDuration: number;
  // Char-ranges in `transcript` that were red/orange in the source Google Doc.
  // Any planned segment overlapping one of these is FORCED to block_type
  // 'avatar', overriding Gemini's choice. Empty when no doc marks (pasted text).
  avatarRanges?: AvatarMarkRange[];
}): Promise<PlannedSegment[]> {
  const { projectId, jobId, transcript, words, voiceoverDuration } = input;
  const avatarRanges = input.avatarRanges ?? [];
  if (!transcript.trim()) throw new Error("buildSyntheticTimeline: empty transcript");

  // Gemini 2.5-flash hits intermittent 503 "high demand" spikes. The planner is
  // a single one-shot call per project (not high-volume), so we can afford to
  // wait it out: 6 attempts with a longer base backoff rather than the default
  // 3. A demand spike is per-model, so if the primary model still fails after
  // all 6 retries we fall back to GEMINI_FALLBACK_MODEL and retry there — turning
  // a transient Google outage on one model into a slightly slower success on
  // another, instead of a hard job failure.
  const { result: res, model: usedModel } = await withGeminiModelFallback(
    "buildSyntheticTimeline",
    (model) =>
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: buildPrompt(transcript) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      }),
    { attempts: 6, baseMs: 2000 },
  );
  if (usedModel !== getEnv().GEMINI_MODEL) {
    await logJob({ projectId, jobId }, "synthetic.plan.model_fallback", { model: usedModel });
  }
  const txt = res.response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    throw new Error(`buildSyntheticTimeline: Gemini returned non-JSON: ${txt.slice(0, 200)}`);
  }
  const safe = GeminiResponseSchema.safeParse(parsed);
  if (!safe.success || safe.data.segments.length === 0) {
    throw new Error(
      `buildSyntheticTimeline: schema/empty: ${JSON.stringify(safe.success ? "empty" : safe.error.flatten()).slice(0, 300)}`,
    );
  }

  // Shared style bible for the whole video. Prepended to each block's
  // scene-specific prompt at persist time (composePrompt) so adjacent blocks of
  // the same scene generate as one continuous world, and used as the visual
  // fallback for demoted avatar blocks instead of raw narration text.
  const basePrompt = safe.data.basePrompt.trim();

  let planned = alignSegments(safe.data.segments, words, voiceoverDuration);

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
        : composePrompt(basePrompt, secondVisualPrompt(p.imagePrompt, p.secondVisual)),
    animation_prompt: p.animationPrompt,
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

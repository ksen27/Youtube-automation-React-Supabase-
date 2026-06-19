import { z } from "zod";
import { getEnv } from "@/lib/env";
import { getGeminiModel, withGeminiRetry } from "@/lib/ai/gemini";
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
const GeminiResponseSchema = z.object({ segments: z.array(GeminiSegmentSchema) });

export interface PlannedSegment {
  position: number;
  blockType: SyntheticBlockType;
  startTime: number;
  endTime: number;
  duration: number;
  script: string;
  imagePrompt: string | null;
  animationPrompt: string | null;
}

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
    "Block sizing: aim for 3-8 seconds of narration per block, ~6s typical;",
    "split long passages into multiple blocks rather than one long hold. Never",
    "let a single visual block run longer than ~8 seconds of narration.",
    "",
    "For image/ai_clip/split_2 blocks, write an `imagePrompt`: a vivid, concrete",
    "visual description (subject, setting, composition). Do NOT include camera",
    "or film-grain styling — that is appended automatically.",
    "For ai_clip blocks also write an `animationPrompt` describing the motion",
    "(camera move, subject action). avatar blocks need no prompts.",
    "",
    'Respond ONLY with JSON: {"segments":[{"blockType","script","imagePrompt","animationPrompt"}]}',
    "",
    "TRANSCRIPT:",
    transcript.trim(),
  ].join("\n");
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
): PlannedSegment[] {
  const span = origEnd - origStart;
  const runs = span > 0 ? intersectRuns(origStart, origEnd, ranges) : [];
  // Whole-block (single run) — no carving needed; just label it.
  if (runs.length <= 1) {
    const marked = runs.length === 1 ? runs[0].marked : false;
    return [applyMark(seg, marked)];
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
    out.push(applyMark(sub, run.marked));
  }
  return out.length > 0 ? out : [applyMark(seg, runs.some((r) => r.marked))];
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

// Split a long VISUAL segment into N back-to-back sub-segments so no single
// block holds longer than the client's pacing window (~3-8s) — which is also
// the constraint that lets LTX-2 generate each ai_clip in one image-to-video
// call (its tiers top out well above 8s, but the planner cap keeps clips on
// the 6/8s tiers). Mirrors the sourced engine's footage/image slot-split in
// lib/ai/timeline-plan.ts.
//
// A block longer than `threshold` is divided into round(duration / target)
// equal sub-blocks (at least 2). Each sub-block:
//   - inherits the parent's blockType + image/animation prompts (so an ai_clip
//     stays an ai_clip; the same prompt drives every sub-clip),
//   - gets a proportional, word-boundary-snapped slice of the script,
//   - gets a proportional slice of the spoken-time window.
//
// 'avatar' blocks are NEVER split: a talking head holds for the whole sentence
// and is generated by HeyGen, not LTX, so the duration ceiling doesn't apply.
// `position` is reassigned by the caller after all splits.
export function splitByDuration(
  seg: PlannedSegment,
  targetSeconds: number,
  thresholdSeconds: number,
): PlannedSegment[] {
  if (seg.blockType === "avatar") return [seg];
  const dur = seg.endTime - seg.startTime;
  if (dur <= thresholdSeconds || dur <= 0) return [seg];

  const slots = Math.max(2, Math.round(dur / targetSeconds));
  const scriptLen = seg.script.length;
  const out: PlannedSegment[] = [];
  for (let k = 0; k < slots; k++) {
    const f0 = k / slots;
    const f1 = (k + 1) / slots;
    const cutStart = k === 0 ? 0 : snapToSpace(seg.script, Math.round(f0 * scriptLen));
    const cutEnd = k === slots - 1 ? scriptLen : snapToSpace(seg.script, Math.round(f1 * scriptLen));
    const piece = seg.script.slice(cutStart, cutEnd).trim();
    const startTime = seg.startTime + f0 * dur;
    const endTime = seg.startTime + f1 * dur;
    out.push({
      ...seg,
      startTime,
      endTime,
      duration: Math.max(0.5, endTime - startTime),
      // A sub-block whose proportional script slice landed empty (e.g. a long
      // pause with few words) still keeps the parent's image prompt so the
      // visual generates; fall back to the parent script only if no prompt.
      script: piece || seg.script.slice(0, 200),
    });
  }
  return out;
}

// Set a segment's avatar-ness. Marked -> avatar (drop visual prompts).
// Unmarked -> if it was avatar (Gemini's choice, not a real mark), demote to
// image; otherwise keep whatever non-avatar type it already had.
function applyMark(seg: PlannedSegment, marked: boolean): PlannedSegment {
  if (marked) {
    return { ...seg, blockType: "avatar", imagePrompt: null, animationPrompt: null };
  }
  if (seg.blockType === "avatar") {
    return {
      ...seg,
      blockType: "image",
      imagePrompt: seg.imagePrompt || seg.script.slice(0, 200),
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

  const model = getGeminiModel();
  // Gemini 2.5-flash hits intermittent 503 "high demand" spikes. The planner is
  // a single one-shot call per project (not high-volume), so we can afford to
  // wait it out: 6 attempts with a longer base backoff rather than the default
  // 3. This turns a transient Google outage from a hard failure into a slightly
  // slower success.
  const res = await withGeminiRetry(
    "buildSyntheticTimeline",
    () =>
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: buildPrompt(transcript) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      }),
    { attempts: 6, baseMs: 2000 },
  );
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
        result.push(applyMark(seg, false));
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
        result.push(applyMark(seg, false));
        continue;
      }
      placed++;
      const origStart = normToOrig[at];
      const origEnd = (normToOrig[at + needle.length - 1] ?? origStart) + 1;
      // Advance the cursor only on a real match so a single miss can't strand
      // the rest. Re-anchor search from just after this match.
      searchFrom = at + needle.length;
      const pieces = splitByMarks(seg, origStart, origEnd, avatarRanges);
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
    image_prompt: p.imagePrompt,
    animation_prompt: p.animationPrompt,
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
  });

  return planned;
}

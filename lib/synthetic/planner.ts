import { z } from "zod";
import { getGeminiModel, withGeminiRetry } from "@/lib/ai/gemini";
import { getServerSupabase } from "@/lib/supabase/server";
import { logJob } from "@/lib/jobs/db";
import type { WordTiming } from "@/lib/ai/deepgram";
import type { SyntheticBlockType } from "@/lib/types";
import { segmentIsAvatarMarked, type AvatarMarkRange } from "@/lib/synthetic/doc-marks";

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
    "Block sizing: aim for 4-8 seconds of narration per block; split long",
    "passages into multiple blocks rather than one long hold.",
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

// Locate a segment's spoken window by matching its first/last words against the
// word-timing stream, advancing a shared cursor so blocks stay in order. Falls
// back to a cadence estimate when a match isn't found (mirrors the sourced
// aligner's degrade-gracefully behaviour).
const FALLBACK_WPS = 2.5;
function norm(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/g, "");
}

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

  const normWords = words.map((w) => norm(w.word));
  let wi = 0; // word cursor
  let prevEnd = 0;
  segs.forEach((s, i) => {
    const tokens = s.script.trim().split(/\s+/).map(norm).filter(Boolean);
    const tokenCount = Math.max(1, tokens.length);
    // Find the run start: first transcript token at/after the cursor.
    let start = -1;
    for (let j = wi; j < normWords.length; j++) {
      if (tokens[0] && normWords[j] === tokens[0]) { start = j; break; }
    }
    const startIdx = start >= 0 ? start : wi;
    const endIdx = Math.min(words.length - 1, startIdx + tokenCount - 1);
    const vo_start = start >= 0 ? words[startIdx].start : prevEnd;
    const vo_end = words[endIdx]?.end ?? vo_start + tokenCount / FALLBACK_WPS;
    out.push(mk(s, i, vo_start, Math.max(vo_end, vo_start + 0.5)));
    wi = endIdx + 1;
    prevEnd = out[out.length - 1].endTime;
  });

  // Make the timeline continuous: snap each block's start to the previous
  // block's end and the last block's end to the audio duration.
  for (let i = 1; i < out.length; i++) out[i].startTime = out[i - 1].endTime;
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

  const planned = alignSegments(safe.data.segments, words, voiceoverDuration);

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
    for (const seg of planned) {
      const needle = normNeedle(seg.script);
      if (!needle) continue;
      const at = normStr.indexOf(needle, searchFrom);
      // Whether or not we can locate the segment, doc marks are AUTHORITATIVE:
      // a segment is avatar IFF its text falls inside a marked range. So the
      // DEFAULT for any segment is "not avatar" — we only promote to avatar on
      // a confirmed overlap. This means a segment that can't be placed, or that
      // Gemini wrongly chose as avatar, is corrected to a non-avatar type.
      let marked = false;
      if (at >= 0) {
        placed++;
        const origStart = normToOrig[at];
        const origEnd = (normToOrig[at + needle.length - 1] ?? origStart) + 1;
        // Advance the cursor only on a real match so a single miss can't strand
        // the rest. Re-anchor search from just after this match.
        searchFrom = at + needle.length;
        marked = segmentIsAvatarMarked(origStart, origEnd, avatarRanges);
      } else {
        unplaced++;
      }
      if (marked) {
        forced++;
        seg.blockType = "avatar";
        seg.imagePrompt = null;
        seg.animationPrompt = null;
      } else if (seg.blockType === "avatar") {
        // NOT inside a marked range (or unplaceable) but Gemini chose avatar.
        // Marks are authoritative -> demote to image.
        seg.blockType = "image";
        seg.imagePrompt = seg.imagePrompt || seg.script.slice(0, 200);
      }
    }
    await logJob({ projectId, jobId }, "synthetic.plan.avatar_marks", {
      ranges: avatarRanges.length,
      transcriptChars: transcript.length,
      markedChars: avatarRanges.reduce((a, r) => a + (r.end - r.start), 0),
      segmentsPlaced: placed,
      segmentsUnplaced: unplaced,
      segmentsTotal: planned.length,
      avatarForced: forced,
    });
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

// Spoken windows for the transcript's OWN sentences.
//
// This is the timing half of the align-first planner. The old synthetic
// planner asked Gemini to segment the transcript, then searched the word
// stream for Gemini's block text to discover when each block was spoken.
// Gemini paraphrases (it normalizes punctuation, merges clauses, rewords),
// so a meaningful share of blocks could never be found — and the search's
// own recovery rules then deadlocked, leaving the plan hundreds of seconds
// behind the audio (see AlignOptions in lib/ai/sentence-alignment.ts).
//
// Here the dependency is inverted: we time the transcript's real sentences
// FIRST, and Gemini only groups them by index afterwards. The sentences are
// verbatim by construction, so alignment is reliable, and nothing downstream
// has to search for anything.
//
// Output contract — the properties every caller depends on:
//   * one TimedSentence per transcript sentence, in order
//   * windows are CONTINUOUS: sentence i ends exactly where i+1 starts
//   * the set spans EXACTLY [0, voiceoverDuration]
//
// The last two mean any partition of these sentences into blocks sums to the
// voiceover duration by construction. That's what makes the render route's
// "Timeline duration must match voiceover" gate unfailable from the planner
// side — there is no floor, no synthesized residual, and no final block left
// to absorb an accumulated error.

import type { WordTiming } from "@/lib/ai/deepgram";
import { alignSentencesToWords } from "@/lib/ai/sentence-alignment";
import { splitTranscriptIntoSentences } from "@/lib/ai/sentences";

export interface TimedSentence {
  // Index into the sentence list. This is the ONLY handle Gemini gets, and
  // the only thing block ranges are expressed in.
  index: number;
  text: string;
  // Char range in the original transcript, so a block can slice its exact
  // script and doc-mark ranges can be intersected without any text search.
  charStart: number;
  charEnd: number;
  voStart: number;
  voEnd: number;
  // True when this sentence's window came from real word timings. False
  // means it was interpolated between two anchors (or across the whole
  // voiceover when there are no timings at all).
  anchored: boolean;
}

export interface TimedSentenceResult {
  sentences: TimedSentence[];
  anchored: number;
  interpolated: number;
  // Share of sentences with real word-timing anchors. The planner logs this
  // and fails the plan when it collapses — the signal that was completely
  // absent when alignment silently died 53 sentences in.
  anchoredFraction: number;
}

function wordCount(text: string): number {
  return text.trim().match(/\S+/g)?.length ?? 0;
}

// Spread [startSeconds, endSeconds] across sentences [from..to] in proportion
// to their word counts. Used for runs with no usable anchor. Proportional
// distribution between two REAL anchors can't drift: the run is pinned at
// both ends, so an error inside it is bounded by the run's own length
// instead of accumulating into every later sentence.
function distribute(
  out: TimedSentence[],
  from: number,
  to: number,
  startSeconds: number,
  endSeconds: number,
): void {
  if (from > to) return;
  const span = Math.max(0, endSeconds - startSeconds);
  const counts: number[] = [];
  let total = 0;
  for (let i = from; i <= to; i++) {
    const c = Math.max(1, wordCount(out[i].text));
    counts.push(c);
    total += c;
  }
  let cursor = startSeconds;
  for (let i = from; i <= to; i++) {
    const share = total > 0 ? (counts[i - from] / total) * span : 0;
    out[i].voStart = cursor;
    // Pin the run's last sentence to the exact end so rounding can't leak.
    out[i].voEnd = i === to ? endSeconds : cursor + share;
    cursor = out[i].voEnd;
  }
}

export function buildTimedSentences(input: {
  transcript: string;
  words: WordTiming[] | null;
  voiceoverDuration: number;
  // Narration language (projects.language). Only the SPLIT depends on it —
  // German abbreviations and ordinal dates end in '.' without ending a
  // sentence, and each false break would become its own visual block.
  language?: string | null;
}): TimedSentenceResult {
  const { transcript, words, voiceoverDuration, language } = input;
  const raw = splitTranscriptIntoSentences(transcript, undefined, language);
  if (raw.length === 0) {
    return { sentences: [], anchored: 0, interpolated: 0, anchoredFraction: 0 };
  }

  const out: TimedSentence[] = raw.map((s, i) => ({
    index: i,
    text: s.text,
    charStart: s.char_offset,
    charEnd: s.char_offset + s.text.length,
    voStart: 0,
    voEnd: 0,
    anchored: false,
  }));

  const total = Number.isFinite(voiceoverDuration) && voiceoverDuration > 0 ? voiceoverDuration : 0;

  // No word timings (or no duration): the best we can do is proportional.
  // Still continuous and still exactly spanning the voiceover.
  if (!words || words.length === 0 || total <= 0) {
    distribute(out, 0, out.length - 1, 0, total);
    return { sentences: out, anchored: 0, interpolated: out.length, anchoredFraction: 0 };
  }

  const aligned = alignSentencesToWords(raw, words, {
    resyncAfterMisses: 2,
    // The narrator's REAL rate, not the 2.5 wps constant.
    fallbackWps: words.length / total,
  });

  // Collect usable anchors. An anchor must be genuinely aligned, have a
  // positive window, sit inside the voiceover, and not run backwards past
  // the previous anchor. Anything else is discarded and interpolated
  // instead — one bad anchor is far more damaging than a missing one,
  // because every sentence in its run inherits its error.
  const anchorIdx: number[] = [];
  let lastEnd = 0;
  for (let i = 0; i < aligned.length; i++) {
    const a = aligned[i];
    if (!a.aligned) continue;
    const s = Number(a.vo_start);
    const e = Number(a.vo_end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (e <= s) continue;
    if (s < lastEnd - 0.001) continue;
    if (e > total + 0.001) continue;
    out[i].voStart = s;
    out[i].voEnd = Math.min(e, total);
    out[i].anchored = true;
    anchorIdx.push(i);
    lastEnd = out[i].voEnd;
  }

  if (anchorIdx.length === 0) {
    distribute(out, 0, out.length - 1, 0, total);
    return { sentences: out, anchored: 0, interpolated: out.length, anchoredFraction: 0 };
  }

  // Interpolate every run of unanchored sentences against its neighbouring
  // anchors: the head run against [0, firstAnchor.start], each interior run
  // against the gap between its two anchors, the tail run against
  // [lastAnchor.end, voiceoverDuration].
  const first = anchorIdx[0];
  if (first > 0) distribute(out, 0, first - 1, 0, out[first].voStart);
  for (let k = 0; k < anchorIdx.length - 1; k++) {
    const a = anchorIdx[k];
    const b = anchorIdx[k + 1];
    if (b - a > 1) distribute(out, a + 1, b - 1, out[a].voEnd, out[b].voStart);
  }
  const last = anchorIdx[anchorIdx.length - 1];
  if (last < out.length - 1) distribute(out, last + 1, out.length - 1, out[last].voEnd, total);

  // Pin the endpoints and enforce continuity. After the interpolation above
  // this is already true; doing it explicitly makes the output contract hold
  // even if an anchor sat at a pathological boundary.
  out[0].voStart = 0;
  for (let i = 1; i < out.length; i++) {
    out[i].voStart = out[i - 1].voEnd;
    if (out[i].voEnd < out[i].voStart) out[i].voEnd = out[i].voStart;
  }
  out[out.length - 1].voEnd = total;
  if (out[out.length - 1].voEnd < out[out.length - 1].voStart) {
    out[out.length - 1].voStart = out[out.length - 1].voEnd;
  }

  const anchored = out.filter((s) => s.anchored).length;
  return {
    sentences: out,
    anchored,
    interpolated: out.length - anchored,
    anchoredFraction: out.length > 0 ? anchored / out.length : 0,
  };
}

// Deterministically force a set of Gemini-proposed [start,end] sentence
// ranges to partition [from..to] exactly: contiguous, ascending, every index
// covered exactly once. Gemini's ranges are a SUGGESTION about grouping; the
// partition itself is not negotiable, so we repair rather than trust.
//
// This is the structural fix for the repeated-tail failure: when the old
// planner lost its place, one block ended up owning 725 seconds of audio and
// the duration-split pass fanned it into 121 near-identical slots showing the
// same sentence. A block can no longer claim a sentence another block owns,
// and no sentence can be left unclaimed.
export function repairCoverage<T extends { startSentence: number; endSentence: number }>(
  blocks: T[],
  from: number,
  to: number,
): { blocks: T[]; repaired: number; dropped: number } {
  if (to < from) return { blocks: [], repaired: 0, dropped: blocks.length };

  // Order by proposed start; a block whose range is inverted or entirely
  // outside the chunk is unusable.
  const usable = blocks
    .filter(
      (b) =>
        Number.isFinite(b.startSentence) &&
        Number.isFinite(b.endSentence) &&
        b.endSentence >= b.startSentence &&
        b.endSentence >= from &&
        b.startSentence <= to,
    )
    .sort((a, b) => a.startSentence - b.startSentence || a.endSentence - b.endSentence);

  const dropped = blocks.length - usable.length;
  if (usable.length === 0) return { blocks: [], repaired: 0, dropped: blocks.length };

  const out: T[] = [];
  let repaired = 0;
  let cursor = from;
  for (const b of usable) {
    if (cursor > to) break;
    const start = cursor; // always contiguous — closes gaps AND overlaps
    const end = Math.min(to, Math.max(start, b.endSentence));
    if (start !== b.startSentence || end !== b.endSentence) repaired++;
    out.push({ ...b, startSentence: start, endSentence: end });
    cursor = end + 1;
  }
  // Anything Gemini never reached is handed to the final block, so the tail
  // of the chunk is always covered.
  if (cursor <= to && out.length > 0) {
    out[out.length - 1].endSentence = to;
    repaired++;
  }
  return { blocks: out, repaired, dropped };
}

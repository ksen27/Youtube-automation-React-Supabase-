// Sentence ↔ Deepgram audio alignment.
//
// Given the canonical sentence list (from lib/ai/sentences.ts) and the
// Deepgram word stream (from projects.transcript_words), stamp each
// sentence with its real spoken-audio window [vo_start, vo_end]. The
// stamped window is what the block builder uses for `duration`, so a
// 1.5s sentence becomes a 1.5s block — the visual changes exactly when
// the narrator moves to the next sentence.
//
// Why this replaces sentenceDurationFromWords in timeline-plan.ts:
//   The old function tried to align GEMINI's per-block paraphrased text
//   against Deepgram. When Gemini paraphrased ("twenty twenty" vs "two
//   thousand twenty"), the head OR tail bracket failed, and the duration
//   silently collapsed to a cadence estimate. Across 100+ sentences the
//   error compounded into multi-second drift.
//
//   The new function aligns DOC sentences against Deepgram. The doc and
//   the audio are produced from the same source script, so the word
//   sequence is much more reliable: paraphrasing only happens at narrator
//   recording, not between Gemini and the doc.

import type { Sentence } from "./sentences";
import type { WordTiming } from "./deepgram";

export interface AlignedSentence extends Sentence {
  // Real spoken-audio window from Deepgram. Null only in the synthetic
  // path below where neither head nor tail matched and we had no prior
  // window to anchor against (very rare — would mean Deepgram and the
  // doc disagree on virtually every word).
  vo_start: number;
  vo_end: number;
  // True when both head and tail matched in the Deepgram stream. False
  // when we fell back to cadence estimation or synthesized from the
  // previous sentence's end. Logs surface this so we can audit how often
  // alignment degraded on real projects.
  aligned: boolean;
}

// Strip punctuation, lowercase, drop apostrophe-only suffixes. Same
// normalization shape as timeline-plan.ts:normalizeWord so we stay
// consistent with the old aligner's behavior — saves us from
// double-debugging the same edge cases.
function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9']/g, "");
}

// Tokenize a sentence by whitespace, normalize each token, drop empties.
// Used to extract the head/tail brackets for each sentence.
function tokenize(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map(normalizeWord)
    .filter((t) => t.length > 0);
}

// Look for an exact contiguous run of `needle` words inside the Deepgram
// stream starting at `from`. Returns the index of the first matched word
// in `timings`, or -1 if not found. We allow up to MAX_SKIPS positions of
// drift inside the needle — sometimes Deepgram splits a contraction
// ("don't" → "do" + "n't") or transcribes a filler word that the doc
// doesn't have. Skipping past those keeps the bracket match robust.
function findRun(
  timings: WordTiming[],
  needle: string[],
  from: number,
  searchLimit: number,
): number {
  if (needle.length === 0) return -1;
  const lastValid = Math.min(timings.length - needle.length, from + searchLimit);
  for (let i = from; i <= lastValid; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (normalizeWord(timings[i + j].word) !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

// Per-sentence head/tail bracket lengths. We use 3 tokens by default —
// long enough that a triplet is distinctive ("but somehow it" vs the
// 30 other times "it" appears) but short enough that Deepgram glitches
// don't usually break a triplet. For very short sentences (<3 tokens)
// we fall back to the full sentence as the needle.
const BRACKET_LEN = 3;

// How far ahead of the cursor we search for a head match. A sentence
// is usually within ~50 words of where the cursor left off; widening
// past that lets the aligner re-sync after a missing sentence at the
// cost of occasionally jumping into the wrong place. 200 words covers
// ~80 seconds of audio — enough to recover from any single skip but
// not so much that we'd jump several sentences ahead.
const HEAD_SEARCH_LIMIT = 200;

// How far past the head match we look for the tail bracket. The tail
// must come within a reasonable sentence length of the head — capping
// at 80 words (~30 seconds) is generous for any single sentence and
// prevents the tail search from accidentally landing in the next
// paragraph.
const TAIL_SEARCH_LIMIT = 80;

// Per-sentence sanity-check gap: if the aligned vo window is more than
// MAX_INTER_SENTENCE_GAP seconds away from the previous sentence's end,
// we treat that as a desync (e.g. the head matched on a stray occurrence
// far ahead in the audio) and fall back to synthesis from the previous
// window.
const MAX_INTER_SENTENCE_GAP = 30;

// Fallback cadence (words per second) when neither head nor tail aligns.
// Used to estimate a sentence's spoken duration from its word count when
// we can't observe it directly in the Deepgram stream. 2.5 wps == 150 wpm,
// the standard for English voiceover narration.
const FALLBACK_WPS = 2.5;

// Align an ordered Sentence[] against the Deepgram word stream. Returns
// an AlignedSentence[] of the same length and order — every input
// sentence appears in the output, never dropped.
//
// Algorithm summary:
//   1. Walk sentences in order. Maintain a forward-only word cursor
//      into the Deepgram stream.
//   2. For each sentence: take its first BRACKET_LEN tokens (head) and
//      last BRACKET_LEN tokens (tail). Search for head in the stream
//      starting at cursor.
//   3. If head hit: search for tail starting just after head. If tail
//      hit: vo_start = head's first word's start; vo_end = tail's last
//      word's end. Advance cursor past tail.
//   4. If head hit but tail missed (Gemini-style paraphrased ending,
//      or a sentence that runs into the next without a clear tail
//      marker): vo_start = head's first word's start, vo_end =
//      estimated from cadence of nearby words. Advance cursor by the
//      sentence's token count.
//   5. If head missed: synthesize from previous vo_end. vo_start =
//      previous vo_end; vo_end = vo_start + cadenceEstimate(sentence).
//      aligned = false so logs can audit.
//   6. Sanity sweep: if a sentence's vo_start is more than
//      MAX_INTER_SENTENCE_GAP seconds past the previous vo_end, the
//      head must have landed on a wrong occurrence — discard and
//      synthesize.
//   7. Trailing silence handling: any audio time between a sentence's
//      aligned vo_end and the next sentence's vo_start is attached to
//      the PRECEDING sentence (extending its vo_end to the next
//      vo_start). This keeps the timeline continuous without silent
//      gaps where neither sentence "owns" the audio.
export function alignSentencesToWords(
  sentences: Sentence[],
  timings: WordTiming[],
): AlignedSentence[] {
  if (sentences.length === 0) return [];

  // No word timings — degrade gracefully. Every sentence falls back to a
  // cadence estimate, anchored to the cumulative start. The matcher can
  // still use the resulting durations; alignment quality is just lower.
  if (!timings || timings.length === 0) {
    const out: AlignedSentence[] = [];
    let cursor = 0;
    for (const s of sentences) {
      const tokens = tokenize(s.text).length;
      const dur = tokens > 0 ? tokens / FALLBACK_WPS : 0.5;
      out.push({
        ...s,
        vo_start: cursor,
        vo_end: cursor + dur,
        aligned: false,
      });
      cursor += dur;
    }
    return out;
  }

  const result: AlignedSentence[] = [];
  let wordCursor = 0;
  let lastEndSeconds = 0;

  for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
    const s = sentences[sIdx];
    const tokens = tokenize(s.text);

    // Empty sentence (defensive — shouldn't happen given the splitter
    // trims and filters). Carry the previous end forward so we don't
    // emit a NaN window.
    if (tokens.length === 0) {
      result.push({
        ...s,
        vo_start: lastEndSeconds,
        vo_end: lastEndSeconds,
        aligned: false,
      });
      continue;
    }

    const head = tokens.slice(0, Math.min(BRACKET_LEN, tokens.length));
    const tail = tokens.slice(Math.max(0, tokens.length - BRACKET_LEN));

    const headIdx = findRun(timings, head, wordCursor, HEAD_SEARCH_LIMIT);

    if (headIdx < 0) {
      // No head match in the search window. Synthesize: this sentence's
      // window picks up where the previous one ended, sized by cadence.
      // The aligned=false flag lets the matcher surface this in logs.
      const estimatedDur = tokens.length / FALLBACK_WPS;
      const vo_start = lastEndSeconds;
      const vo_end = vo_start + estimatedDur;
      result.push({ ...s, vo_start, vo_end, aligned: false });
      lastEndSeconds = vo_end;
      // Cursor doesn't advance — the next sentence searches from the
      // same position, so a one-sentence Deepgram glitch doesn't
      // cascade-desync the rest of the alignment.
      continue;
    }

    const candidateStart = timings[headIdx].start;

    // Sanity check: head landed too far past previous end. Treat as
    // a desync and synthesize instead.
    if (
      lastEndSeconds > 0 &&
      candidateStart - lastEndSeconds > MAX_INTER_SENTENCE_GAP
    ) {
      const estimatedDur = tokens.length / FALLBACK_WPS;
      const vo_start = lastEndSeconds;
      const vo_end = vo_start + estimatedDur;
      result.push({ ...s, vo_start, vo_end, aligned: false });
      lastEndSeconds = vo_end;
      // Don't advance the cursor — the suspicious head match shouldn't
      // dictate where subsequent sentences search from.
      continue;
    }

    // Head matched. If the sentence is shorter than the bracket length,
    // head and tail overlap completely — we already have the full window.
    if (tokens.length <= BRACKET_LEN) {
      const lastIdx = headIdx + tokens.length - 1;
      const vo_start = candidateStart;
      const vo_end = timings[lastIdx].end;
      result.push({ ...s, vo_start, vo_end, aligned: true });
      lastEndSeconds = vo_end;
      wordCursor = lastIdx + 1;
      continue;
    }

    // Look for the tail bracket after the head's match.
    const tailSearchStart = headIdx + head.length;
    const tailIdx = findRun(timings, tail, tailSearchStart, TAIL_SEARCH_LIMIT);

    if (tailIdx >= 0) {
      const lastIdx = tailIdx + tail.length - 1;
      const vo_start = candidateStart;
      const vo_end = timings[lastIdx].end;
      // Defensive: if the tail somehow ended before the head started
      // (Deepgram word ordering glitch), fall back to head-only.
      if (vo_end <= vo_start) {
        const estimatedDur = tokens.length / FALLBACK_WPS;
        result.push({
          ...s,
          vo_start,
          vo_end: vo_start + estimatedDur,
          aligned: false,
        });
        lastEndSeconds = vo_start + estimatedDur;
        wordCursor = headIdx + head.length;
        continue;
      }
      result.push({ ...s, vo_start, vo_end, aligned: true });
      lastEndSeconds = vo_end;
      wordCursor = lastIdx + 1;
      continue;
    }

    // Head matched but tail didn't. Estimate the sentence's end from
    // local cadence around the head — better than using the constant
    // FALLBACK_WPS because the narrator's speed varies across the
    // recording.
    const cadenceLookahead = Math.min(20, timings.length - headIdx);
    let estimatedDur: number;
    if (cadenceLookahead >= 2) {
      const cadenceSpan =
        timings[headIdx + cadenceLookahead - 1].end - timings[headIdx].start;
      const localWps = cadenceSpan > 0 ? cadenceLookahead / cadenceSpan : FALLBACK_WPS;
      estimatedDur = tokens.length / localWps;
    } else {
      estimatedDur = tokens.length / FALLBACK_WPS;
    }
    const vo_start = candidateStart;
    const vo_end = vo_start + estimatedDur;
    result.push({ ...s, vo_start, vo_end, aligned: false });
    lastEndSeconds = vo_end;
    // Advance the cursor past the head — we don't know where the
    // sentence actually ended, but we know it starts somewhere after
    // the head. Conservative cursor advance prevents the next
    // sentence from accidentally matching this sentence's later words.
    wordCursor = headIdx + head.length;
  }

  // Trailing-silence sweep. Attach inter-sentence gaps to the PRECEDING
  // sentence so the timeline has no orphaned audio time. The viewer
  // experiences "this sentence ends here, then the next one starts" —
  // any narration pause between them belongs visually to the sentence
  // that just finished.
  //
  // We also enforce monotonicity: if sentence k's vo_start landed before
  // sentence k-1's vo_end (rare — happens when the synthesizer overshot
  // on a missed alignment), pull k's start forward to k-1's end.
  for (let i = 0; i < result.length - 1; i++) {
    const cur = result[i];
    const next = result[i + 1];
    if (next.vo_start < cur.vo_end) {
      // Monotonicity: trim cur back to next's start. This preserves
      // narration order even when the synthesizer overestimated.
      cur.vo_end = next.vo_start;
    } else if (next.vo_start > cur.vo_end) {
      // Trailing silence: extend cur to next's start.
      cur.vo_end = next.vo_start;
    }
    if (cur.vo_end < cur.vo_start) cur.vo_end = cur.vo_start;
  }

  return result;
}

// Dynamic timeline duration planner.
//
// Replaces the old fixed-5s block heuristic. The goal is for the assembled
// video to match the voiceover length while keeping per-block durations
// bucketed by content type:
//   - footage (real clips):   4–6s   (short, lowers copyright risk)
//   - images / backgrounds:   5s     (fixed — user spec)
//   - split screens:          6–8s
//   - intro:                  5–6s   (one only, at start)
//
// The "avg block" target depends on total length — long-form videos get
// slower pacing so the final cut isn't a strobe of 5s cuts.

export type BlockType = "intro" | "footage" | "image" | "title_card" | "split_2" | "split_4";

export interface DurationRange {
  min: number;
  max: number;
}

export const DURATION_RANGES: Record<BlockType, DurationRange> = {
  intro:   { min: 5,  max: 6  },
  // Footage holds are now capped at ~7s. Per client direction, every
  // clip should land in the 5-6s window so the viewer's eye gets a new
  // visual every few seconds instead of holding on a 12s talking-head
  // shot. Long sentences are split into multiple sub-blocks of
  // FOOTAGE_HOLD_SECONDS at the planner stage (see footage-split logic
  // below — mirrors the existing image-split). The 1s headroom over the
  // hold target lets a sentence land at 6.5s (just under the split
  // threshold) without being forced into a split it doesn't need.
  // The min prevents degenerate 0.4s flashes from 1-word sentences.
  footage: { min: 3,  max: 7  },
  // Image blocks now follow the narrator's exact spoken time (vo_end −
  // vo_start), so the range is widened. The transcript-driven builder splits
  // long sentences into multiple image fragments sharing the same subject
  // (see IMAGE_SPLIT_THRESHOLD), so no single image holds longer than ~7s
  // in practice. Lower bound 1s prevents degenerate flash frames on
  // 1-word sentences; upper bound 15s is a hard safety ceiling.
  image:   { min: 1,  max: 15 },
  // Black title cards for section breaks. Fixed 5s hold per client spec —
  // matches the per-image hold so a card reads as a deliberate beat, not a
  // flash. The block-builder clamps to this range, so a long sentence on a
  // section-opening hint still lands at 5s.
  title_card: { min: 5, max: 5 },
  // Fixed 6s split-screen hold per client spec — two half-width images
  // need a beat longer than a single image so the viewer can scan both
  // halves. Acts the same as the title_card pin: any sentence-derived
  // duration gets clamped to this constant.
  split_2: { min: 6,  max: 6  },
  split_4: { min: 5,  max: 8  },
};

// Words-per-second narration rate. Used to convert a sentence's word count
// into its spoken duration so a block's hold time matches the sentence.
// 2.5 wps == 150 wpm is the standard for English voiceover narration.
export const WORDS_PER_SECOND_NARRATION = 2.5;

// Per-image hold target (seconds). Long sentences exceeding the IMAGE_SPLIT
// threshold are broken into multiple back-to-back image blocks of this
// length so the per-image hold rule stays intact.
export const IMAGE_HOLD_SECONDS = 5;

// Sentence durations longer than this threshold trigger multi-image split
// for image blocks. A 6.5s sentence on a tattoo reference produces TWO
// 5s image blocks (cloned hint metadata), not ONE 6.5s image hold.
export const IMAGE_SPLIT_THRESHOLD = IMAGE_HOLD_SECONDS + 1.5;

// Per-footage hold target (seconds). Mirrors the image-split logic — long
// sentences exceeding FOOTAGE_SPLIT_THRESHOLD are broken into multiple
// back-to-back footage blocks of this length so the viewer never sees a
// single talking-head clip held for 10-12 seconds. Each sub-block gets
// its own clip slot, and the matcher's no-adjacent-same-source rule then
// forces the sub-blocks to come from different sources where possible.
//
// Set to 6 to match the client direction "keep the clip duration 5-6s".
export const FOOTAGE_HOLD_SECONDS = 6;
export const FOOTAGE_SPLIT_THRESHOLD = FOOTAGE_HOLD_SECONDS + 1.5;

export interface TimelinePlan {
  voiceoverSeconds: number;
  avgBlockSeconds: number;       // target average — drives total_blocks
  totalBlocks: number;            // includes the intro
  footageBlocks: number;
  imageBlocks: number;
  bucket: "short" | "medium" | "long";
}

export function pickAvgBlockSeconds(voiceoverSeconds: number): {
  avg: number;
  bucket: TimelinePlan["bucket"];
} {
  const minutes = voiceoverSeconds / 60;
  if (minutes <= 5)  return { avg: 5.5, bucket: "short" };   // 5–6s window
  if (minutes <= 15) return { avg: 7,   bucket: "medium" };  // 6–8s window
  return { avg: 9, bucket: "long" };                          // 8–10s window — default for 20–35min
}

export function planTimeline(voiceoverSeconds: number): TimelinePlan {
  const safeVo = Math.max(1, Math.round(voiceoverSeconds));
  const { avg, bucket } = pickAvgBlockSeconds(safeVo);
  // 70/30 split is on TIME ON SCREEN, not block count. Footage uses 4–6s
  // windows; images are fixed at 5s. A count-based split made images
  // dominate visual time when image holds were 8–12s; computing from
  // target seconds gives ~70% footage ON SCREEN — what users mean by
  // "70% footage."
  const targetFootageSec = safeVo * 0.7;
  const targetImageSec   = safeVo * 0.3;
  // Footage avg ~5s, image fixed at 5s. Both 5 in current ranges; the avg
  // computation handles future range tweaks without touching this math.
  const footageAvg = (DURATION_RANGES.footage.min + DURATION_RANGES.footage.max) / 2;   // 5
  const imageAvg   = (DURATION_RANGES.image.min   + DURATION_RANGES.image.max)   / 2;   // 5
  const footageBlocks = Math.max(1, Math.round(targetFootageSec / footageAvg));
  const imageBlocks   = Math.max(1, Math.round(targetImageSec / imageAvg));
  const totalBlocks = footageBlocks + imageBlocks;
  return {
    voiceoverSeconds: safeVo,
    avgBlockSeconds: avg,
    totalBlocks,
    footageBlocks,
    imageBlocks,
    bucket,
  };
}

// Deterministic-ish randomness: wrap Math.random so callers can pass a stub
// in tests without us pulling in a full PRNG.
type RandomFn = () => number;

export function pickDuration(type: BlockType, rand: RandomFn = Math.random): number {
  const r = DURATION_RANGES[type];
  // 0.1s steps — finer than 1s to avoid systematic drift.
  const span = r.max - r.min;
  const v = r.min + rand() * span;
  return Math.round(v * 10) / 10;
}

export function clampToRange(type: BlockType, seconds: number): number {
  const r = DURATION_RANGES[type];
  return Math.min(r.max, Math.max(r.min, seconds));
}

export interface PlannedBlock {
  type: BlockType;
  duration: number;
}

// Build a sequence of blocks that fills voiceover_seconds within ±1s.
// - The first block is always an intro.
// - After the intro we alternate footage/image roughly 60/40.
// - The last block is trimmed (or extended slightly, if we're under by <3s)
//   so timeline_duration ≈ voiceover_seconds.
export function buildBlockSequence(
  plan: TimelinePlan,
  rand: RandomFn = Math.random,
): PlannedBlock[] {
  // The timeline contains ONLY footage and image blocks. The intro segment
  // (5–6s of celebrity-interview audio + video) is a separate prefix
  // assembled at render time using projects.intro_clip_id and
  // projects.intro_audio_url. It is NOT a block in this sequence.
  //
  // Why this matters: the timeline's block durations sum to voiceoverSeconds.
  // The intro plays its own audio for the first 5–6s of the final video,
  // BEFORE this timeline starts. So the first footage/image block here
  // corresponds to the first words of the voiceover, not to the intro.
  const blocks: PlannedBlock[] = [];
  let acc = 0;

  // Pre-compute a footage/image pattern to hit the 60/40 ratio.
  let footageLeft = plan.footageBlocks;
  let imageLeft = plan.imageBlocks;

  // Hard cap on consecutive image blocks. 3+ images in a row = a long
  // slideshow stretch with no motion — visually dead AND a copyright-risk
  // concentration (the surrounding footage blocks get more attention from
  // automated systems when they stand out from a static background).
  const MAX_CONSECUTIVE_IMAGES = 2;
  let consecutiveImages = 0;

  while (acc + 0.5 < plan.voiceoverSeconds) {
    // Pick footage vs image based on remaining budget — if one is exhausted,
    // use the other. Otherwise weight by remaining count.
    let type: BlockType;
    if (footageLeft <= 0 && imageLeft <= 0) {
      // Out of budgeted slots but we still need to fill — keep going with
      // images (longer holds → fewer extra blocks → less pacing churn).
      // The MAX_CONSECUTIVE_IMAGES guard below still applies.
      type = "image";
    } else if (footageLeft <= 0) {
      type = "image";
    } else if (imageLeft <= 0) {
      type = "footage";
    } else {
      const total = footageLeft + imageLeft;
      type = rand() < footageLeft / total ? "footage" : "image";
    }

    // Override if we'd be emitting a third image in a row. Force footage
    // when we still have it, otherwise keep going with image — but at
    // least we tried.
    if (type === "image" && consecutiveImages >= MAX_CONSECUTIVE_IMAGES && footageLeft > 0) {
      type = "footage";
    }

    if (type === "footage") {
      footageLeft--;
      consecutiveImages = 0;
    } else {
      imageLeft--;
      consecutiveImages++;
    }

    const dur = pickDuration(type, rand);
    blocks.push({ type, duration: dur });
    acc += dur;
  }

  // Last-block reconciliation: trim if over, extend if under by <3s.
  const last = blocks[blocks.length - 1];
  const overshoot = acc - plan.voiceoverSeconds;
  if (overshoot > 1) {
    // Trim the last block — but never below 1s. If trimming would hit that
    // floor, drop the whole block instead (only when we have spares).
    const minDur = 1;
    const newDur = Math.max(minDur, last.duration - overshoot);
    if (newDur >= minDur) {
      last.duration = Math.round(newDur * 10) / 10;
    }
  } else if (overshoot < 0 && Math.abs(overshoot) < 3) {
    // Stretch to absorb the gap. Images are fixed at 5s by spec — extending
    // them would break that contract — so we stretch the last FOOTAGE block
    // instead. If the tail is all-image, walk back to the most recent
    // footage block and stretch that one. If there is no footage block at
    // all (degenerate plan), fall through and accept the small undershoot
    // rather than violating the image fix.
    const stretch = -overshoot;
    let stretchIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === "footage") { stretchIdx = i; break; }
    }
    if (stretchIdx >= 0) {
      const target = blocks[stretchIdx];
      target.duration = Math.round((target.duration + stretch) * 10) / 10;
    }
  }

  return blocks;
}

export function sumDurations(blocks: { duration: number }[]): number {
  return blocks.reduce((s, b) => s + (Number(b.duration) || 0), 0);
}

// A per-block hint emitted by Gemini's analyzeSegment, used by the
// hint-aware planner. We accept the union of all visual types but the
// builder only emits "footage" | "image" | "title_card" | "split_2"; an
// "intro" hint is ignored (intros are a render-time prefix, not a block).
export interface BlockPlanHint {
  text: string;
  resolved_subject?: string;
  // Phase D: subject taxonomy emitted by Gemini per block. Drives the image
  // matcher's type-aware routing (company → logo, movie → poster, place →
  // place photo, etc.) and the once-per-video shown-entity dedup. The field
  // was always carried on the Gemini block plan but was being dropped during
  // hint forwarding; bringing it through unlocks the docs-spec routing.
  subject_type?: "person" | "place" | "movie" | "show" | "company" | "event" | "object" | "general";
  recommended_visual_type: "footage" | "image" | "title_card" | "split_2";
  // Optional section title for title_card blocks. When unset for a
  // title_card hint, the builder falls back to "" and the matcher fills
  // text in from the segment's sectionTitle at assignment time.
  section_title?: string;
  // Phase C: specific visual references in this block's narration
  // ("tattoo", "mother", "Frida"). The image matcher uses these to build
  // reference-driven queries instead of falling back to the entity pool.
  specific_visual_references?: string[];
  // Phase C: named entities literally appearing in the block's text.
  // Lets the image matcher prefer logos/posters when the reference is a
  // company/show/movie that's also a named entity.
  mentioned_entities?: string[];
  // Documentary-style person-first axis. Forwarded verbatim from Gemini's
  // per-block visual_priority. The matcher consults this when deciding
  // the fallback path: "person_default" blocks fall back to person clips,
  // "specific_*" blocks fall back to the person image when the exact match
  // can't be found (never random visuals).
  visual_priority?: "person_default" | "specific_event" | "specific_object" | "title_card" | "split_2";
  // Closed-world block-entity binding. The analyze pass picks ONE entity
  // type per block (person | company | tv_show | movie | song | place |
  // celebrity_default) and pairs it with the literal name. The matcher
  // uses (type, name) as the verify target — never refs[0]/ents[0] which
  // often contain common nouns ("transcript", "announcement"). When
  // type === "celebrity_default" the matcher skips the reference-driven
  // image search and routes directly to the celebrity pool / person
  // fallback — the spec's "NEVER random visuals" rule.
  block_entity?: { type: "person" | "company" | "tv_show" | "movie" | "song" | "place" | "celebrity_default"; name: string };
  // Doc-paragraph the hint's narration came from (0-based, counted across
  // the project transcript split on "\n"). When set, the planner's grouping
  // pass refuses to merge hints from different paragraphs so a single block
  // never spans a doc paragraph boundary. null/undefined means "unknown" —
  // grouping falls back to the legacy type-only merge rule.
  paragraph_index?: number | null;
}

export interface PlannedBlockWithHint extends PlannedBlock {
  // The text window this block covers — copied through from the hint so
  // the matcher doesn't have to re-derive from voiceover offsets when a
  // Gemini-supplied text is already aligned to the narration.
  text: string;
  resolved_subject?: string;
  section_title?: string;
  specific_visual_references?: string[];
  mentioned_entities?: string[];
  subject_type?: "person" | "place" | "movie" | "show" | "company" | "event" | "object" | "general";
  visual_priority?: "person_default" | "specific_event" | "specific_object" | "title_card" | "split_2";
  // Closed-world entity binding (mirrored from BlockPlanHint). The matcher
  // uses (type, name) as the verify target and as the routing signal for
  // celebrity_default blocks (which skip the reference-driven image search).
  block_entity?: { type: "person" | "company" | "tv_show" | "movie" | "song" | "place" | "celebrity_default"; name: string };
  // Doc paragraph this block's narration came from. Forwarded from the
  // source hint so post-build passes (mergeShortFootage, etc.) can keep
  // the no-merge-across-paragraph invariant intact.
  paragraph_index?: number | null;
  // Voiceover-relative spoken-time window for this block's narration,
  // derived from Deepgram word timings. The matcher copies these onto
  // the timeline item's metadata so downstream code (script marker
  // positioning, per-block text slicing) can map between audio time
  // and item position WITHOUT relying on cumulative block.duration
  // sums — those drift away from real spoken time because Gemini
  // hints don't cover every word in the audio. Null when word timings
  // weren't available at plan time.
  vo_start_seconds?: number | null;
  vo_end_seconds?: number | null;
}

// Estimate spoken duration of a text chunk based on its word count and a
// narration cadence. The cadence is a measured-or-assumed words-per-second
// value: callers with access to the transcript+voiceover length should
// pass the real cadence; the default falls back to the 2.5 wps constant
// for legacy callers. Returns seconds, with a 0.1s floor so empty chunks
// don't collapse to 0.
export function sentenceDurationSeconds(
  text: string,
  wordsPerSecond: number = WORDS_PER_SECOND_NARRATION,
): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0.1;
  return words / wordsPerSecond;
}

// Word-timing entry as persisted in projects.transcript_words. Mirrors
// lib/ai/deepgram.ts WordTiming but kept local so timeline-plan stays a
// leaf module (no cross-cutting imports from server code).
export interface PlannerWordTiming {
  word: string;
  start: number;
  end: number;
}

// Strip everything except letters, digits, and apostrophes so a
// transcript word ("Today,") and a hint word ("today") compare equal.
// Lowercase to drop sentence-case differences.
function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9']/g, "");
}

// Consume `text`'s words from `timings` starting at `cursor` and return
// { duration, nextCursor }. Matching is tolerant: punctuation and case
// don't have to line up, and a word that fails to match advances the
// cursor by one anyway (so a single transcription glitch doesn't desync
// the whole pass). The returned duration is the wall-clock span from the
// first matched word's start to the last matched word's end — i.e. the
// real narration time for this sentence in the audio file. Returns null
// when the text has no matchable words against the remaining timings,
// which lets the caller fall back to the cadence estimator.
export function sentenceDurationFromWords(
  text: string,
  timings: PlannerWordTiming[],
  cursor: number,
): { durationSeconds: number; nextCursor: number; firstStart: number; lastEnd: number } | null {
  const hintWords = text
    .trim()
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);
  if (hintWords.length === 0) return null;

  // Strategy: find the hint's FIRST and LAST distinctive tokens in the
  // Deepgram word stream and use those to bracket the sentence. The old
  // per-word walk with LOOKAHEAD=3 was too brittle — a single filler
  // word or contraction split in the audio would desync the cursor and
  // collapse `lastEnd` back onto the first matched word, returning a
  // microscopic "duration" that completely misrepresents the sentence's
  // actual spoken span.
  //
  // We bracket-search instead: pick a 3-token needle from the START of
  // the hint and walk forward from `cursor` until it matches — that's
  // firstStart. Then pick a 3-token needle from the END of the hint and
  // search forward from firstStart's match — that's lastEnd. This is
  // robust to mid-sentence misalignment because we only need the
  // brackets to match, not every word.
  const HEAD_LEN = Math.min(3, hintWords.length);
  const TAIL_LEN = Math.min(3, hintWords.length);
  const head = hintWords.slice(0, HEAD_LEN);
  const tail = hintWords.slice(hintWords.length - TAIL_LEN);

  function findContiguous(needle: string[], from: number): number {
    if (needle.length === 0) return -1;
    const limit = timings.length - needle.length;
    for (let i = from; i <= limit; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (normalizeWord(timings[i + j].word) !== needle[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  const headIdx = findContiguous(head, cursor);
  if (headIdx < 0) return null;
  const firstStart = timings[headIdx].start;

  // For single-sentence hints where head === tail (very short text),
  // lastEnd is just the head's last word's end.
  if (hintWords.length <= HEAD_LEN) {
    const lastEnd = timings[headIdx + hintWords.length - 1].end;
    return {
      durationSeconds: lastEnd - firstStart,
      nextCursor: headIdx + hintWords.length,
      firstStart,
      lastEnd,
    };
  }

  const tailIdx = findContiguous(tail, headIdx + HEAD_LEN);
  if (tailIdx < 0) {
    // Tail not found — narrator paraphrased the end of the sentence.
    // Estimate the spoken duration from the hint's word count vs the
    // local cadence around the head. Better than returning null (which
    // would leave the block without a real vo window).
    const cadenceWords = Math.min(20, timings.length - headIdx);
    if (cadenceWords < 2) return null;
    const cadenceSpan =
      timings[headIdx + cadenceWords - 1].end - timings[headIdx].start;
    const wordsPerSecond = cadenceWords / cadenceSpan;
    const estimatedSeconds = hintWords.length / wordsPerSecond;
    const lastEnd = firstStart + estimatedSeconds;
    return {
      durationSeconds: estimatedSeconds,
      nextCursor: headIdx + HEAD_LEN,
      firstStart,
      lastEnd,
    };
  }

  const lastEnd = timings[tailIdx + tail.length - 1].end;
  if (lastEnd <= firstStart) return null;
  return {
    durationSeconds: lastEnd - firstStart,
    nextCursor: tailIdx + tail.length,
    firstStart,
    lastEnd,
  };
}

// Build a timeline sequence from Gemini's per-block hints. The hints come
// in narration order and each hint covers 1-3 sentences of consecutive
// narration; this function preserves that order and:
//   1. Sets each block's duration from its sentence's spoken length so
//      visuals stay aligned with what's being said (Option 3: variable-
//      duration footage, ~5s per image, multi-image split for long
//      sentences).
//   2. Splits long IMAGE blocks (sentence > IMAGE_SPLIT_THRESHOLD) into
//      multiple back-to-back ~5s image blocks sharing the same hint
//      metadata. Honors the 5s-per-image rule while keeping the sentence
//      as the unit of meaning.
//   3. Tail-reconciles the realized total to land within ±1s of
//      voiceoverSeconds by adjusting the last block.
//
// Why this and not buildBlockSequence: the legacy builder picks types from
// a budget (X footage blocks, Y image blocks) without knowing what each
// block is ABOUT. The hint-aware builder respects Gemini's per-block
// recommendation AND each block's actual spoken length, so "she had a
// tattoo" lands as one image block of the sentence's length, and a long
// narrative footage sentence gets a proportional hold.
export function buildBlockSequenceFromHints(
  hints: BlockPlanHint[],
  voiceoverSeconds: number,
  // Optional. When provided, the planner derives the *actual* narration
  // cadence from totalWords / voiceoverSeconds and uses it to size each
  // hint's block. Without this, the planner falls back to the 2.5 wps
  // constant, which mismatches real audio (faster or slower) and pushes
  // block durations away from the words they should cover. Pass the full
  // project transcript when calling from the matcher.
  transcript?: string,
  // Per-word timings from Deepgram. When provided, each hint's raw
  // duration is computed from the wall-clock span of the words actually
  // spoken in that hint's text — eliminating the per-sentence drift the
  // uniform-cadence estimator produces (a 100+ sentence audio compounds
  // that drift into a multi-second timeline-vs-voiceover gap). Falls back
  // to the cadence estimator per-hint when a hint's words can't be aligned
  // (rare — Gemini paraphrasing far enough that the words don't match).
  wordTimings?: PlannerWordTiming[] | null,
  // DEPRECATED / no longer subtracted — kept for call-site API stability.
  //
  // This once encoded an "intro overlays the first ~6s of narration" model:
  // the planner shrank its target by the intro's length so that
  // intro + blocks == voiceover. But the renderer plays the intro as ADDITIVE
  // pre-roll — it runs BEFORE the planned timeline with its own source audio
  // (renderProcessor: "The intro plays BEFORE the planned timeline"), and the
  // transcript-driven builder (the primary path) builds blocks covering the
  // FULL voiceover. Subtracting the intro here made the legacy path target
  // (voiceover − intro) while the transcript path targeted the full voiceover,
  // so the two builders produced different timeline lengths for the same
  // project. The render-route duration check compares against the full
  // voiceover, so the legacy path's shorter timeline failed by exactly the
  // intro length (e.g. 2326s vs 2332s, off by 6s > ±3s tolerance, 2026-07-20).
  //
  // Both builders now target the full voiceover; the intro is additive. This
  // parameter is intentionally ignored (see targetSeconds below).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for API stability; intro is now additive pre-roll, not subtracted.
  introReservedSeconds: number = 0,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for API stability; sentence-aligned builder is deterministic.
  _rand: RandomFn = Math.random,
): PlannedBlockWithHint[] {
  if (hints.length === 0 || voiceoverSeconds <= 0) return [];
  // Target sum the planner aims for = the FULL voiceover. The intro is
  // additive pre-roll (played before the timeline with its own audio), NOT
  // carved out of the narration, so the planned blocks must cover the entire
  // voiceover. (introReservedSeconds is deliberately not subtracted — see the
  // parameter doc above.)
  const targetSeconds = voiceoverSeconds;

  // Derive the speaker's real cadence from the transcript when available.
  // Falls back to the 2.5 wps constant for legacy callers that don't have
  // the transcript at hand. Only used for hints whose words can't be
  // aligned against wordTimings — the timing-based path is exact.
  const transcriptWords = transcript
    ? transcript.trim().split(/\s+/).filter(Boolean).length
    : 0;
  const cadence =
    transcriptWords > 0 && voiceoverSeconds > 0
      ? transcriptWords / voiceoverSeconds
      : WORDS_PER_SECOND_NARRATION;

  // Demote orphan title_card hints (no section_title) to footage. Title
  // cards are chapter dividers; Gemini sometimes tags individual mid-
  // segment sentences as title_card, which produces a black-card flash
  // every ~85s in a 10-minute video.
  const effectiveTypes: BlockType[] = hints.map((h) =>
    h.recommended_visual_type === "title_card" && !h.section_title
      ? "footage"
      : h.recommended_visual_type,
  );

  // Step 1 — Decide each hint's slot count and per-slot duration in two
  // passes. The earlier single-pass-then-clamp design was the source of
  // the timeline-vs-voiceover gap: scaling sentence durations and then
  // clamping pinned types (image=5/5, title_card=5/5, split_2=6/6) silently
  // discards the fractional seconds left over after each clamp, so the
  // planned total drifts away from voiceoverSeconds proportionally to how
  // many pinned blocks the timeline contains.
  //
  // The fix is to pin first, then scale only the flexible (footage) blocks
  // to absorb whatever voiceover time the pinned blocks didn't consume.
  // Image-split slot count comes from raw (unscaled) sentence duration so
  // it doesn't depend on the scale factor we're trying to compute.
  // Per-hint raw spoken duration. When word timings are available, use the
  // wall-clock span of the words Deepgram heard for this hint's text —
  // that's the narrator's actual spoken time, which is what we want each
  // block to cover. When timings are missing or a hint's words can't be
  // aligned (Gemini paraphrasing diverged from the transcript), fall back
  // to the cadence estimator so older projects and edge cases keep working.
  let wordCursor = 0;
  const rawDurations: number[] = [];
  // Per-hint voiceover spoken-time window from Deepgram. Null when the
  // hint's words can't be aligned. These flow through grouping/splitting
  // below and end up on each PlannedBlockWithHint so the matcher can
  // pin items to real audio positions.
  const rawVoStart: Array<number | null> = [];
  const rawVoEnd: Array<number | null> = [];
  for (const h of hints) {
    if (wordTimings && wordTimings.length > 0) {
      const aligned = sentenceDurationFromWords(h.text, wordTimings, wordCursor);
      if (aligned) {
        wordCursor = aligned.nextCursor;
        rawDurations.push(aligned.durationSeconds);
        rawVoStart.push(aligned.firstStart);
        rawVoEnd.push(aligned.lastEnd);
        continue;
      }
    }
    rawDurations.push(sentenceDurationSeconds(h.text, cadence));
    rawVoStart.push(null);
    rawVoEnd.push(null);
  }

  // Per-sentence audio-sync rule (replaces the old hallucination filter):
  //
  // The old hallucination filter dropped any hint whose tokens overlapped
  // ≥80% with the previous hint's prefix. It was meant to catch Gemini
  // double-emitting a single narration, but it false-positived on real
  // short follow-up sentences ("But somehow it just happened.") whose
  // first few tokens happened to mirror the prior sentence — producing
  // the "missing sentences" bug the user reported.
  //
  // Every Gemini hint now stays in the stream. Duplicate hints are
  // tolerated: each gets its own block in the editor. If the duplicate
  // covered exactly the same vo window as a previous block, the matcher's
  // existing block reconciliation downstream still produces sensible
  // visuals (a duplicate hint just means a second editor row for the
  // same audio moment — visible to the user, not dropped silently).
  //
  // The trade is intentional: silently dropping a real sentence is the
  // worst failure mode because the editor stops mirroring the doc and
  // the user can't tell anything went wrong. A duplicate hint, by
  // contrast, is plainly visible and the user can delete the extra row.

  // Group consecutive same-type sentence hints into blocks whose combined
  // spoken duration lands in the footage target window. The previous
  // one-sentence-per-block design accumulated drift two ways:
  //   - Sentences shorter than the footage minimum got pushed up to the
  //     minimum (planner overstates).
  //   - Sentences longer than the assigned clip got clamped down to the
  //     clip's real length (matcher understates).
  // Each per-block bias is small but compounds across 100+ blocks into a
  // 30-60s timeline-vs-voiceover gap.
  //
  // Grouping eliminates the bias: each merged block's duration equals the
  // exact sum of its sentences' wall-clock times, and the sum naturally
  // falls in [GROUP_MIN, GROUP_MAX] (the footage range) so neither the
  // planner's clamp nor the matcher's clip-cap discards seconds. Only
  // adjacent hints of the same effective type merge — that preserves
  // Gemini's per-sentence visual targeting (image vs. footage vs. title
  // card) for blocks at type boundaries.
  //
  // Pinned-duration types (image=5s, title_card=5s, split_2=6s) don't
  // merge: their durations are fixed by spec, so merging would either
  // violate the spec or re-introduce the drift problem. They pass through
  // as one-sentence blocks.
  const GROUP_MIN = DURATION_RANGES.footage.min;
  const GROUP_MAX = DURATION_RANGES.footage.max;
  const MERGEABLE_TYPES = new Set<BlockType>(["footage"]);

  interface GroupedHint {
    hint: BlockPlanHint;
    type: BlockType;
    duration: number;
    // Merged sentence text. For single-hint groups this equals hint.text;
    // for multi-hint groups it concatenates each sentence in order so
    // downstream code that reads the block's spoken text sees all of it.
    text: string;
    // Whether this group merged 2+ sentences. Used by callers for logging.
    merged: boolean;
    // Real spoken-audio window for this group's narration (from Deepgram
    // word timings). Used downstream to pin items to actual voiceover
    // positions; null when none of the hints in the group could be
    // aligned.
    voStart: number | null;
    voEnd: number | null;
  }

  const groupedHints: GroupedHint[] = [];
  let cursor = 0;
  while (cursor < hints.length) {
    const baseType = effectiveTypes[cursor];
    const baseHint = hints[cursor];
    const baseDur = rawDurations[cursor];

    // Non-mergeable types pass through unchanged. So do mergeable hints
    // whose own duration already sits at or above GROUP_MIN — those have
    // no drift to amortize and merging would needlessly group them.
    if (!MERGEABLE_TYPES.has(baseType) || baseDur >= GROUP_MIN) {
      groupedHints.push({
        hint: baseHint,
        type: baseType,
        duration: baseDur,
        text: baseHint.text,
        merged: false,
        voStart: rawVoStart[cursor] ?? null,
        voEnd: rawVoEnd[cursor] ?? null,
      });
      cursor++;
      continue;
    }

    // Walk forward absorbing consecutive same-type hints while the
    // accumulated duration would still land in [GROUP_MIN, GROUP_MAX].
    // We stop as soon as adding the next hint would push past GROUP_MAX,
    // and accept the current accumulation even if it's below GROUP_MIN —
    // the redistributor at the end of this function closes any small
    // residual gap.
    let accDur = baseDur;
    let accText = baseHint.text;
    const mergedRefs = [...(baseHint.specific_visual_references ?? [])];
    const mergedEntities = [...(baseHint.mentioned_entities ?? [])];
    let accVoStart: number | null = rawVoStart[cursor] ?? null;
    let accVoEnd: number | null = rawVoEnd[cursor] ?? null;
    let lookahead = cursor + 1;
    // Doc paragraph the base hint came from. When both base and candidate
    // have a known paragraph_index, they must match — a single block must
    // never span two doc paragraphs (e.g. "This is the full story."
    // + "Private conversations between friends..." were getting merged
    // across the blank-line that separates them, hiding the paragraph
    // break from the editor and the renderer). When either side's index
    // is unknown (null/undefined — older payloads, or a hint whose first
    // 10 words couldn't be located against the doc), fall through to the
    // legacy type-only rule so the planner stays usable.
    const baseParagraph = baseHint.paragraph_index;
    while (lookahead < hints.length) {
      if (effectiveTypes[lookahead] !== baseType) break;
      const candidateParagraph = hints[lookahead].paragraph_index;
      if (baseParagraph != null && candidateParagraph != null && candidateParagraph !== baseParagraph) break;
      const candidate = rawDurations[lookahead];
      if (accDur + candidate > GROUP_MAX) break;
      accDur += candidate;
      accText = `${accText} ${hints[lookahead].text}`;
      mergedRefs.push(...(hints[lookahead].specific_visual_references ?? []));
      mergedEntities.push(...(hints[lookahead].mentioned_entities ?? []));
      // Extend the group's vo window to include this hint's window. If
      // the base had no alignment but a later hint did, accept the
      // later hint's start so the group still gets at least the partial
      // window. End always advances to the latest aligned hint.
      const candStart = rawVoStart[lookahead];
      const candEnd = rawVoEnd[lookahead];
      if (candStart != null && accVoStart == null) accVoStart = candStart;
      if (candEnd != null) accVoEnd = candEnd;
      lookahead++;
      // Stop once we've reached the target window. Don't keep merging
      // past GROUP_MIN — a 5-6s block is the sweet spot for the matcher.
      if (accDur >= GROUP_MIN) break;
    }

    // Dedup merged reference lists. The matcher's image search treats
    // the array as a set; duplicates waste search budget.
    const dedup = (xs: string[]) => Array.from(new Set(xs));
    groupedHints.push({
      hint: {
        ...baseHint,
        specific_visual_references: dedup(mergedRefs),
        mentioned_entities: dedup(mergedEntities),
      },
      type: baseType,
      duration: accDur,
      text: accText,
      merged: lookahead > cursor + 1,
      voStart: accVoStart,
      voEnd: accVoEnd,
    });
    cursor = lookahead;
  }

  // Tiny-tail absorption has been removed.
  //
  // The previous tiny-tail logic folded any sentence under 2s into its
  // previous block, concatenating the texts. That hid the short sentence
  // from the editor (it disappeared as its own row) — the same failure
  // mode the user reported for "But somehow it just happened.", "That is
  // not a detail that emerged in the scandal.", etc.
  //
  // Short sentences now keep their own block. The matcher's existing
  // clip-duration clamp + render-time fade tolerate 1-2s visual flashes
  // gracefully, and the matchProcessor's downstream pickFillerForBlock
  // chain handles the clip selection. If we later want SHARED-CLIP
  // visual grouping for short sentences, that lives in transcript-driven-
  // builder.ts (lib/ai/transcript-driven-builder.ts) which assigns
  // group ids without merging editor rows. For now: every sentence =
  // its own editor row, no exceptions.

  // Rebuild the parallel arrays so the rest of this function sees the
  // post-merge view. After this point, `mergedHints` / `rawDurations` /
  // `effectiveTypes` indices refer to MERGED groups, not individual
  // sentences. The slot/scale/materialize passes below use mergedHints
  // in place of the original hints parameter.
  const mergedHints: BlockPlanHint[] = groupedHints.map((g) => ({
    ...g.hint,
    text: g.text,
  }));
  // Per-merged-hint voiceover window. Same length as mergedHints. Will be
  // forwarded onto each materialized block below so the matcher can pin
  // items to actual audio positions instead of cumulative-duration sums.
  const mergedVoStart: Array<number | null> = groupedHints.map((g) => g.voStart);
  const mergedVoEnd: Array<number | null> = groupedHints.map((g) => g.voEnd);
  for (let i = 0; i < groupedHints.length; i++) {
    rawDurations[i] = groupedHints[i].duration;
    effectiveTypes[i] = groupedHints[i].type;
  }
  rawDurations.length = groupedHints.length;
  effectiveTypes.length = groupedHints.length;

  // When word timings are available, each hint's rawDuration is the real
  // wall-clock span the narrator spent on that sentence. We size every
  // block from that real duration:
  //
  // - Footage blocks: duration = rawDuration (no cadence-scaling). The
  //   visual stays on screen for exactly as long as the narrator speaks
  //   the sentence. The matcher then clamps to the assigned clip's real
  //   length downstream — same as before.
  // - Image blocks: still pinned to 5s holds per client spec, with long
  //   sentences split into N back-to-back 5s slots (slot count rounded
  //   from rawDuration / 5). A sentence whose real time doesn't divide
  //   cleanly by 5 leaves a small per-hint residue.
  // - Title_card / split_2 blocks: pinned to their spec value (5s / 6s).
  //
  // The legacy footage-scale path is preserved as a fallback for the
  // edge case where every hint failed to align against word timings
  // (rare, but possible if Gemini paraphrased every sentence). In that
  // case rawDurations are cadence-estimated and footage gets scaled the
  // old way so the timeline still lands near voiceoverSeconds.
  const haveRealTimings = wordTimings != null && wordTimings.length > 0;

  // Slot counts for image AND footage hints. Round to nearest whole
  // hold-size multiple so a 7s sentence gets one slot (5s for image)
  // and a 12s sentence gets two (10s).
  //
  // Footage uses FOOTAGE_HOLD_SECONDS (6s) so a 12s talking-head
  // sentence becomes TWO 6s footage blocks instead of one 12s hold.
  // Each sub-block gets its own clip slot, and the matcher's
  // no-adjacent-same-source rule picks two visually distinct clips.
  //
  // Math.round used over Math.floor: a 7.5s sentence becomes
  // two slots, which is closer to the truth than one.
  // Hard caps on slot expansion per hint. A single Gemini hint represents
  // 1–3 sentences of narration; expanding it into more than a handful of
  // blocks indicates rawSec overshot (typically because Gemini paraphrased
  // the sentence and sentenceDurationFromWords couldn't find the tail
  // bracket, falling back to a cadence estimate that landed on a slow
  // narration patch). On long audios (~30 min) the overshoot compounds
  // across hundreds of hints into a timeline 2× the audio length, with the
  // same source sentence repeated across many editor rows. These caps stop
  // a single hint from inflating the timeline regardless of how badly the
  // raw duration was estimated.
  const MAX_IMAGE_SLOTS_PER_HINT = 3;
  const MAX_FOOTAGE_SLOTS_PER_HINT = 2;
  const slotCounts = new Array<number>(mergedHints.length).fill(1);
  for (let i = 0; i < mergedHints.length; i++) {
    const rawSec = rawDurations[i];
    if (effectiveTypes[i] === "image") {
      slotCounts[i] = Math.min(
        MAX_IMAGE_SLOTS_PER_HINT,
        Math.max(1, Math.round(rawSec / IMAGE_HOLD_SECONDS)),
      );
    } else if (effectiveTypes[i] === "footage") {
      // Only split when the sentence is meaningfully longer than the
      // target hold — short sentences stay as a single block (a 4s
      // sentence at FOOTAGE_HOLD_SECONDS=6 would otherwise become a
      // 4s slot, which is fine, but rounding to one slot avoids
      // degenerate sub-1-slot math). The FOOTAGE_SPLIT_THRESHOLD is
      // hold + 1.5s so 7.5s sentences split, 7.0s sentences don't.
      slotCounts[i] = rawSec >= FOOTAGE_SPLIT_THRESHOLD
        ? Math.min(
            MAX_FOOTAGE_SLOTS_PER_HINT,
            Math.max(1, Math.round(rawSec / FOOTAGE_HOLD_SECONDS)),
          )
        : 1;
    }
  }

  // Footage scale is only used when rawDurations came from the cadence
  // estimator (no word timings available). With real timings we don't
  // scale — each footage block stays at its real spoken duration.
  let footageScale = 1;
  if (!haveRealTimings) {
    let pinnedTime = 0;
    for (let i = 0; i < mergedHints.length; i++) {
      const type = effectiveTypes[i];
      if (type === "image") pinnedTime += slotCounts[i] * IMAGE_HOLD_SECONDS;
      else if (type === "title_card") pinnedTime += DURATION_RANGES.title_card.min;
      else if (type === "split_2") pinnedTime += DURATION_RANGES.split_2.min;
      else if (type === "split_4") pinnedTime += DURATION_RANGES.split_4.min;
    }
    let footageRawTotal = 0;
    for (let i = 0; i < mergedHints.length; i++) {
      if (effectiveTypes[i] === "footage") footageRawTotal += rawDurations[i];
    }
    const footageTarget = Math.max(0, targetSeconds - pinnedTime);
    footageScale =
      footageRawTotal > 0 && footageTarget > 0
        ? footageTarget / footageRawTotal
        : 1;
  }

  const blocks: PlannedBlockWithHint[] = [];
  mergedHints.forEach((h, i) => {
    const type = effectiveTypes[i];

    if (type === "image") {
      const slots = slotCounts[i];
      // Split the merged hint's spoken-audio window evenly across slots.
      // Slot k of N covers [voStart + k*span/N, voStart + (k+1)*span/N).
      // When the hint had no aligned vo window, slot windows are null.
      const hintVoStart = mergedVoStart[i];
      const hintVoEnd = mergedVoEnd[i];
      const hintSpan =
        hintVoStart != null && hintVoEnd != null && hintVoEnd > hintVoStart
          ? hintVoEnd - hintVoStart
          : null;
      for (let k = 0; k < slots; k++) {
        const slotStart =
          hintVoStart != null && hintSpan != null
            ? hintVoStart + (k * hintSpan) / slots
            : null;
        const slotEnd =
          hintVoStart != null && hintSpan != null
            ? hintVoStart + ((k + 1) * hintSpan) / slots
            : null;
        blocks.push({
          type: "image",
          duration: IMAGE_HOLD_SECONDS,
          text: h.text,
          resolved_subject: h.resolved_subject,
          // Section titles only ride the first block of a segment.
          section_title: k === 0 ? h.section_title : undefined,
          specific_visual_references: h.specific_visual_references,
          mentioned_entities: h.mentioned_entities,
          subject_type: h.subject_type,
          visual_priority: h.visual_priority,
          paragraph_index: h.paragraph_index,
          vo_start_seconds: slotStart,
          vo_end_seconds: slotEnd,
        });
      }
      return;
    }

    // Footage may need to be split into multiple sub-blocks the same way
    // images already do. When slotCounts[i] > 1, the sentence's spoken
    // window is divided evenly across N sub-blocks, each at the
    // FOOTAGE_HOLD_SECONDS target — so a 12s talking-head sentence
    // produces two 6s footage rows instead of one 12s hold, and the
    // matcher can fill each from a different source.
    if (type === "footage") {
      const slots = slotCounts[i];
      if (slots > 1) {
        const hintVoStart = mergedVoStart[i];
        const hintVoEnd = mergedVoEnd[i];
        const hintSpan =
          hintVoStart != null && hintVoEnd != null && hintVoEnd > hintVoStart
            ? hintVoEnd - hintVoStart
            : null;
        // Slot duration: prefer the spoken-window slice (so two 6.4s
        // halves of a 12.8s sentence land at 6.4s each, not 6s + leftover
        // gap), but fall back to FOOTAGE_HOLD_SECONDS when the hint had
        // no aligned audio window. Round to 0.1s precision to match the
        // existing block-duration convention.
        const slotDur = hintSpan != null
          ? Math.round((hintSpan / slots) * 10) / 10
          : FOOTAGE_HOLD_SECONDS;
        for (let k = 0; k < slots; k++) {
          const slotStart = hintVoStart != null && hintSpan != null
            ? hintVoStart + (k * hintSpan) / slots
            : null;
          const slotEnd = hintVoStart != null && hintSpan != null
            ? hintVoStart + ((k + 1) * hintSpan) / slots
            : null;
          blocks.push({
            type,
            duration: slotDur,
            text: h.text,
            resolved_subject: h.resolved_subject,
            // Section titles only ride the FIRST sub-block of a split
            // sentence — putting the section title on every sub-block
            // would render the chapter heading repeatedly.
            section_title: k === 0 ? h.section_title : undefined,
            specific_visual_references: h.specific_visual_references,
            mentioned_entities: h.mentioned_entities,
            subject_type: h.subject_type,
            visual_priority: h.visual_priority,
            block_entity: h.block_entity,
            paragraph_index: h.paragraph_index,
            vo_start_seconds: slotStart,
            vo_end_seconds: slotEnd,
          });
        }
        return;
      }
    }

    let duration: number;
    if (type === "footage") {
      // Single-slot footage. With real timings: use the spoken duration
      // directly so the visual is on screen for as long as the narrator
      // speaks the sentence. Without timings: scale to fit voiceover
      // length as before. Either way we round to 0.1s precision.
      const raw = haveRealTimings
        ? rawDurations[i]
        : rawDurations[i] * footageScale;
      duration = Math.round(raw * 10) / 10;
    } else {
      duration = DURATION_RANGES[type].min;
    }

    blocks.push({
      type,
      duration,
      text: h.text,
      resolved_subject: h.resolved_subject,
      section_title: h.section_title,
      specific_visual_references: h.specific_visual_references,
      mentioned_entities: h.mentioned_entities,
      subject_type: h.subject_type,
      visual_priority: h.visual_priority,
      block_entity: h.block_entity,
      paragraph_index: h.paragraph_index,
      vo_start_seconds: mergedVoStart[i],
      vo_end_seconds: mergedVoEnd[i],
    });
  });

  // Step 3 — formerly mergeShortFootage. Now a no-op (see function body).
  // Every Gemini hint stays as its own block; we no longer fuse short
  // adjacent blocks because that hid short sentences from the editor.
  mergeShortFootage(blocks);

  // Step 4 — Residual cleanup. With real word timings, footage durations
  // are exact spoken lengths; never shorten them. With cadence-estimated
  // durations, residue is larger and we can use the legacy redistributor
  // which clamps to the footage range [3, 8].
  if (haveRealTimings) {
    redistributeResidueWithRealTimings(blocks, targetSeconds);
  } else {
    redistributeFootageResidue(blocks, targetSeconds);
  }

  return blocks;
}

// Disabled. Used to fuse adjacent short blocks (footage→footage,
// image→footage with same block_entity, etc.) into one larger block,
// concatenating their script text. Both merge paths hid short sentences
// from the editor — the user can no longer see "But somehow it just
// happened." as its own row because it was folded into the previous
// block. Per the spec "every sentence must appear in the editor", we
// keep every block separate. Visual choppiness from a 1-2s flash is the
// acceptable trade for never silently dropping a sentence.
//
// Function kept (instead of deleted) so the call site stays stable.
// If we later want shared-clip grouping that DOESN'T merge editor rows,
// the right place is transcript-driven-builder.ts (which assigns group
// ids without concatenating text or splicing the array).
function mergeShortFootage(_blocks: PlannedBlockWithHint[]): void {
  // intentionally empty
}

// Real-timing residue path. Footage blocks already hold their real spoken
// duration so we must not shrink them — that would desync the visual from
// the narration. We only stretch when the timeline is short, and only by
// a tiny per-block amount (max +2s) to keep alignment intact. Any residue
// we can't absorb this way is left for the render-tolerance check (±3s).
//
// We split the gap across all footage blocks, not just one tail block,
// so any single block stretches at most 2s — a hold that's 2s longer than
// the narration on screen is visually imperceptible, but stretching one
// block by 10s would be a desync.
function redistributeResidueWithRealTimings(blocks: PlannedBlockWithHint[], target: number): void {
  const EPSILON = 0.1;
  const PER_BLOCK_STRETCH_LIMIT = 2.0;
  const MAX_PASSES = 8;
  const footage = blocks.filter((b) => b.type === "footage");
  if (footage.length === 0) return;
  const ceilings = new Map<PlannedBlockWithHint, number>();
  for (const b of footage) {
    ceilings.set(b, b.duration + PER_BLOCK_STRETCH_LIMIT);
  }
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const total = sumDurations(blocks);
    const gap = target - total;
    if (gap < EPSILON) return;
    const stretchable = footage.filter((b) => b.duration < (ceilings.get(b) ?? b.duration));
    if (stretchable.length === 0) return;
    const perBlock = gap / stretchable.length;
    let absorbed = 0;
    for (const b of stretchable) {
      const ceiling = ceilings.get(b) ?? b.duration;
      const headroom = ceiling - b.duration;
      const add = Math.min(perBlock, headroom);
      const next = Math.round((b.duration + add) * 10) / 10;
      absorbed += next - b.duration;
      b.duration = next;
    }
    if (absorbed < 0.01) return;
  }
}

// Legacy residue path used when word timings are unavailable. The cadence-
// estimated rawDurations have large per-hint drift; this redistributor
// soaks it up by stretching/shrinking footage within the [3, 8] range.
// Image / title_card / split_2 time is already exact, so we never touch
// them here. Each pass spreads the remaining gap evenly across footage
// blocks with headroom; we re-evaluate per pass because the clamp can
// pin some blocks at min/max.
function redistributeFootageResidue(blocks: PlannedBlockWithHint[], target: number): void {
  const footageRange = DURATION_RANGES.footage;
  const MAX_PASSES = 6;
  const EPSILON = 0.1;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const total = sumDurations(blocks);
    const gap = target - total;
    if (Math.abs(gap) < EPSILON) return;

    const adjustable = blocks.filter((b) => {
      if (b.type !== "footage") return false;
      return gap > 0 ? b.duration < footageRange.max : b.duration > footageRange.min;
    });
    if (adjustable.length === 0) return;

    const perBlock = gap / adjustable.length;
    for (const b of adjustable) {
      const next = clampToRange("footage", b.duration + perBlock);
      b.duration = Math.round(next * 10) / 10;
    }
  }
}


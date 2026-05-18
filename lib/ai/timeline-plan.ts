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
  // Footage holds match the spoken length of their sentence: short
  // sentences → short holds, long sentences → long holds. The max is
  // capped at CLIP_DURATION_MAX_SECONDS (8s) because the clip generator
  // produces 5–8s windows and asking for more would require either a
  // frame-freeze or a clip-loop (both visually bad). Keeping the planner
  // inside the clip-generator's range means timeline_items.duration
  // matches what actually gets rendered. The min prevents degenerate
  // 0.4s flashes from 1-word sentences.
  footage: { min: 3,  max: 8 },
  // Per-image hold is still 5s per user spec. The sentence-aligned planner
  // honors this by SPLITTING long sentences (>~6s) across multiple 5s image
  // blocks rather than stretching one image, so the contract holds.
  image:   { min: 5,  max: 5  },
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
): { durationSeconds: number; nextCursor: number } | null {
  const hintWords = text
    .trim()
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);
  if (hintWords.length === 0) return null;

  let i = cursor;
  let firstStart: number | null = null;
  let lastEnd: number | null = null;
  // Allow a small forward window when a hint word doesn't immediately
  // match — handles Deepgram inserting filler words or splitting a hint's
  // contraction. Keeps the cursor advancing without realigning on noise.
  const LOOKAHEAD = 3;

  for (let h = 0; h < hintWords.length; h++) {
    const target = hintWords[h];
    if (!target) continue;
    let matched = false;
    const limit = Math.min(timings.length, i + 1 + LOOKAHEAD);
    for (let k = i; k < limit; k++) {
      if (normalizeWord(timings[k].word) === target) {
        if (firstStart === null) firstStart = timings[k].start;
        lastEnd = timings[k].end;
        i = k + 1;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Hint word missing from timings (e.g. punctuation-only or a
      // Gemini-paraphrase artifact). Advance i by one to stay roughly
      // aligned with the narration; the next hint word usually re-syncs.
      i = Math.min(timings.length, i + 1);
    }
  }

  if (firstStart === null || lastEnd === null || lastEnd <= firstStart) {
    return null;
  }
  return { durationSeconds: lastEnd - firstStart, nextCursor: i };
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for API stability; sentence-aligned builder is deterministic.
  _rand: RandomFn = Math.random,
): PlannedBlockWithHint[] {
  if (hints.length === 0 || voiceoverSeconds <= 0) return [];

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
  const rawDurations: number[] = hints.map((h) => {
    if (wordTimings && wordTimings.length > 0) {
      const aligned = sentenceDurationFromWords(h.text, wordTimings, wordCursor);
      if (aligned) {
        wordCursor = aligned.nextCursor;
        return aligned.durationSeconds;
      }
    }
    return sentenceDurationSeconds(h.text, cadence);
  });

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

  // Slot counts for image hints. Round to nearest whole 5s multiple so
  // a 7s sentence gets one slot (5s) and a 12s sentence gets two (10s).
  // Math.round used to gain over Math.floor: a 7.5s sentence becomes
  // two slots, which is closer to the truth than one.
  const slotCounts = new Array<number>(hints.length).fill(1);
  for (let i = 0; i < hints.length; i++) {
    if (effectiveTypes[i] === "image") {
      const rawSec = rawDurations[i];
      slotCounts[i] = Math.max(1, Math.round(rawSec / IMAGE_HOLD_SECONDS));
    }
  }

  // Footage scale is only used when rawDurations came from the cadence
  // estimator (no word timings available). With real timings we don't
  // scale — each footage block stays at its real spoken duration.
  let footageScale = 1;
  if (!haveRealTimings) {
    let pinnedTime = 0;
    for (let i = 0; i < hints.length; i++) {
      const type = effectiveTypes[i];
      if (type === "image") pinnedTime += slotCounts[i] * IMAGE_HOLD_SECONDS;
      else if (type === "title_card") pinnedTime += DURATION_RANGES.title_card.min;
      else if (type === "split_2") pinnedTime += DURATION_RANGES.split_2.min;
      else if (type === "split_4") pinnedTime += DURATION_RANGES.split_4.min;
    }
    let footageRawTotal = 0;
    for (let i = 0; i < hints.length; i++) {
      if (effectiveTypes[i] === "footage") footageRawTotal += rawDurations[i];
    }
    const footageTarget = Math.max(0, voiceoverSeconds - pinnedTime);
    footageScale =
      footageRawTotal > 0 && footageTarget > 0
        ? footageTarget / footageRawTotal
        : 1;
  }

  const blocks: PlannedBlockWithHint[] = [];
  hints.forEach((h, i) => {
    const type = effectiveTypes[i];

    if (type === "image") {
      const slots = slotCounts[i];
      for (let k = 0; k < slots; k++) {
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
        });
      }
      return;
    }

    let duration: number;
    if (type === "footage") {
      // With real timings: use the spoken duration directly so the visual
      // is on screen for as long as the narrator speaks the sentence.
      // Without timings: scale to fit voiceover length as before. Either
      // way we round to 0.1s precision — finer precision adds no value
      // because the matcher's clip-clamp is the dominant rounding step.
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
    });
  });

  // Step 3 — Merge very short adjacent footage blocks. A 3s footage block
  // means a clip flashes by while the speaker is mid-thought; viewers
  // perceive that as choppy. Fuse adjacent footage blocks when the first
  // is short (≤MERGE_SHORT_FOOTAGE_THRESHOLD) and the combined duration
  // still fits in footage's 3-10s range. We only merge footage — images
  // need per-slot variety, title cards are deliberate beats, splits are
  // fixed. The matcher uses the first hint's metadata, so the merged
  // block searches by the leading sentence's subject (typical case: a
  // short transition sentence followed by the meatier follow-up — the
  // follow-up's hint subject is the right anchor for the combined block).
  mergeShortFootage(blocks);

  // Step 4 — Residual cleanup. With real word timings, footage durations
  // are exact spoken lengths; never shorten them. With cadence-estimated
  // durations, residue is larger and we can use the legacy redistributor
  // which clamps to the footage range [3, 8].
  if (haveRealTimings) {
    redistributeResidueWithRealTimings(blocks, voiceoverSeconds);
  } else {
    redistributeFootageResidue(blocks, voiceoverSeconds);
  }

  return blocks;
}

// Threshold below which a footage block is considered "too short" and
// becomes a merge candidate. 3s is the footage minimum — a block sitting
// at the floor reads as a visual flash rather than a beat.
const MERGE_SHORT_FOOTAGE_THRESHOLD = 3.5;

function mergeShortFootage(blocks: PlannedBlockWithHint[]): void {
  const footageMax = DURATION_RANGES.footage.max;
  let i = 0;
  while (i < blocks.length - 1) {
    const a = blocks[i];
    const b = blocks[i + 1];
    // Only fuse adjacent footage→footage where the first is short and the
    // combined duration still fits. Crossing block types breaks visual
    // contracts (image cadence, section beats).
    if (
      a.type === "footage" &&
      b.type === "footage" &&
      a.duration <= MERGE_SHORT_FOOTAGE_THRESHOLD &&
      a.duration + b.duration <= footageMax
    ) {
      // Keep the second block's metadata (typically the meatier follow-up
      // sentence) but concatenate text so anything downstream that reads
      // the block's text still sees both sentences.
      const mergedText = [a.text, b.text].filter(Boolean).join(" ");
      blocks.splice(i, 2, {
        type: "footage",
        duration: Math.round((a.duration + b.duration) * 10) / 10,
        text: mergedText,
        resolved_subject: b.resolved_subject ?? a.resolved_subject,
        // Section titles ride the first block of a segment — preserve a's
        // if present, otherwise use b's.
        section_title: a.section_title ?? b.section_title,
        specific_visual_references: [
          ...(a.specific_visual_references ?? []),
          ...(b.specific_visual_references ?? []),
        ].filter((v, k, arr) => arr.indexOf(v) === k),
        mentioned_entities: [
          ...(a.mentioned_entities ?? []),
          ...(b.mentioned_entities ?? []),
        ].filter((v, k, arr) => arr.indexOf(v) === k),
        subject_type: b.subject_type ?? a.subject_type,
        visual_priority: b.visual_priority ?? a.visual_priority,
      });
      // Don't advance i — the merged block might now be a merge candidate
      // with the *next* block (e.g. three 3s footage blocks in a row).
      continue;
    }
    i++;
  }
}

// Real-timing residue path. Footage blocks already hold their real spoken
// duration so we must not shrink them — that would desync the visual from
// the narration. We only stretch when the timeline is short, and only by
// a tiny per-block amount (max +1s) to keep alignment intact. Any residue
// we can't absorb this way is left for the render-tolerance check (±3s).
//
// We split the gap across all footage blocks, not just one tail block,
// so any single block stretches at most 1s — a hold that's 1s longer than
// the narration on screen is visually imperceptible, but stretching one
// block by 10s would be a desync.
function redistributeResidueWithRealTimings(blocks: PlannedBlockWithHint[], target: number): void {
  const EPSILON = 0.1;
  const PER_BLOCK_STRETCH_LIMIT = 1.0;
  const total = sumDurations(blocks);
  const gap = target - total;
  // Negative gap (timeline > voiceover) is rare with real timings — the
  // narration can't be longer than itself. Skip negative-gap handling to
  // avoid shortening real-timing blocks.
  if (gap < EPSILON) return;

  const footage = blocks.filter((b) => b.type === "footage");
  if (footage.length === 0) return;

  const perBlock = Math.min(PER_BLOCK_STRETCH_LIMIT, gap / footage.length);
  for (const b of footage) {
    b.duration = Math.round((b.duration + perBlock) * 10) / 10;
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


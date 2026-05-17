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
  // Widened to 3–10s for sentence-aligned planning (Option 3). A footage
  // block now mirrors the spoken length of its sentence: short sentences
  // get short holds, long sentences get long holds. Video clips are
  // typically longer than 10s, so any hold in this range is fine —
  // viewers don't notice. The min/max cap prevents degenerate cases
  // (a 1-word sentence at 0.4s, a run-on sentence at 25s).
  footage: { min: 3,  max: 10 },
  // Per-image hold is still 5s per user spec. The sentence-aligned planner
  // honors this by SPLITTING long sentences (>~6s) across multiple 5s image
  // blocks rather than stretching one image, so the contract holds.
  image:   { min: 5,  max: 5  },
  // Black title cards for section breaks. Short on purpose — they're a
  // pacing beat, not a real visual hold.
  title_card: { min: 2, max: 4 },
  split_2: { min: 5,  max: 8  },
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
// fixed narration cadence. Used to size blocks by sentence length rather
// than by a hard-coded per-block duration. Returns seconds, with a 0.1s
// floor so empty chunks don't collapse to 0.
export function sentenceDurationSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0.1;
  return words / WORDS_PER_SECOND_NARRATION;
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for API stability; sentence-aligned builder is deterministic.
  _rand: RandomFn = Math.random,
): PlannedBlockWithHint[] {
  if (hints.length === 0 || voiceoverSeconds <= 0) return [];

  // Step 1 — Compute a target duration for each hint from its text's
  // spoken length, then scale uniformly so the sum matches the actual
  // voiceover duration. Uniform scaling preserves the proportions
  // between blocks: a sentence twice as long stays twice as long.
  const rawDurations = hints.map((h) => sentenceDurationSeconds(h.text));
  const rawTotal = rawDurations.reduce((s, d) => s + d, 0);
  // Guard against zero/NaN (all-empty hints) — fall back to even split.
  const scale = rawTotal > 0 ? voiceoverSeconds / rawTotal : 1;
  const scaledDurations = rawDurations.map((d) => d * scale);

  // Step 2 — Materialize blocks. For footage / title_card / split_2 each
  // hint becomes ONE block whose duration is the scaled sentence length
  // clamped to its type's range. For image blocks, sentences exceeding
  // IMAGE_SPLIT_THRESHOLD are SPLIT into multiple ~5s blocks that share
  // the hint's text and metadata — the matcher then assigns a separate
  // image to each block, honoring the 5s-per-image rule for long
  // sentences.
  const blocks: PlannedBlockWithHint[] = [];
  hints.forEach((h, i) => {
    const sentenceSec = scaledDurations[i];
    const type = h.recommended_visual_type;

    // Image blocks: keep 5s per image. If the sentence runs long, emit
    // multiple back-to-back image blocks of ~5s each, all sharing the
    // hint metadata. The matcher will pick a different image for each
    // slot via its reference + person-fallback chain.
    if (type === "image" && sentenceSec > IMAGE_SPLIT_THRESHOLD) {
      const slotCount = Math.max(1, Math.round(sentenceSec / IMAGE_HOLD_SECONDS));
      const slotDur = Math.round((sentenceSec / slotCount) * 10) / 10;
      for (let k = 0; k < slotCount; k++) {
        blocks.push({
          type: "image",
          duration: clampToRange("image", slotDur),
          text: h.text,
          resolved_subject: h.resolved_subject,
          section_title: k === 0 ? h.section_title : undefined,
          specific_visual_references: h.specific_visual_references,
          mentioned_entities: h.mentioned_entities,
          subject_type: h.subject_type,
          visual_priority: h.visual_priority,
        });
      }
      return;
    }

    // Footage / title_card / split_2: one block per hint, duration = the
    // scaled sentence length clamped to the type's range. Footage allows
    // 3-10s so most sentences land naturally; very short / very long
    // outliers get clamped.
    blocks.push({
      type,
      duration: clampToRange(type, Math.round(sentenceSec * 10) / 10),
      text: h.text,
      resolved_subject: h.resolved_subject,
      section_title: h.section_title,
      specific_visual_references: h.specific_visual_references,
      mentioned_entities: h.mentioned_entities,
      subject_type: h.subject_type,
      visual_priority: h.visual_priority,
    });
  });

  // Step 3 — Tail reconciliation. Clamping + image splits introduce small
  // drift; trim the last block by overshoot, or extend the most recent
  // footage block by undershoot (<3s). Image blocks stay at 5s — we
  // never stretch them.
  const total = sumDurations(blocks);
  const overshoot = total - voiceoverSeconds;
  const last = blocks[blocks.length - 1];
  if (overshoot > 1) {
    const minDur = 1;
    const newDur = Math.max(minDur, last.duration - overshoot);
    last.duration = Math.round(newDur * 10) / 10;
  } else if (overshoot < 0 && Math.abs(overshoot) < 3) {
    const stretch = -overshoot;
    let stretchIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === "footage") { stretchIdx = i; break; }
    }
    if (stretchIdx >= 0) {
      blocks[stretchIdx].duration = Math.round((blocks[stretchIdx].duration + stretch) * 10) / 10;
    }
  }

  return blocks;
}


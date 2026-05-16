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
  // Tightened to 4–5s per client spec for the celebrity-style refactor.
  // Was 4–6s; the upper bound is reduced because the new planner emits
  // more title_card / split_2 variety so individual footage holds can run
  // shorter without making the cut feel jumpy.
  footage: { min: 4,  max: 5  },
  // Fixed at 5s per user spec. Image holds previously ranged 5–8s, averaging
  // ~7s. The fixed value standardizes pacing across the slideshow stretch
  // and makes the timeline-plan math deterministic for image-time budgeting.
  image:   { min: 5,  max: 5  },
  // Black title cards for section breaks. Short on purpose — they're a
  // pacing beat, not a real visual hold.
  title_card: { min: 2, max: 4 },
  split_2: { min: 5,  max: 8  },
  split_4: { min: 5,  max: 8  },
};

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
  recommended_visual_type: "footage" | "image" | "title_card" | "split_2";
  // Optional section title for title_card blocks. When unset for a
  // title_card hint, the builder falls back to "" and the matcher fills
  // text in from the segment's sectionTitle at assignment time.
  section_title?: string;
}

export interface PlannedBlockWithHint extends PlannedBlock {
  // The text window this block covers — copied through from the hint so
  // the matcher doesn't have to re-derive from voiceover offsets when a
  // Gemini-supplied text is already aligned to the narration.
  text: string;
  resolved_subject?: string;
  section_title?: string;
}

// Approximate 60/40 footage:image balance per the client spec. Title cards
// and split_2 blocks count toward the "non-footage" 40% bucket.
const TARGET_FOOTAGE_RATIO = 0.6;
const FOOTAGE_RATIO_TOLERANCE = 0.1;     // ±10% — "approximate" balance.

// Build a timeline sequence from Gemini's per-block hints. The hints come
// in narration order; this function preserves that order and only adjusts:
//   1. block durations (clamped to DURATION_RANGES per type)
//   2. type rebalancing when the realized 60/40 ratio drifts outside ±10%
//   3. tail trimming/stretching to land within ±1s of voiceoverSeconds
//
// Why this and not buildBlockSequence: the legacy builder picks types from
// a budget (X footage blocks, Y image blocks) without knowing what each
// block is ABOUT. The hint-aware builder respects Gemini's per-block
// recommendation, so "she had a tattoo" lands as an image block even when
// the footage budget would otherwise pick footage.
export function buildBlockSequenceFromHints(
  hints: BlockPlanHint[],
  voiceoverSeconds: number,
  rand: RandomFn = Math.random,
): PlannedBlockWithHint[] {
  if (hints.length === 0 || voiceoverSeconds <= 0) return [];

  // Step 1 — give every hint a starting duration from its type range. We
  // pick mid-range so the initial total is predictable; the final tail
  // pass handles the over/undershoot.
  const blocks: PlannedBlockWithHint[] = hints.map((h) => {
    const type = h.recommended_visual_type;
    const dur = pickDuration(type, rand);
    return {
      type,
      duration: dur,
      text: h.text,
      resolved_subject: h.resolved_subject,
      section_title: h.section_title,
    };
  });

  // Step 2 — measure footage ratio by TIME and rebalance if it drifts.
  // We only rebalance footage<->image (the two majority types). title_card
  // and split_2 stay as Gemini placed them; they're an intentional pacing
  // signal that shouldn't be silently dropped to hit a ratio.
  let ratio = footageTimeRatio(blocks);
  // Promote image→footage while we're under the lower bound.
  if (ratio < TARGET_FOOTAGE_RATIO - FOOTAGE_RATIO_TOLERANCE) {
    for (let i = 0; i < blocks.length && ratio < TARGET_FOOTAGE_RATIO - FOOTAGE_RATIO_TOLERANCE; i++) {
      if (blocks[i].type === "image") {
        blocks[i] = { ...blocks[i], type: "footage", duration: pickDuration("footage", rand) };
        ratio = footageTimeRatio(blocks);
      }
    }
  }
  // Demote footage→image while we're over the upper bound.
  if (ratio > TARGET_FOOTAGE_RATIO + FOOTAGE_RATIO_TOLERANCE) {
    for (let i = blocks.length - 1; i >= 0 && ratio > TARGET_FOOTAGE_RATIO + FOOTAGE_RATIO_TOLERANCE; i--) {
      if (blocks[i].type === "footage") {
        blocks[i] = { ...blocks[i], type: "image", duration: pickDuration("image", rand) };
        ratio = footageTimeRatio(blocks);
      }
    }
  }

  // Step 3 — tail reconciliation. Same logic as buildBlockSequence: trim
  // overshoot off the last block (down to 1s floor); for undershoot < 3s,
  // stretch the most recent footage block. Image blocks stay fixed at 5s
  // per spec, so we never stretch them.
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

// Helper — share of timeline time spent on footage blocks. title_card and
// split_2 count toward the non-footage 40% per the spec.
function footageTimeRatio(blocks: PlannedBlock[]): number {
  const total = sumDurations(blocks);
  if (total <= 0) return 0;
  const footage = blocks.filter((b) => b.type === "footage").reduce((s, b) => s + b.duration, 0);
  return footage / total;
}

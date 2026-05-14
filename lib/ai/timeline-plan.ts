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

export type BlockType = "intro" | "footage" | "image" | "split_2" | "split_4";

export interface DurationRange {
  min: number;
  max: number;
}

export const DURATION_RANGES: Record<BlockType, DurationRange> = {
  intro:   { min: 5,  max: 6  },
  footage: { min: 4,  max: 6  },
  // Fixed at 5s per user spec. Image holds previously ranged 5–8s, averaging
  // ~7s. The fixed value standardizes pacing across the slideshow stretch
  // and makes the timeline-plan math deterministic for image-time budgeting.
  image:   { min: 5,  max: 5  },
  split_2: { min: 6,  max: 8  },
  split_4: { min: 6,  max: 8  },
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

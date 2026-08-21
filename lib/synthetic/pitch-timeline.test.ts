import { describe, it, expect } from "vitest";
import {
  planPitchPlacement,
  buildRenumberPlan,
  orderSegmentRows,
  expectedTimelineOrder,
} from "@/lib/synthetic/pitch-timeline";
import type { PitchAnchorRow, TimelineOrderRow } from "@/lib/synthetic/pitch-timeline";

// SALES-PITCH PLACEMENT (client 2026-08-18 via Joey: "the sales pitch feature is
// not working correctly / its showing up at the first second").
//
// Two independent routes led to the pitch playing first, and both are covered
// here because neither is visible until someone watches a finished 40-minute
// video:
//   1. unusable timing data collapsing the nearest-boundary snap to index 0;
//   2. an interrupted renumber leaving the row at the position it was inserted
//      at, which used to be 0.

/** `n` blocks of `each` seconds laid end to end, positions 0..n-1. */
function segments(n: number, each = 6, script: (i: number) => string | null = () => null): PitchAnchorRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `seg-${i}`,
    position: i,
    duration: each,
    start_time: i * each,
    script_text: script(i),
  }));
}

describe("planPitchPlacement", () => {
  it("snaps to the segment boundary nearest the insert mark", () => {
    // 100 x 6s = 600s. The 180s mark is exactly the start of block 30.
    const p = planPitchPlacement(segments(100), 180);
    expect(p.boundaryIndex).toBe(30);
    expect(p.approxStartSeconds).toBe(180);
    expect(p.snapDeltaSeconds).toBe(0);
    expect(p.frontGuardApplied).toBe(false);
    expect(p.usedStartTimeFallback).toBe(false);
  });

  it("snaps to the nearest boundary when the mark falls mid-block", () => {
    // Blocks start at 0, 7, 14, 21… — 20s is nearest the block starting at 21.
    const p = planPitchPlacement(segments(100, 7), 20);
    expect(p.approxStartSeconds).toBe(21);
    expect(p.snapDeltaSeconds).toBeLessThanOrEqual(3.5);
  });

  it("appends past the last block when the video ends before the mark", () => {
    const segs = segments(10); // 60s total, mark at 180s
    const p = planPitchPlacement(segs, 180);
    expect(p.boundaryIndex).toBe(segs.length);
  });

  // --- the reported bug -----------------------------------------------------

  it("does not put the pitch first when durations are missing", () => {
    // Every duration null: the cumulative sum stays 0, so every boundary ties at
    // delta 180 and the naive search keeps its first candidate — index 0, the
    // pitch playing before the video. start_time still carries usable timing.
    const segs = segments(100).map((s) => ({ ...s, duration: null }));
    const p = planPitchPlacement(segs, 180);
    expect(p.usedStartTimeFallback).toBe(true);
    expect(p.boundaryIndex).toBe(30);
    expect(p.frontGuardApplied).toBe(false);
  });

  it("sends the pitch to the END when ALL timing data is unusable", () => {
    // Neither durations nor start_times survive, so the timeline has no length
    // and there is no honest place to snap to. "Plays last" is the safe
    // direction; "plays first" is the bug.
    const segs = segments(100).map((s) => ({ ...s, duration: 0, start_time: null }));
    const p = planPitchPlacement(segs, 180);
    expect(p.noTimingData).toBe(true);
    expect(p.boundaryIndex).toBe(segs.length);
  });

  it("never returns index 0 on a timeline that runs past the insert mark", () => {
    // The invariant the client's complaint reduces to, over a spread of shapes.
    for (const [count, each, mark] of [
      [100, 6, 180], [300, 4, 180], [50, 20, 180], [400, 6, 240], [20, 30, 180],
    ] as const) {
      for (const broken of [
        (s: PitchAnchorRow) => ({ ...s, duration: null }),
        (s: PitchAnchorRow) => ({ ...s, duration: 0, start_time: null }),
        (s: PitchAnchorRow) => s,
      ]) {
        const segs = segments(count, each).map(broken);
        const p = planPitchPlacement(segs, mark);
        if (p.timelineEndSeconds > mark) expect(p.boundaryIndex).toBeGreaterThan(0);
      }
    }
  });

  it("legitimately allows index 0 when the video is shorter than the mark", () => {
    // Not every index 0 is a bug: with nothing past the mark the front guard
    // must not fire and invent a placement.
    const segs = segments(2, 6); // 12s total
    const p = planPitchPlacement(segs, 180);
    expect(p.frontGuardApplied).toBe(false);
  });

  // --- sentence guard (client 2026-07-03) -----------------------------------

  it("pushes past a sentence that was time-split across two blocks", () => {
    // Blocks 30 and 31 are the two visual halves of one narrated sentence, so
    // the boundary between them is mid-sentence.
    const segs = segments(100, 6, (i) => (i === 30 || i === 31 ? "one long sentence" : `line ${i}`));
    const p = planPitchPlacement(segs, 186); // nearest boundary is index 31
    expect(p.boundaryIndex).toBe(32);
    expect(p.sentenceGuardShift).toBe(1);
  });

  it("reports no shift when the boundary is already between sentences", () => {
    const p = planPitchPlacement(segments(100, 6, (i) => `line ${i}`), 180);
    expect(p.sentenceGuardShift).toBe(0);
    expect(p.boundaryIndex).toBe(30);
  });

  it("ignores blank scripts when detecting a split sentence", () => {
    // Two adjacent blocks with empty scripts are not one sentence.
    const p = planPitchPlacement(segments(100, 6, () => "  "), 180);
    expect(p.sentenceGuardShift).toBe(0);
  });
});

describe("buildRenumberPlan", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `seg-${i}`);
  const settled = (n: number) => new Map(ids(n).map((id, i) => [id, i]));

  it("gives the pitch the slot at boundaryIndex and shifts later segments up", () => {
    const plan = buildRenumberPlan(ids(10), 4, settled(10));
    expect(plan.pitchPosition).toBe(4);
    // Blocks 0-3 keep their positions; 4-9 shift up by one.
    const byId = new Map(plan.segmentWrites.map((w) => [w.id, w.position]));
    expect(byId.has("seg-3")).toBe(false);
    expect(byId.get("seg-4")).toBe(5);
    expect(byId.get("seg-9")).toBe(10);
    expect(plan.segmentWrites).toHaveLength(6);
  });

  it("orders segment writes highest-position-first so none ever collide", () => {
    // Applied in this order, a row never takes a position another row still
    // holds — the property that keeps an interrupted renumber consistent.
    const plan = buildRenumberPlan(ids(50), 10, settled(50));
    const positions = plan.segmentWrites.map((w) => w.position);
    expect(positions).toEqual([...positions].sort((a, b) => b - a));

    const live = new Map(settled(50));
    for (const w of plan.segmentWrites) {
      const clash = [...live.entries()].find(([id, p]) => p === w.position && id !== w.id);
      expect(clash).toBeUndefined();
      live.set(w.id, w.position);
    }
  });

  it("leaves the pitch out of the segment writes entirely", () => {
    // The pitch is written separately, LAST, so it must not appear here — that
    // separation is what keeps it parked past the end until the very last write.
    const plan = buildRenumberPlan(ids(10), 4, settled(10));
    expect(plan.segmentWrites.every((w) => w.id.startsWith("seg-"))).toBe(true);
  });

  it("writes nothing when the timeline is already settled", () => {
    // A re-run over an already-placed pitch: boundary 4 means segments 4+ are
    // already at 5+, so there is nothing to move.
    const placed = new Map(ids(10).map((id, i) => [id, i < 4 ? i : i + 1]));
    const plan = buildRenumberPlan(ids(10), 4, placed);
    expect(plan.segmentWrites).toHaveLength(0);
    expect(plan.pitchPosition).toBe(4);
  });

  it("appends the pitch after the last segment", () => {
    const plan = buildRenumberPlan(ids(10), 10, settled(10));
    expect(plan.pitchPosition).toBe(10);
    expect(plan.segmentWrites).toHaveLength(0);
  });

  it("produces a contiguous ordering with the pitch in its slot", () => {
    const n = 10;
    const boundary = 4;
    const plan = buildRenumberPlan(ids(n), boundary, settled(n));
    const final = new Map(settled(n));
    for (const w of plan.segmentWrites) final.set(w.id, w.position);
    final.set("pitch", plan.pitchPosition);

    const order = [...final.entries()].sort((a, b) => a[1] - b[1]);
    expect(order.map(([, p]) => p)).toEqual(Array.from({ length: n + 1 }, (_, i) => i));
    expect(order[boundary][0]).toBe("pitch");
    // Segments keep their relative order around the pitch.
    expect(order.filter(([id]) => id !== "pitch").map(([id]) => id)).toEqual(ids(n));
  });
});

// TIMELINE PLAY ORDER (client 2026-08-21 via Joey: "the first clip is avatar
// part but this is not avatar in the rendered video").
//
// The render concatenates strictly by timeline_items.position against ONE
// continuous voiceover, so a permuted position column does not fail — it ships
// a video whose visuals do not match the words. On project e8177073 the last 23
// blocks played first and the opening avatar landed third.
//
// The cause was two renumber loops racing over different row sets and zippering
// their writes together, then a compaction pass that tidied the result into
// unique contiguous positions — wrong, but perfectly well-formed. The fix is
// that order is re-derived from synthetic_segments.position every time, so any
// two runs compute the SAME answer and a damaged timeline heals itself. These
// tests pin that property.

/** `n` timeline rows carrying the positions they currently hold on disk. */
function timelineRows(currentOrderOfSegments: ReadonlyArray<number>): TimelineOrderRow[] {
  return currentOrderOfSegments.map((segIndex, i) => ({
    id: `row-${segIndex}`,
    position: i,
    synthetic_segment_id: `seg-${segIndex}`,
  }));
}

/** The authoritative order: segment `i` plays at index `i`. */
function segmentPositions(n: number): Map<string, number> {
  return new Map(Array.from({ length: n }, (_, i) => [`seg-${i}`, i]));
}

describe("orderSegmentRows", () => {
  it("orders by segment position, ignoring the position the row currently holds", () => {
    // The exact shape observed on e8177073: the tail hoisted to the front.
    const scrambled = [203, 205, 0, 214, 213, 1, 2];
    const { ordered } = orderSegmentRows(timelineRows(scrambled), segmentPositions(215));
    expect(ordered.map((r) => r.synthetic_segment_id)).toEqual([
      "seg-0", "seg-1", "seg-2", "seg-203", "seg-205", "seg-213", "seg-214",
    ]);
  });

  it("returns the same order no matter what order the rows arrive in", () => {
    // This is the property that kills the race: two concurrent reconciles read
    // the timeline at different moments, in different states, and must still
    // agree on the target — otherwise their interleaved writes hybridize.
    const segPos = segmentPositions(10);
    const a = orderSegmentRows(timelineRows([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), segPos);
    const b = orderSegmentRows(timelineRows([7, 2, 9, 0, 4, 1, 8, 3, 6, 5]), segPos);
    expect(b.ordered.map((r) => r.id)).toEqual(a.ordered.map((r) => r.id));
  });

  it("holds back rows whose segment no longer exists", () => {
    // A deleted / re-planned segment leaves a dead row behind. Giving it a slot
    // would render an asset the review screen no longer shows.
    const rows = timelineRows([0, 1, 2]);
    rows.push({ id: "row-ghost", position: 3, synthetic_segment_id: "seg-gone" });
    const { ordered, orphans } = orderSegmentRows(rows, segmentPositions(3));
    expect(ordered).toHaveLength(3);
    expect(orphans.map((r) => r.id)).toEqual(["row-ghost"]);
  });

  it("skips rows that are not segment rows at all", () => {
    // The pitch row carries no synthetic_segment_id — it is placed separately.
    const rows = timelineRows([0, 1]);
    rows.push({ id: "row-pitch", position: 2, synthetic_segment_id: null });
    const { ordered, orphans } = orderSegmentRows(rows, segmentPositions(2));
    expect(ordered.map((r) => r.id)).toEqual(["row-0", "row-1"]);
    expect(orphans).toHaveLength(0);
  });
});

describe("expectedTimelineOrder", () => {
  it("splices the pitch into its boundary slot", () => {
    expect(expectedTimelineOrder(["a", "b", "c"], "pitch", 2)).toEqual(["a", "b", "pitch", "c"]);
  });

  it("appends the pitch when the boundary is past the last segment", () => {
    expect(expectedTimelineOrder(["a", "b"], "pitch", 9)).toEqual(["a", "b", "pitch"]);
  });

  it("is just the segments when the project has no pitch video", () => {
    expect(expectedTimelineOrder(["a", "b", "c"], null, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("order reconcile end to end (pure halves)", () => {
  // orderSegmentRows -> buildRenumberPlan -> expectedTimelineOrder is the whole
  // decision path; only the writes are I/O. Running the halves together proves a
  // scrambled timeline converges in ONE pass rather than needing a second.
  function applyPlan(rows: TimelineOrderRow[], segCount: number, boundaryIndex: number) {
    const { ordered } = orderSegmentRows(rows, segmentPositions(segCount));
    const current = new Map(rows.map((r) => [r.id, r.position] as const));
    const { segmentWrites, pitchPosition } = buildRenumberPlan(
      ordered.map((r) => r.id),
      boundaryIndex,
      current,
    );
    const landed = new Map(current);
    for (const w of segmentWrites) landed.set(w.id, w.position);
    return { landed, pitchPosition, writes: segmentWrites.length, ordered };
  }

  it("repairs a scrambled timeline in a single pass", () => {
    const rows = timelineRows([3, 0, 4, 1, 2]); // 5 blocks, badly shuffled
    const { landed, ordered } = applyPlan(rows, 5, -1);
    const playOrder = [...landed.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
    expect(playOrder).toEqual(["row-0", "row-1", "row-2", "row-3", "row-4"]);
    expect(ordered).toHaveLength(5);
  });

  it("leaves an already-correct timeline untouched", () => {
    // Zero writes on a settled timeline is what makes it cheap enough to re-run
    // as a gate immediately before every render.
    const rows = timelineRows([0, 1, 2, 3, 4]);
    expect(applyPlan(rows, 5, -1).writes).toBe(0);
  });

  it("converges to the same result from two different starting scrambles", () => {
    const a = applyPlan(timelineRows([4, 3, 2, 1, 0]), 5, 2);
    const b = applyPlan(timelineRows([1, 4, 0, 3, 2]), 5, 2);
    const order = (r: typeof a) =>
      [...r.landed.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
    expect(order(b)).toEqual(order(a));
    expect(b.pitchPosition).toBe(a.pitchPosition);
  });

  it("keeps the pitch slot free while the segments are laid out around it", () => {
    const rows = timelineRows([2, 0, 3, 1]);
    const { landed, pitchPosition } = applyPlan(rows, 4, 2);
    const taken = new Set(landed.values());
    expect(pitchPosition).toBe(2);
    expect(taken.has(2)).toBe(false); // nothing else claims the pitch's slot
    expect([...taken].sort((a, b) => a - b)).toEqual([0, 1, 3, 4]);
  });
});

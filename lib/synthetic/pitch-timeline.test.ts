import { describe, it, expect } from "vitest";
import { planPitchPlacement, buildRenumberPlan } from "@/lib/synthetic/pitch-timeline";
import type { PitchAnchorRow } from "@/lib/synthetic/pitch-timeline";

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

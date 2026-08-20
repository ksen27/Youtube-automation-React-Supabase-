import { describe, it, expect } from "vitest";
import { capSplit2Blocks, ensureMinSplit2, rebalanceSplit2ToFront } from "@/lib/synthetic/planner";
import type { PlannedSegment } from "@/lib/synthetic/planner";

// SPLIT_2 FRONT-LOADING (client 2026-08-18 via Joey: "i want more split screens
// in the 12 min of the video. Put 80% of the splitscreens in the first 12 min
// and the 20% to the rest").
//
// The band knobs decide HOW MANY split_2 a video gets; these tests are about
// WHERE they land. Front window is 720s throughout, matching
// SYNTHETIC_SPLIT2_FRONT_SECONDS.

const FRONT_SECONDS = 720;
const FRONT_SHARE = 0.8;
// Front-window spacing rule (SYNTHETIC_SPLIT2_FRONT_MIN_GAP): tighter than the
// whole-video MIN_GAP because 80% of the split_2 in 12 minutes is by definition
// a denser stretch, but still never back-to-back.
const FRONT_GAP = 3;

let pos = 0;
function seg(
  blockType: PlannedSegment["blockType"],
  duration: number,
  startTime: number,
): PlannedSegment {
  return {
    position: pos++,
    blockType,
    startTime,
    endTime: startTime + duration,
    duration,
    script: "s",
    imagePrompt: blockType === "avatar" ? null : "a scene",
    animationPrompt: null,
  };
}

/** `n` blocks of `each` seconds laid end to end, typed by `typeAt`. */
function timeline(
  n: number,
  typeAt: (i: number, startTime: number) => PlannedSegment["blockType"],
  each = 6,
): PlannedSegment[] {
  const out: PlannedSegment[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    out.push(seg(typeAt(i, t), each, t));
    t += each;
  }
  return out;
}

const split2At = (segs: PlannedSegment[]) =>
  segs.filter((s) => s.blockType === "split_2");
const frontCount = (segs: PlannedSegment[]) =>
  split2At(segs).filter((s) => s.startTime < FRONT_SECONDS).length;

describe("capSplit2Blocks — front-loading", () => {
  it("keeps every front-window split_2 it can before spending quota on the tail", () => {
    // 40-minute video (400 blocks x 6s), split_2 every 10th block: 12 land in
    // the first 12 minutes, 28 after. The allowance (8% of 400 = 32) is bigger
    // than the front window can supply, so the cap should keep ALL 12 front ones
    // and fill the remainder from the tail — front-loading as far as the input
    // allows. Reaching a true 80% from here is the rebalance pass's job.
    const segs = timeline(400, (i) => (i % 10 === 0 ? "split_2" : "image"));
    const { segments, keptFront, keptRest, demoted } =
      capSplit2Blocks(segs, 0.08, 2, 5, FRONT_SECONDS, FRONT_SHARE);

    expect(demoted).toBeGreaterThan(0);
    expect(keptFront).toBe(12); // every split_2 the front window had
    expect(frontCount(segments)).toBe(keptFront);
    expect(split2At(segments)).toHaveLength(keptFront + keptRest);
  });

  it("front-loads when the front window has more split_2 than its quota", () => {
    // Dense split_2 in the front window, sparse in the tail. The front quota
    // (80% of the allowance) must bind and the tail must be thinned. The 5%
    // band is used so the quota (16) sits below what the window can hold at the
    // front spacing rule — see the ceiling test below for the other case.
    const segs = timeline(400, (i, t) => {
      const isSplit = t < FRONT_SECONDS ? i % 3 === 0 : i % 10 === 0;
      return isSplit ? "split_2" : "image";
    });
    const { keptFront, keptRest } =
      capSplit2Blocks(segs, 0.05, 2, 5, FRONT_SECONDS, FRONT_SHARE, FRONT_GAP);
    const kept = keptFront + keptRest;
    expect(keptFront / kept).toBeGreaterThanOrEqual(0.75);
    expect(keptFront / kept).toBeLessThanOrEqual(0.85);
  });

  it("lets the spacing rule cap front density rather than packing split_2 together", () => {
    // The front share is NOT achievable at any cost: a 12-minute window holds
    // only so many split_2 once the min-gap rule is honoured. The client
    // explicitly rejected consecutive split_2, so spacing wins and the front
    // share falls short — the planner logs the achieved share for exactly this.
    const segs = timeline(400, (i, t) => {
      const isSplit = t < FRONT_SECONDS ? i % 3 === 0 : i % 10 === 0;
      return isSplit ? "split_2" : "image";
    });
    const { segments, keptFront } =
      capSplit2Blocks(segs, 0.08, 2, 5, FRONT_SECONDS, FRONT_SHARE, FRONT_GAP);
    // 120 front blocks at a 3-block gap -> at most one per 4 blocks.
    expect(keptFront).toBeLessThanOrEqual(Math.ceil(120 / (FRONT_GAP + 1)));
    const idx = segments
      .map((s, i) => (s.blockType === "split_2" && s.startTime < FRONT_SECONDS ? i : -1))
      .filter((i) => i >= 0);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i] - idx[i - 1]).toBeGreaterThan(FRONT_GAP);
    }
  });

  it("respects the total band — front-loading redistributes, never adds", () => {
    const segs = timeline(400, (i) => (i % 10 === 0 ? "split_2" : "image"));
    const zoned = capSplit2Blocks(segs, 0.08, 2, 5, FRONT_SECONDS, FRONT_SHARE);
    const flat = capSplit2Blocks(segs, 0.08, 2, 5);
    expect(split2At(zoned.segments).length).toBe(split2At(flat.segments).length);
  });

  it("still honours the minimum gap between kept split_2", () => {
    // A clump of consecutive split_2 inside the front window must not survive
    // just because the front quota wants filling — the client explicitly
    // rejected back-to-back split_2.
    const segs = timeline(400, (i) => (i >= 20 && i < 60 ? "split_2" : "image"));
    const { segments } = capSplit2Blocks(segs, 0.08, 2, 5, FRONT_SECONDS, FRONT_SHARE);
    const idx = segments
      .map((s, i) => (s.blockType === "split_2" ? i : -1))
      .filter((i) => i >= 0);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i] - idx[i - 1]).toBeGreaterThan(5);
    }
  });

  it("spills the front quota to the tail when the front window has none", () => {
    // Gemini put every split_2 after 12 minutes. Front-loading is a placement
    // preference, not a reason to ship fewer split_2 than the band allows.
    const segs = timeline(400, (i, t) => (t >= FRONT_SECONDS && i % 10 === 0 ? "split_2" : "image"));
    const { segments, keptFront, keptRest } =
      capSplit2Blocks(segs, 0.08, 2, 5, FRONT_SECONDS, FRONT_SHARE);
    expect(keptFront).toBe(0);
    expect(keptRest).toBeGreaterThan(0);
    const flat = capSplit2Blocks(segs, 0.08, 2, 5);
    expect(split2At(segments).length).toBe(split2At(flat.segments).length);
  });

  it("leaves a plan alone when zoning is disabled", () => {
    const segs = timeline(400, (i) => (i % 10 === 0 ? "split_2" : "image"));
    const zoned = capSplit2Blocks(segs, 1, 0, 0, 0, 0);
    expect(zoned.demoted).toBe(0);
    expect(split2At(zoned.segments)).toHaveLength(split2At(segs).length);
  });
});

describe("ensureMinSplit2 — front-loading", () => {
  // The promoter's intro cutoff is the PHASE-1 clip window (180s since the
  // 2026-08-20 trim, previously 240), because the opening minutes are meant to
  // be mostly clips and a split_2 is not a clip.
  const INTRO_CUTOFF = 180;

  it("promotes into the first 12 minutes to reach the front share", () => {
    // No split_2 at all — the exact case the floor pass exists for.
    const segs = timeline(400, () => "image");
    const { segments, promoted, promotedFront } =
      ensureMinSplit2(segs, 20, INTRO_CUTOFF, FRONT_SECONDS, FRONT_SHARE);

    expect(promoted).toBe(20);
    expect(promotedFront).toBe(16); // 80% of 20
    expect(frontCount(segments)).toBe(16);
  });

  it("never promotes inside the clip-heavy opening window", () => {
    const segs = timeline(400, () => "image");
    const { segments } = ensureMinSplit2(segs, 20, INTRO_CUTOFF, FRONT_SECONDS, FRONT_SHARE);
    for (const s of split2At(segments)) {
      expect(s.startTime).toBeGreaterThanOrEqual(INTRO_CUTOFF);
    }
  });

  it("counts split_2 already in the front window toward the share", () => {
    // Gemini already clustered every 4th block of the front window as split_2
    // (22 of them between the intro cutoff and 12:00). The promoter should top
    // the total up in the TAIL, not pile more into the front.
    const segs = timeline(400, (i, t) =>
      t >= INTRO_CUTOFF && t < FRONT_SECONDS && i % 4 === 0 ? "split_2" : "image",
    );
    const haveFront = frontCount(segs);
    expect(haveFront).toBe(22);

    const { segments, promotedFront } =
      ensureMinSplit2(segs, haveFront + 5, INTRO_CUTOFF, FRONT_SECONDS, FRONT_SHARE);
    // Front is already over its share, so nothing new goes there.
    expect(promotedFront).toBe(0);
    expect(frontCount(segments)).toBe(haveFront);
  });

  it("spills to the tail when the front window is out of eligible images", () => {
    // Everything between the intro cutoff and 12 minutes is avatar — nothing
    // there to promote, so the promotions must still happen, in the tail.
    const segs = timeline(400, (_i, t) =>
      t >= INTRO_CUTOFF && t < FRONT_SECONDS ? "avatar" : "image",
    );
    const { segments, promoted, promotedFront } =
      ensureMinSplit2(segs, 20, INTRO_CUTOFF, FRONT_SECONDS, FRONT_SHARE);
    expect(promoted).toBe(20);
    expect(promotedFront).toBe(0);
    expect(split2At(segments)).toHaveLength(20);
  });

  it("behaves as before when zoning is disabled", () => {
    const segs = timeline(400, () => "image");
    const { promoted, promotedFront } = ensureMinSplit2(segs, 20, INTRO_CUTOFF);
    expect(promoted).toBe(20);
    expect(promotedFront).toBe(0);
  });

  it("never touches avatar or ai_clip blocks", () => {
    const segs = timeline(400, (i) => (i % 3 === 0 ? "avatar" : i % 3 === 1 ? "ai_clip" : "image"));
    const before = segs.map((s) => s.blockType);
    const { segments } = ensureMinSplit2(segs, 20, INTRO_CUTOFF, FRONT_SECONDS, FRONT_SHARE);
    segments.forEach((s, i) => {
      if (before[i] === "avatar" || before[i] === "ai_clip") expect(s.blockType).toBe(before[i]);
    });
  });
});

describe("rebalanceSplit2ToFront", () => {
  const INTRO_CUTOFF = 240;
  const OPTS = {
    frontSeconds: FRONT_SECONDS,
    frontShare: FRONT_SHARE,
    introCutoffSeconds: INTRO_CUTOFF,
    minGap: 5,
    frontMinGap: FRONT_GAP,
  };

  it("moves tail split_2 into the front window to reach the 80% share", () => {
    // The case the cap and floor passes both miss: total is inside the band,
    // but the split_2 are spread evenly so only a fraction sit in the first 12
    // min. 20 split_2 over 40 minutes — 80% of that (16) fits the front window
    // at the front spacing rule, so the share IS reachable here.
    const segs = timeline(400, (i) => (i % 20 === 0 ? "split_2" : "image"));
    const before = frontCount(segs);
    const total = split2At(segs).length;

    const r = rebalanceSplit2ToFront(segs, OPTS);
    expect(r.total).toBe(total);
    expect(r.moved).toBeGreaterThan(0);
    // Total is unchanged — this is a redistribution, not an increase.
    expect(split2At(r.segments)).toHaveLength(total);
    expect(frontCount(r.segments)).toBeGreaterThan(before);
    expect(frontCount(r.segments) / total).toBeGreaterThanOrEqual(0.75);
    expect(r.frontAfter).toBe(frontCount(r.segments));
  });

  it("stops at what the front window can hold instead of packing them together", () => {
    // 34 split_2: 80% is 27, but the promotable stretch (4:00-12:00, 80 blocks)
    // holds far fewer at the front spacing rule. The pass must move what it can
    // and stop — never tighten the spacing to hit the number.
    const segs = timeline(400, (i) => (i % 12 === 0 ? "split_2" : "image"));
    const total = split2At(segs).length;
    const r = rebalanceSplit2ToFront(segs, OPTS);

    expect(split2At(r.segments)).toHaveLength(total); // total still fixed
    expect(r.frontAfter).toBeLessThan(Math.round(total * FRONT_SHARE));
    const idx = r.segments
      .map((s, i) => (s.blockType === "split_2" && s.startTime < FRONT_SECONDS ? i : -1))
      .filter((i) => i >= 0);
    for (let k = 1; k < idx.length; k++) {
      expect(idx[k] - idx[k - 1]).toBeGreaterThan(FRONT_GAP);
    }
  });

  it("does nothing when the front window already has its share", () => {
    const segs = timeline(400, (i, t) =>
      t >= INTRO_CUTOFF && t < FRONT_SECONDS && i % 6 === 0 ? "split_2" : "image",
    );
    const r = rebalanceSplit2ToFront(segs, OPTS);
    expect(r.moved).toBe(0);
    expect(r.segments).toBe(segs);
  });

  it("never promotes inside the clip-heavy opening window", () => {
    const segs = timeline(400, (i) => (i % 12 === 0 ? "split_2" : "image"));
    const r = rebalanceSplit2ToFront(segs, OPTS);
    for (const s of split2At(r.segments)) {
      // The only split_2 allowed before the cutoff are ones Gemini put there;
      // the pass must not add any.
      if (s.startTime < INTRO_CUTOFF) {
        expect(segs.find((o) => o.startTime === s.startTime)!.blockType).toBe("split_2");
      }
    }
  });

  it("honours the minimum gap when promoting", () => {
    const segs = timeline(400, (i) => (i % 12 === 0 ? "split_2" : "image"));
    const r = rebalanceSplit2ToFront(segs, OPTS);
    const idx = r.segments
      .map((s, i) => (s.blockType === "split_2" ? i : -1))
      .filter((i) => i >= 0);
    for (let k = 1; k < idx.length; k++) {
      expect(idx[k] - idx[k - 1]).toBeGreaterThan(5);
    }
  });

  it("gives up tail split_2 from the tightest clumps first", () => {
    // A tight clump late on plus well-spread ones. The clump should be thinned
    // before the spread-out blocks are taken, so the tail keeps its coverage.
    const segs = timeline(400, (i, t) => {
      if (t < FRONT_SECONDS) return "image";
      if (i >= 300 && i < 320 && i % 2 === 0) return "split_2"; // clump
      return i % 40 === 0 ? "split_2" : "image";                // spread
    });
    const spreadBefore = split2At(segs).filter((s) => s.position >= 320).length;
    const r = rebalanceSplit2ToFront(segs, OPTS);
    const spreadAfter = r.segments.filter(
      (s) => s.blockType === "split_2" && s.position >= 320,
    ).length;
    expect(r.moved).toBeGreaterThan(0);
    expect(spreadAfter).toBe(spreadBefore); // the spread ones survived
  });

  it("is a no-op when zoning is disabled", () => {
    const segs = timeline(400, (i) => (i % 12 === 0 ? "split_2" : "image"));
    expect(rebalanceSplit2ToFront(segs, { ...OPTS, frontSeconds: 0 }).moved).toBe(0);
    expect(rebalanceSplit2ToFront(segs, { ...OPTS, frontShare: 0 }).moved).toBe(0);
  });

  it("stops early when the front window has no promotable images", () => {
    // Front window past the cutoff is all avatar — nothing to trade for.
    const segs = timeline(400, (_i, t) => {
      if (t >= INTRO_CUTOFF && t < FRONT_SECONDS) return "avatar";
      return t >= FRONT_SECONDS && Math.round(t / 6) % 12 === 0 ? "split_2" : "image";
    });
    const r = rebalanceSplit2ToFront(segs, OPTS);
    expect(r.moved).toBe(0);
    expect(split2At(r.segments)).toHaveLength(r.total);
  });
});

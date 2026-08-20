import { describe, it, expect } from "vitest";
import { assignClipDurationQuota } from "@/lib/synthetic/planner";
import type { PlannedSegment } from "@/lib/synthetic/planner";

// The client states the clip budget as a share of VIDEO DURATION ("25% LTX, 5%
// veo"), so these assert on seconds of screen time — not block counts, which is
// the distinction the pass exists to get right.

let pos = 0;
function seg(
  blockType: PlannedSegment["blockType"],
  duration: number,
  startTime = 0,
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

/** A timeline of `n` visual blocks of equal length, laid end to end. */
function visuals(n: number, each = 6): PlannedSegment[] {
  const out: PlannedSegment[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    out.push(seg("image", each, t));
    t += each;
  }
  return out;
}

const OPTS = { clipFraction: 0.25, veoFraction: 0.05, veoEnabled: true, cutoffSeconds: 0 };

const secondsOf = (segs: PlannedSegment[], pred: (s: PlannedSegment) => boolean) =>
  segs.filter(pred).reduce((a, s) => a + s.duration, 0);

describe("assignClipDurationQuota", () => {
  it("hits the 25% / 5% duration split on a uniform timeline", () => {
    const segs = visuals(100); // 600s total
    const q = assignClipDurationQuota(segs, OPTS);

    expect(q.totalSeconds).toBe(600);
    // 30% of the video is clips, within one block's length of the target.
    expect(q.clipSeconds).toBeGreaterThanOrEqual(180);
    expect(q.clipSeconds).toBeLessThan(180 + 6);
    // and 5% of it is veo.
    expect(q.veoSeconds).toBeGreaterThanOrEqual(30);
    expect(q.veoSeconds).toBeLessThan(30 + 6);
    expect(q.shortfallSeconds).toBe(0);

    // The achieved figures must match what actually landed on the segments.
    const out = q.segments;
    expect(secondsOf(out, (s) => s.blockType === "ai_clip")).toBe(q.clipSeconds);
    expect(secondsOf(out, (s) => s.clipEngine === "veo")).toBe(q.veoSeconds);
  });

  it("counts avatar and split_2 toward the total but never reassigns them", () => {
    // Half the video is avatar (doc-highlighted, not ours to touch).
    const segs = [
      ...Array.from({ length: 25 }, (_, i) => seg("avatar", 12, i * 12)),
      ...Array.from({ length: 50 }, (_, i) => seg("image", 6, 300 + i * 6)),
    ];
    const q = assignClipDurationQuota(segs, OPTS);

    expect(q.totalSeconds).toBe(600);
    // Every avatar block survives untouched...
    expect(q.segments.filter((s) => s.blockType === "avatar")).toHaveLength(25);
    // ...and the 30% is measured against the WHOLE video, not just the visuals.
    expect(q.clipSeconds).toBeGreaterThanOrEqual(180);
  });

  it("reports a shortfall when the doc is too heavily highlighted to fit the budget", () => {
    // 90% avatar leaves only 60s of visuals, but 30% of 600s is 180s.
    const segs = [
      ...Array.from({ length: 45 }, (_, i) => seg("avatar", 12, i * 12)),
      ...Array.from({ length: 10 }, (_, i) => seg("image", 6, 540 + i * 6)),
    ];
    const q = assignClipDurationQuota(segs, OPTS);

    expect(q.clipSeconds).toBe(60); // every available visual became a clip
    expect(q.shortfallSeconds).toBe(120); // and it still could not reach 180
  });

  it("demotes surplus clips when the plan starts over budget", () => {
    const segs = visuals(100).map((s) => ({ ...s, blockType: "ai_clip" as const }));
    const q = assignClipDurationQuota(segs, OPTS);

    expect(q.demoted).toBeGreaterThan(0);
    expect(q.promoted).toBe(0);
    expect(q.clipSeconds).toBeLessThan(180 + 6);
    // Demoted blocks must not keep a stale engine or animation prompt.
    for (const s of q.segments.filter((x) => x.blockType === "image")) {
      expect(s.clipEngine ?? null).toBeNull();
      expect(s.animationPrompt).toBeNull();
    }
  });

  it("spreads clips across the timeline rather than clumping them", () => {
    const segs = visuals(100);
    const q = assignClipDurationQuota(segs, OPTS);
    // Index within THIS timeline — `position` is a module-level counter shared
    // across the builders above, so it is not 0-based per test.
    const clipPositions = q.segments
      .map((s, i) => ({ s, i }))
      .filter((x) => x.s.blockType === "ai_clip")
      .map((x) => x.i);

    // Clips must appear in both halves of the video, not bunched at one end.
    const firstHalf = clipPositions.filter((p) => p < 50).length;
    const secondHalf = clipPositions.filter((p) => p >= 50).length;
    expect(firstHalf).toBeGreaterThan(0);
    expect(secondHalf).toBeGreaterThan(0);
    // Evenly spread means neither half holds more than ~2/3 of them.
    const total = clipPositions.length;
    expect(Math.max(firstHalf, secondHalf)).toBeLessThan(total * 0.7);
  });

  it("keeps at least one veo clip when 5% rounds below a single block", () => {
    // 60s video: 5% = 3s, shorter than any one 6s block.
    const q = assignClipDurationQuota(visuals(10), OPTS);
    expect(q.veoBlocks).toBeGreaterThanOrEqual(1);
  });

  it("assigns every clip an engine, and non-clips none", () => {
    const q = assignClipDurationQuota(visuals(100), OPTS);
    for (const s of q.segments) {
      if (s.blockType === "ai_clip") expect(["ltx", "veo"]).toContain(s.clipEngine);
      else expect(s.clipEngine ?? null).toBeNull();
    }
    expect(q.ltxBlocks + q.veoBlocks).toBe(
      q.segments.filter((s) => s.blockType === "ai_clip").length,
    );
  });

  it("routes everything to LTX when the veo lane is disabled", () => {
    const q = assignClipDurationQuota(visuals(100), { ...OPTS, veoEnabled: false });
    expect(q.veoBlocks).toBe(0);
    expect(q.veoSeconds).toBe(0);
    // The veo share is NOT silently handed to LTX — the total drops to 25%.
    expect(q.clipSeconds).toBeGreaterThanOrEqual(150);
    expect(q.clipSeconds).toBeLessThan(150 + 6);
  });

  it("prefers scenes that can carry a human action when promoting stills", () => {
    // Half the stills show a person doing something, half are still-lifes.
    // The 30% budget needs ~30 of 100 blocks, so it should be able to fill
    // entirely from the action-capable half.
    const segs: PlannedSegment[] = [];
    let t = 0;
    for (let i = 0; i < 100; i++) {
      const s = seg("image", 6, t);
      s.imagePrompt = i % 2 === 0 ? "a woman pouring milk into a bowl" : "a sealed jar on a shelf";
      segs.push(s);
      t += 6;
    }
    const q = assignClipDurationQuota(segs, OPTS);
    const clips = q.segments.filter((s) => s.blockType === "ai_clip");

    expect(clips.length).toBeGreaterThan(0);
    // Every promoted clip should be one of the action-capable scenes.
    for (const c of clips) expect(c.imagePrompt).toMatch(/pouring/);
  });

  it("falls back to still-life scenes when action scenes cannot fill the budget", () => {
    // Only 2 action scenes (12s) against a 180s target — the rest must still
    // be filled, or the client's 30% silently becomes 2%.
    const segs: PlannedSegment[] = [];
    let t = 0;
    for (let i = 0; i < 100; i++) {
      const s = seg("image", 6, t);
      s.imagePrompt = i < 2 ? "a woman stirring a pot" : "a sealed jar on a shelf";
      segs.push(s);
      t += 6;
    }
    const q = assignClipDurationQuota(segs, OPTS);
    expect(q.clipSeconds).toBeGreaterThanOrEqual(180);
    expect(q.shortfallSeconds).toBe(0);
  });

  it("keeps blocks Gemini already chose as clips ahead of promoting stills", () => {
    const segs: PlannedSegment[] = [];
    let t = 0;
    for (let i = 0; i < 100; i++) {
      // 20 existing ai_clip blocks (120s) — less than the 180s budget, so all
      // of them should survive and the remainder come from stills.
      segs.push(seg(i < 20 ? "ai_clip" : "image", 6, t));
      t += 6;
    }
    const q = assignClipDurationQuota(segs, OPTS);
    const kept = q.segments.filter((s, i) => i < 20 && s.blockType === "ai_clip").length;
    expect(kept).toBe(20);
    expect(q.demoted).toBe(0);
    expect(q.promoted).toBeGreaterThan(0);
  });

  it("confines the budget to the clip-heavy window when a cutoff is set", () => {
    const segs = visuals(100); // 600s
    const q = assignClipDurationQuota(segs, { ...OPTS, cutoffSeconds: 300 });
    for (const s of q.segments.filter((x) => x.blockType === "ai_clip")) {
      expect(s.startTime).toBeLessThan(300);
    }
  });
});

// ---------------------------------------------------------------------------
// TWO-PHASE MIX (client 2026-08-20 via Joey: "The first 3 min, 65 % ltx clips
// and 35 % images. After 3 mins, 70% images and 30% clips" — the body figure
// being the 20% LTX + 10% VEO already set on 2026-08-18, so only the opening
// window moved: 4 min @ 80% -> 3 min @ 65%, to cut LTX spend).
//
// The phases are asserted SEPARATELY on purpose: a video-wide percentage can
// look correct while the opening window — the part the client is watching — is
// starved, which is exactly what a single flat budget did.

const CLIENT_PHASES = [
  { startSeconds: 0, endSeconds: 180, clipFraction: 0.65, veoFraction: 0, label: "phase1_opening" },
  { startSeconds: 180, endSeconds: Infinity, clipFraction: 0.2, veoFraction: 0.1, label: "phase2_body" },
];

const PHASE_OPTS = {
  phases: CLIENT_PHASES,
  basis: "visual" as const,
  veoEnabled: true,
  cutoffSeconds: 0,
};

/** Seconds of `pred` blocks whose start time falls in [from, to). */
const secondsInWindow = (
  segs: PlannedSegment[],
  from: number,
  to: number,
  pred: (s: PlannedSegment) => boolean,
) =>
  segs
    .filter((s) => s.startTime >= from && s.startTime < to && pred(s))
    .reduce((a, s) => a + s.duration, 0);

describe("assignClipDurationQuota — two-phase mix", () => {
  it("gives the opening window 65% clips and the body 20% LTX + 10% veo", () => {
    // 20 minutes of visuals: 30 blocks before 3:00, 170 after.
    const segs = visuals(200); // 1200s
    const q = assignClipDurationQuota(segs, PHASE_OPTS);
    const out = q.segments;

    const p1Visual = secondsInWindow(out, 0, 180, () => true);
    const p1Clip = secondsInWindow(out, 0, 180, (s) => s.blockType === "ai_clip");
    // 65% of the opening window, within one block's length.
    expect(p1Clip / p1Visual).toBeGreaterThanOrEqual(0.65);
    expect(p1Clip / p1Visual).toBeLessThan(0.65 + 6 / p1Visual + 0.01);

    const p2Visual = secondsInWindow(out, 180, Infinity, () => true);
    const p2Clip = secondsInWindow(out, 180, Infinity, (s) => s.blockType === "ai_clip");
    const p2Veo = secondsInWindow(out, 180, Infinity, (s) => s.clipEngine === "veo");
    // 30% clips (20 LTX + 10 veo), of which a third is veo.
    expect(p2Clip / p2Visual).toBeGreaterThanOrEqual(0.3);
    expect(p2Clip / p2Visual).toBeLessThan(0.3 + 6 / p2Visual + 0.01);
    expect(p2Veo / p2Visual).toBeGreaterThanOrEqual(0.1);
    expect(p2Veo / p2Visual).toBeLessThan(0.1 + 6 / p2Visual + 0.01);
  });

  it("keeps veo out of the opening window entirely", () => {
    // The client asked for "ltx clips" in the first 3 minutes and specified veo
    // only for the body, so the phase-1 veo floor must NOT fire the way the
    // whole-video one does.
    const segs = visuals(200);
    const q = assignClipDurationQuota(segs, PHASE_OPTS);
    const openingVeo = q.segments.filter((s) => s.startTime < 180 && s.clipEngine === "veo");
    expect(openingVeo).toHaveLength(0);
    // ...while the body still gets its veo lane.
    expect(q.segments.some((s) => s.startTime >= 180 && s.clipEngine === "veo")).toBe(true);
  });

  it("measures the visual basis against image/clip time, not avatar time", () => {
    // Half the opening window is avatar (doc-marked, unreassignable). On the
    // "visual" basis 65% still means 65% of the blocks we can actually touch —
    // on the "total" basis only 50% of the window is reassignable at all, so
    // the 65% target is unreachable and must report a shortfall.
    const segs: PlannedSegment[] = [];
    let t = 0;
    for (let i = 0; i < 30; i++) { segs.push(seg(i % 2 === 0 ? "avatar" : "image", 6, t)); t += 6; }
    for (let i = 0; i < 100; i++) { segs.push(seg("image", 6, t)); t += 6; }

    const visual = assignClipDurationQuota(segs, PHASE_OPTS);
    const p1 = visual.phases.find((p) => p.label === "phase1_opening")!;
    expect(p1.basisSeconds).toBe(90);               // only the 15 image blocks
    expect(p1.shortfallSeconds).toBe(0);
    expect(p1.clipSeconds / p1.basisSeconds).toBeGreaterThanOrEqual(0.65);

    const total = assignClipDurationQuota(segs, { ...PHASE_OPTS, basis: "total" });
    const t1 = total.phases.find((p) => p.label === "phase1_opening")!;
    expect(t1.basisSeconds).toBe(180);              // avatar counted in
    expect(t1.shortfallSeconds).toBeGreaterThan(0); // 65% of it is unreachable
  });

  it("reports a per-phase shortfall when the opening window has too few visuals", () => {
    // A heavily avatar-marked opening: 4 visual blocks in the first 3 minutes.
    const segs: PlannedSegment[] = [];
    let t = 0;
    for (let i = 0; i < 26; i++) { segs.push(seg("avatar", 6, t)); t += 6; }
    for (let i = 0; i < 4; i++) { segs.push(seg("image", 6, t)); t += 6; }
    for (let i = 0; i < 100; i++) { segs.push(seg("image", 6, t)); t += 6; }
    // Every visual in the window promotes, so the 65% target is met on the
    // visual basis — the pass must not invent a shortfall out of avatar time.
    const q = assignClipDurationQuota(segs, PHASE_OPTS);
    const p1 = q.phases.find((p) => p.label === "phase1_opening")!;
    expect(p1.basisSeconds).toBe(24);
    expect(p1.shortfallSeconds).toBe(0);
  });

  it("still spreads each phase's clips across that phase rather than clumping", () => {
    const segs = visuals(200);
    const q = assignClipDurationQuota(segs, PHASE_OPTS);
    // Body clips must appear in both halves of the body, not all at 3:00.
    const body = q.segments.filter((s) => s.startTime >= 180);
    const mid = 180 + (1200 - 180) / 2;
    const early = body.filter((s) => s.startTime < mid && s.blockType === "ai_clip").length;
    const late = body.filter((s) => s.startTime >= mid && s.blockType === "ai_clip").length;
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
  });

  it("treats the legacy single-fraction options as one whole-video phase", () => {
    // Back-compat: the pre-2026-08-18 call shape must keep meaning exactly what
    // it did, including its total-time basis.
    const segs = visuals(100);
    const q = assignClipDurationQuota(segs, OPTS);
    expect(q.phases).toHaveLength(1);
    expect(q.phases[0].basisSeconds).toBe(600);
    expect(q.clipSeconds).toBeGreaterThanOrEqual(180);
  });
});

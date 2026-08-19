import { describe, it, expect } from "vitest";
import { sceneWords, sceneSimilarity, findRepeatedScenes } from "@/lib/synthetic/planner";

// WITHIN-VIDEO SCENE REPETITION (client 2026-08-19 via Joey: "for example the
// german video, it is showing spoons a lot, very similar images and similar
// footages. I want more variation").
//
// The detection has to fire on prompts a human would call "the same picture"
// while leaving genuinely different scenes of the same subject alone — a pass
// that flags everything would regenerate the whole plan and change nothing.

const BASE = "warm kitchen documentary style, natural light, shallow depth of field";

describe("sceneWords", () => {
  it("drops stopwords, prompt boilerplate and very short words", () => {
    const w = sceneWords("A close-up shot of the wooden spoon on a marble counter");
    expect(w.has("wooden")).toBe(true);
    expect(w.has("spoon")).toBe(true);
    expect(w.has("marble")).toBe(true);
    expect(w.has("counter")).toBe(true);
    // stopword / boilerplate / too short
    expect(w.has("the")).toBe(false);
    expect(w.has("close")).toBe(false);
    expect(w.has("shot")).toBe(false);
    expect(w.has("of")).toBe(false);
  });

  it("excludes the shared base-prompt vocabulary", () => {
    // Every prompt carries the base style, so counting it would make two
    // unrelated scenes look similar. This is why `exclude` exists.
    const base = sceneWords(BASE);
    const w = sceneWords(`${BASE}. A cast iron pan on a stove`, base);
    expect(w.has("kitchen")).toBe(false);
    expect(w.has("documentary")).toBe(false);
    expect(w.has("cast")).toBe(true);
    expect(w.has("iron")).toBe(true);
    expect(w.has("stove")).toBe(true);
  });
});

describe("sceneSimilarity", () => {
  it("scores reworded versions of the same picture as similar", () => {
    const a = sceneWords("close-up of a wooden spoon resting on a marble counter");
    const b = sceneWords("a wooden spoon on a marble countertop, close up");
    expect(sceneSimilarity(a, b)).toBeGreaterThanOrEqual(0.5);
  });

  it("scores different scenes of the same subject as dissimilar", () => {
    // Both are about spoons — a subject-only match must NOT be enough, or the
    // pass would regenerate every block of a spoon script.
    const a = sceneWords("a wooden spoon resting on a marble counter");
    const b = sceneWords("a factory worker stamping metal spoons from a press");
    expect(sceneSimilarity(a, b)).toBeLessThan(0.5);
  });

  it("returns 0 when either side has no content words", () => {
    expect(sceneSimilarity(new Set(), sceneWords("a wooden spoon"))).toBe(0);
  });
});

describe("findRepeatedScenes", () => {
  const OPTS = { basePrompt: BASE, similarity: 0.5, window: 40, maxRegen: 80 };

  it("flags the later duplicates and keeps the first occurrence", () => {
    const scenes = [
      "a wooden spoon resting on a marble counter",
      "a busy factory floor with stamping presses",
      "a wooden spoon on a marble countertop",       // dup of 0
      "a wooden spoon lying on marble counter top",  // dup of 0
    ];
    const { repeats, flaggedTotal } = findRepeatedScenes(scenes, OPTS);
    expect(flaggedTotal).toBe(2);
    expect(repeats.map((r) => r.index)).toEqual([2, 3]);
    // The first occurrence is the anchor and is never regenerated.
    expect(repeats.every((r) => r.anchor === 0)).toBe(true);
    expect(repeats[0].avoid).toContain(scenes[0]);
  });

  it("does not chain duplicates off a scene that is being replaced", () => {
    // Block 2 duplicates block 0 and is flagged. Block 3 must anchor on block 0
    // too — anchoring on 2 would de-duplicate against a prompt that is about to
    // be thrown away.
    const scenes = [
      "a wooden spoon resting on a marble counter",
      "a wooden spoon on a marble countertop",
      "a wooden spoon lying on the marble counter",
    ];
    const { repeats } = findRepeatedScenes(scenes, OPTS);
    expect(repeats).toHaveLength(2);
    expect(repeats.every((r) => r.anchor === 0)).toBe(true);
  });

  it("leaves genuinely varied scenes alone", () => {
    const scenes = [
      "a wooden spoon resting on a marble counter",
      "a factory worker stamping metal spoons from a press",
      "an antique silver spoon in a museum display case",
      "a child eating soup with a plastic spoon",
    ];
    const { repeats, flaggedTotal } = findRepeatedScenes(scenes, OPTS);
    expect(flaggedTotal).toBe(0);
    expect(repeats).toHaveLength(0);
  });

  it("skips avatar blocks, which carry no scene", () => {
    const scenes = [
      "a wooden spoon resting on a marble counter",
      null,
      null,
      "a wooden spoon on a marble countertop",
    ];
    const { repeats } = findRepeatedScenes(scenes, OPTS);
    expect(repeats.map((r) => r.index)).toEqual([3]);
  });

  it("only compares within the window of recent visuals", () => {
    // The same scene twenty blocks apart is a repeat; a hundred blocks apart is
    // a callback the viewer has long forgotten.
    // Each filler needs its own vocabulary — fillers built from a shared
    // template would themselves trip the detector and mask what is being tested.
    const filler = Array.from(
      { length: 100 },
      (_, i) => `alpha${i} bravo${i} charlie${i} delta${i} echo${i}`,
    );
    const scenes = ["a wooden spoon resting on a marble counter", ...filler, "a wooden spoon on a marble countertop"];
    expect(findRepeatedScenes(scenes, { ...OPTS, window: 40 }).repeats).toHaveLength(0);
    // ...and with the window lifted it IS caught.
    expect(findRepeatedScenes(scenes, { ...OPTS, window: 0 }).repeats).toHaveLength(1);
  });

  it("caps regenerations but still reports the true count", () => {
    // An extremely repetitive script must not turn planning into hundreds of
    // Gemini calls — but the overflow has to be visible, not silently dropped.
    const scenes = Array.from({ length: 30 }, () => "a wooden spoon on a marble counter");
    const { repeats, flaggedTotal } = findRepeatedScenes(scenes, { ...OPTS, maxRegen: 5 });
    expect(repeats).toHaveLength(5);
    expect(flaggedTotal).toBe(29); // all but the first occurrence
  });

  it("groups repeats by anchor so each chain can de-duplicate against itself", () => {
    const scenes = [
      "a wooden spoon resting on a marble counter",
      "a factory worker stamping metal spoons from a press",
      "a wooden spoon on a marble countertop",              // anchor 0
      "a factory worker stamping metal spoons at a press",  // anchor 1
      "a wooden spoon lying on the marble counter",         // anchor 0
    ];
    const { repeats } = findRepeatedScenes(scenes, OPTS);
    const anchors = new Set(repeats.map((r) => r.anchor));
    expect(anchors).toEqual(new Set([0, 1]));
    expect(repeats.filter((r) => r.anchor === 0)).toHaveLength(2);
  });

  it("ignores prompts with too little distinctive vocabulary to judge", () => {
    const scenes = ["the shot", "the shot", "a wooden spoon on a marble counter"];
    const { repeats } = findRepeatedScenes(scenes, OPTS);
    expect(repeats).toHaveLength(0);
  });
});

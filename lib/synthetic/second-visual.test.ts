import { describe, it, expect } from "vitest";
import { splitByDuration } from "@/lib/synthetic/planner";
import type { PlannedSegment } from "@/lib/synthetic/planner";

// A long sentence is covered by two visuals. The second one is supposed to be a
// genuinely DIFFERENT picture -- but the code took Gemini's imagePrompt2 on
// trust, and Gemini sometimes returns it identical to the first.
//
// Measured 2026-08-26 on a live post-deploy plan: blocks #202/#203, #304/#305
// and #407/#408 carried byte-identical prompts, i.e. the same shot rendered
// twice in a row, three times in one video.
function seg(over: Partial<PlannedSegment>): PlannedSegment {
  return {
    position: 0,
    blockType: "image",
    startTime: 0,
    endTime: 12,
    duration: 12,
    script: "a long sentence that needs two visuals to cover it",
    imagePrompt: "close-up of a digital kitchen scale with a cooked turkey portion on it",
    animationPrompt: null,
    ...over,
  } as PlannedSegment;
}

describe("splitByDuration — the second visual", () => {
  it("uses imagePrompt2 when it is a genuinely different picture", () => {
    const pieces = splitByDuration(seg({ imagePrompt2: "wide shot of a supermarket meat aisle with shoppers passing" }), 6, 5);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[1].imagePrompt).toContain("supermarket meat aisle");
    // Taken as-is, so no different-angle nudge is needed.
    expect(pieces[1].secondVisual).toBe(false);
  });

  it("REJECTS an imagePrompt2 identical to the first and falls back to regeneration", () => {
    const first = "close-up of a digital kitchen scale with a cooked turkey portion on it";
    const pieces = splitByDuration(seg({ imagePrompt: first, imagePrompt2: first }), 6, 5);
    expect(pieces.length).toBeGreaterThan(1);
    // secondVisual:true is the path that adds the different-angle nudge and lets
    // the distinct-scene pass regenerate it -- the whole point of the guard.
    expect(pieces[1].secondVisual).toBe(true);
    expect(pieces[1].imagePrompt).toBe(first);
  });

  it("REJECTS a near-identical imagePrompt2 (reworded, same scene)", () => {
    const pieces = splitByDuration(
      seg({
        imagePrompt: "close-up of a digital kitchen scale with a cooked turkey portion on it",
        imagePrompt2: "close-up of a digital kitchen scale showing a cooked turkey portion on it",
      }), 6, 5);
    expect(pieces[1].secondVisual).toBe(true);
  });

  it("falls back to regeneration when imagePrompt2 is missing", () => {
    const pieces = splitByDuration(seg({ imagePrompt2: undefined }), 6, 5);
    expect(pieces[1].secondVisual).toBe(true);
  });
});

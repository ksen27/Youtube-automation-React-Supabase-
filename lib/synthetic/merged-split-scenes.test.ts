import { describe, it, expect } from "vitest";
import { splitMergedVisuals } from "@/lib/synthetic/planner";
import type { PlannedSegment } from "@/lib/synthetic/planner";

// A MERGED visual block that is re-split into N slots must show N DIFFERENT
// things, the same way splitByDuration does (d59a222).
//
// Client "Joey", 2026-09-03, second round: a fridge sentence still rendered as
// four framings of one open fridge AFTER the splitByDuration fix shipped. The
// blocks he was looking at came from this function, which was left on the old
// `secondVisual: k > 0` behaviour -- every slot after the first reused slot 1's
// prompt with a "different angle" nudge.
//
// The distinct-scene rescue pass could not save them either: it groups slots
// into runs by IDENTICAL script, and a merged block carries the COMBINED script
// of both sentences it absorbed, so the merged slots never joined the un-merged
// slots' run.
function merged(over: Partial<PlannedSegment>): PlannedSegment {
  return {
    position: 0,
    blockType: "image",
    startTime: 0,
    endTime: 16,
    duration: 16,
    needsPromptRegen: true,
    script: "the refrigerator became the default place to store everything, and today I will show you fifteen foods that should not be in there",
    imagePrompt: "a wide shot of a kitchen with a large modern refrigerator as a focal point",
    animationPrompt: null,
    ...over,
  } as PlannedSegment;
}

describe("splitMergedVisuals — a scene per slot", () => {
  it("walks imagePrompt2 then extraScenes instead of re-framing slot 1", () => {
    const { segments } = splitMergedVisuals(
      [
        merged({
          imagePrompt2: "fresh tomatoes and greens resting in a wooden bowl on a counter",
          extraScenes: [
            { imagePrompt: "a woman leaning into an open fridge, deciding what to take out", shotType: "medium shot" },
            { imagePrompt: "cured meat and cheese wrapped in paper on a cool pantry shelf", shotType: "close-up" },
          ],
        }),
      ],
      4,
      8,
    );

    expect(segments.length).toBe(4);
    // Slot 1 keeps the merged block's own (regenerated, combined) prompt.
    expect(segments[0].imagePrompt).toContain("focal point");
    expect(segments[1].imagePrompt).toContain("wooden bowl");
    expect(segments[2].imagePrompt).toContain("deciding what to take out");
    expect(segments[3].imagePrompt).toContain("cool pantry shelf");
    // Having taken a real scene, no slot needs the angle-nudge fallback.
    expect(segments.every((s) => !s.secondVisual)).toBe(true);
  });

  it("every slot shows a different scene", () => {
    const { segments } = splitMergedVisuals(
      [
        merged({
          imagePrompt2: "fresh tomatoes and greens resting in a wooden bowl on a counter",
          extraScenes: [
            { imagePrompt: "a woman leaning into an open fridge, deciding what to take out", shotType: "medium shot" },
            { imagePrompt: "cured meat and cheese wrapped in paper on a cool pantry shelf", shotType: "close-up" },
          ],
        }),
      ],
      4,
      8,
    );
    const prompts = segments.map((s) => s.imagePrompt);
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it("falls back to secondVisual when a scene merely rewords an earlier one", () => {
    // The exact failure from the client's screenshot: two prompts that are the
    // same picture in different words. Better to regenerate than ship a clone.
    const { segments } = splitMergedVisuals(
      [
        merged({
          imagePrompt: "a person opening a full brightly lit refrigerator revealing food on shelves and in drawers",
          imagePrompt2: "a person opening a full brightly lit refrigerator revealing food on shelves and in drawers",
        }),
      ],
      4,
      8,
    );
    expect(segments[1].secondVisual).toBe(true);
  });

  it("falls back to secondVisual when the planner wrote no extra scenes", () => {
    const { segments } = splitMergedVisuals([merged({})], 4, 8);
    expect(segments.length).toBe(4);
    expect(segments.slice(1).every((s) => s.secondVisual)).toBe(true);
  });

  it("leaves a block it did not merge alone", () => {
    const { segments, split } = splitMergedVisuals([merged({ needsPromptRegen: false })], 4, 8);
    expect(split).toBe(0);
    expect(segments.length).toBe(1);
  });
});

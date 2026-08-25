import { describe, it, expect } from "vitest";
import { sanitizeBasePrompt } from "@/lib/synthetic/planner";

// The basePrompt is appended to EVERY visual block ("... Setting: <base>."), so
// a clause that names a subject, an action or a framing is rendered once per
// block -- ~200 times in a 20-minute video. Client 2026-08-25, Loom: "the
// footage is so repetitive ... constantly someone holding a computer on a
// mountain. It doesn't make sense." One bad clause, two hundred bad shots.
describe("sanitizeBasePrompt", () => {
  it("keeps a well-formed world untouched", () => {
    const base = "a rural family kitchen and the small homestead around it, present day, warm and ordinary";
    const { cleaned, dropped } = sanitizeBasePrompt(base);
    expect(cleaned).toBe(base);
    expect(dropped).toEqual([]);
  });

  it("drops a person-with-an-action clause but keeps the world", () => {
    // The reported failure, in the shape the planner emits it.
    const { cleaned, dropped } = sanitizeBasePrompt(
      "a remote mountainside, overcast daylight, a man holding a laptop computer",
    );
    expect(cleaned).toBe("a remote mountainside, overcast daylight");
    expect(dropped).toEqual(["a man holding a laptop computer"]);
  });

  it("drops a baked-in camera framing", () => {
    const { cleaned, dropped } = sanitizeBasePrompt(
      "a cluttered garage workshop, close-up of the workbench, evening light",
    );
    expect(cleaned).toBe("a cluttered garage workshop, evening light");
    expect(dropped).toEqual(["close-up of the workbench"]);
  });

  it("drops several offending clauses at once", () => {
    const { cleaned, dropped } = sanitizeBasePrompt(
      "a coastal fishing village, 1970s, a woman standing on the dock, wide shot",
    );
    expect(cleaned).toBe("a coastal fishing village, 1970s");
    expect(dropped).toHaveLength(2);
  });

  it("cleans an entirely-poison base to empty rather than passing it through", () => {
    // Empty is SAFE: composePrompt then returns the block's own scene, so each
    // shot stands on its own instead of inheriting a bad world.
    const { cleaned } = sanitizeBasePrompt("a man holding a computer on a mountain");
    expect(cleaned).toBe("");
  });

  it("handles empty and null input", () => {
    expect(sanitizeBasePrompt("").cleaned).toBe("");
    expect(sanitizeBasePrompt(null).cleaned).toBe("");
    expect(sanitizeBasePrompt(undefined).cleaned).toBe("");
  });

  it("does not split on periods inside a single-sentence base", () => {
    const base = "a quiet suburban street in the U.S. midwest, late autumn";
    expect(sanitizeBasePrompt(base).cleaned).toBe(base);
  });

  it("keeps setting nouns that merely mention people generically", () => {
    // "family kitchen" and "village" are places, not subjects pinned in frame.
    const base = "a family kitchen in a small village, present day, soft daylight";
    expect(sanitizeBasePrompt(base).cleaned).toBe(base);
  });
});

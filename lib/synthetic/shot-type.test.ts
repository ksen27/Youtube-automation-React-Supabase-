import { describe, expect, it } from "vitest";
import { composePrompt, normalizeShotType } from "./planner";

// shotType is free text in the planner's JSON and composePrompt puts it in
// FRONT of the scene. Measured 2026-08-26 on a Mount Sinai plan, two blocks
// came back with shotType "aerial views of Mount Sinai" — lifted from the
// derived topic's environmentExamples — and composed to "aerial views of Mount
// Sinai: A clear, sunny aerial view of Mount Sinai...". Only a recognised
// framing may lead the prompt.

describe("normalizeShotType", () => {
  it("accepts every canonical framing", () => {
    for (const t of [
      "extreme close-up / macro detail",
      "close-up",
      "medium shot",
      "wide / establishing shot",
      "top-down (overhead) shot",
      "low-angle ground-level shot",
      "over-the-shoulder shot",
      "product shot",
    ]) {
      expect(normalizeShotType(t)).toBe(t);
    }
  });

  it("strips the explanatory parenthetical the prompt lists", () => {
    expect(normalizeShotType("product shot (an object presented on a surface)")).toBe("product shot");
  });

  it("is case- and punctuation-insensitive", () => {
    expect(normalizeShotType("  Medium Shot: ")).toBe("medium shot");
  });

  it("rejects an environmentExamples phrase leaking into shotType", () => {
    expect(normalizeShotType("aerial views of Mount Sinai")).toBeNull();
    expect(normalizeShotType("researchers studying data")).toBeNull();
  });

  it("rejects empty and nullish values", () => {
    expect(normalizeShotType("")).toBeNull();
    expect(normalizeShotType(null)).toBeNull();
    expect(normalizeShotType(undefined)).toBeNull();
  });
});

describe("composePrompt shot-type guard", () => {
  it("leads with a recognised framing", () => {
    expect(composePrompt("a desert site", "a radar unit on the sand", "medium shot"))
      .toBe("medium shot: a radar unit on the sand. Setting: a desert site.");
  });

  it("drops an unrecognised framing instead of prefixing it", () => {
    expect(composePrompt("a desert site", "a radar unit on the sand", "aerial views of Mount Sinai"))
      .toBe("a radar unit on the sand. Setting: a desert site.");
  });
});

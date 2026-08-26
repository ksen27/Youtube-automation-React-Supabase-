import { describe, expect, it } from "vitest";
import { blockNamesItsOwnPlace, composePrompt } from "./planner";

// When a block names a place of its own, composePrompt must NOT append the
// video's recurring world, or the prompt carries two contradictory locations.
//
// The detector used to require a preposition-first shape (in/at/on + article +
// <=1 word + noun). These fixtures are taken verbatim from a live plan where
// that shape missed and the contradiction shipped.

const ARMORY = "a collector's private armory, present day, well-lit and organized";

describe("blockNamesItsOwnPlace", () => {
  it("catches a place named BEFORE its preposition", () => {
    // Shipped as "... a rural driveway in the background. Setting: a
    // collector's private armory." — three place mentions, none detected.
    expect(blockNamesItsOwnPlace(
      "medium shot: a man standing beside an open truck bed, carefully lifting a long, wrapped object into the truck, a rural driveway in the background",
    )).toBe(true);
  });

  it('catches "beside" and "into", which are not in any preposition list', () => {
    expect(blockNamesItsOwnPlace("a person standing beside an open tailgate")).toBe(true);
    expect(blockNamesItsOwnPlace("lifting a wrapped object into the truck")).toBe(true);
  });

  it("still catches the preposition-first phrasings it always did", () => {
    expect(blockNamesItsOwnPlace("a person driving on a rural highway, looking at the road")).toBe(true);
    expect(blockNamesItsOwnPlace("hands working in the kitchen")).toBe(true);
  });

  it("catches the workbench and boardroom scenes this script is full of", () => {
    expect(blockNamesItsOwnPlace("a person at a workbench assembling parts")).toBe(true);
    expect(blockNamesItsOwnPlace("legal documents on a polished boardroom table")).toBe(true);
    expect(blockNamesItsOwnPlace("a person browsing at an estate sale")).toBe(true);
  });

  it("is false for a scene with no place at all", () => {
    // A bare object study genuinely has nowhere — it SHOULD receive the world.
    expect(blockNamesItsOwnPlace("close-up: the worn wooden stock and dark metal of an old rifle")).toBe(false);
    expect(blockNamesItsOwnPlace("extreme close-up: a stamped serial number, light raking across the metal")).toBe(false);
    expect(blockNamesItsOwnPlace("")).toBe(false);
    expect(blockNamesItsOwnPlace(null)).toBe(false);
  });
});

describe("composePrompt with the recurring world", () => {
  it("does NOT append a contradictory world to a scene that has its own place", () => {
    const block = "a man standing beside an open truck bed, a rural driveway in the background";
    const out = composePrompt(ARMORY, block, "medium shot");
    expect(out).not.toMatch(/Setting:/);
    expect(out).toBe(`medium shot: ${block}`);
  });

  it("still appends the world to a placeless object study", () => {
    const block = "the worn wooden stock and dark metal of an old rifle";
    const out = composePrompt(ARMORY, block, "close-up");
    expect(out).toBe(`close-up: ${block}. Setting: ${ARMORY}.`);
  });
});

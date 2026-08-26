import { describe, expect, it } from "vitest";
import {
  characterScenePrompt,
  personalVoiceScore,
  selectCharacterBlocks,
  type CharacterCandidate,
} from "./character-blocks";

// The client asked for the narrating avatar to appear as a character in a few
// shots — "all clip is not related to the avatar and show the small count".
// These tests pin the SMALLNESS and the eligibility rules, because a regression
// toward "most blocks" would rebuild the same-person-every-frame repetition
// that sanitizeBasePrompt exists to prevent.

const person = (script: string, blockType: CharacterCandidate["blockType"] = "image"): CharacterCandidate => ({
  blockType,
  script,
  imagePrompt: "medium shot: a person at a workbench fitting a part",
});
const noPerson = (script: string): CharacterCandidate => ({
  blockType: "image",
  script,
  imagePrompt: "close-up: a worn metal receiver resting on a bench",
});

describe("personalVoiceScore", () => {
  it("ranks first-person singular highest", () => {
    expect(personalVoiceScore("I paid eight hundred for it.")).toBe(3);
    expect(personalVoiceScore("That was my first mistake.")).toBe(3);
  });

  it("ranks first-person plural next", () => {
    expect(personalVoiceScore("Let us be clear about that.")).toBe(2);
    expect(personalVoiceScore("We expected to find geology.")).toBe(2);
  });

  it("ranks direct address lowest but non-zero", () => {
    expect(personalVoiceScore("Check it before you price it.")).toBe(1);
  });

  it("scores impersonal narration zero", () => {
    expect(personalVoiceScore("Winchester was sold.")).toBe(0);
    expect(personalVoiceScore("The rifle underneath it did.")).toBe(0);
    expect(personalVoiceScore("")).toBe(0);
    expect(personalVoiceScore(null)).toBe(0);
  });
});

describe("selectCharacterBlocks", () => {
  it("never exceeds the max", () => {
    const blocks = Array.from({ length: 60 }, () => person("I remember that day."));
    expect(selectCharacterBlocks(blocks, { max: 4 })).toHaveLength(4);
  });

  it("returns nothing when the max is zero (feature off)", () => {
    const blocks = Array.from({ length: 20 }, () => person("I remember that day."));
    expect(selectCharacterBlocks(blocks, { max: 0 })).toEqual([]);
  });

  it("skips scenes with no person in them", () => {
    // Personal narration, but the planned picture is an object on a bench —
    // dropping a face into it would be wrong.
    const blocks = [noPerson("I paid eight hundred for it."), noPerson("Let us be clear.")];
    expect(selectCharacterBlocks(blocks, { max: 4 })).toEqual([]);
  });

  it("skips impersonal narration even when a person is in the scene", () => {
    const blocks = [person("Winchester was sold."), person("The consolidations.")];
    expect(selectCharacterBlocks(blocks, { max: 4 })).toEqual([]);
  });

  it("never picks avatar or split_2 blocks — they already show the real face", () => {
    const blocks = [person("I remember it.", "avatar"), person("I remember it.", "split_2")];
    expect(selectCharacterBlocks(blocks, { max: 4 })).toEqual([]);
  });

  it("prefers the most personal lines over merely the earliest", () => {
    const blocks = [
      person("Check it before you price it."), // score 1, index 0
      ...Array.from({ length: 20 }, () => noPerson("filler")),
      person("I drove four hours to get there."), // score 3, index 21
    ];
    expect(selectCharacterBlocks(blocks, { max: 1 })).toEqual([21]);
  });

  it("spreads picks apart instead of clustering them", () => {
    const blocks = Array.from({ length: 100 }, () => person("I remember that day."));
    const picked = selectCharacterBlocks(blocks, { max: 4 });
    expect(picked).toHaveLength(4);
    for (let i = 1; i < picked.length; i++) {
      expect(picked[i] - picked[i - 1]).toBeGreaterThanOrEqual(8);
    }
  });

  it("returns ascending indices", () => {
    const blocks = Array.from({ length: 100 }, (_, i) =>
      person(i % 2 === 0 ? "I remember that day." : "Check it before you price it."),
    );
    const picked = selectCharacterBlocks(blocks, { max: 4 });
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });

  it("handles an empty plan", () => {
    expect(selectCharacterBlocks([], { max: 4 })).toEqual([]);
  });
});

describe("characterScenePrompt", () => {
  it("keeps the scene description intact after the identity preamble", () => {
    const scene = "medium shot: a person at the wheel of a pickup truck on a highway";
    const out = characterScenePrompt(scene);
    expect(out).toContain(scene);
    expect(out).toMatch(/reference photograph/i);
    // The scene must come LAST — it is what makes the shot match the narration.
    expect(out.indexOf(scene)).toBeGreaterThan(out.indexOf("reference photograph"));
  });

  it("forbids inventing extra people", () => {
    expect(characterScenePrompt("a scene")).toMatch(/do not add any other people/i);
  });
});

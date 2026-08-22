import { describe, expect, it } from "vitest";
import {
  AMBIENT_MOTION_ANIMATION_PROMPT,
  resolveAnimationPrompt,
  sceneHasPerson,
} from "@/lib/synthetic/clip-motion";
import { DEFAULT_ACTION_ANIMATION_PROMPT } from "@/lib/synthetic/constants";

describe("sceneHasPerson", () => {
  it("detects a person named directly", () => {
    expect(sceneHasPerson("a woman kneeling beside a river")).toBe(true);
    expect(sceneHasPerson("close-up: a researcher checking a camera trap")).toBe(true);
  });

  it("detects a person shown only as a body part", () => {
    // The bug case in reverse: "a hand reaching into a drawer" never says
    // "person" but unmistakably shows one, and animating it is correct.
    expect(sceneHasPerson("close-up: a hand reaching into a drawer")).toBe(true);
    expect(sceneHasPerson("fingers tracing the bark of a tree")).toBe(true);
  });

  it("returns false for the scenes that caused the hallucinated hands", () => {
    // Verbatim shapes from the 2026-08-22 project where every clip grew hands.
    expect(sceneHasPerson("close-up: A single, large, intricately woven spider web, glistening with dew drops")).toBe(false);
    expect(sceneHasPerson("close-up: A large spider's dark brown, textured exoskeleton, showing fine hairs")).toBe(false);
    expect(sceneHasPerson("dense rainforest canopy at dawn, mist between the trees")).toBe(false);
  });

  it("treats empty input as person-less", () => {
    expect(sceneHasPerson("")).toBe(false);
    expect(sceneHasPerson(null)).toBe(false);
    expect(sceneHasPerson(undefined)).toBe(false);
  });
});

describe("resolveAnimationPrompt", () => {
  it("always prefers a stored prompt, whatever the scene", () => {
    // Stored prompts are operator-editable on the review screen; overriding one
    // would make that screen lie about what will render.
    const r = resolveAnimationPrompt("she pours the milk into the bowl", "a spider web");
    expect(r.source).toBe("stored");
    expect(r.prompt).toBe("she pours the milk into the bowl");
  });

  it("uses the human-action default when the still shows a person", () => {
    const r = resolveAnimationPrompt(null, "close-up: a hand opening an old jewelry box");
    expect(r.source).toBe("action_default");
    expect(r.prompt).toBe(DEFAULT_ACTION_ANIMATION_PROMPT);
  });

  it("uses ambient motion when the still has no person", () => {
    const r = resolveAnimationPrompt(null, "close-up: silken strands of a large spider web");
    expect(r.source).toBe("ambient_default");
    expect(r.prompt).toBe(AMBIENT_MOTION_ANIMATION_PROMPT);
  });

  it("treats a whitespace-only stored prompt as absent", () => {
    const r = resolveAnimationPrompt("   ", "dense jungle canopy");
    expect(r.source).toBe("ambient_default");
  });

  it("forbids body parts entering a person-less scene", () => {
    // The instruction that actually stops the hallucination -- if this wording
    // is ever softened, the hands come back.
    expect(AMBIENT_MOTION_ANIMATION_PROMPT).toMatch(/NO PEOPLE APPEAR/);
    expect(AMBIENT_MOTION_ANIMATION_PROMPT).toMatch(/no hands, fingers, arms/);
  });
});

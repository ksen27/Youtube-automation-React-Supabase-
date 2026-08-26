import { describe, it, expect } from "vitest";
import { describesCameraMove } from "@/lib/synthetic/planner";

// Client 2026-08-26: "not just guns that rotate like this."
//
// Caught in our own test output the same day: asked for the motion of a line
// with no action in it, the model answered "the camera slowly rotates around the
// Luger pistol" -- despite the prompt saying "the CAMERA IS LOCKED OFF and NEVER
// MOVES". Prompt text alone did not hold, so the answer is checked.
describe("describesCameraMove", () => {
  it("rejects the answer that actually shipped", () => {
    expect(describesCameraMove("the camera slowly rotates around the Luger pistol")).toBe(true);
  });

  it("rejects camera moves of every common shape", () => {
    for (const s of [
      "the camera pans across the workbench",
      "camera slowly zooms in on the label",
      "a slow push-in on the receiver",
      "the camera tracks alongside the truck",
      "an orbiting shot of the pistol",
      "the frame circles around the mug",
      "camera drifts to the left",
      // The exact answer that slipped past the first version of this guard:
      // adverbs stacked between "camera" and the verb.
      "the camera slowly and smoothly pans across the length of the pistol, revealing its details",
      "the camera gently and steadily glides toward the workbench",
    ]) {
      expect(describesCameraMove(s), s).toBe(true);
    }
  });

  it("rejects the subject spinning on the spot (the turntable)", () => {
    for (const s of [
      "the pistol rotates slowly on a turntable",
      "the package spins in place on the counter",
      "the mug revolves on the spot",
    ]) {
      expect(describesCameraMove(s), s).toBe(true);
    }
  });

  it("keeps real subject motion, including things that legitimately turn", () => {
    for (const s of [
      "a man lifts a large cardboard box and places it into the back of a pickup truck",
      "the person's hands fit two firearm parts together at a workbench",
      "steam rises from the roasting tin",
      "he turns the page of the notebook",
      "she turns the key in the lock",
      "the mill wheel turns as water pours over it",
      "a hand slides a handgun across the counter",
    ]) {
      expect(describesCameraMove(s), s).toBe(false);
    }
  });

  it("is safe on empty input", () => {
    expect(describesCameraMove("")).toBe(false);
    expect(describesCameraMove(null)).toBe(false);
    expect(describesCameraMove(undefined)).toBe(false);
  });
});

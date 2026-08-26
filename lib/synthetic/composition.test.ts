import { describe, it, expect } from "vitest";
import { compositionSignature, findRepeatedCompositions } from "@/lib/synthetic/planner";

// THE CASE THIS EXISTS FOR (client 2026-08-26, five CONSECUTIVE live blocks).
// All five are "a person's hand + a ground turkey package + a label", worded
// five different ways. Their pairwise CONTENT-WORD overlap is 0.24-0.52, so the
// scene-dedupe pass misses every pair at 0.70 and at 0.55 alike — you would need
// ~0.25 to catch them, which would flag nearly every block in the video.
const FIVE = [
  "close-up: A close-up of the back panel of a ground turkey package, showing a short, simple list of ingredients, held in a person's hand in a supermarket meat aisle. Setting: A brightly lit, clean supermarket meat aisle and a sterile food laboratory.",
  "close-up: A person's hand pointing to a small, almost blank white label on the back of a generic ground turkey package in a supermarket meat aisle, emphasizing the simplicity and lack of information. Setting: A brightly lit, clean supermarket meat aisle and a sterile food laboratory.",
  "close-up: A person's hand holding a generic ground turkey package, with the back panel facing the camera, showing a sparse, almost blank white label, in a supermarket meat aisle. Setting: A brightly lit, clean supermarket meat aisle and a sterile food laboratory.",
  "close-up: A person at home, holding a package of ground turkey and looking at the label, with kitchen counter in the background. Setting: A brightly lit, clean supermarket meat aisle and a sterile food laboratory.",
  "close-up: A person's hand pointing to the nutritional information label on a package of ground turkey, the text in focus, on a supermarket shelf. Setting: A brightly lit, clean supermarket meat aisle and a sterile food laboratory.",
];

describe("compositionSignature", () => {
  it("ignores the appended world and the shot-type prefix", () => {
    const a = compositionSignature("close-up: a rusted lever on a workbench. Setting: a quiet rural garage, present day.");
    const b = compositionSignature("wide shot: a rusted lever on a workbench. Setting: a busy city depot at night.");
    // Same subject, different framing and different world -> same signature.
    expect(a).toBe(b);
  });

  it("separates shots with a body in frame from shots without one", () => {
    const withBody = compositionSignature("a woman lifting a crate onto a shelf");
    const without = compositionSignature("a crate resting on a shelf");
    expect(withBody.startsWith("body|")).toBe(true);
    expect(without.startsWith("nobody|")).toBe(true);
    expect(withBody).not.toBe(without);
  });

  it("returns empty for an empty prompt", () => {
    expect(compositionSignature("")).toBe("");
    expect(compositionSignature(null)).toBe("");
  });
});

describe("findRepeatedCompositions", () => {
  it("catches the five real blocks that word overlap could not", () => {
    const { repeats, flaggedTotal } = findRepeatedCompositions(FIVE, { window: 40, maxRegen: 100 });
    // #1 establishes the composition; #2-#5 all repeat it.
    expect(flaggedTotal).toBe(4);
    expect(repeats.length).toBe(4);
    // Never flags the first occurrence.
    expect(repeats.every((r) => r.index > 0)).toBe(true);
    // Each flagged block points back at the earlier shot it duplicates.
    for (const r of repeats) expect(r.anchor).toBeLessThan(r.index);
  });

  it("leaves genuinely different pictures alone", () => {
    const varied = [
      "a ground turkey package on a supermarket shelf beside its price tag",
      "a laboratory technician weighing a sample on a digital balance",
      "a cast-iron skillet with browned mince on a home stove",
      "a printed receipt on a kitchen table showing a long list of prices",
      "a refrigerated display case filled with meat trays",
    ];
    const { flaggedTotal } = findRepeatedCompositions(varied, { window: 40, maxRegen: 100 });
    expect(flaggedTotal).toBe(0);
  });

  it("respects the window — a repeat far later is not flagged", () => {
    // The filler must be genuinely varied: an earlier version of this test used
    // eight near-identical "unrelated scene number N" strings, which the detector
    // correctly flagged as repeats of each other. The fixture was wrong, not the
    // detector.
    const filler = [
      "a rusted tractor abandoned in a field of long grass",
      "a harbour at dawn with fishing boats tied along the dock",
      "an attic full of cardboard boxes under a bare bulb",
      "a mountain trail switchbacking above the treeline",
      "a printing press running sheets through steel rollers",
      "a beekeeper's smoker resting on a wooden hive lid",
      "a laundromat row of dryers spinning behind glass",
      "a chalkboard covered in half-erased equations",
    ];
    const scenes = [FIVE[0], ...filler, FIVE[2]];
    const near = findRepeatedCompositions(scenes, { window: 40, maxRegen: 100 });
    const far = findRepeatedCompositions(scenes, { window: 2, maxRegen: 100 });
    expect(near.flaggedTotal).toBe(1);
    expect(far.flaggedTotal).toBe(0);
  });

  it("honours maxRegen while still reporting the true total", () => {
    const { repeats, flaggedTotal } = findRepeatedCompositions(FIVE, { window: 40, maxRegen: 1 });
    expect(repeats.length).toBe(1);
    expect(flaggedTotal).toBeGreaterThan(1);
  });
});

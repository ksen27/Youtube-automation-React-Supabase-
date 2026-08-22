import { describe, it, expect } from "vitest";
import { softenImagePrompt, hasDepictionRisk } from "@/lib/synthetic/safe-depiction";

// The prompt 69labs actually refused (2026-08-21, cat-behaviour video). Kept
// verbatim as the canonical regression case: whatever else changes, THIS must
// come out generatable.
const REFUSED =
  "medium shot: A human squirting a cat with a water bottle, and the cat " +
  "flinching and looking startled and confused. Setting: A cozy, lived-in home " +
  "living space, filled with natural light, creating a warm and inviting atmosphere.";

describe("softenImagePrompt — the refused prompt", () => {
  const out = softenImagePrompt(REFUSED);

  it("removes the act and keeps the instrument as a prop", () => {
    expect(out.changed).toBe(true);
    expect(out.prompt).not.toMatch(/squirting a cat/i);
    expect(out.prompt).toMatch(/holding a water bottle/i);
    expect(out.prompt).toMatch(/standing a few feet from a cat/i);
  });

  it("removes the distress reaction", () => {
    expect(out.prompt).not.toMatch(/flinch/i);
    expect(out.prompt).not.toMatch(/startled/i);
    expect(out.prompt).toMatch(/leaning back/i);
    expect(out.prompt).toMatch(/alert/i);
  });

  it("leaves the shot type and the Setting clause intact", () => {
    expect(out.prompt.startsWith("medium shot:")).toBe(true);
    expect(out.prompt).toMatch(/Setting: A cozy, lived-in home living space/);
  });

  it("clears the risk flag, so no LLM rewrite is needed", () => {
    expect(out.risky).toBe(false);
  });

  it("reports what it matched, for the job log", () => {
    expect(out.matches.join(" | ")).toMatch(/squirting a cat with a water bottle/i);
  });
});

describe("softenImagePrompt — idempotence", () => {
  it("is a no-op on its own output (the retry path re-softens)", () => {
    const once = softenImagePrompt(REFUSED).prompt;
    const twice = softenImagePrompt(once);
    expect(twice.changed).toBe(false);
    expect(twice.prompt).toBe(once);
  });
});

describe("softenImagePrompt — other force shapes", () => {
  it("neutralises a force verb with no instrument", () => {
    const r = softenImagePrompt("close-up: A man scolding the dog in a hallway.");
    expect(r.prompt).toMatch(/standing near the dog/i);
    expect(r.risky).toBe(false);
  });

  it("neutralises 'pushing them away'", () => {
    const r = softenImagePrompt("wide shot: A woman pushing the cat away from the counter.");
    expect(r.prompt).toMatch(/standing apart from the cat/i);
    expect(r.prompt).not.toMatch(/pushing/i);
  });

  it("handles the doubling gerunds", () => {
    expect(softenImagePrompt("A person hitting a dog.").prompt).toMatch(/standing near a dog/i);
    expect(softenImagePrompt("A person grabbing the kitten.").prompt).toMatch(/standing near the kitten/i);
  });
});

describe("softenImagePrompt — leaves benign prompts alone", () => {
  // Precision matters more than recall here: every false positive silently
  // rewrites a picture the client asked for.
  const benign = [
    "wide shot: A woman spraying the tomato plants with a garden mister on a sunny balcony.",
    "close-up: A carpenter hitting a nail with a hammer on a workbench.",
    "medium shot: A father pushing a child on a swing in a suburban backyard.",
    "medium shot: A cat sitting on a windowsill watching birds outside.",
    "wide shot: A man dragging a heavy suitcase across a train platform.",
  ];

  for (const p of benign) {
    it(`does not touch: ${p.slice(0, 44)}…`, () => {
      const r = softenImagePrompt(p);
      expect(r.prompt).toBe(p);
      expect(r.changed).toBe(false);
      expect(r.risky).toBe(false);
    });
  }
});

describe("hasDepictionRisk", () => {
  it("flags a prompt that needs work and clears one that does not", () => {
    expect(hasDepictionRisk(REFUSED)).toBe(true);
    expect(hasDepictionRisk("medium shot: A cat asleep on a sunlit rug.")).toBe(false);
  });

  it("flags a harm signal the rewrites cannot repair, for LLM escalation", () => {
    // No parsable "<verb> <det> <living>" object, so nothing is rewritten — but
    // the prompt is still a refusal candidate and must not be sent as-is.
    expect(hasDepictionRisk("medium shot: A scene of animal cruelty in a living room.")).toBe(true);
  });
});

// The prompts 69labs refused on the 2026-08-22 hunting video. Kept verbatim:
// whatever else changes, these must come out generatable.
describe("softenImagePrompt — the dead subject", () => {
  it("turns a predator on a kill into a predator over a dark shape", () => {
    const r = softenImagePrompt(
      "medium shot: A polar bear feeding on a kill on the ice, with several ravens waiting nearby.",
    );
    expect(r.prompt).not.toMatch(/kill|feeding on/i);
    expect(r.prompt).toMatch(/standing over a dark shape on the ice/i);
    expect(r.prompt).toMatch(/ravens waiting nearby/i);
    expect(r.risky).toBe(false);
  });

  it("turns a killed animal into the pelt it becomes", () => {
    const r = softenImagePrompt(
      "medium shot: An Inuit hunter performing a ritual over a killed polar bear, tools laid out respectfully.",
    );
    expect(r.prompt).not.toMatch(/killed|polar bear/i);
    expect(r.prompt).toMatch(/a ritual over a large pelt laid out on the ground/i);
  });

  it("turns butchery into work over the pelt, without doubling the clause", () => {
    const r = softenImagePrompt(
      "medium shot: An Inuit hunter skinning a polar bear, demonstrating the skill involved in processing the animal.",
    );
    expect(r.prompt).not.toMatch(/skinning|processing the animal/i);
    expect(r.prompt).toMatch(/working over a large pelt spread on the ground/i);
    expect(r.prompt).toMatch(/skill involved in working with the hides/i);
    // The general butchery rule must not fire a second time on "the animal".
    expect(r.prompt.match(/working over/gi)?.length).toBe(1);
  });

  it("rewrites a carcass, organ meat, and abstract predation", () => {
    expect(softenImagePrompt("a sled laden with a fresh seal carcass").prompt)
      .toMatch(/a canvas-wrapped bundle/i);
    expect(softenImagePrompt("A close-up of a raw polar bear liver, dark and dense.").prompt)
      .toMatch(/a dark slab of raw meat/i);
    expect(softenImagePrompt("A polar bear on the ice, demonstrating its powerful feeding behavior.").prompt)
      .toMatch(/its presence in the landscape/i);
  });

  it("puts a demonstrated weapon at rest", () => {
    const r = softenImagePrompt("An older hunter demonstrating a knife thrust to a young hunter.");
    expect(r.prompt).toMatch(/a knife held ready/i);
    expect(r.prompt).not.toMatch(/thrust/i);
  });

  it("leaves food, wildlife, and idiom alone", () => {
    for (const p of [
      "close-up: a chef slicing raw chicken breast on a wooden board beside a bowl of herbs.",
      "medium shot: a polar bear walking across flat sea ice under an overcast sky.",
      "wide shot: a dead end sign at the top of a quiet suburban street.",
      "close-up: a woman spraying the tomato plants in a greenhouse.",
    ]) {
      const r = softenImagePrompt(p);
      expect(r.changed).toBe(false);
      expect(r.risky).toBe(false);
    }
  });

  it("escalates a death signal it cannot rewrite instead of guessing", () => {
    expect(hasDepictionRisk("close-up: blood on the snow beside a set of tracks.")).toBe(true);
    expect(hasDepictionRisk("wide shot: hunters returning across the ice at dusk.")).toBe(false);
  });
});

// From the 2026-08-22 audit of every project's refused blocks.
describe("softenImagePrompt — injury wording stays grammatical", () => {
  it("keeps 'badly injured' from becoming 'badly resting'", () => {
    const r = softenImagePrompt(
      "close-up: An elderly woman applying a tourniquet to a badly injured person's arm.",
    );
    expect(r.prompt).toMatch(/a bandaged person's arm/i);
    expect(r.prompt).not.toMatch(/badly resting/i);
  });

  it("bandages an injury attached to a noun, and rests a state", () => {
    expect(softenImagePrompt("a wounded man on a stretcher").prompt).toMatch(/a bandaged man/i);
    expect(softenImagePrompt("a cat bleeding on the rug").prompt).toMatch(/a cat resting/i);
  });
});

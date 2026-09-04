import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The extra scenes of one sentence must CHANGE THE SUBJECT along the chain the
// line implies, not re-frame one object (client "Joey", 2026-09-03, third round:
// for one fridge line his reference video shows a supermarket cooler, a chest
// freezer, and browning ground beef -- only the first frame holds a fridge).
//
// The instruction lives in the Gemini prompt, which is built by module-private
// functions, so this guards the prompt TEXT: that the rule is present, that it
// is wired into the planner prompt, and -- most importantly -- that its leash
// survives. Without the leash this rule re-opens the "merely in the same WORLD
// as the line" failure that SCRIPT_MATCH_RULE calls the thing the client rejects
// hardest, which is a far worse regression than the repetition it fixes.
const SRC = fs.readFileSync(path.join(process.cwd(), "lib/synthetic/planner.ts"), "utf8");

describe("RELATED_SUBJECT_RULE", () => {
  it("is defined and wired into the planner prompt", () => {
    expect(SRC).toContain("const RELATED_SUBJECT_RULE");
    // Listed among the rules the segmentation prompt assembles.
    expect(SRC).toMatch(/^\s+RELATED_SUBJECT_RULE,$/m);
  });

  it("tells the model to change the subject rather than the angle", () => {
    expect(SRC).toContain("CHANGE THE SUBJECT, NOT THE ANGLE");
    expect(SRC).toContain("WALK THE CHAIN THE LINE IMPLIES");
  });

  it("keeps the causal leash so substitution cannot drift to the merely nearby", () => {
    expect(SRC).toContain("THE LEASH — RELATED MEANS CAUSALLY RELATED");
    // The four permitted relationships. If someone loosens these, the rule stops
    // being "the same story continuing" and becomes free association. Matched on
    // the source with string-concatenation seams collapsed, since the rule is
    // written as adjacent quoted lines.
    const flat = SRC.replace(/"\s*\+\s*\n\s*"/g, "");
    expect(flat).toMatch(/acts on, comes from, is kept in, or turns? into/);
    expect(SRC).toContain("merely nearby");
  });

  it("exempts the FIRST scene, which still answers the line literally", () => {
    // SCRIPT_MATCH_RULE owns imagePrompt. Only the scenes after it walk the
    // chain -- a fridge line must still OPEN on a fridge.
    expect(SRC).toContain("THIS DOES NOT APPLY TO imagePrompt");
  });

  it("no longer forbids a different subject outright in the regen path", () => {
    // The old wording ("You must NOT write a different SUBJECT") banned exactly
    // what the client asked for. It must not come back.
    expect(SRC).not.toContain("You must NOT write a different SUBJECT");
    expect(SRC).toContain("WALK THE CHAIN");
  });

  it("still forbids the unrelated swap in the regen path", () => {
    // The half of the old rule that was RIGHT: dropping the line's subject for
    // something that merely shares its world.
    expect(SRC).toContain("the receipt instead of the machine");
  });
});

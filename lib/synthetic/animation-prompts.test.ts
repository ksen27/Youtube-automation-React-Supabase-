import { describe, it, expect, vi, beforeEach } from "vitest";

// generateAnimationPrompts is the pass that stops a promoted block from
// reaching the worker with no motion of its own (client 2026-08-25: "the clips
// ... are very random and do not match at all"). Its correctness is mostly
// about what it does with a MODEL RESPONSE, so the model is the only thing
// mocked here — everything else is the real planner module.
const generateContent = vi.fn();

vi.mock("@/lib/ai/gemini", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/gemini")>("@/lib/ai/gemini");
  return {
    ...actual,
    // Call the callback with a stub model, and let a thrown error propagate the
    // way an exhausted retry ladder would.
    withGeminiModelFallback: async (_label: string, fn: (model: unknown) => Promise<unknown>) => ({
      result: await fn({ generateContent }),
      model: "test-model",
    }),
  };
});

vi.mock("@/lib/jobs/db", () => ({
  logJob: vi.fn(async () => {}),
  setMediaJob: vi.fn(async () => {}),
}));

const { generateAnimationPrompts } = await import("@/lib/synthetic/planner");

function respond(payload: unknown) {
  return { response: { text: () => JSON.stringify(payload), candidates: [{ finishReason: "STOP" }] } };
}

const block = (i: number) => ({
  i,
  script: `line ${i} of the narration`,
  imagePrompt: `scene ${i}: a close-up of something`,
});

beforeEach(() => {
  generateContent.mockReset();
});

describe("generateAnimationPrompts", () => {
  it("returns a prompt per block, keyed by the block's index", async () => {
    generateContent.mockResolvedValue(
      respond({
        animations: [
          { i: 3, animationPrompt: "she pours the milk into the bowl" },
          { i: 7, animationPrompt: "the web sways in the draught" },
        ],
      }),
    );

    const out = await generateAnimationPrompts({
      projectId: "p1",
      blocks: [block(3), block(7)],
    });

    expect(out.get(3)).toBe("she pours the milk into the bowl");
    expect(out.get(7)).toBe("the web sways in the draught");
  });

  it("ignores indices that were not asked about", async () => {
    // The failure this guards is the exact bug the pass exists to fix: motion
    // written onto a block it does not belong to.
    generateContent.mockResolvedValue(
      respond({
        animations: [
          { i: 3, animationPrompt: "correct motion" },
          { i: 99, animationPrompt: "motion for a block in another batch" },
        ],
      }),
    );

    const out = await generateAnimationPrompts({ projectId: "p1", blocks: [block(3)] });

    expect(out.get(3)).toBe("correct motion");
    expect(out.has(99)).toBe(false);
    expect(out.size).toBe(1);
  });

  it("drops empty prompts rather than storing blank motion", async () => {
    generateContent.mockResolvedValue(
      respond({ animations: [{ i: 1, animationPrompt: "   " }, { i: 2, animationPrompt: "it turns" }] }),
    );

    const out = await generateAnimationPrompts({ projectId: "p1", blocks: [block(1), block(2)] });

    expect(out.has(1)).toBe(false);
    expect(out.get(2)).toBe("it turns");
  });

  it("batches large plans and merges every batch's results", async () => {
    // ANIMATION_BATCH_SIZE is 12, so 30 blocks must be three calls.
    const blocks = Array.from({ length: 30 }, (_, i) => block(i));
    generateContent.mockImplementation(async ({ contents }: { contents: Array<{ parts: Array<{ text: string }> }> }) => {
      const text = contents[0].parts[0].text;
      const asked = [...text.matchAll(/--- shot (\d+)/g)].map((m) => Number(m[1]));
      return respond({ animations: asked.map((i) => ({ i, animationPrompt: `motion ${i}` })) });
    });

    const out = await generateAnimationPrompts({ projectId: "p1", blocks });

    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(out.size).toBe(30);
    expect(out.get(0)).toBe("motion 0");
    expect(out.get(29)).toBe("motion 29");
  });

  it("survives a failing batch and still returns the batches that worked", async () => {
    // Non-fatal by design: a Gemini outage must degrade the clips, not fail a
    // plan that is otherwise complete.
    const blocks = Array.from({ length: 24 }, (_, i) => block(i));
    let call = 0;
    generateContent.mockImplementation(async ({ contents }: { contents: Array<{ parts: Array<{ text: string }> }> }) => {
      call++;
      if (call === 1) throw new Error("503 model overloaded");
      const text = contents[0].parts[0].text;
      const asked = [...text.matchAll(/--- shot (\d+)/g)].map((m) => Number(m[1]));
      return respond({ animations: asked.map((i) => ({ i, animationPrompt: `motion ${i}` })) });
    });

    const out = await generateAnimationPrompts({ projectId: "p1", blocks });

    expect(out.size).toBe(12);
  });

  it("returns an empty map for no blocks without calling the model", async () => {
    const out = await generateAnimationPrompts({ projectId: "p1", blocks: [] });
    expect(out.size).toBe(0);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("puts each block's own narration and scene in the prompt it is asked about", async () => {
    generateContent.mockResolvedValue(respond({ animations: [] }));

    await generateAnimationPrompts({
      projectId: "p1",
      basePrompt: "a rural kitchen in winter",
      blocks: [{ i: 5, script: "the dough is folded twice", imagePrompt: "hands on a floured board" }],
    });

    const text = generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
    expect(text).toContain("the dough is folded twice");
    expect(text).toContain("hands on a floured board");
    expect(text).toContain("a rural kitchen in winter");
    // The rule the client's complaint is actually about.
    expect(text).toContain("narration is saying");
  });
});

// isNoMotionAnswer exists because Gemini answers the animationPrompt field with
// "no movement" / "still image" on scenes it judges static, and a STORED answer
// beats every fallback — so that string renders as a frozen clip.
describe("isNoMotionAnswer", () => {
  it("treats absence answers as no motion", async () => {
    const { isNoMotionAnswer } = await import("@/lib/synthetic/planner");
    for (const s of ["no movement", "No animation.", "still image", "none", "n/a", "static", "  ", null, "nothing moves"]) {
      expect(isNoMotionAnswer(s)).toBe(true);
    }
  });

  it("keeps real motion descriptions, including ones that start with those words", async () => {
    const { isNoMotionAnswer } = await import("@/lib/synthetic/planner");
    for (const s of [
      "a hand turns a page in the open notebook",
      "steam gently rises from the roasting tin",
      "still water in the trough ripples as the tap drips into it",
      "motion of the water settles as the bucket is set down",
      "no hands enter the frame; the leaves stir in the breeze and the light shifts",
    ]) {
      expect(isNoMotionAnswer(s)).toBe(false);
    }
  });
});

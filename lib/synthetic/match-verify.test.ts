import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { sceneOnly, score, type Judged } from "./match-verify";

// verifyAndRepair calls the judge (a model). These tests stub that module so
// the REPAIR POLICY can be tested without a network: which blocks are picked,
// in what order, how many, and — most importantly — that a rewrite is only kept
// when it is genuinely better. That last rule is what stops the gate from
// quietly replacing a weak-but-sensible shot with a wrong one.

const judged = (over: Partial<Judged> & Pick<Judged, "i" | "verdict">): Judged => ({
  script: "s", prompt: "p", why: "because", ...over,
});

describe("sceneOnly", () => {
  it("strips the trailing recurring world so the scene is judged", () => {
    expect(sceneOnly("close-up: a worn stock. Setting: workshops and gun shops, present day."))
      .toBe("close-up: a worn stock");
  });
  it("leaves a prompt with no world untouched", () => {
    expect(sceneOnly("close-up: a worn stock")).toBe("close-up: a worn stock");
  });
});

describe("score", () => {
  it("counts and rounds", () => {
    const s = score([
      judged({ i: 0, verdict: "MATCH" }), judged({ i: 1, verdict: "MATCH" }),
      judged({ i: 2, verdict: "WEAK" }), judged({ i: 3, verdict: "MISMATCH" }),
    ]);
    expect(s).toMatchObject({ n: 4, match: 2, weak: 1, mismatch: 1, matchPct: 50, mismatchPct: 25 });
  });
  it("does not divide by zero on an empty plan", () => {
    expect(score([])).toMatchObject({ n: 0, matchPct: 0, mismatchPct: 0 });
  });
});

describe("verifyAndRepair", () => {
  const targets = [
    { i: 0, script: "The guns looked old.", imagePrompt: "folded blankets" },
    { i: 1, script: "He drove four hours.", imagePrompt: "a rifle on a bench" },
    { i: 2, script: "That is not nostalgia.", imagePrompt: "a workshop" },
  ];

  let verdicts: Record<number, Judged["verdict"]>;
  let recheck: Judged["verdict"];

  beforeEach(() => {
    vi.resetModules();
    verdicts = { 0: "MISMATCH", 1: "MISMATCH", 2: "WEAK" };
    recheck = "MATCH";
    // Stub at the MODEL boundary rather than spying on judgeBatch:
    // verifyAndRepair calls judgeAll through a module-local reference, which a
    // namespace spy cannot intercept. Going through the real judgeBatch also
    // exercises its prompt building and JSON parsing.
    vi.doMock("@/lib/ai/gemini", () => ({
      withGeminiModelFallback: async (
        _name: string,
        fn: (m: { generateContent: (a: unknown) => unknown }) => Promise<unknown>,
      ) => ({
        result: await fn({
          generateContent: (arg: { contents: Array<{ parts: Array<{ text: string }> }> }) => {
            const text = arg.contents[0].parts[0].text;
            // Recover which items this batch asked about, and what each SEES.
            const items = [...text.matchAll(/^\[(\d+)\]\nHEARS: .*\nSEES: (.*)$/gm)].map((m) => {
              const i = Number(m[1]);
              const sees = m[2];
              return {
                i,
                verdict: sees.startsWith("REWRITTEN") ? recheck : (verdicts[i] ?? "MATCH"),
                why: "because",
              };
            });
            return { response: { text: () => JSON.stringify({ items }) } };
          },
        }),
        model: "stub",
      }),
    }));
  });
  afterEach(() => vi.doUnmock("@/lib/ai/gemini"));

  async function load() {
    return import("./match-verify");
  }

  it("rewrites MISMATCH blocks and keeps improvements", async () => {
    const mod = await load();
    const rewrite = vi.fn(async () => "REWRITTEN scene");
    const { outcomes } = await mod.verifyAndRepair(targets, rewrite, { maxRepairs: 10 });
    // Both mismatches attempted, the weak one left alone.
    expect(rewrite).toHaveBeenCalledTimes(2);
    expect(outcomes.map((o) => o.i).sort()).toEqual([0, 1]);
    expect(outcomes.every((o) => o.rewritten === "REWRITTEN scene")).toBe(true);
  });

  it("DISCARDS a rewrite that does not judge better", async () => {
    const mod = await load();
    recheck = "MISMATCH"; // the retry is no better than what it replaces
    const { outcomes } = await mod.verifyAndRepair(targets, async () => "REWRITTEN scene", { maxRepairs: 10 });
    expect(outcomes.every((o) => o.rewritten === null)).toBe(true);
  });

  it("discards a rewrite that is merely equal, not better", async () => {
    const mod = await load();
    verdicts = { 0: "WEAK", 1: "MATCH", 2: "MATCH" };
    recheck = "WEAK"; // same rank as before
    const { outcomes } = await mod.verifyAndRepair(targets, async () => "REWRITTEN scene", {
      maxRepairs: 10, alsoWeak: true,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].rewritten).toBeNull();
  });

  it("leaves WEAK alone unless alsoWeak is set", async () => {
    const mod = await load();
    verdicts = { 0: "WEAK", 1: "WEAK", 2: "WEAK" };
    const lenient = await mod.verifyAndRepair(targets, async () => "REWRITTEN scene", { maxRepairs: 10 });
    expect(lenient.outcomes).toHaveLength(0);

    const strict = await mod.verifyAndRepair(targets, async () => "REWRITTEN scene", {
      maxRepairs: 10, alsoWeak: true,
    });
    expect(strict.outcomes).toHaveLength(3);
  });

  it("spends a small cap on MISMATCH before WEAK", async () => {
    const mod = await load();
    verdicts = { 0: "WEAK", 1: "MISMATCH", 2: "WEAK" };
    const { outcomes } = await mod.verifyAndRepair(targets, async () => "REWRITTEN scene", {
      maxRepairs: 1, alsoWeak: true,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].i).toBe(1); // the mismatch, not the earlier weak one
  });

  it("survives a rewrite that throws", async () => {
    const mod = await load();
    const { outcomes } = await mod.verifyAndRepair(
      targets,
      async () => { throw new Error("model down"); },
      { maxRepairs: 10 },
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.rewritten === null)).toBe(true);
  });

  it("does nothing on an empty plan", async () => {
    const mod = await load();
    const r = await mod.verifyAndRepair([], async () => "x", { maxRepairs: 10 });
    expect(r).toMatchObject({ outcomes: [], judged: [], failedBatches: 0 });
  });
});

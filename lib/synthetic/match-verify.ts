/* eslint-disable no-console */
// Shared script-to-picture judge. Used by judge-project-match.ts (a SHIPPED
// project, read from the database) and bench-match.ts (raw scripts planned
// fresh). Both ask the same question with the same wording, so their numbers
// are comparable — a bench score is only useful if it means the same thing as
// the score from a real project.
//
// SCORED BY LLM JUDGE, NOT KEYWORDS, for the reason prompt-match-check.ts
// records: a keyword test scores "a receipt for a lawn mower" as a match for a
// line about a mower, and showing the receipt instead of the machine is exactly
// the failure being hunted.
import { withGeminiModelFallback } from "@/lib/ai/gemini";

export type Verdict = "MATCH" | "WEAK" | "MISMATCH";

export interface JudgeItem {
  i: number;
  script: string;
  prompt: string;
}

export interface Judged extends JudgeItem {
  verdict: Verdict;
  why: string;
}

export const JUDGE_BATCH = 10;

function buildJudgePrompt(rows: JudgeItem[]): string {
  return [
    "You are reviewing a narrated video. For each item you get the NARRATION",
    "the viewer HEARS and a description of the PICTURE they SEE at that moment.",
    "",
    "Answer one question per item: does the picture belong to those words?",
    "",
    'Return STRICT JSON ONLY: {"items":[{"i":<number>,"verdict":"MATCH|WEAK|MISMATCH","why":"<=15 words"}]}',
    "",
    "MATCH    - a viewer instantly sees the connection. The picture shows the",
    "           main thing the line is about, or the event it describes.",
    "WEAK     - same general world, but the picture is not what the line is",
    "           about: a related object, a detail at the edge, or a generic shot",
    "           of the topic where the line named something specific.",
    "MISMATCH - the picture shows something the line is not about at all, or",
    "           hides/omits the thing the line describes.",
    "",
    "Be strict. Being on-topic is NOT a match: a video about guns showing a gun",
    "while the line is about a factory closing is a MISMATCH. A line describing",
    "how something LOOKS, illustrated by that thing wrapped, covered or boxed,",
    "is a MISMATCH -- the viewer cannot see what is being described.",
    "",
    "One allowance, because the image generator REFUSES trademarked names: a",
    "line naming a real brand or manufacturer may be illustrated by the generic",
    "object or the generic activity. Judge whether the SUBJECT is right, not",
    "whether the brand is identifiable.",
    "",
    "ITEMS:",
    ...rows.map((r) => `[${r.i}]\nHEARS: ${r.script}\nSEES: ${r.prompt}\n`),
  ].join("\n");
}

/** Judge one batch. Throws on a model/parse failure so the caller can count it. */
export async function judgeBatch(rows: JudgeItem[]): Promise<Judged[]> {
  const { result } = await withGeminiModelFallback(
    "matchJudge",
    async (model) => {
      const res = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: buildJudgePrompt(rows) }] }],
        // temperature 0: the score has to be comparable between runs, or it
        // cannot be used to tell whether a rule change helped.
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      });
      const parsed = JSON.parse(res.response.text());
      if (!parsed?.items?.length) throw new Error("judge returned no items");
      return parsed as { items: Array<{ i: number; verdict: Verdict; why: string }> };
    },
    { attempts: 2, baseMs: 800 },
    { attempts: 3, baseMs: 1500 },
  );

  return result.items.map((it) => {
    const src = rows.find((r) => r.i === it.i);
    return {
      i: it.i,
      verdict: it.verdict,
      why: it.why,
      script: src?.script ?? "",
      prompt: src?.prompt ?? "",
    };
  });
}

/** Judge every item, batched. Failed batches are skipped and reported by count. */
export async function judgeAll(items: JudgeItem[]): Promise<{ judged: Judged[]; failedBatches: number }> {
  const judged: Judged[] = [];
  let failedBatches = 0;
  for (let i = 0; i < items.length; i += JUDGE_BATCH) {
    try {
      judged.push(...(await judgeBatch(items.slice(i, i + JUDGE_BATCH))));
    } catch {
      failedBatches++;
    }
  }
  return { judged, failedBatches };
}

export interface Score {
  n: number;
  match: number;
  weak: number;
  mismatch: number;
  matchPct: number;
  mismatchPct: number;
}

export function score(judged: Judged[]): Score {
  const n = judged.length;
  const count = (v: Verdict) => judged.filter((j) => j.verdict === v).length;
  const match = count("MATCH");
  const mismatch = count("MISMATCH");
  return {
    n,
    match,
    weak: count("WEAK"),
    mismatch,
    matchPct: n ? Math.round((match / n) * 100) : 0,
    mismatchPct: n ? Math.round((mismatch / n) * 100) : 0,
  };
}

/** Strip the trailing recurring world so the SCENE is judged, not the base prompt. */
export function sceneOnly(imagePrompt: string): string {
  return imagePrompt.replace(/\.\s*Setting:[\s\S]*$/i, "").trim();
}

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------
// Everything above is measurement. This is the part that acts on it.
//
// Until now nothing in the pipeline checked whether a block's picture belonged
// to its line. The planner's rules make a wrong prompt less likely and a
// benchmark can tell us how much less likely, but every prompt still went
// straight to the image generator and then to the clip generator: a block that
// showed folded blankets for a line about how some guns looked was generated,
// animated, rendered and shipped, at full cost, with nothing between it and the
// viewer.
//
// So: judge every block against its own line BEFORE anything is generated, and
// rewrite the ones that fail. This is the same trust-but-verify shape already
// used for refused prompts and for duplicate scenes -- ask the model, check the
// answer, retry the failures -- applied to the thing the client actually
// complains about.
//
// Judging is cheap next to what it protects. One text call covers ten blocks;
// a 266-block project is ~27 calls plus a rewrite for each failure, against
// hundreds of image and video generations that would otherwise be spent on
// shots that do not match.

export interface VerifyTarget {
  /** Stable id for the caller to map results back (a position or index). */
  i: number;
  script: string;
  /** The composed prompt as it would be stored. */
  imagePrompt: string;
}

export interface VerifyOutcome {
  i: number;
  verdictBefore: Verdict;
  verdictAfter: Verdict | null;
  /** The rewritten prompt, or null when it was kept as-is. */
  rewritten: string | null;
  why: string;
}

/**
 * Judge every target and rewrite the failures.
 *
 * `rewrite` is supplied by the caller (the planner passes a closure over
 * regenerateSegmentPrompt) so this module stays free of planner imports and
 * can be unit-tested without a model.
 *
 * Only MISMATCH is rewritten by default. WEAK is "right world, wrong detail",
 * which is often the best available answer for an abstract line -- rewriting
 * all of them would burn budget re-rolling lines that have no better picture,
 * and risks trading a weak-but-sensible shot for a wrong one. `alsoWeak` opts
 * into the stricter behaviour.
 *
 * A rewrite is KEPT ONLY IF IT JUDGES BETTER. That matters: a regeneration is
 * another roll of the same dice, and without the re-check this pass could
 * replace a weak shot with a worse one and call it progress.
 */
export async function verifyAndRepair(
  targets: VerifyTarget[],
  rewrite: (t: VerifyTarget, why: string) => Promise<string | null>,
  opts: { maxRepairs: number; alsoWeak?: boolean } = { maxRepairs: 60 },
): Promise<{ outcomes: VerifyOutcome[]; judged: Judged[]; failedBatches: number }> {
  if (targets.length === 0) return { outcomes: [], judged: [], failedBatches: 0 };

  const items: JudgeItem[] = targets.map((t) => ({
    i: t.i,
    script: t.script.slice(0, 400),
    prompt: sceneOnly(t.imagePrompt).slice(0, 400),
  }));
  const { judged, failedBatches } = await judgeAll(items);

  const failing = judged
    .filter((j) => j.verdict === "MISMATCH" || (opts.alsoWeak && j.verdict === "WEAK"))
    // Worst first, so a maxRepairs cap spends itself on the blocks that read as
    // most broken rather than on whichever happened to be judged first.
    .sort((a, b) => (a.verdict === "MISMATCH" ? 0 : 1) - (b.verdict === "MISMATCH" ? 0 : 1))
    .slice(0, Math.max(0, opts.maxRepairs));

  const outcomes: VerifyOutcome[] = [];
  for (const f of failing) {
    const target = targets.find((t) => t.i === f.i);
    if (!target) continue;
    let rewritten: string | null = null;
    let verdictAfter: Verdict | null = null;
    try {
      rewritten = await rewrite(target, f.why);
      if (rewritten?.trim()) {
        const [recheck] = await judgeBatch([
          { i: f.i, script: target.script.slice(0, 400), prompt: sceneOnly(rewritten).slice(0, 400) },
        ]);
        verdictAfter = recheck?.verdict ?? null;
        // Keep the rewrite only when it is genuinely better than what it replaces.
        const rank = (v: Verdict | null) => (v === "MATCH" ? 2 : v === "WEAK" ? 1 : 0);
        if (rank(verdictAfter) <= rank(f.verdict)) rewritten = null;
      }
    } catch {
      rewritten = null;
    }
    outcomes.push({ i: f.i, verdictBefore: f.verdict, verdictAfter, rewritten, why: f.why });
  }

  return { outcomes, judged, failedBatches };
}

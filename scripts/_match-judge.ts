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

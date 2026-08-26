// Do ACTION lines now get a person doing the action?
//
// The fixtures are the client's own examples from the 2026-08-26 Loom, plus the
// exact narration those complaints came from, taken verbatim from the stored
// plan. Run on this branch, then `git stash` and run again to compare.
import { regenerateSegmentPrompt } from "@/lib/synthetic/planner";
import { withGeminiModelFallback } from "@/lib/ai/gemini";

const BASE = "an ordinary American home and the shops and roads around it, present day, plain and unglamorous";

const LINES = [
  {
    script:
      "And sold everything inside it for eight hundred dollars. A collector drove four hours to get there. He paid the eight hundred, loaded the truck, and within sixty days had sold two of those firearms.",
    want: "someone driving / loading a truck",
  },
  {
    script:
      "The firearms worth real money in twenty twenty-six were built to look exactly like the ones people let go of for nothing.",
    want: "someone building / working on a firearm",
  },
  {
    script: "He paid the eight hundred, loaded the truck, and drove home before dark.",
    want: "a person loading a truck",
  },
  {
    script: "Most sellers never check the serial numbers before they hand the gun over.",
    want: "a person handing a gun over / checking numbers",
  },
  {
    script: "A Luger in original configuration is worth several times one that has been refinished.",
    want: "(no action — an object shot is correct here)",
  },
];

async function judge(script: string, prompt: string) {
  const q = [
    "A line of narration and the shot planned for it.",
    "",
    `NARRATION: ${script}`,
    `SHOT: ${prompt}`,
    "",
    "Does the shot show a PERSON PERFORMING the action the narration describes?",
    "Answer PERSON_ACTION if a human is visibly doing the thing.",
    "Answer HANDS_ONLY if only disembodied hands are shown doing it.",
    "Answer OBJECT if it is a shot of a thing with no human performing anything.",
    "Answer NO_ACTION if the narration describes no action at all.",
    "",
    'Respond ONLY with JSON: {"verdict":"PERSON_ACTION|HANDS_ONLY|OBJECT|NO_ACTION","why":"<8 words>"}',
  ].join("\n");
  const { result } = await withGeminiModelFallback("actionJudge", async (model) => {
    const res = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: q }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0,
        maxOutputTokens: 256,
        thinkingConfig: { thinkingBudget: 0 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    return JSON.parse(res.response.text()) as { verdict: string; why: string };
  });
  return result;
}

async function main() {
  const tally: Record<string, number> = {};
  for (const fx of LINES) {
    const r = await regenerateSegmentPrompt({
      projectId: "00000000-0000-0000-0000-000000000000",
      script: fx.script,
      basePrompt: BASE,
      blockType: "ai_clip",
    });
    const v = await judge(fx.script, r.imagePrompt);
    tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;
    console.log(`\n[${v.verdict}] ${fx.script.slice(0, 95)}`);
    console.log(`   want   : ${fx.want}`);
    console.log(`   judge  : ${v.why}`);
    console.log(`   picture: ${r.imagePrompt.replace(/\. Setting:[\s\S]*$/, "")}`);
    if (r.animationPrompt) console.log(`   motion : ${r.animationPrompt}`);
  }
  console.log("\n" + JSON.stringify(tally));
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

/* eslint-disable no-console */
// Does the picture we plan actually show what the line is talking about?
//
//   npx tsx --env-file=.env.local scripts/prompt-match-check.ts
//
// The client's 2026-08-25 Loom is a list of lines and the wrong shot we made for
// each: "this mower that cost eight hundred dollars" -> gloves; "it's talking
// about an email" -> a letter; "when he says mugs, you should show mugs". Those
// lines are the fixtures below.
//
// TWO MODES, and the difference between them is the point:
//
//   FRESH  — the first block about this subject. No avoid list.
//   REPEAT — a LATER block about the same subject, with the earlier shot passed
//            as already-shown. This is the scene-dedupe path, and on a real
//            video it is most blocks: a script that stays on its topic flags
//            nearly every block as a repeat of an earlier one (up to 80 were
//            regenerated this way on the reported project).
//
// SCORING IS BY LLM JUDGE, NOT KEYWORDS. A keyword test scores "a receipt for a
// lawn mower" as a MATCH for a line about a mower — but a receipt is not the
// mower, and showing the receipt instead of the machine is precisely what the
// client is complaining about. The judge is asked the question he asks: would a
// viewer hearing this line and seeing this picture think they belong together?
//
// Gemini only: no images, no clips, a fraction of a cent.

import { regenerateSegmentPrompt } from "@/lib/synthetic/planner";
import { withGeminiModelFallback } from "@/lib/ai/gemini";

const BASE_PROMPT =
  "a rural family kitchen and the small homestead around it, present day, warm and ordinary";

interface Fixture {
  script: string;
  // The line a LATER block covers -- a new sentence about the same subject,
  // which is what a real script does and what the dedupe pass actually sees.
  laterScript: string;
  note: string;
  // A shot of this same subject the video has ALREADY used — the avoid list that
  // reproduces the dedupe path.
  alreadyShown: string[];
}

const FIXTURES: Fixture[] = [
  {
    script: "This mower cost me eight hundred dollars, and it lasted exactly one summer.",
    laterScript: "By August the mower would not start at all, no matter what I tried.",
    note: 'Loom: "that cost eight hundred dollars, so you just show gloves"',
    alreadyShown: [
      "close-up: a ride-on lawn mower parked on a gravel path beside a shed, its engine cover slightly ajar",
      "medium shot: a lawn mower standing on cut grass, clippings scattered around its blades",
    ],
  },
  {
    script: "Then I got an email from the manufacturer telling me the warranty had expired.",
    laterScript: "I read that email four times before I understood what it actually said.",
    note: 'Loom: "It is talking about an email. This is like a letter."',
    alreadyShown: [
      "close-up: an email open on a smartphone screen, held in one hand over a kitchen counter",
    ],
  },
  {
    script: "He collected mugs, dozens of them, lined up along the shelf.",
    laterScript: "Every mug had a story, and he could tell you every one of them.",
    note: 'Loom: "like mugs, you should like show mugs"',
    alreadyShown: [
      "medium shot: ceramic mugs of various colours arranged along a wooden kitchen shelf",
      "close-up: two chipped ceramic mugs beside a kettle on a worn countertop",
    ],
  },
  {
    script: "The turkey crown had been injected with retained water to make it heavier.",
    laterScript: "That water cooks straight out of the turkey and you pay for it by weight.",
    note: 'Loom: "talking about retained water. You should show water."',
    alreadyShown: [
      "close-up: a raw turkey crown resting on a kitchen counter beside a syringe of clear liquid",
      "medium shot: a turkey crown in a roasting tin on a kitchen table",
    ],
  },
  {
    script: "Every recipe went into the notebook, and eventually it became her own cookbook.",
    laterScript: "The notebook filled up over thirty years of cooking for the same family.",
    note: "The reference channel shows a cookbook here — the standard he wants",
    alreadyShown: [
      "close-up: a handwritten recipe notebook open on a wooden kitchen counter, its cover worn",
    ],
  },
  {
    script: "Her mother stood in the doorway, watching her work.",
    laterScript: "Her mother never said much, but she was always there in that kitchen.",
    note: "A line that IS about a person — show the person, not an object",
    alreadyShown: [
      "medium shot: an older woman standing in a sunlit kitchen doorway, watching the room",
    ],
  },
];

type Verdict = "MATCH" | "PARTIAL" | "MISS";

async function judge(script: string, imagePrompt: string): Promise<{ verdict: Verdict; why: string }> {
  const prompt = [
    "You are checking whether a video shot matches the line of narration it plays under.",
    "",
    `NARRATION: ${script}`,
    `SHOT: ${imagePrompt}`,
    "",
    "Answer as a viewer would, not as a proofreader. The question is whether the",
    "MAIN THING the narration is about is what the viewer SEES.",
    "",
    "MATCH   — the shot shows the main thing the line is about.",
    "PARTIAL — the shot is related but shows something ADJACENT instead of the",
    "          main thing: a document about the object rather than the object, a",
    "          tool used on it, its packaging, its aftermath, a different part of",
    "          the same story. A viewer would notice the mismatch.",
    "MISS    — the shot shows something else entirely.",
    "",
    "Be strict about PARTIAL. If the line is about a mower and the shot is a",
    "receipt for a mower, that is PARTIAL, not MATCH. If the line says a person",
    "stood in a doorway and the shot shows hands kneading dough, that is a MISS.",
    "",
    'Respond ONLY with JSON: {"verdict":"MATCH|PARTIAL|MISS","why":"<8 words>"}',
  ].join("\n");

  const { result } = await withGeminiModelFallback("promptMatchJudge", async (model) => {
    const res = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0,
        maxOutputTokens: 256,
        thinkingConfig: { thinkingBudget: 0 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    return JSON.parse(res.response.text()) as { verdict: Verdict; why: string };
  });
  return result;
}

// The client's "hands or feet only" complaint, measured: a still with no person
// in it that is nonetheless animated by a hand reaching into frame.
function handsInvented(imagePrompt: string, animationPrompt: string | null): boolean {
  if (!animationPrompt) return false;
  const personInStill = /\b(person|people|woman|man|mother|father|girl|boy|she|he|they|her|his)\b/i.test(imagePrompt);
  const handsInMotion = /\bhands?\b|\bfingers?\b|\bpalm\b/i.test(animationPrompt);
  return handsInMotion && !personInStill;
}

async function run(mode: "FRESH" | "REPEAT") {
  const tally = { MATCH: 0, PARTIAL: 0, MISS: 0 };
  let hands = 0;

  console.log(`\n${"=".repeat(78)}`);
  console.log(
    mode === "FRESH"
      ? "MODE: FRESH — first block about this subject"
      : "MODE: REPEAT — a later block; the earlier shot is already used (dedupe path)",
  );
  console.log("=".repeat(78));

  for (const fx of FIXTURES) {
    let imagePrompt = "";
    let animationPrompt: string | null = null;
    try {
      const r = await regenerateSegmentPrompt({
        projectId: process.env.PROMPT_CHECK_PROJECT_ID || "00000000-0000-0000-0000-000000000000",
        script: mode === "REPEAT" ? fx.laterScript : fx.script,
        basePrompt: BASE_PROMPT,
        blockType: "ai_clip",
        avoidScenes: mode === "REPEAT" ? fx.alreadyShown : undefined,
      });
      imagePrompt = r.imagePrompt;
      animationPrompt = r.animationPrompt;
    } catch (e) {
      console.log(`\n[ERROR] ${fx.script}\n   ${(e as Error).message}`);
      continue;
    }

    const line = mode === "REPEAT" ? fx.laterScript : fx.script;
    const { verdict, why } = await judge(line, imagePrompt);
    tally[verdict] = (tally[verdict] ?? 0) + 1;
    const invented = handsInvented(imagePrompt, animationPrompt);
    if (invented) hands++;

    console.log(`\n[${verdict.padEnd(7)}] ${line}`);
    console.log(`   judge  : ${why}`);
    console.log(`   picture: ${imagePrompt.replace(/ Setting: .*$/, "")}`);
    if (animationPrompt) console.log(`   motion : ${animationPrompt}`);
    if (invented) console.log(`   ^^ HANDS INVENTED — no person in the still, but the motion adds hands`);
  }

  console.log(
    `\n${mode}: ${tally.MATCH} match, ${tally.PARTIAL} partial, ${tally.MISS} miss` +
      `  |  hands invented on ${hands}/${FIXTURES.length}`,
  );
  return { tally, hands };
}

async function main() {
  const fresh = await run("FRESH");
  const repeat = await run("REPEAT");
  console.log(`\n${"=".repeat(78)}`);
  console.log("SUMMARY");
  console.log(`  FRESH   ${fresh.tally.MATCH} match / ${fresh.tally.PARTIAL} partial / ${fresh.tally.MISS} miss   hands: ${fresh.hands}`);
  console.log(`  REPEAT  ${repeat.tally.MATCH} match / ${repeat.tally.PARTIAL} partial / ${repeat.tally.MISS} miss   hands: ${repeat.hands}`);
  console.log("  A real video is mostly REPEAT blocks — that row is the one that matters.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/* eslint-disable no-console */
// Plan a raw script through the CURRENT per-segment rules and print each
// line beside the picture we would generate for it — a review harness for
// the client's requirement that every part shows what ITS OWN narration
// says (a factory line shows the factory, not another photo of the topic).
//
//   npx tsx --env-file=.env.local scripts/review-script-prompts.ts <script.txt> ["base prompt"]
//
// Sequential on purpose: each line's accepted prompt joins the avoid list
// for the lines after it, which is the scene-dedupe path a real plan takes.
// Gemini only: no images, no clips, a fraction of a cent.
import { readFileSync } from "node:fs";
import { regenerateSegmentPrompt } from "@/lib/synthetic/planner";
import { splitTranscriptIntoSentences } from "@/lib/ai/sentences";

const AVOID_WINDOW = 6;

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: review-script-prompts.ts <script.txt> [\"base prompt\"]");
    process.exit(1);
  }
  const basePrompt =
    process.argv[3] ??
    "American home workshops, gun shops, estate sales and old gun safes, present day";
  const raw = readFileSync(file, "utf8");

  // ALL-CAPS lines are section headings, not narration — a real plan turns
  // them into title cards, so we skip planning a picture for them.
  const narration = raw
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^[A-Z0-9 ,'"-]+$/.test(l.trim()))
    .join(" ");

  const sentences = splitTranscriptIntoSentences(narration).map((s) => s.text.trim()).filter(Boolean);
  console.log(`${sentences.length} narration lines | base: "${basePrompt}"\n`);

  const avoid: string[] = [];
  for (const [i, line] of sentences.entries()) {
    try {
      const r = await regenerateSegmentPrompt({
        projectId: "00000000-0000-0000-0000-000000000000",
        script: line,
        basePrompt,
        blockType: "image",
        avoidScenes: avoid.slice(-AVOID_WINDOW),
        surroundingScript: [sentences[i - 1], sentences[i + 1]].filter(Boolean).join(" "),
      });
      const prompt = r.imagePrompt.trim();
      avoid.push(prompt);
      console.log(`--- ${String(i + 1).padStart(2, "0")} ---`);
      console.log(`LINE:   ${line}`);
      console.log(`PROMPT: ${prompt}\n`);
    } catch (e) {
      console.log(`--- ${String(i + 1).padStart(2, "0")} ---`);
      console.log(`LINE:   ${line}`);
      console.log(`ERROR:  ${(e as Error).message.slice(0, 200)}\n`);
    }
  }
}

main();

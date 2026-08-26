/* eslint-disable no-console */
// Which lines of a script would the narrator appear in, and what would that
// shot look like? Runs the real selection logic, then generates ONE of the
// chosen shots with a face reference so the result can be judged by eye.
//
//   npx tsx --env-file=.env.local scripts/probe-character-blocks.ts <script.txt> <face.png>
import { readFileSync, writeFileSync } from "node:fs";
import { selectCharacterBlocks, characterScenePrompt, personalVoiceScore } from "@/lib/synthetic/character-blocks";
import { regenerateSegmentPrompt } from "@/lib/synthetic/planner";
import { generateGeminiImage } from "@/lib/synthetic/gemini-image";
import { splitTranscriptIntoSentences } from "@/lib/ai/sentences";
import { getEnv } from "@/lib/env";

const BASE = "American home workshops, gun shops, estate sales and old gun safes, present day";

async function main() {
  const [file, facePath] = process.argv.slice(2);
  const raw = readFileSync(file, "utf8");
  const narration = raw.split(/\r?\n/).filter((l) => l.trim() && !/^[A-Z0-9 ,'"-]+$/.test(l.trim())).join(" ");
  const sentences = splitTranscriptIntoSentences(narration).map((s) => s.text.trim()).filter(Boolean);

  console.log(`${sentences.length} lines; planning prompts...\n`);
  const blocks = [];
  for (const [i, script] of sentences.entries()) {
    const r = await regenerateSegmentPrompt({
      projectId: "00000000-0000-0000-0000-000000000000",
      script, basePrompt: BASE, blockType: "image",
      surroundingScript: [sentences[i - 1], sentences[i + 1]].filter(Boolean).join(" "),
    });
    blocks.push({ blockType: "image" as const, script, imagePrompt: r.imagePrompt });
  }

  const picked = selectCharacterBlocks(blocks, { max: getEnv().SYNTHETIC_CHARACTER_BLOCKS_MAX });
  console.log(`AVATAR APPEARS IN ${picked.length} of ${blocks.length} blocks (max ${getEnv().SYNTHETIC_CHARACTER_BLOCKS_MAX}):\n`);
  for (const i of picked) {
    console.log(`  [${i}] voice=${personalVoiceScore(blocks[i].script)}  "${blocks[i].script}"`);
    console.log(`       -> ${blocks[i].imagePrompt}\n`);
  }
  if (!picked.length || !facePath) return;

  const face = readFileSync(facePath);
  const chosen = blocks[picked[0]];
  console.log(`generating block [${picked[0]}] with the face reference...`);
  const out = await generateGeminiImage(
    characterScenePrompt(chosen.imagePrompt!),
    { image: face, mimeType: "image/png" },
  );
  writeFileSync("character-block.png", out.image);
  console.log("WROTE character-block.png");
}
main().catch((e) => { console.error("FAILED: " + (e as Error).message); process.exit(1); });

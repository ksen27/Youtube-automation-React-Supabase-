/* eslint-disable no-console */
// Plan a raw script the way PRODUCTION does: derive the video's niche, let the
// planner GROUP the narration into visual blocks, and print each block's spoken
// lines beside the prompt that block would store.
//
//   npx tsx --env-file=.env.local scripts/review-plan-grouped.ts <script.txt> "<title>"
//
// Differs from review-script-prompts.ts, which regenerates ONE line at a time.
// That per-sentence view makes two adjacent sentences describing the same beat
// look like a duplicate shot, when production would have grouped them into a
// single block and generated one image. This harness shows the real blocks.
//
// Gemini only: no images, no clips, no database.
import { readFileSync } from "node:fs";
import {
  composePrompt,
  deriveVideoTopic,
  planTranscriptChunk,
  sanitizeBasePrompt,
} from "@/lib/synthetic/planner";
import { DEFAULT_LANGUAGE } from "@/lib/i18n/locale";

const PROJECT_ID = "00000000-0000-0000-0000-000000000000";

async function main() {
  const file = process.argv[2];
  const title = process.argv[3] ?? "";
  if (!file) {
    console.error('usage: review-plan-grouped.ts <script.txt> "<title>"');
    process.exit(1);
  }

  // ALL-CAPS lines are section headings — production turns them into title
  // cards rather than planning a picture for them.
  const raw = readFileSync(file, "utf8");
  const transcript = raw
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^[A-Z0-9 ,'"-]+$/.test(l.trim()))
    .join(" ")
    .trim();

  const topic = await deriveVideoTopic({
    projectId: PROJECT_ID,
    title,
    transcript,
    language: DEFAULT_LANGUAGE,
  });
  console.log("DERIVED NICHE:      " + (topic.niche || "(none)"));
  console.log("DERIVED SETTING:    " + (topic.setting || "(none)"));
  console.log("SUBJECT EXAMPLES:   " + (topic.subjectExamples || "(none)"));
  console.log("ENVIRONMENT EXMPLS: " + (topic.environmentExamples || "(none)"));

  const { basePrompt, segments } = await planTranscriptChunk(
    { projectId: PROJECT_ID },
    transcript,
    "review",
    topic,
  );

  // Production stores the SANITIZED base — clauses that would fight the block's
  // own scene are stripped before it is appended to every prompt.
  const checked = sanitizeBasePrompt(basePrompt);
  console.log("\nBASE PROMPT (raw):       " + (basePrompt || "(none)"));
  console.log("BASE PROMPT (sanitized): " + (checked.cleaned || "(none)"));
  console.log(`\n${segments.length} visual blocks\n`);

  segments.forEach((seg, i) => {
    const composed = composePrompt(checked.cleaned, seg.imagePrompt ?? null, seg.shotType ?? null);
    console.log(`--- BLOCK ${String(i + 1).padStart(2, "0")}  [${seg.blockType}] ---`);
    console.log(`SPOKEN: ${seg.script.trim()}`);
    console.log(`PROMPT: ${composed ?? "(none — avatar block)"}`);
    if (seg.imagePrompt2?.trim()) {
      const second = composePrompt(checked.cleaned, seg.imagePrompt2, seg.shotType2 ?? null);
      console.log(`2ND:    ${second}`);
    }
    console.log("");
  });
}

main();

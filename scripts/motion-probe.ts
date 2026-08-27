/* eslint-disable no-console */
// Do freshly planned clips describe motion a viewer would SEE?
//
//   npx tsx --env-file=.env.local scripts/motion-probe.ts <script.txt>
//
// clip-motion-audit reads a SHIPPED project. This plans one fresh, so a rule
// change can be checked without a re-plan. Same classification.
import { readFileSync } from "node:fs";
import { deriveVideoTopic, planTranscriptChunk, sanitizeBasePrompt } from "@/lib/synthetic/planner";
import { DEFAULT_LANGUAGE } from "@/lib/i18n/locale";

const PROJECT_ID = "00000000-0000-0000-0000-000000000000";
const DAMP_RE = /\b(slow(?:ly)?|unhurried|gentle|gently|calm(?:ly)?|deliberate(?:ly)?|softly|subtle|slight(?:ly)?|small|minimal|barely|faint(?:ly)?)\b/i;
const TRAVEL_RE = /\b(walk\w*|driv\w*|run\w*|carry\w*|lift\w*|pour\w*|open\w*|clos\w*|push\w*|pull\w*|throw\w*|hand\w*|load\w*|swing\w*|turn\w*|rise|rises|fall\w*|enter\w*|exit\w*|arriv\w*|leav\w*|pass\w*|cross\w*|sweep\w*|spread\w*|roll\w*|blow\w*|drift\w*)\b/i;

async function main() {
  const file = process.argv[2];
  if (!file) { console.error("usage: motion-probe.ts <script.txt>"); process.exit(1); }
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const title = (lines[0] ?? "").trim();
  const transcript = lines.slice(1).filter((l) => l.trim() && !/^[A-Z0-9 ,'"-]+$/.test(l.trim())).join(" ").trim();

  const topic = await deriveVideoTopic({ projectId: PROJECT_ID, title, transcript, language: DEFAULT_LANGUAGE });
  const { segments } = await planTranscriptChunk({ projectId: PROJECT_ID }, transcript, "motion-probe", topic);
  const clips = segments.filter((s) => s.blockType === "ai_clip" && (s.animationPrompt ?? "").trim());
  if (!clips.length) return console.log("no ai_clip blocks with motion prompts");

  let damp = 0, travel = 0;
  for (const c of clips) {
    const a = String(c.animationPrompt);
    if (DAMP_RE.test(a)) damp++;
    if (TRAVEL_RE.test(a)) travel++;
  }
  console.log(`${clips.length} clip motion prompts\n`);
  console.log(`  ${String(Math.round((travel / clips.length) * 100)).padStart(3)}%  something TRAVELS`);
  console.log(`  ${String(Math.round((damp / clips.length) * 100)).padStart(3)}%  carry a dampening word  (was 97% on the shipped plan)`);
  console.log("\nALL MOTION PROMPTS");
  for (const c of clips) console.log(`  - ${String(c.animationPrompt).slice(0, 160)}`);
}
main().catch((e) => { console.error("FAILED: " + (e as Error).message); process.exit(1); });

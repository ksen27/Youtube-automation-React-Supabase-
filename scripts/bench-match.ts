/* eslint-disable no-console */
// HOW OFTEN DOES THE PICTURE MATCH THE LINE? Across several different scripts.
//
//   npx tsx --env-file=.env.local scripts/bench-match.ts
//   npx tsx --env-file=.env.local scripts/bench-match.ts --dir path/to/scripts
//   npx tsx --env-file=.env.local scripts/bench-match.ts --only mountain
//
// WHY THIS EXISTS
// ---------------
// Every planner rule in this codebase was added to fix one observed failure,
// and each was verified on the script that motivated it. That is how a fix for
// one script silently breaks another: the "move the sequence forward" rule
// overrode the older "never drop the line's own subject" rule, and a block
// about how some guns LOOKED came back as a stack of folded blankets with the
// guns hidden underneath. Nothing caught it, because nothing re-checked the
// other scripts.
//
// So the unit of verification is no longer one script. This plans EVERY script
// in bench-scripts/ through the real batch path and scores each block with the
// same judge used on shipped projects (scripts/_match-judge.ts), then prints a
// per-script and overall number.
//
// HOW TO USE IT: run it BEFORE a rule change and AFTER. If MATCH went up on the
// script you were fixing and down on another, the change is not a fix, it is a
// trade -- which is exactly the information that has been missing.
//
// Gemini only: no images, no clips, no database. A few cents a run.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  deriveVideoTopic,
  planTranscriptChunk,
  composePrompt,
  sanitizeBasePrompt,
} from "@/lib/synthetic/planner";
import { DEFAULT_LANGUAGE } from "@/lib/i18n/locale";
import { judgeAll, score, sceneOnly, type Judged, type JudgeItem } from "@/scripts/_match-judge";

const PROJECT_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_DIR = "scripts/bench-scripts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// The first line of each fixture is its title (the planner derives the video's
// niche from title + transcript, so the bench must supply one).
function readScript(path: string): { title: string; transcript: string } {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const title = (lines[0] ?? "").trim();
  const body = lines.slice(1)
    // ALL-CAPS lines are section headings; production makes them title cards
    // rather than planning a picture for them.
    .filter((l) => l.trim() && !/^[A-Z0-9 ,'"-]+$/.test(l.trim()))
    .join(" ")
    .trim();
  return { title, transcript: body };
}

async function benchOne(name: string, path: string): Promise<{ name: string; judged: Judged[] } | null> {
  const { title, transcript } = readScript(path);
  if (!transcript) return null;

  const topic = await deriveVideoTopic({
    projectId: PROJECT_ID, title, transcript, language: DEFAULT_LANGUAGE,
  });
  const { basePrompt, segments } = await planTranscriptChunk(
    { projectId: PROJECT_ID }, transcript, `bench:${name}`, topic,
  );
  const base = sanitizeBasePrompt(basePrompt).cleaned;

  const items: JudgeItem[] = segments
    .filter((s) => s.blockType !== "avatar" && (s.imagePrompt ?? "").trim())
    .map((s, i) => ({
      i,
      script: s.script.trim().slice(0, 400),
      prompt: sceneOnly(composePrompt(base, s.imagePrompt ?? null, s.shotType ?? null) ?? "").slice(0, 400),
    }));

  const { judged, failedBatches } = await judgeAll(items);
  if (failedBatches) console.log(`    (${failedBatches} judge batch(es) failed)`);
  return { name, judged };
}

async function main() {
  const dir = argValue("--dir") ?? DEFAULT_DIR;
  const only = argValue("--only")?.toLowerCase();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .filter((f) => !only || f.toLowerCase().includes(only))
    .sort();
  if (!files.length) return console.log(`no .txt scripts in ${dir}`);

  console.log(`benching ${files.length} script(s) from ${dir}\n`);
  const results: Array<{ name: string; judged: Judged[] }> = [];
  for (const f of files) {
    const name = f.replace(/\.txt$/, "");
    process.stdout.write(`  ${name.padEnd(22)} planning…`);
    try {
      const r = await benchOne(name, join(dir, f));
      if (!r) { console.log(" empty, skipped"); continue; }
      const s = score(r.judged);
      console.log(`\r  ${name.padEnd(22)} ${String(s.n).padStart(3)} blocks   MATCH ${String(s.matchPct).padStart(3)}%   weak ${String(s.weak).padStart(2)}   MISMATCH ${String(s.mismatch).padStart(2)}`);
      results.push(r);
    } catch (e) {
      console.log(`\r  ${name.padEnd(22)} FAILED: ${(e as Error).message.slice(0, 90)}`);
    }
  }

  const all = results.flatMap((r) => r.judged);
  const s = score(all);
  console.log("\n" + "-".repeat(66));
  console.log(`OVERALL  ${s.n} blocks   MATCH ${s.matchPct}%   WEAK ${s.weak}   MISMATCH ${s.mismatch} (${s.mismatchPct}%)`);
  console.log("-".repeat(66));

  // Mismatches are the ones that read as broken on screen; print them all, with
  // their script, because a count alone cannot be acted on.
  const bad = all.filter((j) => j.verdict === "MISMATCH");
  if (bad.length) {
    console.log(`\nMISMATCHES (${bad.length}) — these are the ones to fix:`);
    for (const b of bad) {
      console.log(`\n  ${b.why}`);
      console.log(`    says : ${b.script.slice(0, 140)}`);
      console.log(`    shows: ${b.prompt.slice(0, 140)}`);
    }
  }
}

main().catch((e) => { console.error("FAILED: " + (e as Error).message); process.exit(1); });

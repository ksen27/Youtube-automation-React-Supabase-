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
  splitByDuration,
  regenerateSegmentPrompt,
  type PlannedSegment,
} from "@/lib/synthetic/planner";
import { getEnv } from "@/lib/env";
import { DEFAULT_LANGUAGE } from "@/lib/i18n/locale";
import { judgeAll, score, sceneOnly, type Judged, type JudgeItem } from "@/scripts/_match-judge";

const PROJECT_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_DIR = "scripts/bench-scripts";

// Narration pace, used to give each block a plausible spoken length. The bench
// has no voiceover and therefore no word timings, but DURATION is what decides
// whether a block is split into several visuals — and the split path is where
// the worst repetition lives. Estimating it is far closer to production than
// skipping the split entirely. ~2.6 words/sec is ordinary documentary pace.
const WORDS_PER_SECOND = 2.6;

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

  // THE SPLIT PATH. A long sentence is covered by several visuals, and the
  // extra slots are REGENERATED against the earlier ones — which is where the
  // repetition and the wrong-subject failures actually happen (the "blankets
  // instead of the guns" block came from here, not from first-pass planning).
  // Judging only the planner's first pass would score that plan clean, so the
  // bench reproduces the split and the regeneration.
  const env = getEnv();
  let clock = 0;
  const planned: PlannedSegment[] = segments
    .filter((s) => s.blockType !== "avatar" && (s.imagePrompt ?? "").trim())
    .map((s, i) => {
      const words = s.script.trim().split(/\s+/).filter(Boolean).length;
      const duration = Math.max(1, words / WORDS_PER_SECOND);
      const startTime = clock;
      clock += duration;
      return {
        position: i,
        blockType: s.blockType,
        startTime,
        endTime: clock,
        duration,
        script: s.script,
        imagePrompt: s.imagePrompt ?? null,
        shotType: s.shotType ?? null,
        imagePrompt2: s.imagePrompt2 ?? null,
        shotType2: s.shotType2 ?? null,
        animationPrompt: s.animationPrompt ?? null,
      } as PlannedSegment;
    });

  const split = planned.flatMap((p) =>
    splitByDuration(p, env.SYNTHETIC_BLOCK_TARGET_SECONDS, env.SYNTHETIC_BLOCK_SPLIT_THRESHOLD),
  );

  // Same shape as the planner's distinct-scene pass: an anchor followed by its
  // same-script slots, each regenerated with the earlier scenes to avoid and
  // its place in the run, sequentially so the avoid list accumulates.
  let i = 0;
  while (i < split.length) {
    const anchor = split[i];
    const slots: PlannedSegment[] = [];
    let j = i + 1;
    while (j < split.length && split[j].secondVisual && split[j].script === anchor.script) {
      slots.push(split[j]);
      j++;
    }
    if (slots.length) {
      const avoid: string[] = [];
      if (anchor.imagePrompt?.trim()) avoid.push(anchor.imagePrompt.trim());
      for (const [k, slot] of slots.entries()) {
        try {
          const r = await regenerateSegmentPrompt({
            projectId: PROJECT_ID,
            script: slot.script,
            basePrompt: base,
            blockType: slot.blockType,
            avoidScenes: avoid,
            sequence: { index: k + 2, total: slots.length + 1 },
          });
          slot.imagePrompt = r.imagePrompt;
          slot.shotType = null;
          avoid.push(r.imagePrompt);
        } catch {
          // Keep the slot's inherited prompt, exactly as the planner does.
          if (slot.imagePrompt?.trim()) avoid.push(slot.imagePrompt.trim());
        }
      }
    }
    i = j > i + 1 ? j : i + 1;
  }

  const items: JudgeItem[] = split
    .filter((s) => (s.imagePrompt ?? "").trim())
    .map((s, idx) => ({
      i: idx,
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

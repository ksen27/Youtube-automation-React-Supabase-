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
import { judgeAll, score, sceneOnly, verifyAndRepair, shapeMix, shotShape, type Judged, type JudgeItem } from "@/lib/synthetic/match-verify";

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

async function benchOne(name: string, path: string): Promise<{ name: string; judged: Judged[]; before: Judged[] | null } | null> {
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

  // MATCH VERIFICATION, the same gate the planner runs before persisting.
  // Skipped with --no-verify so the bench can show what the plan looks like
  // WITHOUT it — which is the only way to see what the gate is worth.
  const usable = split.filter((s) => (s.imagePrompt ?? "").trim());
  let before: Judged[] | null = null;
  if (!process.argv.includes("--no-verify")) {
    const { outcomes, judged } = await verifyAndRepair(
      usable.map((s, idx) => ({
        i: idx,
        script: s.script,
        imagePrompt: composePrompt(base, s.imagePrompt ?? null, s.shotType ?? null) ?? "",
      })),
      async (t, why) => {
        const seg = usable[t.i];
        const r = await regenerateSegmentPrompt({
          projectId: PROJECT_ID,
          script: seg.script,
          basePrompt: base,
          blockType: seg.blockType,
          surroundingScript: [usable[t.i - 1]?.script, usable[t.i + 1]?.script].filter(Boolean).join(" "),
          mismatchReason: why,
        });
        return r.imagePrompt;
      },
      { maxRepairs: env.SYNTHETIC_MATCH_VERIFY_MAX_REPAIRS, alsoWeak: env.SYNTHETIC_MATCH_VERIFY_STRICT },
    );
    // The verdicts the gate saw, i.e. this exact plan BEFORE any repair. The
    // only honest way to price the gate: the planner runs at temperature 0.3,
    // so two bench runs produce two different plans and comparing them measures
    // nothing but the weather.
    before = judged;
    for (const o of outcomes) {
      if (!o.rewritten?.trim()) continue;
      usable[o.i].imagePrompt = o.rewritten;
      usable[o.i].shotType = null;
    }
  }

  const items: JudgeItem[] = usable.map((s, idx) => ({
    i: idx,
    script: s.script.trim().slice(0, 400),
    prompt: sceneOnly(composePrompt(base, s.imagePrompt ?? null, s.shotType ?? null) ?? "").slice(0, 400),
  }));

  const { judged, failedBatches } = await judgeAll(items);
  if (failedBatches) console.log(`    (${failedBatches} judge batch(es) failed)`);
  return { name, judged, before };
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
  const results: Array<{ name: string; judged: Judged[]; before: Judged[] | null }> = [];
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

  // BEFORE vs AFTER on the SAME plans. Two bench runs produce two different
  // plans (the planner is temperature 0.3), so a run-to-run comparison measures
  // the weather. This is the only comparison that prices the gate.
  const beforeAll = results.flatMap((r) => r.before ?? []);
  if (beforeAll.length) {
    const b = score(beforeAll);
    console.log(`BEFORE gate  ${b.n} blocks   MATCH ${b.matchPct}%   WEAK ${b.weak}   MISMATCH ${b.mismatch}`);
    console.log(`AFTER  gate  ${s.n} blocks   MATCH ${s.matchPct}%   WEAK ${s.weak}   MISMATCH ${s.mismatch}`);
  } else {
    console.log(`OVERALL  ${s.n} blocks   MATCH ${s.matchPct}%   WEAK ${s.weak}   MISMATCH ${s.mismatch} (${s.mismatchPct}%)`);
  }
  console.log("-".repeat(66));

  // THE OTHER AXIS. Every block above can match its own line while the video is
  // still one picture repeated — "a person examining a rifle" matches a line
  // about a rifle, and thirty percent of a shipped video was exactly that.
  // Contents and shape are measured separately because they fail separately.
  const shapes = shapeMix(all.map((j) => j.prompt));
  console.log("SHOT SHAPES");
  for (const [name, n] of shapes.rows.slice(0, 8)) {
    console.log(`  ${String(Math.round((n / all.length) * 100)).padStart(3)}%  ${String(n).padStart(3)}  ${name}`);
  }

  // --show-shapes prints the prompts inside each bucket. The point is the
  // "other" buckets: they are the classifier saying "I have no name for this",
  // which is NOT the same as saying the shots are varied. A large "other" can
  // hide a new repeated composition just as easily as it can hold genuine
  // variety, and the only way to tell is to read them.
  if (process.argv.includes("--show-shapes")) {
    for (const [name] of shapes.rows) {
      const inBucket = all.filter((j) => shotShape(j.prompt) === name);
      console.log(`\n--- ${name} (${inBucket.length}) ---`);
      for (const j of inBucket) console.log(`  ${j.prompt.slice(0, 120)}`);
    }
  }

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

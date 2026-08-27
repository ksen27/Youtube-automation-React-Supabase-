/* eslint-disable no-console */
// Does a SHIPPED project's picture actually match its own line?
//
//   npx tsx --env-file=.env.local scripts/judge-project-match.ts "<project>" [sampleSize]
//
// audit-project-prompts.ts counts structural markers (missing motion, hands,
// near-identical pairs). It cannot answer the question the client actually
// asks, which is whether the shot on screen belongs to the words being spoken.
//
// Shares its judge with bench-match.ts (scripts/_match-judge.ts) so a score
// here and a score there mean the same thing — otherwise the bench could not
// be used to predict what a real project will look like.
//
// Blocks are sampled EVENLY across the whole project, not from the opening,
// because the opening is the part that always looks best.
//
// Read-only. Gemini text only; no images, no clips.
import { getServerSupabase } from "@/lib/supabase/server";
import { judgeAll, score, sceneOnly, type JudgeItem } from "@/lib/synthetic/match-verify";

async function main() {
  const needle = process.argv[2];
  const sampleSize = Number(process.argv[3] ?? 40);
  if (!needle) {
    console.error('usage: judge-project-match.ts "<project>" [sampleSize]');
    process.exit(1);
  }
  const sb = getServerSupabase();
  const { data: projs } = await sb
    .from("projects").select("id, title, created_at")
    .ilike("title", `%${needle}%`).order("created_at", { ascending: false }).limit(1);
  const proj = (projs ?? [])[0];
  if (!proj) return console.log(`no project matching "${needle}"`);
  console.log(`project: ${proj.title}  (${String(proj.created_at).slice(0, 16)})\n`);

  const { data: segs } = await sb
    .from("synthetic_segments")
    .select("position, block_type, script, image_prompt")
    .eq("project_id", proj.id)
    .order("position", { ascending: true });

  const visual = (segs ?? []).filter(
    (s) => s.block_type !== "avatar" && String(s.image_prompt ?? "").trim() && String(s.script ?? "").trim(),
  );
  if (!visual.length) return console.log("no visual blocks with prompts");

  const step = Math.max(1, Math.floor(visual.length / sampleSize));
  const sample: JudgeItem[] = Array.from(
    { length: Math.min(sampleSize, visual.length) },
    (_, k) => visual[k * step],
  )
    .filter(Boolean)
    .map((s) => ({
      i: Number(s.position),
      script: String(s.script).trim().slice(0, 400),
      prompt: sceneOnly(String(s.image_prompt)).slice(0, 400),
    }));

  console.log(`${visual.length} visual blocks; judging ${sample.length} sampled evenly\n`);
  const { judged, failedBatches } = await judgeAll(sample);
  if (failedBatches) console.log(`(${failedBatches} judge batch(es) failed)\n`);

  const s = score(judged);
  console.log(`MATCH    ${String(s.match).padStart(3)}  (${s.matchPct}%)`);
  console.log(`WEAK     ${String(s.weak).padStart(3)}`);
  console.log(`MISMATCH ${String(s.mismatch).padStart(3)}  (${s.mismatchPct}%)`);

  const bad = judged.filter((a) => a.verdict !== "MATCH");
  if (bad.length) {
    console.log(`\nEVERY NON-MATCH (${bad.length}):`);
    for (const b of bad) {
      console.log(`\n  #${b.i}  ${b.verdict} -- ${b.why}`);
      console.log(`    says : ${b.script.slice(0, 150)}`);
      console.log(`    shows: ${b.prompt.slice(0, 150)}`);
    }
  }
}

main().catch((e) => { console.error("FAILED: " + (e as Error).message); process.exit(1); });

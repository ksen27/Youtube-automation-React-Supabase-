// Was this project planned BEFORE or AFTER the 2026-08-25 prompt fixes?
//
//   npx tsx --env-file=.env.local scripts/audit-project-prompts.ts            # list recent projects
//   npx tsx --env-file=.env.local scripts/audit-project-prompts.ts <project>  # audit one
//
// <project> is a project id or a name fragment ("test2").
//
// Checks the four things the client complained about, each with a marker that is
// visible in the stored plan without rendering anything:
//
//   1. MOTION      ai_clip blocks with animation_prompt NULL. Those reach the
//                  worker and get generic fallback motion unrelated to their own
//                  line -- "the clips are very random and do not match at all".
//   2. BASE PROMPT a recurring world naming a subject/action/framing. It is
//                  appended to EVERY block, so one bad clause is rendered once
//                  per block -- "constantly someone holding a computer on a
//                  mountain".
//   3. HANDS       image prompts whose subject is hands rather than a person or
//                  the object -- "why the all clip is ther hands?".
//   4. REPETITION  near-identical image prompts across the project.
//
// Read-only. Touches nothing.
import { getServerSupabase } from "@/lib/supabase/server";
import { sanitizeBasePrompt } from "@/lib/synthetic/planner";

const HANDS_RE = /\b(hands?|fingers?|palm)\b/i;
const PERSON_RE = /\b(person|people|man|woman|mother|father|girl|boy|child|worker|farmer|she|he|they)\b/i;

/** Jaccard overlap of content words — the same shape the planner's dedupe uses. */
function similarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

async function listProjects() {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("projects")
    .select("id, title, created_at")
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) throw new Error(error.message);
  console.log("Recent projects:\n");
  for (const p of data ?? []) {
    console.log(`  ${String(p.created_at).slice(0, 16)}  ${String(p.id).slice(0, 8)}  ${p.title ?? "(untitled)"}`);
  }
  console.log("\nRe-run with a project id or a name fragment to audit one.");
}

async function audit(needle: string) {
  const sb = getServerSupabase();

  const isUuid = /^[0-9a-f-]{36}$/i.test(needle);
  const q = sb.from("projects").select("id, title, created_at");
  const { data: projs, error: perr } = isUuid
    ? await q.eq("id", needle)
    : await q.ilike("title", `%${needle}%`).order("created_at", { ascending: false }).limit(1);
  if (perr) throw new Error(perr.message);
  const proj = (projs ?? [])[0];
  if (!proj) {
    console.log(`No project matching "${needle}".`);
    return;
  }

  const { data: segs, error: serr } = await sb
    .from("synthetic_segments")
    .select("position, block_type, script, image_prompt, animation_prompt, metadata")
    .eq("project_id", proj.id)
    .order("position", { ascending: true });
  if (serr) throw new Error(serr.message);
  const all = segs ?? [];

  console.log(`PROJECT  ${proj.title ?? "(untitled)"}`);
  console.log(`id       ${proj.id}`);
  console.log(`planned  ${proj.created_at}`);
  console.log(`segments ${all.length}\n`);
  if (all.length === 0) {
    console.log("No segments — this project has not been planned yet.");
    return;
  }

  const byType = new Map<string, number>();
  for (const s of all) byType.set(s.block_type as string, (byType.get(s.block_type as string) ?? 0) + 1);
  console.log("block types:");
  for (const [t, n] of [...byType.entries()].sort()) console.log(`  ${t.padEnd(10)} ${n}`);

  // 1. MOTION
  const clips = all.filter((s) => s.block_type === "ai_clip");
  const noMotion = clips.filter((s) => !((s.animation_prompt as string) ?? "").trim());
  console.log(`\n1. MOTION`);
  console.log(`   ai_clip blocks            : ${clips.length}`);
  console.log(`   with NO animation_prompt  : ${noMotion.length}` + (clips.length ? `  (${Math.round((noMotion.length / clips.length) * 100)}%)` : ""));
  if (noMotion.length > 0) {
    console.log(`   -> those render with GENERIC motion unrelated to their line (pre-fix plan)`);
  }

  // 2. BASE PROMPT
  const base = ((all[0]?.metadata as { base_prompt?: string } | null)?.base_prompt ?? "").trim();
  const { cleaned, dropped } = sanitizeBasePrompt(base);
  console.log(`\n2. BASE PROMPT (appended to every block)`);
  console.log(`   "${base || "(none)"}"`);
  if (dropped.length > 0) {
    console.log(`   -> POISONED. These clauses repeat in all ${all.length} blocks:`);
    for (const d of dropped) console.log(`      - ${d}`);
    console.log(`   -> after the fix it would be: "${cleaned}"`);
  } else if (base) {
    console.log(`   -> clean (setting/mood only)`);
  }

  // 3. HANDS
  const visual = all.filter((s) => ((s.image_prompt as string) ?? "").trim());
  const handsOnly = visual.filter((s) => {
    const p = s.image_prompt as string;
    return HANDS_RE.test(p) && !PERSON_RE.test(p);
  });
  console.log(`\n3. HANDS`);
  console.log(`   visual blocks             : ${visual.length}`);
  console.log(`   hands-but-no-person       : ${handsOnly.length}` + (visual.length ? `  (${Math.round((handsOnly.length / visual.length) * 100)}%)` : ""));

  // 4. REPETITION
  let pairs = 0;
  let worst = { a: -1, b: -1, sim: 0, ta: "", tb: "" };
  for (let i = 0; i < visual.length; i++) {
    for (let j = i + 1; j < Math.min(i + 40, visual.length); j++) {
      const sim = similarity(visual[i].image_prompt as string, visual[j].image_prompt as string);
      if (sim >= 0.6) pairs++;
      if (sim > worst.sim) {
        worst = {
          a: visual[i].position as number,
          b: visual[j].position as number,
          sim,
          ta: visual[i].image_prompt as string,
          tb: visual[j].image_prompt as string,
        };
      }
    }
  }
  console.log(`\n4. REPETITION (within a 40-block window)`);
  console.log(`   near-identical pairs >=0.6: ${pairs}`);
  if (worst.sim > 0) {
    console.log(`   most similar pair (${worst.sim.toFixed(2)}): #${worst.a} vs #${worst.b}`);
    console.log(`      ${worst.ta.slice(0, 110)}`);
    console.log(`      ${worst.tb.slice(0, 110)}`);
  }

  // A few real lines, so the script<->picture relationship can be eyeballed.
  console.log(`\nSAMPLE (script -> picture)`);
  const step = Math.max(1, Math.floor(visual.length / 5));
  for (let i = 0; i < visual.length && i < step * 5; i += step) {
    const s = visual[i];
    console.log(`\n  #${s.position} [${s.block_type}]`);
    console.log(`    says : ${String(s.script ?? "").trim().slice(0, 120)}`);
    console.log(`    shows: ${String(s.image_prompt ?? "").trim().slice(0, 120)}`);
    const anim = String(s.animation_prompt ?? "").trim();
    if (s.block_type === "ai_clip") console.log(`    moves: ${anim || "(NULL -> generic fallback)"}`);
  }

  // WHAT THIS CAN AND CANNOT TELL YOU.
  //
  // The markers below are POSITIVE evidence of a pre-fix plan. Their ABSENCE
  // proves nothing: a plan can carry no NULL animation prompts because Gemini
  // wrote one for every clip it picked itself, and no base_prompt because the
  // model returned an empty one. Neither means the fix was applied.
  //
  // The only conclusive test is the plan timestamp against the deploy that
  // carried the planner changes. Until that deploy happens, EVERY project in the
  // database is pre-fix by definition.
  const markers: string[] = [];
  if (noMotion.length > 0) markers.push(`${noMotion.length} clips with no motion of their own`);
  if (dropped.length > 0) markers.push("a base prompt that repeats a subject in every block");
  if (pairs > 0) markers.push(`${pairs} near-identical prompt pairs`);

  console.log("\nFINDINGS");
  if (markers.length === 0) {
    console.log("  none of the pre-fix markers are present in this plan.");
  } else {
    for (const m of markers) console.log(`  - ${m}`);
  }
  console.log(
    "\nNOTE: absence of a marker is NOT evidence the fix was applied. Compare\n" +
      `      this plan's date (${String(proj.created_at).slice(0, 16)}) against the deploy that\n` +
      "      shipped the planner changes. Any plan older than that deploy is pre-fix\n" +
      "      and needs re-planning to pick the fixes up.",
  );
}

async function main() {
  const arg = process.argv[2];
  if (!arg) await listProjects();
  else await audit(arg);
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

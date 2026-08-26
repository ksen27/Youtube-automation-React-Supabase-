// Dump the most-duplicated prompts in a project, in full, with their scripts.
//
//   npx tsx --env-file=.env.local scripts/show-dupes.ts <project-name> [minSim]
//
// The audit reports HOW MANY near-identical pairs a plan carries; this shows
// WHICH ones and what each was supposed to illustrate. The question it answers:
// are these two blocks repeating because the dedupe cap ran out, or because they
// genuinely describe the same moment twice (a different bug)?
import { getServerSupabase } from "@/lib/supabase/server";

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

async function main() {
  const needle = process.argv[2] ?? "test1";
  const minSim = Number(process.argv[3] ?? 0.85);
  const sb = getServerSupabase();

  const { data: projs } = await sb
    .from("projects")
    .select("id, title")
    .ilike("title", `%${needle}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  const proj = (projs ?? [])[0];
  if (!proj) return console.log(`no project matching "${needle}"`);

  const { data: segs } = await sb
    .from("synthetic_segments")
    .select("position, block_type, script, image_prompt")
    .eq("project_id", proj.id)
    .order("position", { ascending: true });

  const visual = (segs ?? []).filter((s) => ((s.image_prompt as string) ?? "").trim());
  console.log(`${proj.title}  —  ${visual.length} visual blocks, pairs >= ${minSim}\n`);

  let shown = 0;
  for (let i = 0; i < visual.length && shown < 6; i++) {
    for (let j = i + 1; j < Math.min(i + 40, visual.length) && shown < 6; j++) {
      const sim = similarity(visual[i].image_prompt as string, visual[j].image_prompt as string);
      if (sim < minSim) continue;
      shown++;
      const a = visual[i];
      const b = visual[j];
      console.log(`──── pair ${shown}  sim ${sim.toFixed(2)}  #${a.position} vs #${b.position}  (${(b.position as number) - (a.position as number)} blocks apart)`);
      console.log(`  #${a.position} [${a.block_type}]`);
      console.log(`    says : ${String(a.script ?? "").trim().slice(0, 180)}`);
      console.log(`    shows: ${String(a.image_prompt ?? "").trim()}`);
      console.log(`  #${b.position} [${b.block_type}]`);
      console.log(`    says : ${String(b.script ?? "").trim().slice(0, 180)}`);
      console.log(`    shows: ${String(b.image_prompt ?? "").trim()}`);
      console.log();
    }
  }
  if (shown === 0) console.log("(no pairs at that threshold)");
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

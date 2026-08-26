// Quantify two failure modes visible in test1's plan:
//   A. blocks whose image_prompt IS the bare base prompt (Gemini returned an
//      empty per-block scene, so composePrompt fell back to the world alone --
//      every such block renders the SAME generic picture);
//   B. adjacent blocks sharing an identical prompt (the duration-split pass
//      copying one prompt onto both halves).
import { getServerSupabase } from "@/lib/supabase/server";

async function main() {
  const needle = process.argv[2] ?? "test1";
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
    .select("position, block_type, script, image_prompt, metadata")
    .eq("project_id", proj.id)
    .order("position", { ascending: true });
  const all = segs ?? [];

  // The base as actually stored. Read from ANY row that has it, not just row 0 --
  // an avatar block carries no visual metadata.
  let base = "";
  for (const s of all) {
    const b = ((s.metadata as { base_prompt?: string } | null)?.base_prompt ?? "").trim();
    if (b) {
      base = b;
      break;
    }
  }
  console.log(`${proj.title}  -  ${all.length} segments`);
  console.log(`base_prompt in metadata: ${base ? `"${base}"` : "(absent)"}\n`);

  const NUDGE = "Show this from a different angle and composition";
  const visual = all.filter((s) => ((s.image_prompt as string) ?? "").trim());
  // No "Setting:" means composePrompt had no block-specific lead to put first,
  // so the stored prompt is the recurring world and nothing else.
  const baseOnly = visual.filter((s) => !/\bSetting:/.test(String(s.image_prompt)));
  console.log(`A. blocks whose picture IS just the recurring world (no scene of their own)`);
  console.log(`   ${baseOnly.length} of ${visual.length} visual blocks`);
  for (const s of baseOnly.slice(0, 8)) {
    console.log(`     #${s.position} [${s.block_type}]  says: ${String(s.script ?? "").trim().slice(0, 90)}`);
  }
  if (baseOnly.length > 8) console.log(`     ... and ${baseOnly.length - 8} more`);
  const withNudge = baseOnly.filter((s) => String(s.image_prompt).includes(NUDGE)).length;
  console.log(`   (${withNudge} of them are "second visuals" of such a block)`);

  let adjacent = 0;
  const examples: string[] = [];
  for (let i = 1; i < visual.length; i++) {
    const a = String(visual[i - 1].image_prompt).trim();
    const b = String(visual[i].image_prompt).trim();
    if (a && a === b) {
      adjacent++;
      if (examples.length < 6) {
        examples.push(`#${visual[i - 1].position} + #${visual[i].position} [${visual[i].block_type}]`);
      }
    }
  }
  console.log(`\nB. ADJACENT blocks with a byte-identical prompt (same picture twice in a row)`);
  console.log(`   ${adjacent} pairs`);
  for (const e of examples) console.log(`     ${e}`);
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

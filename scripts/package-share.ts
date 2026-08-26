// "its showing too much of the ground turkey in the package" (client 2026-08-26).
//
//   npx tsx --env-file=.env.local scripts/package-share.ts "<project>" [n]
//
// Counts one thing: how many shots are the packaged product. Old prompts from
// the shipped plan vs the same lines re-planned under the current rules, so the
// answer is a delta rather than an opinion.
import { getServerSupabase } from "@/lib/supabase/server";
import { regenerateSegmentPrompt } from "@/lib/synthetic/planner";

// The composition the client is describing: the product in its retail packaging.
const PACKAGE_RE = /\b(package|packaging|packet|tray|wrapper|label|sleeve|carton)\b/i;
const PERSON_RE =
  /\b(person|people|man|woman|shopper|customer|cook|chef|worker|technician|scientist|family|someone)\b/i;

async function main() {
  const needle = process.argv[2] ?? "Ground Turkey";
  const n = Number(process.argv[3] ?? 14);
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
    .select("position, script, image_prompt, metadata")
    .eq("project_id", proj.id)
    .order("position", { ascending: true });

  const visual = (segs ?? []).filter(
    (s) => String(s.image_prompt ?? "").trim() && String(s.script ?? "").trim(),
  );
  let base = "";
  for (const s of segs ?? []) {
    const b = ((s.metadata as { base_prompt?: string } | null)?.base_prompt ?? "").trim();
    if (b) { base = b; break; }
  }

  // Whole-plan share first -- the number the client is reacting to.
  const wholePlanPackage = visual.filter((s) => PACKAGE_RE.test(String(s.image_prompt))).length;
  console.log(`${proj.title}`);
  console.log(`visual blocks                     : ${visual.length}`);
  console.log(`shots of the PACKAGED product     : ${wholePlanPackage}  (${Math.round((wholePlanPackage / visual.length) * 100)}% of the whole video)\n`);

  const step = Math.max(1, Math.floor(visual.length / n));
  const sample = Array.from({ length: n }, (_, i) => visual[i * step]).filter(Boolean);

  let oldPkg = 0;
  let newPkg = 0;
  let oldPerson = 0;
  let newPerson = 0;
  for (const s of sample) {
    const oldP = String(s.image_prompt).replace(/\. Setting:[\s\S]*$/i, "");
    if (PACKAGE_RE.test(oldP)) oldPkg++;
    if (PERSON_RE.test(oldP)) oldPerson++;

    let newP = "";
    try {
      const r = await regenerateSegmentPrompt({
        projectId: "00000000-0000-0000-0000-000000000000",
        script: String(s.script),
        basePrompt: base,
        blockType: "image",
      });
      newP = r.imagePrompt.replace(/\. Setting:[\s\S]*$/i, "");
    } catch (e) {
      newP = `(failed: ${(e as Error).message?.slice(0, 60)})`;
    }
    if (PACKAGE_RE.test(newP)) newPkg++;
    if (PERSON_RE.test(newP)) newPerson++;

    console.log(`#${s.position}  ${PACKAGE_RE.test(oldP) ? "PKG" : "---"} -> ${PACKAGE_RE.test(newP) ? "PKG" : "---"}`);
    console.log(`  says: ${String(s.script).trim().slice(0, 105)}`);
    console.log(`  was : ${oldP.slice(0, 105)}`);
    console.log(`  now : ${newP.slice(0, 105)}\n`);
  }

  console.log("=".repeat(64));
  console.log(`sampled ${sample.length} lines`);
  console.log(`  packaged-product shots  BEFORE ${oldPkg}   AFTER ${newPkg}`);
  console.log(`  a person in frame       BEFORE ${oldPerson}   AFTER ${newPerson}`);
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

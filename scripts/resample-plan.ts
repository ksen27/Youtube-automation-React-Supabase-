// Take REAL lines from a shipped plan, re-plan each one through the CURRENT
// rules, and compare old picture against new.
//
//   npx tsx --env-file=.env.local scripts/resample-plan.ts "<project>" [n]
//
// Fixtures I choose are a weak test -- I pick lines I already know the fix
// handles. These are sampled evenly across the whole script, so the result is
// representative of the video the client actually watched.
import { getServerSupabase } from "@/lib/supabase/server";
import { regenerateSegmentPrompt } from "@/lib/synthetic/planner";

const PERSON_RE =
  /\b(person|people|man|woman|collector|owner|seller|buyer|dealer|shopper|customer|worker|gunsmith|smith|figure|someone|crowd|family)\b/i;
const HAND_RE = /\b(hands?|fingers?|palm)\b/i;
const ISOLATED_RE =
  /\b(resting|sitting|lying|laid|placed|displayed|propped|mounted|arranged)\s+(on|in|against|atop|inside)\b|\bproduct shot\b|\bagainst a (plain|neutral|dark|black|white)\b/i;
const PLACE_RE =
  /\b(shop|store|counter|market|fair|show|auction|workbench|bench|garage|workshop|kitchen|table|room|drawer|box|crate|car|truck|van|range|barn|attic|basement|booth|stall|cabinet|safe|rack|wall|porch|hallway|driveway|street|road|field)\b/i;

type Kind = "person" | "hands" | "situated" | "isolated";
function classify(promptRaw: string): Kind {
  const p = promptRaw.replace(/\. Setting:[\s\S]*$/i, "");
  const person = PERSON_RE.test(p.replace(/\b(a |the )?person(?='s)\b/gi, ""));
  if (person) return "person";
  if (HAND_RE.test(p)) return "hands";
  if (PLACE_RE.test(p) && !ISOLATED_RE.test(p)) return "situated";
  if (PLACE_RE.test(p)) return "situated";
  return "isolated";
}

async function main() {
  const needle = process.argv[2] ?? "Old Guns";
  const n = Number(process.argv[3] ?? 12);
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

  // Evenly spaced across the whole script, not the opening.
  const step = Math.max(1, Math.floor(visual.length / n));
  const sample = Array.from({ length: n }, (_, i) => visual[i * step]).filter(Boolean);

  const before: Record<Kind, number> = { person: 0, hands: 0, situated: 0, isolated: 0 };
  const after: Record<Kind, number> = { person: 0, hands: 0, situated: 0, isolated: 0 };

  for (const s of sample) {
    const oldPrompt = String(s.image_prompt);
    const oldKind = classify(oldPrompt);
    before[oldKind]++;

    let newPrompt = "";
    let newKind: Kind = "isolated";
    try {
      const r = await regenerateSegmentPrompt({
        projectId: "00000000-0000-0000-0000-000000000000",
        script: String(s.script),
        basePrompt: base,
        blockType: "image",
      });
      newPrompt = r.imagePrompt;
      newKind = classify(newPrompt);
    } catch (e) {
      newPrompt = `(failed: ${(e as Error).message?.slice(0, 80)})`;
    }
    after[newKind]++;

    console.log(`\n#${s.position}  ${oldKind} -> ${newKind}`);
    console.log(`  says : ${String(s.script).trim().slice(0, 120)}`);
    console.log(`  was  : ${oldPrompt.replace(/\. Setting:[\s\S]*$/i, "").slice(0, 130)}`);
    console.log(`  now  : ${newPrompt.replace(/\. Setting:[\s\S]*$/i, "").slice(0, 130)}`);
  }

  const row = (label: string, r: Record<Kind, number>) =>
    `${label.padEnd(8)} person ${r.person}  hands ${r.hands}  situated ${r.situated}  ISOLATED ${r.isolated}`;
  console.log(`\n${"=".repeat(70)}`);
  console.log(row("BEFORE", before));
  console.log(row("AFTER", after));
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

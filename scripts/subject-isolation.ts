// "I know the script is about guns, but all we do is show footage about guns."
//
//   npx tsx --env-file=.env.local scripts/subject-isolation.ts "<project>"
//
// The action-line fix only touches lines where somebody DOES something. This
// measures the rest: of every visual block, how many are an ISOLATED shot of the
// topic object (the thing alone on a surface, in a case, on a shelf) versus a
// scene with a person, a place, or a situation in it.
//
// A video can match its script line-for-line and still be 300 close-ups of the
// same object. That is what the client is describing, and it is a different
// failure from mismatch.
import { getServerSupabase } from "@/lib/supabase/server";

// Words that mean a human is present as a subject (not merely a hand).
const PERSON_RE =
  /\b(person|people|man|woman|collector|owner|seller|buyer|dealer|shopper|customer|worker|gunsmith|smith|figure|someone|crowd|family)\b/i;
const HAND_RE = /\b(hands?|fingers?|palm)\b/i;
// An object presented alone: resting/sitting/lying/displayed on or in something.
const ISOLATED_RE =
  /\b(resting|sitting|lying|laid|placed|displayed|propped|mounted|arranged)\s+(on|in|against|atop|inside)\b|\bproduct shot\b|\bagainst a (plain|neutral|dark|black|white)\b/i;
// A place or situation beyond a bare surface.
const CONTEXT_RE =
  /\b(shop|store|market|fair|show|auction|counter|workbench|bench|garage|workshop|kitchen|room|hallway|porch|yard|field|road|street|truck|car|van|table with|estate sale|gun show|range|forest|barn|attic|basement|warehouse|booth|stall)\b/i;

async function main() {
  const needle = process.argv[2] ?? "Old Guns";
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
    .select("position, image_prompt")
    .eq("project_id", proj.id)
    .order("position", { ascending: true });

  const visual = (segs ?? [])
    .map((s) => String(s.image_prompt ?? "").replace(/\. Setting:[\s\S]*$/i, ""))
    .filter((p) => p.trim());

  let person = 0;
  let handsOnly = 0;
  let isolated = 0;
  let contextual = 0;
  for (const p of visual) {
    const hasPerson = PERSON_RE.test(p.replace(/\b(a |the )?person(?='s)\b/gi, ""));
    if (hasPerson) person++;
    else if (HAND_RE.test(p)) handsOnly++;
    else if (ISOLATED_RE.test(p) || !CONTEXT_RE.test(p)) isolated++;
    else contextual++;
  }

  const pct = (n: number) => `${Math.round((n / visual.length) * 100)}%`;
  console.log(`${proj.title}`);
  console.log(`visual blocks                : ${visual.length}\n`);
  console.log(`a PERSON in frame            : ${person}  (${pct(person)})`);
  console.log(`HANDS only                   : ${handsOnly}  (${pct(handsOnly)})`);
  console.log(`the object ALONE / no place  : ${isolated}  (${pct(isolated)})`);
  console.log(`object in a real place/scene : ${contextual}  (${pct(contextual)})`);
  console.log(
    `\n-> ${pct(isolated + handsOnly)} of the video is the topic object with no人 person and no place around it.`.replace("人 ", ""),
  );
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

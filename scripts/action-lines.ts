// Lines that describe SOMEONE DOING SOMETHING -- and what we showed instead.
//
//   npx tsx --env-file=.env.local scripts/action-lines.ts "<project>" [limit]
//
// Client 2026-08-26: "The script is saying a collector drove four hours. Why are
// you showing a gun? You should show someone driving." And: "the script is
// saying the firearms were built. You should show someone building a gun."
//
// The claim is that ACTION lines get OBJECT pictures. This finds every block
// whose narration has a human agent doing something, and prints the picture we
// planned for it, so the claim can be counted rather than argued.
import { getServerSupabase } from "@/lib/supabase/server";

// A person-ish agent followed (loosely) by a past/present action verb.
const AGENT_RE =
  /\b(collector|owner|seller|buyer|dealer|picker|man|woman|someone|family|father|grandfather|smith|gunsmith|worker|maker|soldier|veteran|shooter|hunter|he|she|they|people)\b/i;
const ACTION_RE =
  /\b(drove|drive|driving|built|build|building|made|make|making|carried|carry|walked|walk|bought|buy|buying|sold|sell|selling|handed|hand|opened|open|opening|loaded|load|fired|fire|firing|cleaned|clean|cleaning|inherited|inherit|found|find|discovered|discover|traveled|travelled|travel|visited|visit|worked|work|assembled|assemble|repaired|repair|restored|restore|tested|test|packed|pack|shipped|ship|delivered|deliver)\b/i;

// Does the PICTURE contain a WHOLE human doing something?
//
// "a person's hand holding X" must NOT count. It matches /person/ but it is the
// disembodied-hand shot the client rejects by name, and counting it as a person
// hides the very failure this script exists to measure.
const PICTURE_PERSON_RE =
  /\b(person|people|man|woman|collector|owner|seller|buyer|worker|gunsmith|smith|shopper|customer|figure|someone)\b/i;
const HAND_ONLY_RE = /\b(hands?|fingers?|palm)\b/i;

type Shot = "person" | "hands" | "object";
function classify(prompt: string): Shot {
  const p = prompt.replace(/\. Setting:[\s\S]*$/i, "");
  const hasHand = HAND_ONLY_RE.test(p);
  // A person mentioned ONLY as the owner of a hand ("a person's hand") is a
  // hands shot, not a person shot.
  const bodyBeyondHand = PICTURE_PERSON_RE.test(p.replace(/\b(a |the )?(person|people)(?='s)\b/gi, ""));
  if (bodyBeyondHand) return "person";
  if (hasHand) return "hands";
  return "object";
}

async function main() {
  const needle = process.argv[2] ?? "Old Guns";
  const limit = Number(process.argv[3] ?? 14);
  const sb = getServerSupabase();

  const { data: projs } = await sb
    .from("projects")
    .select("id, title, created_at")
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
  const actionLines = visual.filter((s) => {
    const t = String(s.script ?? "");
    return AGENT_RE.test(t) && ACTION_RE.test(t);
  });

  const buckets: Record<Shot, typeof actionLines> = { person: [], hands: [], object: [] };
  for (const s of actionLines) buckets[classify(String(s.image_prompt))].push(s);
  const missing = [...buckets.object, ...buckets.hands];

  console.log(`${proj.title}`);
  console.log(`planned ${String(proj.created_at).slice(0, 16)}`);
  console.log(`visual blocks                     : ${visual.length}`);
  console.log(`lines with a person DOING something: ${actionLines.length}`);
  const pct = (n: number) => (actionLines.length ? `${Math.round((n / actionLines.length) * 100)}%` : "-");
  console.log(`   shown as a PERSON doing it     : ${buckets.person.length}  (${pct(buckets.person.length)})`);
  console.log(`   shown as HANDS only            : ${buckets.hands.length}  (${pct(buckets.hands.length)})`);
  console.log(`   shown as an OBJECT, no human   : ${buckets.object.length}  (${pct(buckets.object.length)})`);
  console.log(`\nEXAMPLES (action line -> what we planned to show)\n`);

  for (const s of missing.slice(0, limit)) {
    console.log(`#${s.position} [${s.block_type}]`);
    console.log(`  says : ${String(s.script ?? "").trim().slice(0, 150)}`);
    console.log(`  shows: ${String(s.image_prompt ?? "").replace(/\. Setting:[\s\S]*$/, "").trim().slice(0, 150)}`);
    console.log();
  }
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

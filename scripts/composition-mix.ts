/* eslint-disable no-console */
// WHAT SHAPE IS EVERY SHOT? Counts the recurring COMPOSITION across a plan.
//
//   npx tsx --env-file=.env.local scripts/composition-mix.ts "<project>"
//
// The client's 2026-08-27 report: in the gun project "the clip that people
// seeing gun is appeared at many times", and in the mountain project "the clip
// that people seeing computer" — the SAME shot shape in two unrelated videos.
// That is the old "constantly someone holding a computer on a mountain"
// complaint returning, and it is invisible to every check we have:
//
//   - scene dedupe compares NOUNS, and each of these blocks names a different
//     noun, so no pair looks like a repeat;
//   - the match gate judges each block ALONE, and "a person examining a rifle"
//     genuinely does match a line about a rifle, so it passes — every time.
//
// A video can therefore score 100% MATCH with zero duplicate pairs and still be
// one shot repeated three hundred times. This counts the shot SHAPE rather than
// its contents, which is the axis nothing else measures.
//
// Read-only. No model calls.
import { getServerSupabase } from "@/lib/supabase/server";

// Shot shapes, in priority order — the first match wins, so the more specific
// patterns are listed before the general ones.
const SHAPES: Array<{ name: string; re: RegExp }> = [
  // THE ONE THE CLIENT IS REPORTING: a person studying / looking at a thing.
  {
    name: "person EXAMINING a thing",
    re: /\b(examin\w*|inspect\w*|scrutin\w*|studying|studies|peering|looking (?:at|over|closely)|holding .{0,30}\bup to (?:the )?light|magnif\w*|loupe)\b/i,
  },
  { name: "person WORKING on a thing", re: /\b(clean\w*|polish\w*|oil\w*|assembl\w*|fitting|repair\w*|adjust\w*|wiping|applying)\b/i },
  { name: "person AT A SCREEN", re: /\b(laptop|computer|monitor|screen|tablet|display panel)\b/i },
  { name: "person CARRYING / MOVING", re: /\b(carrying|loading|lifting|placing|walking|driving|pushing|hauling)\b/i },
  { name: "documents / paperwork", re: /\b(document|contract|ledger|paperwork|report|invoice|receipt|catalog|book|map|blueprint)\b/i },
  { name: "object ALONE on a surface", re: /\b(resting on|sitting on|lying on|laid out|arranged on|displayed on|on a (?:workbench|table|counter|shelf|cloth))\b/i },
  { name: "wide / place, no person", re: /\b(wide|establishing|aerial|landscape|factory floor|skyline|street)\b/i },
];

const PERSON_RE = /\b(person|people|man|woman|men|women|collector|worker|craftsperson|craftsman|artisan|gunsmith|researcher|scientist|geophysicist|archaeologist|technician|dealer|seller|buyer|someone|hands?)\b/i;

function classify(prompt: string): string {
  const p = prompt.replace(/\.\s*Setting:[\s\S]*$/i, "");
  const hasPerson = PERSON_RE.test(p);
  for (const s of SHAPES) {
    if (s.re.test(p)) {
      // "person X" shapes only count as such when a person is actually present.
      if (s.name.startsWith("person ") && !hasPerson) continue;
      return s.name;
    }
  }
  return hasPerson ? "other, with a person" : "other, no person";
}

async function main() {
  const needle = process.argv[2];
  if (!needle) {
    console.error('usage: composition-mix.ts "<project>"');
    process.exit(1);
  }
  const sb = getServerSupabase();
  const { data: projs } = await sb
    .from("projects").select("id, title, created_at")
    .ilike("title", `%${needle}%`).order("created_at", { ascending: false }).limit(1);
  const proj = (projs ?? [])[0];
  if (!proj) return console.log(`no project matching "${needle}"`);

  const { data: segs } = await sb
    .from("synthetic_segments")
    .select("position, block_type, image_prompt")
    .eq("project_id", proj.id)
    .order("position", { ascending: true });

  const visual = (segs ?? []).filter(
    (s) => s.block_type !== "avatar" && String(s.image_prompt ?? "").trim(),
  );
  if (!visual.length) return console.log("no visual blocks");

  console.log(`project: ${proj.title}  (${String(proj.created_at).slice(0, 16)})`);
  console.log(`${visual.length} visual blocks\n`);

  const counts = new Map<string, number>();
  let withPerson = 0;
  for (const s of visual) {
    const shape = classify(String(s.image_prompt));
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
    if (PERSON_RE.test(String(s.image_prompt))) withPerson++;
  }

  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [shape, n] of rows) {
    const pct = Math.round((n / visual.length) * 100);
    console.log(`  ${String(pct).padStart(3)}%  ${String(n).padStart(4)}  ${shape}  ${"#".repeat(Math.round(pct / 2))}`);
  }
  console.log(`\n  a person is in ${Math.round((withPerson / visual.length) * 100)}% of blocks`);

  const [topShape, topN] = rows[0];
  const topPct = Math.round((topN / visual.length) * 100);
  console.log(
    `\n  DOMINANT SHAPE: "${topShape}" is ${topPct}% of the video.` +
    (topPct >= 30 ? "  <-- one shot, repeated" : ""),
  );
}

main().catch((e) => { console.error("FAILED: " + (e as Error).message); process.exit(1); });

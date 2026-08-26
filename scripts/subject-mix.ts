// Does the VISUAL variety track the SCRIPT's variety?
//
//   npx tsx --env-file=.env.local scripts/subject-mix.ts "<project name>" [docUrl]
//
// The client's standing complaint is repetition ("constantly someone holding a
// computer on a mountain"), and the counter-complaint is mismatch ("gloves for a
// line about a mower"). Both are answered by the same measurement: for each
// concrete thing the SCRIPT talks about, how often does the PICTURE show it?
//
// A script naming fourteen retailers, a lab process and a cooking test has
// plenty of legitimate visual variety available. If the prompts collapse onto
// one noun, that is repetition -- and it is ALSO a matching failure, because the
// lines about the other subjects are getting the wrong picture.
import { getServerSupabase } from "@/lib/supabase/server";

async function main() {
  const needle = process.argv[2] ?? "Ground Turkey";
  const docUrl = process.argv[3];
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
  const all = segs ?? [];
  const visual = all.filter((s) => ((s.image_prompt as string) ?? "").trim());
  const scriptText = all.map((s) => String(s.script ?? "")).join(" ");
  const promptText = visual.map((s) => String(s.image_prompt ?? "")).join(" ");

  // Optional: the source doc, for terms the stored scripts might have dropped.
  if (docUrl) {
    try {
      const { extractDocumentId, fetchGoogleDoc } = await import("@/lib/gdocs/fetch");
      const id = extractDocumentId(docUrl);
      if (id) {
        const doc = await fetchGoogleDoc(id);
        const chars = JSON.stringify(doc).length;
        console.log(`google doc fetched: ${chars} chars of structure\n`);
      }
    } catch (e) {
      console.log(`google doc fetch failed: ${(e as Error).message?.slice(0, 160)}\n`);
    }
  }

  const count = (hay: string, term: string) =>
    (hay.toLowerCase().match(new RegExp(`\\b${term.toLowerCase()}\\w*`, "g")) ?? []).length;

  // Subjects this script actually contains, grouped by what a viewer would see.
  const TERMS: Array<[string, string[]]> = [
    ["the meat itself", ["ground turkey", "turkey", "meat", "patty", "mince"]],
    ["packaging / label", ["package", "packaging", "label", "tray", "wrapper", "barcode"]],
    ["retailers", ["walmart", "costco", "target", "aldi", "kroger", "publix", "safeway", "wegmans", "trader", "whole foods", "store", "supermarket", "aisle", "shelf"]],
    ["price / receipt", ["price", "cost", "receipt", "dollar", "tag"]],
    ["testing / lab", ["lab", "test", "sample", "microscope", "thermometer", "scale", "weigh"]],
    ["cooking", ["cook", "pan", "skillet", "grill", "stove", "kitchen"]],
    ["people", ["person", "woman", "man", "shopper", "customer", "family"]],
    ["hands", ["hand", "finger"]],
  ];

  console.log(`${proj.title}`);
  console.log(`${visual.length} visual blocks\n`);
  console.log("subject".padEnd(20) + "in SCRIPT".padStart(12) + "in PICTURES".padStart(14));
  console.log("-".repeat(46));
  for (const [label, terms] of TERMS) {
    const inScript = terms.reduce((n, t) => n + count(scriptText, t), 0);
    const inPrompt = terms.reduce((n, t) => n + count(promptText, t), 0);
    console.log(label.padEnd(20) + String(inScript).padStart(12) + String(inPrompt).padStart(14));
  }

  // How many DISTINCT retailers appear in the pictures? The script names 14; a
  // plan that shows one of them is repeating rather than illustrating.
  const RETAILERS = ["walmart", "costco", "target", "aldi", "kroger", "publix", "safeway", "wegmans", "trader joe", "whole foods", "sam's club", "meijer", "heb", "winco"];
  const inScript = RETAILERS.filter((r) => scriptText.toLowerCase().includes(r));
  const inPrompt = RETAILERS.filter((r) => promptText.toLowerCase().includes(r));
  console.log(`\nnamed retailers in the script  : ${inScript.length}  (${inScript.join(", ") || "none"})`);
  console.log(`named retailers in the pictures: ${inPrompt.length}  (${inPrompt.join(", ") || "none"})`);

  // Blocks whose picture is a meat close-up, as a share of everything.
  const meat = visual.filter((s) => /\b(ground turkey|turkey meat|raw turkey|mince|patty)\b/i.test(String(s.image_prompt)));
  console.log(`\nblocks showing the meat itself : ${meat.length} of ${visual.length} (${Math.round((meat.length / visual.length) * 100)}%)`);
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

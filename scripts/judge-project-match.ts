/* eslint-disable no-console */
// Does a SHIPPED project's picture actually match its own line?
//
//   npx tsx --env-file=.env.local scripts/judge-project-match.ts "<project>" [sampleSize]
//
// audit-project-prompts.ts counts structural markers (missing motion, hands,
// near-identical pairs). It cannot answer the question the client actually
// asks, which is whether the shot on screen belongs to the words being spoken.
//
// SCORED BY LLM JUDGE, NOT KEYWORDS -- the same reasoning as
// prompt-match-check.ts: a keyword test scores "a receipt for a lawn mower" as
// a MATCH for a line about a mower, and showing the receipt instead of the
// machine is exactly what gets rejected. The judge is asked the client's own
// question: hearing this line and seeing this picture, do they belong together?
//
// Blocks are sampled EVENLY across the whole project, not from the opening,
// because the opening is the part that always looks best.
//
// Read-only. Gemini text only; no images, no clips.
import { getServerSupabase } from "@/lib/supabase/server";
import { withGeminiModelFallback } from "@/lib/ai/gemini";

type Verdict = "MATCH" | "WEAK" | "MISMATCH";
interface Judged { i: number; verdict: Verdict; why: string; script: string; prompt: string }

const BATCH = 10;

function buildPrompt(rows: Array<{ i: number; script: string; prompt: string }>): string {
  return [
    "You are reviewing a narrated video. For each item you get the NARRATION",
    "the viewer HEARS and a description of the PICTURE they SEE at that moment.",
    "",
    "Answer one question per item: does the picture belong to those words?",
    "",
    'Return STRICT JSON ONLY: {"items":[{"i":<number>,"verdict":"MATCH|WEAK|MISMATCH","why":"<=15 words"}]}',
    "",
    "MATCH    - a viewer instantly sees the connection. The picture shows the",
    "           main thing the line is about, or the event it describes.",
    "WEAK     - same general world, but the picture is not what the line is",
    "           about: a related object, a detail at the edge, or a generic shot",
    "           of the topic where the line named something specific.",
    "MISMATCH - the picture shows something the line is not about at all, or",
    "           hides/omits the thing the line describes.",
    "",
    "Be strict. Being on-topic is NOT a match: a video about guns showing a gun",
    "while the line is about a factory closing is a MISMATCH. A line describing",
    "how something LOOKS, illustrated by that thing wrapped, covered or boxed,",
    "is a MISMATCH -- the viewer cannot see what is being described.",
    "",
    "ITEMS:",
    ...rows.map((r) => `[${r.i}]\nHEARS: ${r.script}\nSEES: ${r.prompt}\n`),
  ].join("\n");
}

async function judge(rows: Array<{ i: number; script: string; prompt: string }>): Promise<Judged[]> {
  const { result } = await withGeminiModelFallback("judgeProjectMatch", async (model) => {
    const res = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: buildPrompt(rows) }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    });
    const parsed = JSON.parse(res.response.text());
    if (!parsed?.items?.length) throw new Error("judge returned no items");
    return parsed as { items: Array<{ i: number; verdict: Verdict; why: string }> };
  }, { attempts: 2, baseMs: 800 }, { attempts: 3, baseMs: 1500 });

  return result.items.map((it) => {
    const src = rows.find((r) => r.i === it.i);
    return { i: it.i, verdict: it.verdict, why: it.why, script: src?.script ?? "", prompt: src?.prompt ?? "" };
  });
}

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
  const sample = Array.from({ length: Math.min(sampleSize, visual.length) }, (_, k) => visual[k * step])
    .filter(Boolean)
    .map((s) => ({
      i: Number(s.position),
      script: String(s.script).trim().slice(0, 400),
      // Judge the scene, not the recurring world tacked on the end.
      prompt: String(s.image_prompt).replace(/\.\s*Setting:[\s\S]*$/i, "").trim().slice(0, 400),
    }));

  console.log(`${visual.length} visual blocks; judging ${sample.length} sampled evenly\n`);

  const all: Judged[] = [];
  for (let i = 0; i < sample.length; i += BATCH) {
    const chunk = sample.slice(i, i + BATCH);
    try {
      all.push(...(await judge(chunk)));
    } catch (e) {
      console.error(`  batch at ${i} failed: ${(e as Error).message.slice(0, 120)}`);
    }
    process.stdout.write(`\r  judged ${all.length}/${sample.length}`);
  }
  console.log("\n");

  const n = all.length || 1;
  const count = (v: Verdict) => all.filter((a) => a.verdict === v).length;
  const pct = (v: Verdict) => Math.round((count(v) / n) * 100);
  console.log(`MATCH    ${String(count("MATCH")).padStart(3)}  (${pct("MATCH")}%)`);
  console.log(`WEAK     ${String(count("WEAK")).padStart(3)}  (${pct("WEAK")}%)`);
  console.log(`MISMATCH ${String(count("MISMATCH")).padStart(3)}  (${pct("MISMATCH")}%)`);

  const bad = all.filter((a) => a.verdict !== "MATCH");
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

/* eslint-disable no-console */
// WHAT IS ON SCREEN IN THE FIRST N SECONDS?
//
//   npx tsx --env-file=.env.local scripts/opening-minute.ts "<project>" [seconds]
//
// The client's 2026-08-27 feedback: "I wanted only footage in the first
// minutes ... the first minute is forty-one, fifty-one seconds of animated
// scenes. This basically means that it's 100% animated."
//
// That is a claim about the OPENING specifically, and about block TYPES rather
// than prompts. Everything measured so far has been about whether a prompt
// matches its line, which cannot answer it. This breaks the opening down by
// type and by seconds held.
//
// Read-only. No model calls.
import { getServerSupabase } from "@/lib/supabase/server";

async function main() {
  const needle = process.argv[2];
  const window = Number(process.argv[3] ?? 60);
  if (!needle) {
    console.error('usage: opening-minute.ts "<project>" [seconds]');
    process.exit(1);
  }
  const sb = getServerSupabase();
  const { data: projs } = await sb
    .from("projects").select("id, title, engine, created_at")
    .ilike("title", `%${needle}%`).order("created_at", { ascending: false }).limit(1);
  const proj = (projs ?? [])[0];
  if (!proj) return console.log(`no project matching "${needle}"`);

  const { data: segs } = await sb
    .from("synthetic_segments")
    .select("position, block_type, start_time, end_time, duration, provider, metadata")
    .eq("project_id", proj.id)
    .order("position", { ascending: true });

  const all = segs ?? [];
  const opening = all.filter((s) => Number(s.start_time) < window);
  console.log(`project: ${proj.title}   engine=${proj.engine}   (${String(proj.created_at).slice(0, 16)})`);
  console.log(`${all.length} blocks total; ${opening.length} start inside the first ${window}s\n`);

  // Seconds held by each block type inside the window (clipped at the edge, so
  // a block straddling the boundary contributes only the part on screen).
  const held = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const s of opening) {
    const start = Number(s.start_time);
    const end = Math.min(Number(s.end_time), window);
    const secs = Math.max(0, end - start);
    const t = String(s.block_type);
    held.set(t, (held.get(t) ?? 0) + secs);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  const total = [...held.values()].reduce((a, b) => a + b, 0) || 1;
  console.log(`FIRST ${window}s BY BLOCK TYPE`);
  for (const [t, secs] of [...held.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = Math.round((secs / total) * 100);
    console.log(
      `  ${String(pct).padStart(3)}%  ${secs.toFixed(1).padStart(5)}s  ${String(counts.get(t)).padStart(3)} blocks  ${t}`,
    );
  }

  // MOVING vs STILL is the distinction the client is drawing: an ai_clip is an
  // animated still, an image does not move at all. Neither is real footage.
  const moving = (held.get("ai_clip") ?? 0);
  const still = (held.get("image") ?? 0);
  const avatarSecs = (held.get("avatar") ?? 0) + (held.get("split_2") ?? 0);
  console.log(`\n  animated (ai_clip) : ${moving.toFixed(1)}s  (${Math.round((moving / total) * 100)}%)`);
  console.log(`  still (image)      : ${still.toFixed(1)}s  (${Math.round((still / total) * 100)}%)`);
  console.log(`  avatar / split_2   : ${avatarSecs.toFixed(1)}s  (${Math.round((avatarSecs / total) * 100)}%)`);
  console.log(`\n  NOTE: on the synthetic engine there is no real-footage block type at all.`);
  console.log(`  Every one of the above is generated — an ai_clip is an animated still.`);

  console.log(`\nFIRST ${Math.min(opening.length, 20)} BLOCKS`);
  for (const s of opening.slice(0, 20)) {
    console.log(
      `  #${String(s.position).padStart(3)}  ${String(s.block_type).padEnd(8)}` +
      `  ${Number(s.start_time).toFixed(1).padStart(6)}s -> ${Number(s.end_time).toFixed(1).padStart(6)}s` +
      `  (${Number(s.duration).toFixed(1)}s)  ${s.provider ?? ""}`,
    );
  }
}

main().catch((e) => { console.error("FAILED: " + (e as Error).message); process.exit(1); });

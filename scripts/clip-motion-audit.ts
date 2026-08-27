/* eslint-disable no-console */
// HOW MUCH DOES A CLIP ACTUALLY MOVE?
//
//   npx tsx --env-file=.env.local scripts/clip-motion-audit.ts "<project>"
//
// Client, 2026-08-27, scrolling their timeline: "Image. Image. Image." while
// also saying the first minute is "100% animated". Both are true at once only
// if the clips move so little that they read as stills.
//
// This codebase has been here before. constants.ts records that the 2026-08-22
// "SLOWLY, calmly and deliberately" wording, paired with a LOCKED-OFF camera
// and a 4s clip, left "nothing in frame allowed to move at a visible rate" and
// "clips came back reading as stills" -- reverted three days later. A slow rule
// went back in on 2026-08-26.
//
// So: read the stored animation prompts and count how many describe motion that
// would be visible, versus motion that would not.
//
// Read-only. No model calls.
import { getServerSupabase } from "@/lib/supabase/server";

// Wording that caps how far anything travels. Each of these was added to fix a
// real artifact; together they can leave a clip with nothing to show.
const DAMPENERS: Array<{ name: string; re: RegExp }> = [
  { name: "slow / unhurried / gentle", re: /\b(slow(?:ly)?|unhurried|gentle|gently|calm(?:ly)?|deliberate(?:ly)?|softly|subtle|slight(?:ly)?)\b/i },
  { name: "small / minimal movement", re: /\b(small|minimal|barely|faint(?:ly)?|a little|slightly|micro|tiny)\b/i },
  { name: "in place / no travel", re: /\b(in place|stays? (?:still|put)|without moving|remains? (?:still|stationary)|shifting slightly)\b/i },
];

// Wording that means something genuinely crosses the frame.
const TRAVEL_RE =
  /\b(walk\w*|driv\w*|run\w*|carry\w*|lift\w*|pour\w*|open\w*|clos\w*|push\w*|pull\w*|throw\w*|hand\w*|load\w*|swing\w*|turn\w*|rise|rises|fall\w*|enter\w*|exit\w*|arriv\w*|leav\w*|pass\w*|cross\w*|sweep\w*|spread\w*)\b/i;

// Ambient-only motion: real, but tiny by definition.
const AMBIENT_RE = /\b(dust|motes|steam|smoke|flicker\w*|shimmer\w*|sway\w*|ripple\w*|breeze|drift\w*|light shift\w*|glint\w*|sparkle\w*)\b/i;

async function main() {
  const needle = process.argv[2];
  if (!needle) { console.error('usage: clip-motion-audit.ts "<project>"'); process.exit(1); }
  const sb = getServerSupabase();
  const { data: projs } = await sb
    .from("projects").select("id, title, created_at")
    .ilike("title", `%${needle}%`).order("created_at", { ascending: false }).limit(1);
  const proj = (projs ?? [])[0];
  if (!proj) return console.log(`no project matching "${needle}"`);

  const { data: segs } = await sb
    .from("synthetic_segments")
    .select("position, block_type, animation_prompt, image_prompt")
    .eq("project_id", proj.id).eq("block_type", "ai_clip")
    .order("position", { ascending: true });

  const clips = segs ?? [];
  console.log(`project: ${proj.title}  (${String(proj.created_at).slice(0, 16)})`);
  console.log(`${clips.length} ai_clip blocks\n`);
  if (!clips.length) return;

  let noPrompt = 0, travel = 0, ambientOnly = 0, neither = 0;
  const dampCounts = new Map<string, number>();
  let anyDamp = 0;

  for (const c of clips) {
    const a = String(c.animation_prompt ?? "").trim();
    if (!a) { noPrompt++; continue; }
    let damped = false;
    for (const d of DAMPENERS) {
      if (d.re.test(a)) { dampCounts.set(d.name, (dampCounts.get(d.name) ?? 0) + 1); damped = true; }
    }
    if (damped) anyDamp++;
    if (TRAVEL_RE.test(a)) travel++;
    else if (AMBIENT_RE.test(a)) ambientOnly++;
    else neither++;
  }

  const withPrompt = clips.length - noPrompt || 1;
  console.log("WHAT THE MOTION IS");
  console.log(`  ${String(Math.round((travel / withPrompt) * 100)).padStart(3)}%  ${String(travel).padStart(3)}  something TRAVELS (a real action crosses the frame)`);
  console.log(`  ${String(Math.round((ambientOnly / withPrompt) * 100)).padStart(3)}%  ${String(ambientOnly).padStart(3)}  ambient only (dust, steam, shimmer, sway)`);
  console.log(`  ${String(Math.round((neither / withPrompt) * 100)).padStart(3)}%  ${String(neither).padStart(3)}  neither named`);
  if (noPrompt) console.log(`        ${noPrompt}  no stored animation_prompt (worker falls back to a generic default)`);

  console.log("\nDAMPENING WORDS (these cap how far anything moves)");
  for (const [name, n] of [...dampCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(Math.round((n / withPrompt) * 100)).padStart(3)}%  ${String(n).padStart(3)}  ${name}`);
  }
  console.log(`\n  ${Math.round((anyDamp / withPrompt) * 100)}% of clips carry at least one dampening word.`);
  console.log(`  Every clip additionally has a LOCKED-OFF camera (no pan, zoom, push-in or tilt).`);

  console.log("\nSAMPLE MOTION PROMPTS");
  for (const c of clips.slice(0, 8)) {
    console.log(`  #${String(c.position).padStart(3)}  ${String(c.animation_prompt ?? "(none)").slice(0, 150)}`);
  }
}

main().catch((e) => { console.error("FAILED: " + (e as Error).message); process.exit(1); });

import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const BEARING = new Set(["footage","image","split_2","split_4","title_card","avatar","ai_clip"]);

const { data: projs } = await sb
  .from("projects")
  .select("id, title, status, voiceover_duration_seconds, intro_duration_seconds")
  .eq("engine", "synthetic")
  .order("updated_at", { ascending: false });

console.log("Synthetic projects audit:\n");
for (const p of projs ?? []) {
  const { data: segs } = await sb.from("synthetic_segments").select("id, status").eq("project_id", p.id);
  const { data: items } = await sb.from("timeline_items").select("type, duration, metadata").eq("project_id", p.id);
  const seg = segs ?? [], it = items ?? [];
  const ready = seg.filter((s:any)=>s.status==="ready").length;
  const nonTerminal = seg.filter((s:any)=>!["ready","failed","skipped"].includes(String(s.status))).length;
  const tlSum = it.filter((i:any)=>BEARING.has(String(i.type))).reduce((a:number,i:any)=>a+(Number(i.duration)||0),0);
  const vo = Number(p.voiceover_duration_seconds)||0;
  const intro = Math.max(0, Number(p.intro_duration_seconds)||0);
  const voEff = Math.max(0, vo-intro);
  const delta = voEff>0 ? Math.abs(tlSum - voEff) : 0;
  // ready segments not present in timeline
  const matSet = new Set(it.map((i:any)=>(i.metadata?.synthetic_segment_id)).filter(Boolean));
  const readyMissing = seg.filter((s:any)=>s.status==="ready" && !matSet.has(s.id)).length;

  let verdict = "OK ✅";
  if (nonTerminal>0) verdict = `STILL GENERATING (${nonTerminal} pending)`;
  else if (seg.length===0) verdict = "no segments (not planned)";
  else if (readyMissing>0) verdict = `BROKEN ❌ (${readyMissing} ready blocks missing from timeline)`;
  else if (voEff>0 && delta>3) verdict = `WILL FAIL ❌ (delta ${delta.toFixed(0)}s)`;

  console.log(`${verdict}`);
  console.log(`   "${p.title}" status=${p.status}`);
  console.log(`   segs=${seg.length} ready=${ready} | items=${it.length} | tlSum=${tlSum.toFixed(0)}s voEff=${voEff.toFixed(0)}s delta=${delta.toFixed(1)}s`);
  console.log(`   id=${p.id}\n`);
}

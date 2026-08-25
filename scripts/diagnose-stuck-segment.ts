// Why is a block showing "Stuck — its render stopped without finishing"?
// Finds the project by title fragment, then prints every segment still at
// 'generating' next to its LATEST media_job (the pair the review screen
// cross-references) so the real failure reason is visible.
//
//   npx tsx --env-file=.env.local scripts/diagnose-stuck-segment.ts "Mount Sinai"
import { getServerSupabase } from "@/lib/supabase/server";

async function main() {
  const needle = process.argv[2];
  if (!needle) throw new Error("usage: diagnose-stuck-segment.ts <title fragment>");
  const sb = getServerSupabase();

  const { data: projects, error } = await sb
    .from("projects")
    .select("id, title, status, engine, created_at, updated_at")
    .ilike("title", `%${needle}%`)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  if (!projects?.length) return console.log(`no project matching "${needle}"`);

  for (const p of projects) {
    console.log(`\n=== ${p.title}\n    ${p.id}  engine=${p.engine} status=${p.status} updated=${p.updated_at}`);

    const { data: segs } = await sb
      .from("synthetic_segments")
      .select("id, position, block_type, provider, status, error, updated_at")
      .eq("project_id", p.id)
      .order("position", { ascending: true });

    const counts: Record<string, number> = {};
    for (const s of segs ?? []) counts[s.status as string] = (counts[s.status as string] ?? 0) + 1;
    console.log(`    segments: ${JSON.stringify(counts)}`);

    for (const s of segs ?? []) {
      if (s.status !== "generating" && s.status !== "failed") continue;
      const { data: jobs } = await sb
        .from("media_jobs")
        .select("id, type, status, error, attempts, created_at, updated_at")
        .eq("project_id", p.id)
        .contains("metadata", { segmentId: s.id })
        .order("created_at", { ascending: false })
        .limit(2);
      const j = jobs?.[0];
      const ageMin = j ? Math.round((Date.now() - new Date(j.updated_at as string).getTime()) / 60000) : null;
      console.log(
        `\n    #${s.position} ${s.block_type} provider=${s.provider ?? "-"} seg.status=${s.status}` +
        `\n      seg.error : ${s.error ?? "(none)"}` +
        (j
          ? `\n      job       : ${j.type} status=${j.status} attempts=${j.attempts ?? "?"} last-write ${ageMin}m ago` +
            `\n      job.error : ${j.error ?? "(none)"}` +
            `\n      jobs seen : ${jobs?.length}`
          : `\n      job       : NONE (never dispatched)`),
      );
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

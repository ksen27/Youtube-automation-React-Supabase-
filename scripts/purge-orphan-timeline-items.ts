// Delete ORPHANED synthetic timeline_items — rows left behind by a re-plan.
//
// THE BUG (fixed in lib/synthetic/planner.ts, 2026-08-15)
// ------------------------------------------------------
// Re-planning a synthetic project deleted synthetic_segments but NOT
// timeline_items. Because timeline_items.synthetic_segment_id is `on delete set
// null` (migration 0024), dropping the segments NULLED the old rows' link,
// leaving them invisible to the unique index and to maybeFinalizeSynthetic —
// but still counted by the render route's duration gate. The symptom is
// "Timeline duration must match voiceover" with a delta of roughly one whole
// voiceover.
//
// An ORPHAN here is a timeline_item whose metadata.synthetic_segment_id names a
// synthetic_segments row that NO LONGER EXISTS. That is the only reliable
// marker: the real column was already nulled by the FK, and created_at is not
// trustworthy (a legitimate re-materialize also writes fresh rows).
//
// DELIBERATELY NOT TOUCHED:
//   • rows whose segment still exists (the live plan);
//   • rows with no synthetic_segment_id in metadata at all — that is the
//     sales-pitch row (metadata.kind='pitch_video') and any sourced-engine row.
//     Never infer "orphan" from a missing id; only from an id that resolves to
//     nothing.
//
// DRY RUN BY DEFAULT. Pass --apply to delete. Pass --project <uuid> to scope to
// one project.
//
//   npx tsx --env-file=.env.local scripts/purge-orphan-timeline-items.ts
//   npx tsx --env-file=.env.local scripts/purge-orphan-timeline-items.ts --apply
//   npx tsx --env-file=.env.local scripts/purge-orphan-timeline-items.ts --project <uuid> --apply
import { getServerSupabase } from "@/lib/supabase/server";

type Item = {
  id: string;
  project_id: string;
  type: string;
  duration: number | null;
  synthetic_segment_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

async function pageAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const pIdx = process.argv.indexOf("--project");
  const onlyProject = pIdx >= 0 ? process.argv[pIdx + 1] : null;
  const sb = getServerSupabase();

  // Only synthetic projects can have these rows.
  let projQ = sb.from("projects").select("id, title").eq("engine", "synthetic");
  if (onlyProject) projQ = projQ.eq("id", onlyProject);
  const { data: projects, error: projErr } = await projQ;
  if (projErr) throw new Error(`projects read failed: ${projErr.message}`);

  let totalOrphans = 0;
  let totalSeconds = 0;
  const victims: string[] = [];
  const affectedProjects = new Set<string>();

  for (const p of (projects ?? []) as Array<{ id: string; title: string }>) {
    const items = await pageAll<Item>((from, to) =>
      sb
        .from("timeline_items")
        .select("id, project_id, type, duration, synthetic_segment_id, metadata, created_at")
        .eq("project_id", p.id)
        .range(from, to),
    );
    if (items.length === 0) continue;

    const segs = await pageAll<{ id: string }>((from, to) =>
      sb.from("synthetic_segments").select("id").eq("project_id", p.id).range(from, to),
    );
    const live = new Set(segs.map((s) => s.id));

    const orphans = items.filter((it) => {
      const metaId = (it.metadata ?? {})["synthetic_segment_id"] as string | undefined;
      // No recorded segment id => pitch row / sourced row. Leave it alone.
      if (!metaId) return false;
      // Segment still exists (via either the column or metadata) => live row.
      if (it.synthetic_segment_id && live.has(it.synthetic_segment_id)) return false;
      return !live.has(metaId);
    });
    if (orphans.length === 0) continue;

    const secs = orphans.reduce((s, it) => s + (Number(it.duration) || 0), 0);
    const liveSecs = items
      .filter((it) => it.synthetic_segment_id && live.has(it.synthetic_segment_id))
      .reduce((s, it) => s + (Number(it.duration) || 0), 0);

    console.log(`\n${p.title ?? "(untitled)"}`);
    console.log(`  project        : ${p.id}`);
    console.log(`  timeline rows  : ${items.length}  (live segments: ${live.size})`);
    console.log(`  ORPHANS        : ${orphans.length}  (${secs.toFixed(1)}s)`);
    console.log(`  live rows sum  : ${liveSecs.toFixed(1)}s  <- what the render gate SHOULD see`);

    totalOrphans += orphans.length;
    totalSeconds += secs;
    affectedProjects.add(p.id);
    victims.push(...orphans.map((o) => o.id));
  }

  console.log(
    `\n=== ${totalOrphans} orphan rows across ${affectedProjects.size} project(s), ${totalSeconds.toFixed(1)}s total ===`,
  );

  if (totalOrphans === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (!apply) {
    console.log("DRY RUN — nothing deleted. Re-run with --apply.");
    return;
  }

  const BATCH = 500;
  let deleted = 0;
  for (let i = 0; i < victims.length; i += BATCH) {
    const chunk = victims.slice(i, i + BATCH);
    const { error } = await sb.from("timeline_items").delete().in("id", chunk);
    if (error) throw new Error(`delete failed: ${error.message}`);
    deleted += chunk.length;
    console.log(`  deleted ${deleted}/${victims.length}`);
  }
  console.log(`\nDone. Removed ${deleted} orphan timeline_items.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

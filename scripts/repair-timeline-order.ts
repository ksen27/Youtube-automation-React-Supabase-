import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { getServerSupabase } from "@/lib/supabase/server";
import { reconcileTimelineOrder } from "@/lib/synthetic/pitch-timeline";

// REPAIR: put a synthetic project's timeline back into play order.
//
// For projects damaged BEFORE the ordering fix. The old code renumbered
// timeline_items.position from two racing loops and then compacted the result,
// which turned a scrambled order into a tidy scrambled order — unique,
// contiguous, and still wrong. The render concatenates strictly by that column
// against one continuous voiceover, so the finished video played its blocks out
// of order (project e8177073, 2026-08-21: last 23 blocks first, opening avatar
// third).
//
// Nothing is regenerated and no asset is touched — this only rewrites
// `position`. After a repair the project must be RE-RENDERED to get a correct
// video; the existing output_url is still the scrambled one.
//
//   npm run timeline:repair -- <projectId>          # report only
//   npm run timeline:repair -- <projectId> --apply  # repair
//   npm run timeline:repair -- --all                # report every synthetic project
//   npm run timeline:repair -- --all --apply
//
// Safe to run repeatedly: the reconcile is idempotent and a settled timeline
// costs zero writes.

interface Diagnosis {
  projectId: string;
  title: string | null;
  rows: number;
  segments: number;
  /** Adjacent pairs where the later row plays an EARLIER segment. 0 = correct. */
  inversions: number;
  /** Which segment index currently plays first (should be 0). */
  firstSegmentIndex: number | null;
  orphanRows: number;
}

async function diagnose(projectId: string): Promise<Diagnosis> {
  const sb = getServerSupabase();
  const [{ data: proj }, { data: segs }, { data: items }] = await Promise.all([
    sb.from("projects").select("title").eq("id", projectId).single(),
    sb.from("synthetic_segments").select("id, position").eq("project_id", projectId),
    sb
      .from("timeline_items")
      .select("id, position, synthetic_segment_id")
      .eq("project_id", projectId)
      .order("position", { ascending: true }),
  ]);
  const segPos = new Map((segs ?? []).map((s) => [s.id as string, Number(s.position)] as const));
  const rows = items ?? [];
  // The segment each row plays, in the order the renderer would play them.
  const played: number[] = [];
  let orphanRows = 0;
  for (const row of rows) {
    const segId = row.synthetic_segment_id as string | null;
    if (!segId) continue; // pitch row — placed separately, not part of this check
    const pos = segPos.get(segId);
    if (pos === undefined) orphanRows++;
    else played.push(pos);
  }
  let inversions = 0;
  for (let i = 1; i < played.length; i++) if (played[i] < played[i - 1]) inversions++;
  return {
    projectId,
    title: (proj?.title as string | null) ?? null,
    rows: rows.length,
    segments: segPos.size,
    inversions,
    firstSegmentIndex: played.length > 0 ? played[0] : null,
    orphanRows,
  };
}

function report(d: Diagnosis, when: string): void {
  const verdict = d.inversions === 0 ? "IN ORDER" : `OUT OF ORDER (${d.inversions} inversions)`;
  console.log(
    `  ${when.padEnd(7)} ${verdict} — ${d.rows} rows / ${d.segments} segments, ` +
      `plays segment ${d.firstSegmentIndex} first` +
      (d.orphanRows > 0 ? `, ${d.orphanRows} orphan rows` : ""),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const all = args.includes("--all");
  const ids = args.filter((a) => !a.startsWith("--"));

  if (!all && ids.length === 0) {
    console.error("usage: npm run timeline:repair -- <projectId> [--apply]");
    console.error("       npm run timeline:repair -- --all [--apply]");
    process.exit(1);
  }

  const sb = getServerSupabase();
  let targets = ids;
  if (all) {
    const { data, error } = await sb
      .from("projects")
      .select("id")
      .eq("engine", "synthetic")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`list projects: ${error.message}`);
    targets = (data ?? []).map((p) => p.id as string);
  }
  console.log(`${targets.length} project(s), mode: ${apply ? "APPLY" : "report only"}\n`);

  let damaged = 0;
  let repaired = 0;
  let failed = 0;
  for (const projectId of targets) {
    const before = await diagnose(projectId);
    if (before.inversions === 0 && !apply) continue; // quiet on healthy projects
    console.log(`${projectId}  ${before.title ?? "(untitled)"}`);
    report(before, "before");
    if (before.inversions > 0) damaged++;
    if (!apply) {
      console.log("");
      continue;
    }
    try {
      const result = await reconcileTimelineOrder(projectId);
      const after = await diagnose(projectId);
      report(after, "after");
      console.log(
        `  ${result.writes} position write(s), verified=${result.verified}` +
          (after.inversions === 0 && before.inversions > 0
            ? " — REPAIRED, re-render this project to get a correct video"
            : ""),
      );
      if (after.inversions === 0 && before.inversions > 0) repaired++;
      if (!result.verified || after.inversions > 0) failed++;
    } catch (e) {
      failed++;
      console.log(`  FAILED: ${(e as Error).message}`);
    }
    console.log("");
  }
  console.log(
    `done — ${damaged} out of order` + (apply ? `, ${repaired} repaired, ${failed} still failing` : ""),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

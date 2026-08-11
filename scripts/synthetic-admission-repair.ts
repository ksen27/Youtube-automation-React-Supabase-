/**
 * Repair projects left inconsistent by synthetic-admission-reset.
 *
 * WHAT WENT WRONG
 * ---------------
 * The reset cancelled a project's QUEUED asset jobs and reset its segments, but
 * a project that was still actively dispatching kept enqueuing NEW jobs after
 * the script had read its job list. Result (observed on 616588ed):
 *
 *     jobs queued = 172  AND  jobs cancelled = 172
 *     segs generating = 172        <-- pointing at jobs that will never run
 *
 * Those segments are wedged at 'generating' behind a cancelled job, so the
 * project sits in generating_images doing nothing while HOLDING an admission
 * slot — which is why 5 projects showed as generating against a cap of 3.
 *
 * WHAT THIS DOES
 * --------------
 * For every synthetic project in a generating_* status, it recomputes the truth
 * from the segment rows and repairs:
 *   - segments 'generating' whose media_job is cancelled/failed/absent -> 'pending'
 *   - a project with NO live (queued/running) job and pending segments -> parked
 *     at 'plan_ready' so admission control can promote it cleanly later
 *   - a project whose segments are ALL terminal -> left alone (finalize handles it)
 *
 * Nothing paid for is discarded: 'ready' segments and their images are untouched.
 *
 * USAGE
 *   npx tsx --env-file=.env.local scripts/synthetic-admission-repair.ts          # DRY RUN
 *   npx tsx --env-file=.env.local scripts/synthetic-admission-repair.ts --apply
 */

import { getServerSupabase } from "@/lib/supabase/server";

const GENERATING = ["generating_images", "generating_clips", "generating_avatars"];
const ASSET_TYPES = ["image_gen", "image_to_video", "avatar"];
const DEAD_JOB_STATUSES = ["cancelled", "failed"];

async function main() {
  const apply = process.argv.includes("--apply");
  const sb = getServerSupabase();

  console.log(`${apply ? "APPLY" : "DRY RUN"}\n`);

  const { data: projects, error } = await sb
    .from("projects")
    .select("id, title, status")
    .eq("engine", "synthetic")
    .in("status", GENERATING)
    .order("updated_at", { ascending: true });
  if (error) throw new Error(`read projects: ${error.message}`);
  if (!projects || projects.length === 0) {
    console.log("No projects in a generating status.");
    return;
  }

  let repaired = 0;
  let parked = 0;

  for (const p of projects) {
    const projectId = p.id as string;
    const short = projectId.slice(0, 8);

    // Live work for this project. A queued OR running asset job means the
    // project is legitimately generating — leave it completely alone.
    const { count: live } = await sb
      .from("media_jobs")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .in("type", ASSET_TYPES)
      .in("status", ["queued", "running"]);

    // Segments wedged at 'generating'. Each links its job via metadata.mediaJobId;
    // if that job is dead (or gone), the segment can never complete on its own.
    const { data: generatingSegs } = await sb
      .from("synthetic_segments")
      .select("id, metadata")
      .eq("project_id", projectId)
      .eq("status", "generating");

    // Resolve every linked job in BATCHES. One query per segment meant ~172
    // sequential round-trips per project, which stalled the script before it
    // printed anything.
    const segs = generatingSegs ?? [];
    const jobIdOf = new Map<string, string | null>();
    for (const s of segs) {
      jobIdOf.set(s.id as string, (s.metadata as { mediaJobId?: string } | null)?.mediaJobId ?? null);
    }
    const jobIds = [...new Set([...jobIdOf.values()].filter((v): v is string => !!v))];
    const jobStatus = new Map<string, string>();
    for (let i = 0; i < jobIds.length; i += 200) {
      const { data: rows } = await sb
        .from("media_jobs")
        .select("id, status")
        .in("id", jobIds.slice(i, i + 200));
      for (const r of rows ?? []) jobStatus.set(r.id as string, String(r.status));
    }

    const wedged: string[] = [];
    for (const s of segs) {
      const jobId = jobIdOf.get(s.id as string);
      // No link, job row gone, or the job is dead => the segment can never
      // complete on its own and must go back to 'pending'.
      if (!jobId) { wedged.push(s.id as string); continue; }
      const st = jobStatus.get(jobId);
      if (!st || DEAD_JOB_STATUSES.includes(st)) wedged.push(s.id as string);
    }

    const { count: pending } = await sb
      .from("synthetic_segments")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("status", "pending");

    const willPark = (live ?? 0) === 0;
    if (wedged.length === 0 && !willPark) {
      console.log(`  ${short}: healthy (live=${live} pending=${pending}) — untouched`);
      continue;
    }

    console.log(
      `  ${short}: live=${live} pending=${pending} wedgedGenerating=${wedged.length}` +
        `${willPark ? " -> park at plan_ready" : ""}`,
    );

    if (!apply) continue;

    // 1. Un-wedge segments stuck behind a dead job so they can be re-dispatched.
    if (wedged.length > 0) {
      for (let i = 0; i < wedged.length; i += 200) {
        const { error: e } = await sb
          .from("synthetic_segments")
          .update({ status: "pending", metadata: {} })
          .in("id", wedged.slice(i, i + 200));
        if (e) console.error(`     !! segment update failed: ${e.message}`);
      }
      repaired += wedged.length;
    }

    // 2. No live work => this project is not really generating. Park it so it
    // releases its admission slot and can be promoted properly later.
    if (willPark) {
      const { error: e } = await sb
        .from("projects")
        .update({ status: "plan_ready" })
        .eq("id", projectId);
      if (e) console.error(`     !! project update failed: ${e.message}`);
      else parked++;
    }
  }

  console.log(
    `\n${apply ? "DONE" : "WOULD"}: un-wedge ${repaired} segment(s), park ${parked} project(s).`,
  );
  if (!apply) console.log("\nRe-run with --apply to execute.");
  else console.log("\nParked projects wait at plan_ready; admission control promotes them as slots free.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

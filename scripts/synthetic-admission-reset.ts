/**
 * Reset an over-dispatched synthetic asset backlog onto admission control.
 *
 * WHY THIS EXISTS
 * ---------------
 * Auto-dispatch (SYNTHETIC_AUTO_DISPATCH) removed the manual review gate that
 * used to serialise asset generation, so every project that finished planning
 * fanned its ENTIRE segment list into the shared image queue at once. Observed
 * 2026-08-11: 12 projects in generating_images, 2,666 queued image_gen jobs.
 *
 * BullMQ is one FIFO queue with no per-project fairness, so those jobs interleave
 * and every project completes at roughly the same very late time — no finished
 * video for hours. SYNTHETIC_MAX_GENERATING_PROJECTS now caps how many projects
 * generate at once, but that cap only governs NEW dispatches; a backlog that is
 * already queued stays interleaved.
 *
 * This script re-shapes the existing backlog to match the cap:
 *   1. Removes QUEUED (not started) asset jobs for over-cap projects from BullMQ
 *      and marks their media_jobs rows cancelled.
 *   2. Returns those projects' segments to 'pending' so they can be re-dispatched
 *      later, and parks the projects at 'plan_ready' (the normal waiting state).
 *   3. Leaves the N oldest projects generating, untouched.
 *
 * SAFETY
 * ------
 *  - RUNNING jobs are never touched — work in progress finishes normally.
 *  - Segments already 'ready' keep their generated image. Nothing paid for is
 *    thrown away; only not-yet-started work is deferred.
 *  - Waiting projects are promoted automatically by promoteNextQueuedProject /
 *    the reconcile admission sweep, so no further manual step is needed.
 *
 * USAGE (from the repo root)
 *   npx tsx --env-file=.env.local scripts/synthetic-admission-reset.ts            # DRY RUN
 *   npx tsx --env-file=.env.local scripts/synthetic-admission-reset.ts --apply    # execute
 *   … --apply --keep 3     # override how many projects stay generating
 */

import { getServerSupabase } from "@/lib/supabase/server";
import { getQueue, QUEUE_NAMES } from "@/lib/jobs/queue";
import { getEnv } from "@/lib/env";

const GENERATING = ["generating_images", "generating_clips", "generating_avatars"];
const ASSET_TYPES = ["image_gen", "image_to_video", "avatar"];

const QUEUE_FOR_TYPE: Record<string, (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]> = {
  image_gen: QUEUE_NAMES.imageGeneration,
  image_to_video: QUEUE_NAMES.imageToVideo,
  avatar: QUEUE_NAMES.avatar,
};

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const keepArg = argv.indexOf("--keep");
  const keep =
    keepArg >= 0 ? Number(argv[keepArg + 1]) : getEnv().SYNTHETIC_MAX_GENERATING_PROJECTS;

  const sb = getServerSupabase();

  console.log(`${apply ? "APPLY" : "DRY RUN"} — keeping ${keep} project(s) generating\n`);

  // Oldest-first: the projects closest to finishing keep their slots, so the
  // first completed video arrives as soon as possible.
  // Retry the read. A transient Supabase failure returned 0 rows on one run
  // while the same query returned 11 moments later — and an empty result is
  // indistinguishable from "nothing to do", which in a DESTRUCTIVE script must
  // never be assumed. Any hard error aborts rather than silently no-opping.
  let active: Array<Record<string, unknown>> | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await sb
      .from("projects")
      .select("id, title, status, updated_at")
      .eq("engine", "synthetic")
      .in("status", GENERATING)
      .order("updated_at", { ascending: true });
    if (error) {
      console.error(`  read attempt ${attempt} failed: ${error.message}`);
      if (attempt === 3) throw new Error(`could not read project list: ${error.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    active = data ?? [];
    if (active.length > 0) break;
    // Empty is legitimate (nothing generating) but is also what a silent failure
    // looks like — re-read once before believing it.
    if (attempt < 3) {
      console.log(`  read returned 0 generating projects; re-checking (${attempt}/3)…`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const projects = active ?? [];
  if (projects.length === 0) {
    console.log("No projects are generating (confirmed over 3 reads). Nothing to do.");
    return;
  }

  const keepers = projects.slice(0, keep);
  const defer = projects.slice(keep);

  console.log(`KEEP generating (${keepers.length}):`);
  for (const p of keepers) console.log(`   ${String(p.id).slice(0, 8)}  ${String(p.title).slice(0, 50)}`);
  console.log(`\nDEFER to the waiting queue (${defer.length}):`);
  for (const p of defer) console.log(`   ${String(p.id).slice(0, 8)}  ${String(p.title).slice(0, 50)}`);
  console.log("");

  let totalRemoved = 0;
  let totalSegments = 0;

  for (const p of defer) {
    const projectId = p.id as string;
    try {

    // Only QUEUED jobs are deferred. A running job is real work in flight and is
    // left to finish — its segment will land 'ready' and be kept.
    const { data: queued } = await sb
      .from("media_jobs")
      .select("id, type, metadata")
      .eq("project_id", projectId)
      .in("type", ASSET_TYPES)
      .eq("status", "queued");

    const jobs = queued ?? [];
    const segmentIds = jobs
      .map((j) => (j.metadata as { segmentId?: string } | null)?.segmentId)
      .filter((s): s is string => !!s);

    console.log(`  ${projectId.slice(0, 8)}: ${jobs.length} queued job(s), ${segmentIds.length} segment(s)`);
    totalRemoved += jobs.length;
    totalSegments += segmentIds.length;

    if (!apply) continue;

    // 1. Drop the BullMQ jobs. jobId === mediaJobId is an invariant across every
    // enqueue helper, so the media_jobs id IS the queue job id.
    //
    // Batched + individually guarded: the first --apply run did ~200 sequential
    // getJob/isActive/remove round-trips and died partway through project 1,
    // leaving the DB untouched. Each removal now has its own timeout and can
    // fail without killing the run, and batches go out in parallel so 1,500+
    // jobs clear in seconds rather than minutes.
    const CHUNK = 25;
    let removed = 0;
    for (let i = 0; i < jobs.length; i += CHUNK) {
      await Promise.all(
        jobs.slice(i, i + CHUNK).map(async (j) => {
          const queueName = QUEUE_FOR_TYPE[j.type as string];
          if (!queueName) return;
          try {
            const work = (async () => {
              const job = await getQueue(queueName).getJob(j.id as string);
              // Only remove a job that has NOT started. If it acquired a lock
              // between our DB read and now, leave it — removing an active job
              // orphans its segment at 'generating'.
              if (job && !(await job.isActive())) {
                await job.remove();
                removed++;
              }
            })();
            await Promise.race([
              work,
              new Promise<void>((_, rej) => {
                const t = setTimeout(() => rej(new Error("redis timeout")), 10_000);
                t.unref?.();
              }),
            ]);
          } catch {
            // A job already gone from Redis is the desired end state anyway, and
            // one slow removal must not abort the whole reset.
          }
        }),
      );
    }
    console.log(`     removed ${removed}/${jobs.length} from Redis`);

    // 2. media_jobs -> cancelled, so reconcile doesn't later treat these as
    // stalled and the review screen doesn't count them as in flight.
    await sb
      .from("media_jobs")
      .update({ status: "cancelled", error: "deferred by admission reset" })
      .eq("project_id", projectId)
      .in("type", ASSET_TYPES)
      .eq("status", "queued");

    // 3. Segments back to 'pending' + unlink their dead job, so a later
    // dispatchSegments picks them up. 'ready' segments are untouched — their
    // images are already paid for and kept.
    if (segmentIds.length > 0) {
      for (let i = 0; i < segmentIds.length; i += 200) {
        await sb
          .from("synthetic_segments")
          .update({ status: "pending", metadata: {} })
          .in("id", segmentIds.slice(i, i + 200))
          .neq("status", "ready");
      }
    }

    // 4. Park the project in the waiting state. promoteNextQueuedProject picks
    // up 'plan_ready' projects that still have pending segments, oldest first.
    await sb.from("projects").update({ status: "plan_ready" }).eq("id", projectId);
      console.log(`     -> deferred to plan_ready`);
    } catch (err) {
      // One project failing must not abandon the rest half-reset. Report and
      // continue; re-running the script is safe (it re-reads current state).
      console.error(`     !! ${projectId.slice(0, 8)} failed: ${(err as Error).message}`);
    }
  }

  console.log(
    `\n${apply ? "DONE" : "WOULD"}: defer ${defer.length} project(s), ` +
      `remove ${totalRemoved} queued job(s), reset ${totalSegments} segment(s).`,
  );
  if (!apply) console.log("\nRe-run with --apply to execute.");
  else console.log("\nDeferred projects wait at plan_ready and are promoted automatically as slots free.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

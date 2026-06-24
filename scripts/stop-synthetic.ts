import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { getServerSupabase } from "@/lib/supabase/server";
import { getQueue, QUEUE_NAMES } from "@/lib/jobs/queue";

// Hard-stop ALL synthetic asset generation: drain every synthetic queue
// (image-generation, image-to-video, avatar, synthetic-planner, render) of
// waiting/delayed/active/failed/paused jobs so the worker stops picking them up
// and retrying, then reset stuck DB rows so the UI stops spinning.
//
// Use when a backlog of jobs in Redis keeps hammering a provider (e.g. the 69labs
// 503 storm) even after a code/concurrency deploy — the deploy governs NEW
// dispatch but cannot un-queue jobs already in Redis. This removes them.
//
//   npm run stop:synthetic                 -> all projects (drains everything)
//   npm run stop:synthetic <projectId>     -> reset DB rows for one project only
//                                             (queues are still drained globally)
//
// NOTE: queue draining is GLOBAL (BullMQ jobs aren't cheaply filterable by
// project without scanning each job's data). The optional projectId only scopes
// the DB resets. Draining all is intended here — the backlog is one project's.
const SYNTHETIC_QUEUES = [
  QUEUE_NAMES.imageGeneration,
  QUEUE_NAMES.imageToVideo,
  QUEUE_NAMES.avatar,
  QUEUE_NAMES.syntheticPlanner,
  QUEUE_NAMES.render,
] as const;

(async () => {
  const projectId = process.argv[2]?.trim() || null;
  const sb = getServerSupabase();

  // 1) Drain every synthetic queue so the worker stops picking these up.
  for (const name of SYNTHETIC_QUEUES) {
    const q = getQueue(name);
    await q.drain(true); // remove waiting + delayed
    for (const state of ["failed", "active", "wait", "delayed", "paused"] as const) {
      for (const j of await q.getJobs([state])) await j.remove().catch(() => {});
    }
    const counts = await q.getJobCounts("waiting", "active", "delayed", "failed");
    console.log(`${name.padEnd(40)} after drain: ${JSON.stringify(counts)}`);
    await q.close();
  }

  // 2) Reset stuck segments (generating -> pending) so the UI stops spinning.
  let segQ = sb
    .from("synthetic_segments")
    .update({ status: "pending", error: null })
    .eq("status", "generating");
  if (projectId) segQ = segQ.eq("project_id", projectId);
  const { data: segs } = await segQ.select("id");
  console.log(`reset ${segs?.length ?? 0} stuck segment(s) to pending${projectId ? ` (project ${projectId})` : ""}`);

  // 3) Close in-flight media_jobs across ALL synthetic types.
  let jobQ = sb
    .from("media_jobs")
    .update({ status: "failed", error: "stopped by operator" })
    .in("type", ["image_gen", "image_to_video", "avatar", "plan_synthetic", "render"])
    .in("status", ["queued", "running"]);
  if (projectId) jobQ = jobQ.eq("project_id", projectId);
  const { data: jobs } = await jobQ.select("id");
  console.log(`closed ${jobs?.length ?? 0} in-flight media_job(s)${projectId ? ` (project ${projectId})` : ""}`);

  process.exit(0);
})().catch((e) => {
  console.error("ERR:", (e as Error).message);
  process.exit(1);
});

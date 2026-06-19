import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { getServerSupabase } from "@/lib/supabase/server";
import { getQueue, QUEUE_NAMES } from "@/lib/jobs/queue";

// Stop in-flight avatar generation: drain the avatar queue (waiting/delayed +
// remove failed/active) and reset stuck segments + their media_jobs so the UI
// stops spinning. Optionally scope to one project id as argv[2].
//
//   npm run heygen:stop                 -> all projects
//   npm run heygen:stop <projectId>     -> one project
(async () => {
  const projectId = process.argv[2]?.trim() || null;
  const sb = getServerSupabase();

  // 1) Drain the avatar queue so the worker stops picking these up / retrying.
  const q = getQueue(QUEUE_NAMES.avatar);
  await q.drain(true); // waiting + delayed
  for (const state of ["failed", "active", "wait", "delayed", "paused"] as const) {
    for (const j of await q.getJobs([state])) await j.remove().catch(() => {});
  }
  const counts = await q.getJobCounts("waiting", "active", "delayed", "failed");
  console.log("avatar queue after drain:", JSON.stringify(counts));
  await q.close();

  // 2) Reset stuck segments (generating -> pending) and their media_jobs.
  let segQ = sb
    .from("synthetic_segments")
    .update({ status: "pending", error: null })
    .eq("status", "generating");
  if (projectId) segQ = segQ.eq("project_id", projectId);
  const { data: segs } = await segQ.select("id");
  console.log(`reset ${segs?.length ?? 0} stuck segment(s) to pending`);

  let jobQ = sb
    .from("media_jobs")
    .update({ status: "failed", error: "stopped by operator" })
    .eq("type", "avatar")
    .in("status", ["queued", "running"]);
  if (projectId) jobQ = jobQ.eq("project_id", projectId);
  const { data: jobs } = await jobQ.select("id");
  console.log(`closed ${jobs?.length ?? 0} in-flight avatar media_job(s)`);

  process.exit(0);
})();

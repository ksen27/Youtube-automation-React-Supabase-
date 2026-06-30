import { getServerSupabase } from "@/lib/supabase/server";
import { getQueue, QUEUE_NAMES, closeAllQueues } from "@/lib/jobs/queue";

async function main() {
  const sb = getServerSupabase();
  const projId = "2123bdf6-4ef2-46e0-ad76-22ea822ccda1";

  // Open avatar jobs (queued/running) for this project.
  const { data: jobs } = await sb
    .from("media_jobs")
    .select("id, status, metadata")
    .eq("project_id", projId)
    .eq("type", "avatar")
    .in("status", ["queued", "running"]);

  const q = getQueue(QUEUE_NAMES.avatar);
  let removed = 0;
  for (const job of jobs ?? []) {
    const segId = ((job.metadata ?? {}) as Record<string, unknown>).segmentId as string | undefined;
    if (!segId) continue;
    const { data: seg } = await sb
      .from("synthetic_segments")
      .select("id, status, metadata")
      .eq("id", segId)
      .single();
    if (!seg) continue;
    const currentJobId = ((seg.metadata ?? {}) as Record<string, unknown>).mediaJobId as string | undefined;
    const isStale = seg.status === "ready" && currentJobId !== job.id;
    console.log(`job ${job.id} (${job.status}) -> seg ${segId} status=${seg.status} currentJob=${currentJobId} STALE=${isStale}`);
    if (isStale) {
      // Remove from BullMQ (jobId === mediaJobId) and terminalize the DB row.
      const bj = await q.getJob(job.id as string);
      if (bj) { await bj.remove().catch((e) => console.log("  remove err:", e.message)); }
      await sb.from("media_jobs").update({ status: "failed", error: "drained: stale duplicate (segment already ready)" }).eq("id", job.id);
      removed++;
    }
  }
  console.log(`\nDrained ${removed} stale avatar jobs.`);
  await closeAllQueues();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

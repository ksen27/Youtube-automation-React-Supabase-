// Migrate the EXISTING image-to-video backlog into BullMQ's prioritized set so
// the project you are working on stops queueing behind abandoned ones.
//
// WHY A MIGRATION IS REQUIRED. moveToActive drains the unprioritized `wait`
// LIST first and only consults the `prioritized` ZSET once wait is empty (see
// moveToActive-11.lua). So enqueuing NEW jobs with a priority does nothing
// while a plain wait backlog exists — worse, it puts the new work last. Jobs
// already waiting have to be moved across, which is what changePriority does:
// it LREMs the job from wait and re-adds it to the prioritized set.
//
// Ordering is by DISPATCH RECENCY — each entry ranked by its own media_jobs
// created_at, the same clock dispatchSegments now stamps on new jobs. Blocks
// dispatched in one batch share a minute and so stay contiguous, which keeps a
// video's blocks together instead of interleaving them with another's.
//
// Jobs whose media_jobs row is already terminal or gone are sorted LAST rather
// than deleted — the processor's abandoned-job guard retires them in
// milliseconds, and leaving them in place keeps this script non-destructive.
//
//   npx tsx --env-file=.env.local scripts/prioritize-clip-queue.ts          # dry run
//   npx tsx --env-file=.env.local scripts/prioritize-clip-queue.ts --apply
import { Queue } from "bullmq";
import { QUEUE_NAMES, getRedisConnection, queuePriority } from "@/lib/jobs/queue";
import { getServerSupabase } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

const LAST = 2 ** 21 - 1; // lowest priority BullMQ accepts — for dead entries

async function main() {
  const apply = process.argv.includes("--apply");
  const q = new Queue(QUEUE_NAMES.imageToVideo, { connection: getRedisConnection() });
  const waiting = await q.getJobs(["waiting"], 0, 100_000);
  console.log(`waiting entries: ${waiting.length}${apply ? "" : "   (DRY RUN — pass --apply to write)"}`);

  const sb = getServerSupabase();
  const { data: jobRows, error } = await fetchAllRows((from, to) =>
    sb.from("media_jobs").select("id, project_id, status, created_at", { count: "exact" })
      .eq("type", "image_to_video").order("id", { ascending: true }).range(from, to));
  if (error) throw new Error(error.message);
  const row = new Map((jobRows as Array<{ id: string; project_id: string; status: string; created_at: string }>)
    .map((r) => [r.id, r]));

  const { data: projects } = await sb.from("projects").select("id, title");
  const proj = new Map((projects ?? []).map((p) => [p.id as string, p]));

  // Group before writing so the plan can be printed and eyeballed first.
  const plan = new Map<string, { priority: number; title: string; ids: string[] }>();
  for (const job of waiting) {
    const id = String(job.id);
    const r = row.get(id);
    const p = r ? proj.get(r.project_id) : undefined;
    const dead = !r || r.status === "completed" || r.status === "failed";
    const key = dead ? "(abandoned — sorted last)" : r!.project_id;
    const priority = dead ? LAST : queuePriority(r!.created_at);
    const title = dead ? "(abandoned — sorted last)" : String(p?.title ?? r!.project_id).slice(0, 54);
    // Keep the group's BEST (lowest) priority: a project whose blocks were
    // dispatched across several minutes should rank by its most recent batch,
    // not be split into one line per minute.
    const g = plan.get(key);
    if (!g) plan.set(key, { priority, title, ids: [id] });
    else { g.ids.push(id); g.priority = Math.min(g.priority, priority); }
  }

  const ordered = [...plan.values()].sort((a, b) => a.priority - b.priority);
  console.log("\nresulting order:");
  for (const g of ordered) console.log(`  priority ${String(g.priority).padStart(8)}  ${String(g.ids.length).padStart(4)} jobs  ${g.title}`);

  if (!apply) return console.log("\nnothing written.");

  let moved = 0;
  for (const g of ordered) {
    for (const id of g.ids) {
      const job = await q.getJob(id);
      if (!job) continue; // raced with a worker picking it up — fine, skip
      await job.changePriority({ priority: g.priority });
      moved++;
    }
    console.log(`  moved ${g.ids.length} -> priority ${g.priority}  ${g.title}`);
  }
  console.log(`\nreprioritized ${moved} entries.`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

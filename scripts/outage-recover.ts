// Recover jobs that burned their BullMQ attempts against the dead Supabase DB
// during the 2026-08-04 11:09-11:35 UTC 521 outage.
//
// Dry run (default): lists failed BullMQ jobs per queue, grouped by project.
//   npx tsx --env-file=.env.local scratchpad/outage-recover.ts
// Apply: retries every failed BullMQ job whose projectId is in AFFECTED.
//   npx tsx --env-file=.env.local scratchpad/outage-recover.ts --apply
import { Queue } from "bullmq";
import { QUEUE_NAMES, getRedisConnection } from "@/lib/jobs/queue";

const AFFECTED = new Set([
  "fbd8c587-8fe0-43ea-8a13-9146dafb5d72", // downloading  William Estate
  "189bd9d7-58f2-476a-b10c-bfc839ab856b", // downloading  Spencer Gala
  "82a38865-9173-47cd-8391-910cdb4eae92", // clipping     Diana's Brother
  "e271d935-1e13-4ffd-9794-88133c2f43d6", // rendering    D-Day Meals
  "ea6fabb6-0e8e-41cb-8817-21994727ebc2", // rendering    Book of Enoch
  "133c5943-6fe4-4c2f-9bb7-b8bd92fbd16f", // gen_avatars  Hoover Dam
  "32d58637-41f0-4908-a1f4-f82698a3b1fb", // gen_avatars  Deli Meats
]);
const APPLY = process.argv.includes("--apply");

async function main() {
  const connection = getRedisConnection();
  let totalRetried = 0;
  for (const name of Object.values(QUEUE_NAMES)) {
    const q = new Queue(name, { connection });
    const counts = await q.getJobCounts("failed", "waiting", "delayed", "active");
    const failed = await q.getFailed(0, 1000);
    const byProject = new Map<string, number>();
    let retried = 0;
    for (const job of failed) {
      const pid = (job.data as { projectId?: string }).projectId ?? "(none)";
      byProject.set(pid, (byProject.get(pid) ?? 0) + 1);
      if (APPLY && AFFECTED.has(pid)) {
        await job.retry("failed");
        retried++;
      }
    }
    totalRetried += retried;
    if (failed.length || counts.waiting || counts.active || counts.delayed) {
      console.log(`\n${name}  counts=${JSON.stringify(counts)}`);
      for (const [pid, n] of byProject) {
        const mark = AFFECTED.has(pid) ? (APPLY ? "  RETRIED" : "  <- would retry") : "";
        console.log(`   ${pid}  failed=${n}${mark}`);
      }
    }
    await q.close();
  }
  console.log(`\n${APPLY ? "retried" : "dry-run, would retry"}: ${APPLY ? totalRetried : "(see marks above)"}`);
  process.exit(0);
}

void main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });

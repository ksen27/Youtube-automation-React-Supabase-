// Quick queue-state snapshot: waiting/active/failed per queue.
//   npx tsx --env-file=.env.local scripts/queue-counts.ts
import { Queue } from "bullmq";
import { QUEUE_NAMES, getRedisConnection } from "@/lib/jobs/queue";

async function main() {
  const connection = getRedisConnection();
  for (const name of Object.values(QUEUE_NAMES)) {
    const q = new Queue(name, { connection });
    const c = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    console.log(`${name.padEnd(42)} ${JSON.stringify(c)}`);
    await q.close();
  }
  process.exit(0);
}

void main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });

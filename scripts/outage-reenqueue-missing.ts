// Companion to outage-recover.ts. That script retries BullMQ jobs still in the
// failed set; this one finds media_jobs rows stuck at 'queued' whose BullMQ job
// was EVICTED entirely (failed-set cap) and re-enqueues them fresh, rebuilding
// the payload from media_jobs.metadata.
//
// Dry run:  npx tsx --env-file=.env.local scripts/outage-reenqueue-missing.ts
// Apply:    npx tsx --env-file=.env.local scripts/outage-reenqueue-missing.ts --apply
import { Queue } from "bullmq";
import { getServerSupabase } from "@/lib/supabase/server";
import {
  QUEUE_NAMES,
  getRedisConnection,
  enqueueDownload,
  enqueueClip,
  enqueueImageGeneration,
  enqueueImageToVideo,
  enqueueAvatar,
} from "@/lib/jobs/queue";

const AFFECTED = [
  "fbd8c587-8fe0-43ea-8a13-9146dafb5d72",
  "189bd9d7-58f2-476a-b10c-bfc839ab856b",
  "82a38865-9173-47cd-8391-910cdb4eae92",
  "e271d935-1e13-4ffd-9794-88133c2f43d6",
  "ea6fabb6-0e8e-41cb-8817-21994727ebc2",
  "133c5943-6fe4-4c2f-9bb7-b8bd92fbd16f",
  "32d58637-41f0-4908-a1f4-f82698a3b1fb",
];
const APPLY = process.argv.includes("--apply");

const TYPE_TO_QUEUE: Record<string, string> = {
  download: QUEUE_NAMES.download,
  clip: QUEUE_NAMES.clip,
  image_gen: QUEUE_NAMES.imageGeneration,
  image_to_video: QUEUE_NAMES.imageToVideo,
  avatar: QUEUE_NAMES.avatar,
};

async function main() {
  const sb = getServerSupabase();
  const connection = getRedisConnection();
  const queues = new Map<string, Queue>();
  const q = (name: string) => {
    let v = queues.get(name);
    if (!v) { v = new Queue(name, { connection }); queues.set(name, v); }
    return v;
  };

  let missing = 0, reenqueued = 0, skippedNoMeta = 0;
  for (const pid of AFFECTED) {
    const { data: rows, error } = await sb
      .from("media_jobs")
      .select("id, type, status, metadata")
      .eq("project_id", pid)
      .eq("status", "queued")
      .in("type", Object.keys(TYPE_TO_QUEUE));
    if (error) throw new Error(error.message);

    for (const row of rows ?? []) {
      const queueName = TYPE_TO_QUEUE[row.type as string];
      const job = await q(queueName).getJob(row.id as string);
      if (job) continue; // still tracked by BullMQ (waiting/active/failed) — leave it
      missing++;
      const md = (row.metadata ?? {}) as Record<string, unknown>;
      console.log(`missing in Redis: ${row.type}  ${row.id}  project=${pid.slice(0, 8)}`);
      if (!APPLY) continue;

      if (row.type === "download") {
        const youtubeVideoId = typeof md.youtube_video_id === "string" ? md.youtube_video_id : null;
        const youtubeUrl = typeof md.youtube_url === "string" ? md.youtube_url : null;
        if (!youtubeVideoId || !youtubeUrl) { skippedNoMeta++; continue; }
        await enqueueDownload({ projectId: pid, mediaJobId: row.id as string, youtubeVideoId, youtubeUrl, title: typeof md.title === "string" ? md.title : null });
      } else if (row.type === "clip") {
        const videoSourceId = typeof md.videoSourceId === "string" ? md.videoSourceId : null;
        if (!videoSourceId) { skippedNoMeta++; continue; }
        await enqueueClip({ projectId: pid, mediaJobId: row.id as string, videoSourceId });
      } else {
        const segmentId = typeof md.segmentId === "string" ? md.segmentId : null;
        if (!segmentId) { skippedNoMeta++; continue; }
        if (row.type === "image_gen") await enqueueImageGeneration({ projectId: pid, mediaJobId: row.id as string, segmentId });
        else if (row.type === "image_to_video") await enqueueImageToVideo({ projectId: pid, mediaJobId: row.id as string, segmentId });
        else await enqueueAvatar({ projectId: pid, mediaJobId: row.id as string, segmentId });
      }
      reenqueued++;
    }
  }
  for (const v of queues.values()) await v.close();
  console.log(`\nmissing=${missing}  ${APPLY ? `reenqueued=${reenqueued}  skippedNoMeta=${skippedNoMeta}` : "(dry run — pass --apply to re-enqueue)"}`);
  process.exit(0);
}

void main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });

// What resolution do our EXISTING avatar clips actually come back at? The
// browser-automation path (the primary one) has no resolution setting — we take
// whatever HeyGen's UI renders — so the only way to know is to measure shipped
// assets.
//
//   npx tsx --env-file=.env.local scripts/probe-avatar-res.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getServerSupabase } from "@/lib/supabase/server";

const run = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

async function dims(url: string): Promise<string> {
  const { stdout } = await run(FFPROBE, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0", url,
  ], { maxBuffer: 1 << 20 });
  return stdout.trim();
}

async function main() {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("timeline_items")
    .select("id, project_id, type, video_url, created_at")
    .in("type", ["avatar", "split_2", "ai_clip"])
    .not("video_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(12);
  if (error) throw new Error(error.message);

  console.log(`sampling ${data?.length ?? 0} recent generated clips\n`);
  for (const row of data ?? []) {
    try {
      const d = await dims(row.video_url as string);
      console.log(`${String(row.type).padEnd(8)} ${d.padEnd(12)} ${row.created_at}`);
    } catch (err) {
      console.log(`${String(row.type).padEnd(8)} PROBE FAILED  ${(err as Error).message.slice(0, 120)}`);
    }
  }
}

void main().catch((e) => { console.error("FAILED:", e?.message || e); process.exitCode = 1; });

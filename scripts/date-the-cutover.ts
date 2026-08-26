// When did production actually start rendering on the self-hosted pod?
//
// The two lanes are indistinguishable by provider label (both "ltx2"), but not
// by CLIP LENGTH: api.ltx.video's tier floor is 6s, while the pod was given
// LTX_DURATION_TIERS_OVERRIDE="4,6,8,..." specifically so the client's 4s ask
// was reachable. So a day whose clips are 4s long was rendered on the pod, and a
// day of 6s clips was rendered on the API.
//
// Samples a few real mp4s per day from R2 and reads their duration out of the
// MP4 `mvhd` box -- no ffprobe needed.
import { getServerSupabase } from "@/lib/supabase/server";

const DAYS = ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23"];
const PER_DAY = 4;

/** Duration in seconds from the MP4 movie header, or null if not parseable. */
function mp4Duration(buf: Buffer): number | null {
  const idx = buf.indexOf(Buffer.from("mvhd"));
  if (idx < 0) return null;
  const version = buf[idx + 4];
  try {
    if (version === 1) {
      const timescale = buf.readUInt32BE(idx + 24);
      const duration = Number(buf.readBigUInt64BE(idx + 28));
      return timescale ? duration / timescale : null;
    }
    const timescale = buf.readUInt32BE(idx + 16);
    const duration = buf.readUInt32BE(idx + 20);
    return timescale ? duration / timescale : null;
  } catch {
    return null;
  }
}

async function main() {
  const sb = getServerSupabase();

  for (const day of DAYS) {
    const { data, error } = await sb
      .from("generated_assets")
      .select("asset_url, created_at")
      .eq("asset_type", "clip")
      .gte("created_at", `${day}T00:00:00Z`)
      .lt("created_at", `${day}T23:59:59Z`)
      .limit(PER_DAY);
    if (error) {
      console.log(`${day}  query failed: ${error.message}`);
      continue;
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      console.log(`${day}  (no clips)`);
      continue;
    }

    const durations: string[] = [];
    for (const r of rows) {
      try {
        const res = await fetch(r.asset_url as string);
        if (!res.ok) {
          durations.push(`http${res.status}`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const d = mp4Duration(buf);
        durations.push(d === null ? "?" : `${d.toFixed(1)}s`);
      } catch (e) {
        durations.push("err");
      }
    }
    console.log(`${day}  n=${rows.length}  durations: ${durations.join("  ")}`);
  }

  console.log("\n6s clips => api.ltx.video (its tier floor).");
  console.log("4s clips => the self-hosted pod (LTX_DURATION_TIERS_OVERRIDE).");
  console.log("The first 4s day is the real cutover; purge --from that date.");
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

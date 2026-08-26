// Narrow the cutover to the hour, inside 2026-08-22.
//
// Same discriminator as date-the-cutover.ts: 6s clips are api.ltx.video (its
// tier floor), 4s clips are the self-hosted pod. Walks the day in order and
// reports the duration of a sample from each hour, so the purge window can start
// at the exact moment the pod took over instead of binning that morning's good
// API clips.
import { getServerSupabase } from "@/lib/supabase/server";

const DAY = "2026-08-22";

function mp4Duration(buf: Buffer): number | null {
  const idx = buf.indexOf(Buffer.from("mvhd"));
  if (idx < 0) return null;
  const version = buf[idx + 4];
  try {
    if (version === 1) {
      const ts = buf.readUInt32BE(idx + 24);
      const d = Number(buf.readBigUInt64BE(idx + 28));
      return ts ? d / ts : null;
    }
    const ts = buf.readUInt32BE(idx + 16);
    const d = buf.readUInt32BE(idx + 20);
    return ts ? d / ts : null;
  } catch {
    return null;
  }
}

async function main() {
  const sb = getServerSupabase();
  for (let hour = 0; hour < 24; hour++) {
    const hh = String(hour).padStart(2, "0");
    const { data, error } = await sb
      .from("generated_assets")
      .select("asset_url, created_at")
      .eq("asset_type", "clip")
      .gte("created_at", `${DAY}T${hh}:00:00Z`)
      .lt("created_at", `${DAY}T${hh}:59:59Z`)
      .limit(2);
    if (error) {
      console.log(`${hh}:00  query failed`);
      continue;
    }
    const rows = data ?? [];
    if (rows.length === 0) continue;

    const out: string[] = [];
    for (const r of rows) {
      try {
        const res = await fetch(r.asset_url as string);
        if (!res.ok) {
          out.push(`http${res.status}`);
          continue;
        }
        const d = mp4Duration(Buffer.from(await res.arrayBuffer()));
        out.push(d === null ? "?" : `${d.toFixed(1)}s`);
      } catch {
        out.push("err");
      }
    }
    const lane = out.every((s) => s.startsWith("4")) ? "POD" : out.every((s) => s.startsWith("6")) ? "api" : "MIXED";
    console.log(`${hh}:00 UTC  ${out.join("  ").padEnd(18)}  ${lane}`);
  }
  console.log("\nStart the purge at the first POD hour.");
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

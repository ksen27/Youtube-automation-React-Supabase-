// Is a finished render actually 4K? Looks the project up by title, finds its
// most recent completed render, and probes the real file — the only proof that
// matters (settings can be right while the shipped file is not).
//
//   npx tsx --env-file=.env.local scripts/check-render-res.ts "<title fragment>"
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getServerSupabase } from "@/lib/supabase/server";

const run = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const NEEDLE = process.argv[2] || "Winchester";

async function probe(url: string) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name,r_frame_rate,bit_rate",
    "-show_entries", "format=duration,size",
    "-of", "default=noprint_wrappers=1",
    url,
  ], { maxBuffer: 1 << 20 });
  return stdout.trim();
}

async function main() {
  const sb = getServerSupabase();
  const { data: projects, error } = await sb
    .from("projects")
    .select("id, title, engine, status, created_at")
    .ilike("title", `%${NEEDLE}%`)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  if (!projects?.length) { console.log(`no project matching "${NEEDLE}"`); return; }

  for (const p of projects) {
    console.log(`\n=== ${p.title}`);
    console.log(`    id=${p.id} engine=${p.engine} status=${p.status} created=${p.created_at}`);

    const { data: renders } = await sb
      .from("render_jobs")
      .select("id, status, output_url, created_at")
      .eq("project_id", p.id)
      .order("created_at", { ascending: false })
      .limit(3);

    if (!renders?.length) { console.log("    no render_jobs"); continue; }
    for (const r of renders) {
      console.log(`    render ${r.status}  ${r.created_at}`);
      if (!r.output_url) { console.log("      (no output_url)"); continue; }
      try {
        const info = await probe(r.output_url as string);
        const w = /width=(\d+)/.exec(info)?.[1];
        const h = /height=(\d+)/.exec(info)?.[1];
        const verdict = w === "3840" && h === "2160" ? "*** 4K CONFIRMED ***"
          : `*** NOT 4K (${w}x${h}) ***`;
        console.log(`      ${verdict}`);
        console.log(info.split("\n").map((l) => `      ${l}`).join("\n"));
      } catch (err) {
        console.log(`      probe failed: ${(err as Error).message.slice(0, 200)}`);
      }
    }
  }
}

void main().catch((e) => { console.error("FAILED:", e?.message || e); process.exitCode = 1; });

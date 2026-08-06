// How long have renders actually been taking, before vs after the 4K cutover?
//   npx tsx --env-file=.env.local scripts/render-time-audit.ts
//
// Reads render_jobs (created_at -> updated_at on a completed row is the render
// wall-time) and buckets by the 2026-08-02 4K cutover so the slowdown can be
// measured instead of estimated.
import { getServerSupabase } from "@/lib/supabase/server";

const CUTOVER = "2026-08-02T00:00:00Z";

async function main() {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("render_jobs")
    .select("id, project_id, status, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(400);
  if (error) throw new Error(error.message);

  const rows = (data ?? [])
    .filter((r) => r.status === "completed" || r.status === "done" || r.status === "succeeded")
    .map((r) => ({
      ...r,
      mins: (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 60000,
    }))
    .filter((r) => r.mins > 0.5 && r.mins < 60 * 12);

  const before = rows.filter((r) => r.created_at < CUTOVER);
  const after = rows.filter((r) => r.created_at >= CUTOVER);

  const stat = (label: string, rs: typeof rows) => {
    if (!rs.length) return console.log(`${label.padEnd(18)} (no completed renders)`);
    const ms = rs.map((r) => r.mins).sort((a, b) => a - b);
    const med = ms[Math.floor(ms.length / 2)];
    const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
    console.log(
      `${label.padEnd(18)} n=${String(rs.length).padEnd(4)} median=${med.toFixed(1)}min  ` +
      `avg=${avg.toFixed(1)}min  min=${ms[0].toFixed(1)}  max=${ms[ms.length - 1].toFixed(1)}`
    );
  };

  console.log(`completed renders analysed: ${rows.length}  (cutover ${CUTOVER})\n`);
  stat("before 4K", before);
  stat("after 4K", after);

  console.log("\nmost recent 15:");
  for (const r of rows.slice(0, 15)) {
    console.log(`  ${r.created_at}  ${r.mins.toFixed(1).padStart(6)}min  ${r.project_id}`);
  }
  process.exit(0);
}

void main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });

// After a worker restart, did any job get orphaned mid-flight? A media_job left
// at 'running' with a stale updated_at is the zombie the reconcile sweeps miss.
//
//   npx tsx --env-file=.env.local scripts/check-zombie-jobs.ts
import { getServerSupabase } from "@/lib/supabase/server";

async function main() {
  const sb = getServerSupabase();

  const { data: running, error } = await sb
    .from("media_jobs")
    .select("id, project_id, type, status, updated_at, created_at")
    .eq("status", "running")
    .order("updated_at", { ascending: true })
    .limit(40);
  if (error) throw new Error(error.message);

  const now = Date.now();
  console.log(`media_jobs at 'running': ${running?.length ?? 0}\n`);
  for (const j of running ?? []) {
    const ageMin = Math.round((now - new Date(j.updated_at as string).getTime()) / 60000);
    const flag = ageMin > 10 ? "  <-- STALE (no heartbeat)" : "";
    console.log(`${String(j.type).padEnd(18)} updated ${String(ageMin).padStart(4)}m ago  ${j.id}${flag}`);
  }

  const { data: segs } = await sb
    .from("segments")
    .select("id, project_id, status, updated_at")
    .eq("status", "generating")
    .order("updated_at", { ascending: true })
    .limit(40);
  console.log(`\nsegments at 'generating': ${segs?.length ?? 0}`);
  for (const s of segs ?? []) {
    const ageMin = Math.round((now - new Date(s.updated_at as string).getTime()) / 60000);
    if (ageMin > 10) console.log(`  STALE ${String(ageMin).padStart(4)}m  segment ${s.id}  project ${s.project_id}`);
  }
}

void main().catch((e) => { console.error("FAILED:", e?.message || e); process.exitCode = 1; });

// One-off audit: compare the cluster-wide Gemini image BUDGET COUNTER (Redis,
// incremented once per reservation incl. retries/regenerates) against the
// number of Gemini images that actually SURVIVED into projects (synthetic_
// segments.provider = 'gemini_image'). A large gap confirms the counter is
// inflated by failed/retried attempts rather than distinct final images.
//
// Run: npx tsx --env-file=.env.local scripts/gemini-count-audit.ts
import { getServerSupabase } from "@/lib/supabase/server";
import { getRedisConnection } from "@/lib/jobs/queue";

function budgetKey(): string {
  return `gemini_image:budget:${new Date().toISOString().slice(0, 7)}`;
}

async function main() {
  const sb = getServerSupabase();
  const redis = getRedisConnection();

  // 1) The Redis budget counter the banner reads.
  const key = budgetKey();
  const rawCounter = await redis.get(key);
  const counter = Math.max(0, Number(rawCounter ?? 0) || 0);

  // 2) Ground truth: surviving Gemini images by segment provider.
  const { count: segCount, error: segErr } = await sb
    .from("synthetic_segments")
    .select("*", { count: "exact", head: true })
    .eq("provider", "gemini_image");
  if (segErr) throw segErr;

  // 3) Per-project breakdown of surviving Gemini images.
  const { data: rows, error: rowErr } = await sb
    .from("synthetic_segments")
    .select("project_id")
    .eq("provider", "gemini_image");
  if (rowErr) throw rowErr;

  const byProject = new Map<string, number>();
  for (const r of rows ?? []) {
    byProject.set(r.project_id, (byProject.get(r.project_id) ?? 0) + 1);
  }

  console.log("=== Gemini image count audit ===");
  console.log(`Month bucket:            ${key}`);
  console.log(`Redis BUDGET counter:    ${counter}   (what the banner shows: ${counter}/cap)`);
  console.log(`Surviving in DB:         ${segCount}   (segments.provider = gemini_image)`);
  console.log(`Inflation (counter-DB):  ${counter - (segCount ?? 0)}   (failed/retried/regenerated attempts)`);
  console.log(`Projects with a Gemini image: ${byProject.size}`);
  console.log("");
  console.log("Per-project surviving Gemini images:");
  for (const [pid, n] of [...byProject.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pid}  ${n}`);
  }

  await redis.quit();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

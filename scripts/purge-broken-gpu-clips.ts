// Delete CLIPS rendered during the broken-GPU window from the reuse library.
//
// DRY RUN BY DEFAULT — prints what it would delete and exits. Pass --apply to
// actually delete.
//
//   npx tsx --env-file=.env.local scripts/purge-broken-gpu-clips.ts
//   npx tsx --env-file=.env.local scripts/purge-broken-gpu-clips.ts --apply
//
// WHY
// ---
// Between the self-hosted GPU cutover (f926156, 2026-08-22) and the guidance fix
// (2026-08-25), every clip the pod rendered was damaged two ways:
//   • STG was active on a distilled checkpoint, perturbing the TEMPORAL pathway
//     — the client's "the around action part such as body is not good";
//   • the two-stage path skipped its Stage 2 refinement, so 1080p output carried
//     only 960x544 of real detail.
// Those clips were indexed into generated_assets as they were produced, so the
// reuse lookup will keep recycling them into NEW videos indefinitely. Fixing the
// renderer does not clean the library — this does.
//
// WHAT THIS DOES NOT TOUCH
// ------------------------
//   • R2 objects. Only the reuse INDEX row goes; the mp4 stays.
//   • Existing projects/videos. generated_assets has no FK to segments (see
//     0030's "no FK/cascade on purpose"), and a segment stores its video_url
//     directly, so already-rendered videos are unaffected and keep playing.
//   • Images. Stills were never touched by the GPU bug — LTX only renders video.
// The only effect is that these clips stop being offered for FUTURE reuse.
//
// WINDOW
// ------
// Defaults below bracket the damage. Override either end:
//   --from 2026-08-22T00:00:00Z  --to 2026-08-25T18:15:00Z
// The default --to is when the second backend came up on the fixed code; clips
// after it are good and must be kept. If you are unsure when production actually
// cut over to the pod, run without --apply first: the report breaks the rows down
// by day so you can see where the volume starts.
import { getServerSupabase } from "@/lib/supabase/server";

// Cutover commit f926156 is 2026-08-22 08:31 UTC; start of that day is a safe,
// slightly generous lower bound.
const DEFAULT_FROM = "2026-08-22T00:00:00Z";
// backend0 (the second GPU) was verified on the fixed pipeline at ~18:10 UTC on
// 2026-08-25; a few minutes of margin past it.
const DEFAULT_TO = "2026-08-25T18:15:00Z";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const from = argValue("--from") ?? DEFAULT_FROM;
  const to = argValue("--to") ?? DEFAULT_TO;
  const sb = getServerSupabase();

  console.log(`window : ${from}  ->  ${to}`);
  console.log(`mode   : ${apply ? "APPLY (rows will be deleted)" : "DRY RUN"}\n`);

  // PAGED. A single unbounded select over this window hits the statement
  // timeout -- generated_assets is tens of thousands of rows and created_at is
  // not indexed. Only the columns the report actually needs are fetched.
  const PAGE = 1000;
  const all: Array<{ id: string; provider: string | null; created_at: string; reuse_count: number | null }> = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error } = await sb
      .from("generated_assets")
      .select("id, provider, created_at, reuse_count")
      .eq("asset_type", "clip")
      .gte("created_at", from)
      .lt("created_at", to)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`select failed at offset ${offset}: ${error.message}`);
    const got = page ?? [];
    all.push(...(got as typeof all));
    process.stdout.write(`\r  fetched ${all.length}`);
    if (got.length < PAGE) break;
  }
  process.stdout.write("\n\n");
  if (all.length === 0) {
    console.log("No clips in that window — nothing to do.");
    return;
  }

  // Per-day counts: the honest way to spot the real cutover if the default
  // --from is wrong (volume jumps when the pod took over).
  const byDay = new Map<string, number>();
  const byProvider = new Map<string, number>();
  let alreadyReused = 0;
  for (const r of all) {
    const day = String(r.created_at).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    const p = r.provider ?? "(null)";
    byProvider.set(p, (byProvider.get(p) ?? 0) + 1);
    if ((r.reuse_count ?? 0) > 0) alreadyReused++;
  }

  console.log("clips per day in window:");
  for (const [day, n] of [...byDay.entries()].sort()) console.log(`  ${day}  ${n}`);
  console.log("\nby provider:");
  for (const [p, n] of [...byProvider.entries()].sort()) console.log(`  ${p.padEnd(20)} ${n}`);
  console.log(`\ntotal rows          : ${all.length}`);
  // Rows with reuse_count > 0 have ALREADY been recycled into other videos.
  // Deleting the index row stops further reuse but cannot un-ship those.
  console.log(`already reused once+: ${alreadyReused}  (already in other videos; deleting only stops FUTURE reuse)`);

  // Total clips in the library, for context on how much of the pool this is.
  // Estimated count: an exact count over the whole table also times out.
  const { count: totalClips } = await sb
    .from("generated_assets")
    .select("id", { count: "estimated", head: true })
    .eq("asset_type", "clip");
  console.log(`clips in library    : ${totalClips ?? "?"}  (this purge removes ${all.length})`);

  if (!apply) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --apply to delete.");
    console.log("Check the per-day counts above: if volume starts BEFORE the window,");
    console.log("widen it with --from, since those earlier clips are also from the pod.");
    return;
  }

  // Delete in batches: a single .in() with thousands of ids overflows the
  // PostgREST URL length.
  const ids = all.map((r) => r.id as string);
  const BATCH = 200;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const { error: delErr } = await sb.from("generated_assets").delete().in("id", slice);
    if (delErr) throw new Error(`delete failed at offset ${i}: ${delErr.message}`);
    deleted += slice.length;
    console.log(`  deleted ${deleted}/${ids.length}`);
  }
  console.log(`\nDone. ${deleted} clip rows removed from the reuse library.`);
  console.log("R2 objects and existing videos are untouched.");
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

// Delete FALLBACK-PROVIDER stills from the reuse library (generated_assets).
//
// These are the Gemini / fal.ai FLUX images produced while the 69labs fallback
// chain was live (removed 2026-08-15). They are off-house-style, and until
// migration 0035 the reuse lookup happily recycled them into new videos.
//
// DRY RUN BY DEFAULT — prints what it would delete and exits. Pass --apply to
// actually delete.
//
//   npx tsx --env-file=.env.local scripts/purge-fallback-assets.ts
//   npx tsx --env-file=.env.local scripts/purge-fallback-assets.ts --apply
//
// WHAT THIS DOES NOT TOUCH
// ------------------------
//   • R2 objects. Only the reuse INDEX row goes; the image file stays.
//   • Existing projects/videos. generated_assets has no FK to segments — a
//     segment stores its image_url directly (see 0030's "no FK/cascade on
//     purpose" note), so already-rendered videos are unaffected and any video
//     that reused one of these stills keeps working.
// The only effect is that these images stop being offered for FUTURE reuse.
//
// Migration 0035 already prevents them being SERVED, so this is cleanup rather
// than a fix — run it to shrink the table and make the library honest, not to
// stop the bleeding.
import { getServerSupabase } from "@/lib/supabase/server";
import { REMOVED_FALLBACK_PROVIDERS } from "@/lib/synthetic/asset-library";

async function main() {
  const apply = process.argv.includes("--apply");
  const sb = getServerSupabase();
  // Only the provably off-style fallback stills. The ltx2/heygen-labelled images
  // are ALSO barred from reuse (migration 0036) but are NOT deleted: they are
  // most likely genuine 69labs output that the backfill mislabelled, and
  // deletion cannot be undone.
  const providers = [...REMOVED_FALLBACK_PROVIDERS];

  const { count, error: countErr } = await sb
    .from("generated_assets")
    .select("id", { count: "exact", head: true })
    .in("provider", providers);
  if (countErr) throw new Error(`count failed: ${countErr.message}`);

  console.log(`providers targeted : ${providers.join(", ")}`);
  console.log(`rows matching      : ${count ?? 0}`);

  if (!count) {
    console.log("\nNothing to do.");
    return;
  }

  // Show a sample so the operator can eyeball what is about to go.
  const { data: sample } = await sb
    .from("generated_assets")
    .select("provider, asset_type, reuse_count, created_at, prompt")
    .in("provider", providers)
    .order("reuse_count", { ascending: false })
    .limit(5);
  console.log("\nmost-reused examples:");
  for (const r of (sample ?? []) as Array<Record<string, unknown>>) {
    console.log(
      `  ${String(r.provider).padEnd(15)} reuse=${String(r.reuse_count).padStart(4)}` +
        `  ${String(r.created_at).slice(0, 10)}  ${String(r.prompt).slice(0, 60)}…`,
    );
  }

  if (!apply) {
    console.log(
      `\nDRY RUN — nothing deleted. Re-run with --apply to delete these ${count} rows.`,
    );
    return;
  }

  // Delete in batches: one unbounded DELETE over ~20k rows can exceed the
  // PostgREST statement timeout and leave the job half-done with no report.
  const BATCH = 500;
  let deleted = 0;
  for (;;) {
    const { data: ids, error: selErr } = await sb
      .from("generated_assets")
      .select("id")
      .in("provider", providers)
      .limit(BATCH);
    if (selErr) throw new Error(`select batch failed: ${selErr.message}`);
    if (!ids || ids.length === 0) break;

    const { error: delErr } = await sb
      .from("generated_assets")
      .delete()
      .in("id", (ids as Array<{ id: string }>).map((r) => r.id));
    if (delErr) throw new Error(`delete batch failed: ${delErr.message}`);

    deleted += ids.length;
    console.log(`  deleted ${deleted}/${count}`);
    if (ids.length < BATCH) break;
  }

  console.log(`\nDone. Removed ${deleted} fallback rows from the reuse pool.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

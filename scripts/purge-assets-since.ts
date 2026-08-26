// Delete stills and/or clips from the reuse library by DATE WINDOW.
//
// DRY RUN BY DEFAULT — prints what it would delete and exits. Pass --apply to
// actually delete.
//
//   npx tsx --env-file=.env.local scripts/purge-assets-since.ts --from 2026-08-21
//   npx tsx --env-file=.env.local scripts/purge-assets-since.ts --from 2026-08-21 --apply
//   npx tsx --env-file=.env.local scripts/purge-assets-since.ts --from 2026-08-21 --type image
//
// WHY THIS EXISTS
// ---------------
// purge-broken-gpu-clips.ts already windows by date but is hard-wired to
// asset_type "clip" and to one incident's dates. purge-fallback-assets.ts
// selects by PROVIDER, not by date. Neither can answer "drop everything
// generated since <date>", which is what you want after a change to the PROMPT
// RULES: findReusableAsset matches on prompt text, so stills written under the
// old rules keep getting recycled into new videos and the fix looks like it did
// not work. Fixing the planner does not clean the library — this does.
//
// WHAT THIS DOES NOT TOUCH
// ------------------------
//   • R2 objects. Only the reuse INDEX row goes; the jpg/mp4 stays.
//   • Existing projects/videos. generated_assets has no FK to segments (see
//     0030's "no FK/cascade on purpose") and a segment stores its image_url /
//     video_url directly, so already-rendered videos keep working.
// The only effect is that these assets stop being offered for FUTURE reuse.
//
// A row with reuse_count > 0 has ALREADY been recycled into other videos.
// Deleting the index row stops further reuse but cannot un-ship those.
import { getServerSupabase } from "@/lib/supabase/server";

type AssetType = "image" | "clip";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Accept a bare date ("2026-08-21") as well as a full ISO timestamp, since a
// bare date is what you actually have in your head when you run this.
function normalizeInstant(raw: string, endOfDayIfBare: boolean): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDayIfBare ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable date: ${raw}`);
  return d.toISOString();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const fromRaw = argValue("--from");
  if (!fromRaw) {
    console.error("usage: purge-assets-since.ts --from <YYYY-MM-DD> [--to <YYYY-MM-DD>] [--type image|clip] [--apply]");
    process.exitCode = 1;
    return;
  }
  const from = normalizeInstant(fromRaw, false);
  const toRaw = argValue("--to");
  // No --to means "up to now" — the common case after a rules change.
  const to = toRaw ? normalizeInstant(toRaw, true) : new Date().toISOString();

  const typeArg = argValue("--type");
  if (typeArg && typeArg !== "image" && typeArg !== "clip") {
    throw new Error(`--type must be "image" or "clip" (omit it for both)`);
  }
  const types: AssetType[] = typeArg ? [typeArg as AssetType] : ["image", "clip"];

  const sb = getServerSupabase();
  console.log(`window : ${from}  ->  ${to}`);
  console.log(`types  : ${types.join(", ")}`);
  console.log(`mode   : ${apply ? "APPLY (rows will be deleted)" : "DRY RUN"}\n`);

  const doomed: Array<{ id: string; asset_type: string; created_at: string; reuse_count: number | null }> = [];

  for (const assetType of types) {
    // PAGED. A single unbounded select over this window hits the statement
    // timeout — generated_assets is tens of thousands of rows and created_at is
    // not indexed. Only the columns the report needs are fetched.
    const PAGE = 1000;
    let found = 0;
    for (let offset = 0; ; offset += PAGE) {
      const { data: page, error } = await sb
        .from("generated_assets")
        .select("id, asset_type, provider, created_at, reuse_count")
        .eq("asset_type", assetType)
        .gte("created_at", from)
        .lt("created_at", to)
        .order("created_at", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`select ${assetType} failed at offset ${offset}: ${error.message}`);
      const got = page ?? [];
      doomed.push(...(got as typeof doomed));
      found += got.length;
      process.stdout.write(`\r  ${assetType}: fetched ${found}`);
      if (got.length < PAGE) break;
    }
    process.stdout.write("\n");
  }
  console.log("");

  if (doomed.length === 0) {
    console.log("Nothing in that window — nothing to do.");
    return;
  }

  // Per-day counts, so a wrong --from is visible before anything is deleted.
  const byDay = new Map<string, number>();
  const byType = new Map<string, number>();
  let alreadyReused = 0;
  for (const r of doomed) {
    const day = String(r.created_at).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    byType.set(r.asset_type, (byType.get(r.asset_type) ?? 0) + 1);
    if ((r.reuse_count ?? 0) > 0) alreadyReused++;
  }

  console.log("per day in window:");
  for (const [day, n] of [...byDay.entries()].sort()) console.log(`  ${day}  ${n}`);
  console.log("\nby type:");
  for (const [t, n] of [...byType.entries()].sort()) console.log(`  ${t.padEnd(8)} ${n}`);
  console.log(`\ntotal rows          : ${doomed.length}`);
  console.log(`already reused once+: ${alreadyReused}  (already in other videos; deleting only stops FUTURE reuse)`);

  if (!apply) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --apply to delete.");
    console.log("Check the per-day counts above: if volume starts BEFORE the window,");
    console.log("widen it with --from.");
    return;
  }

  // Delete in batches: a single .in() with thousands of ids overflows the
  // PostgREST URL length.
  const ids = doomed.map((r) => r.id);
  const BATCH = 200;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const { error: delErr } = await sb.from("generated_assets").delete().in("id", slice);
    if (delErr) throw new Error(`delete failed at offset ${i}: ${delErr.message}`);
    deleted += slice.length;
    console.log(`  deleted ${deleted}/${ids.length}`);
  }
  console.log(`\nDone. ${deleted} rows removed from the reuse library.`);
  console.log("R2 objects and existing videos are untouched.");
}

void main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exitCode = 1;
});

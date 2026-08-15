// READ-ONLY audit of the reuse library (public.generated_assets).
//
// Answers: how many reusable assets came from the 69labs primary path, and how
// many are leftovers from the Gemini / fal.ai FLUX fallback that ran while
// 69labs was 503ing (2026-08-14/15). Those fallback stills are off-house-style,
// and because findReusableAsset does not filter on provider they keep getting
// recycled into new videos long after the outage ended.
//
// Writes NOTHING. Run this before scripts/purge-fallback-assets.ts.
//
//   npx tsx --env-file=.env.local scripts/audit-asset-library-providers.ts
import { getServerSupabase } from "@/lib/supabase/server";

// Providers that can no longer be produced (the fallback chain was removed from
// generateImage on 2026-08-15) and whose stills do not match the house look.
const FALLBACK_PROVIDERS = ["gemini_image", "fal_flux_image"];

async function main() {
  const sb = getServerSupabase();

  // Page through ids+providers rather than select("*") — the table holds one row
  // per generated asset and we only need the provider histogram.
  const byProvider = new Map<string, { total: number; reused: number; images: number }>();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("generated_assets")
      .select("provider, asset_type, reuse_count")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`generated_assets read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data as Array<{ provider: string | null; asset_type: string; reuse_count: number }>) {
      const k = row.provider ?? "(null)";
      const acc = byProvider.get(k) ?? { total: 0, reused: 0, images: 0 };
      acc.total += 1;
      if ((row.reuse_count ?? 0) > 0) acc.reused += 1;
      if (row.asset_type === "image") acc.images += 1;
      byProvider.set(k, acc);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const rows = [...byProvider.entries()].sort((a, b) => b[1].total - a[1].total);
  const grand = rows.reduce((n, [, v]) => n + v.total, 0);

  console.log("=== public.generated_assets by provider ===\n");
  console.log("provider".padEnd(20), "total".padStart(8), "images".padStart(8), "everReused".padStart(12));
  for (const [provider, v] of rows) {
    const flag = FALLBACK_PROVIDERS.includes(provider) ? "  <-- FALLBACK, purge candidate" : "";
    console.log(
      provider.padEnd(20),
      String(v.total).padStart(8),
      String(v.images).padStart(8),
      String(v.reused).padStart(12),
      flag,
    );
  }

  const purgeable = rows
    .filter(([p]) => FALLBACK_PROVIDERS.includes(p))
    .reduce((n, [, v]) => n + v.total, 0);
  const nulls = byProvider.get("(null)")?.total ?? 0;

  console.log(`\ntotal rows            : ${grand}`);
  console.log(`fallback (purgeable)  : ${purgeable}`);
  console.log(`null provider         : ${nulls}  (origin unknown — NOT purged by default)`);
  console.log(
    purgeable > 0
      ? `\nRun scripts/purge-fallback-assets.ts to remove the ${purgeable} fallback rows from the reuse pool.`
      : "\nNothing to purge — the reuse pool has no fallback-provider assets.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

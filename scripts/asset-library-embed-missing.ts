// Fill embeddings for generated_assets rows that were indexed WITHOUT one
// (transient embed failures during the backfill leave prompt_embedding null;
// those rows still serve the exact-hash tier but not semantic matching). Finds
// only the null-embedding rows and embeds just those — no re-indexing.
//
// Idempotent + resumable: re-run until it reports { remaining: 0 }.
//
// Run: npx tsx --env-file=.env.local scripts/asset-library-embed-missing.ts

import { getServerSupabase } from "@/lib/supabase/server";
import { embedPrompt } from "@/lib/synthetic/asset-embedding";

async function main() {
  const sb = getServerSupabase();
  let fixed = 0;
  let failed = 0;

  for (;;) {
    const { data, error } = await sb
      .from("generated_assets")
      .select("id, prompt")
      .is("prompt_embedding", null)
      .limit(100);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const vec = await embedPrompt(row.prompt as string);
      if (!vec) {
        failed++;
        continue; // leave null; a later re-run retries it
      }
      const { error: upErr } = await sb
        .from("generated_assets")
        .update({ prompt_embedding: JSON.stringify(vec) })
        .eq("id", row.id);
      if (upErr) {
        failed++;
        continue;
      }
      fixed++;
      if (fixed % 25 === 0) console.log(`embedded ${fixed}...`);
    }
  }

  const { count: remaining } = await sb
    .from("generated_assets")
    .select("*", { count: "exact", head: true })
    .is("prompt_embedding", null);
  console.log(JSON.stringify({ done: true, fixed, failedThisRun: failed, remaining }));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

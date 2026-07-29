// Backfill the cross-project asset library (migration 0030) from EVERYTHING
// already generated: every synthetic segment's live still/clip urls (and,
// with --history, prior versions from asset_history) become generated_assets
// rows keyed by their clean prompts — so the library starts full instead of
// empty and reuse kicks in from the first post-deploy video.
//
// Indexed:  image blocks (image_url), ai_clip blocks (video_url as 'clip' +
//           image_url as 'image'), split_2 right stills (right_image_url).
// Skipped:  avatar videos and split_2 left halves (face-locked per project),
//           pitch videos (site-specific) — reusing those is wrong by design.
//
// Idempotent: generated_assets has a unique index on asset_url, so a re-run
// (or overlap with live indexing) is a per-row no-op. Embedding failures still
// index the row (exact-hash tier works; vector backfillable by re-running).
//
// Run: npx tsx --env-file=.env.local scripts/asset-library-backfill.ts [--history] [--dry-run]

// Force the library ON for this process regardless of the deploy flag, so the
// backfill can run BEFORE ASSET_LIBRARY_ENABLED is flipped in production.
// Must happen before the first getEnv() call (it caches).
process.env.ASSET_LIBRARY_ENABLED = "true";

import { getServerSupabase } from "@/lib/supabase/server";
import { indexGeneratedAsset } from "@/lib/synthetic/asset-library";

const INCLUDE_HISTORY = process.argv.includes("--history");
const DRY_RUN = process.argv.includes("--dry-run");

interface SegRow {
  id: string;
  project_id: string;
  block_type: string;
  image_prompt: string | null;
  image_url: string | null;
  video_url: string | null;
  right_image_url: string | null;
  metadata: { base_prompt?: string } | null;
  asset_history: Array<{
    image_url?: string | null;
    video_url?: string | null;
    right_image_url?: string | null;
    provider?: string | null;
  }> | null;
  provider: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry a flaky async op through transient network failures. A ~40-min backfill
// makes thousands of requests to Supabase + Gemini; a single `TypeError: fetch
// failed` (momentary connection drop) must NOT crash the whole run. Retries
// with exponential backoff, then gives up and rethrows.
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = Math.min(15000, 1000 * 2 ** i);
      console.warn(`${label}: attempt ${i + 1}/${tries} failed (${(e as Error).message?.slice(0, 100)}) — retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function main() {
  const sb = getServerSupabase();
  const PAGE = 500;
  let offset = 0;
  let indexed = 0;
  let skipped = 0;

  for (;;) {
    // Page query wrapped in retry: this is exactly where a transient
    // `fetch failed` previously crashed the whole backfill.
    const { data, error } = await withRetry(`page@${offset}`, async () =>
      // `await` turns the PostgrestFilterBuilder (a thenable, not a real
      // Promise) into a genuine Promise<response> so withRetry's <T> infers the
      // full { data, error } shape instead of collapsing to unknown.
      await sb
        .from("synthetic_segments")
        .select("id, project_id, block_type, image_prompt, image_url, video_url, right_image_url, metadata, asset_history, provider")
        .in("block_type", ["image", "ai_clip", "split_2"])
        .order("created_at", { ascending: true })
        .range(offset, offset + PAGE - 1),
    );
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as SegRow[];
    if (rows.length === 0) break;

    for (const seg of rows) {
      const prompt = (seg.image_prompt?.trim() || seg.metadata?.base_prompt?.trim() || "").trim();
      if (!prompt) {
        skipped++;
        continue;
      }

      // Collect this segment's indexable {url, type, sourceImage} tuples.
      const targets: Array<{ url: string; type: "image" | "clip"; sourceImageUrl?: string | null; provider?: string | null }> = [];
      const addLive = (r: Pick<SegRow, "image_url" | "video_url" | "right_image_url" | "provider">) => {
        if (seg.block_type === "image" && r.image_url) {
          targets.push({ url: r.image_url, type: "image", provider: r.provider });
        }
        if (seg.block_type === "ai_clip") {
          if (r.image_url) targets.push({ url: r.image_url, type: "image", provider: r.provider });
          if (r.video_url) targets.push({ url: r.video_url, type: "clip", sourceImageUrl: r.image_url, provider: r.provider });
        }
        // split_2: ONLY the right still — video_url is the avatar left half.
        if (seg.block_type === "split_2" && r.right_image_url) {
          targets.push({ url: r.right_image_url, type: "image", provider: r.provider });
        }
      };
      addLive(seg);
      if (INCLUDE_HISTORY && Array.isArray(seg.asset_history)) {
        for (const h of seg.asset_history) {
          addLive({
            image_url: h.image_url ?? null,
            video_url: h.video_url ?? null,
            right_image_url: h.right_image_url ?? null,
            provider: h.provider ?? null,
          });
        }
      }

      for (const t of targets) {
        if (DRY_RUN) {
          indexed++;
          continue;
        }
        // indexGeneratedAsset swallows its own errors (best-effort by design),
        // so a transient failure would silently skip the asset. withRetry can't
        // see a swallowed error — instead we let it run, and the FINAL coverage
        // check below reports how many rows actually landed WITH an embedding,
        // so a partial run is visible rather than assumed complete. A short
        // pace keeps us well under Gemini's embedding rate limit.
        await indexGeneratedAsset({
          prompt,
          assetType: t.type,
          assetUrl: t.url,
          sourceImageUrl: t.sourceImageUrl ?? null,
          provider: t.provider ?? null,
          projectId: seg.project_id,
          segmentId: seg.id,
        });
        indexed++;
        if (indexed % 50 === 0) console.log(`indexed ${indexed} assets...`);
      }
    }
    offset += PAGE;
    console.log(`scanned ${offset} segments (indexed ${indexed}, skipped ${skipped})`);
  }

  // Coverage report: how many rows exist and how many have an embedding. If
  // withEmbeddings < total, some embedding calls failed transiently — just
  // re-run with --embed-missing (below) to fill the gaps.
  if (!DRY_RUN) {
    const { count: total } = await withRetry("count-total", async () =>
      await sb.from("generated_assets").select("*", { count: "exact", head: true }),
    );
    const { count: withVec } = await withRetry("count-vec", async () =>
      await sb.from("generated_assets").select("*", { count: "exact", head: true }).not("prompt_embedding", "is", null),
    );
    console.log(JSON.stringify({ coverage: { total, withEmbeddings: withVec, missing: (total ?? 0) - (withVec ?? 0) } }));
  }

  console.log(JSON.stringify({ done: true, dryRun: DRY_RUN, includeHistory: INCLUDE_HISTORY, indexed, skippedNoPrompt: skipped }));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

import { createHash } from "node:crypto";
import { getServerSupabase } from "@/lib/supabase/server";
import { getEnv } from "@/lib/env";
import { embedPrompt } from "@/lib/synthetic/asset-embedding";
import { isProductPrompt } from "@/lib/synthetic/constants";

// Cross-project reusable asset library (migration 0030).
//
// Every generated still / ai_clip is indexed here keyed by its CLEAN semantic
// prompt; before paying a provider (69labs image ~4¢, LTX clip much more) the
// image / image_to_video processors ask the library for a close-enough prior
// generation and reuse its permanent R2 url instead.
//
// Matching is two-tier:
//   1. exact  — sha256 of the normalized prompt (catches verbatim repeats,
//               e.g. the planner's recurring base_prompt) with no embedding
//               round-trip;
//   2. semantic — Gemini prompt embedding -> pgvector cosine NN via the
//               match_generated_assets RPC, gated by
//               ASSET_LIBRARY_REUSE_THRESHOLD.
//
// Variety rules (client requirement — reuse must never read as repetition):
//   - urls already used ANYWHERE in the calling project are excluded, so one
//     video never shows the same asset twice;
//   - among qualifying matches we pick the LEAST recently reused (nulls
//     first), so footage rotates across videos instead of the single closest
//     match recycling everywhere;
//   - product/brand stills only match other product stills (is_product);
//   - at most ASSET_LIBRARY_MAX_REUSE_FRACTION (default 50%) of a project's
//     segments may be served from the library; past that every remaining
//     segment generates fresh.
//
// Failure policy: the library is an optimization, never a dependency. Every
// public function catches its own errors (including "migration not applied
// yet") and returns null / no-ops, so generation always proceeds.

// Providers whose stills may be served from the reuse pool. IMAGES ONLY — an
// ALLOW-LIST of exactly one provider (tightened 2026-08-15, superseding the
// earlier fal_flux_image/gemini_image deny-list; see migration 0036).
//
// Only 69labs output matches the house look the synthetic STYLE_PROMPT is tuned
// for, so only 69labs output may be recycled into a new video.
//
// The deny-list was not enough because of a BACKFILL MISLABEL. Every
// indexGeneratedAsset CALL SITE passes the image's own provider correctly, but
// scripts/asset-library-backfill.ts reads the SEGMENT's `provider` column — and
// for an ai_clip segment imageToVideoProcessor overwrites that column with the
// CLIP's provider once the animation lands (image provider at :118, clobbered
// by clip.provider at :158). So an ai_clip's 69labs still got indexed as
// "ltx2", and a split_2's right-half still as "heygen". Measured 2026-08-15:
// 723 ltx2 + 249 heygen rows of asset_type='image', every one a .jpg under
// /images/ — LTX-2 is image-to-video and HeyGen renders avatar video; NEITHER
// can emit a standalone still, which is what proves these are mislabels.
//
// Those ~972 rows are therefore MOSTLY genuine 69labs stills — but the image's
// true provider is not recoverable (the segment column was overwritten), so any
// that were generated during the fallback era are indistinguishable FLUX/Gemini
// stills. Excluded rather than relabelled: 972 rows is ~2% of the 43.7k clean
// pool, a cheap price for certainty about what gets reused.
//
// SCOPED TO IMAGES. Clip reuse is untouched — the ~10.1k ltx2 clips are the only
// clips there are, and an allow-list applied to them would disable clip reuse
// entirely.
//
// "ai33_image" joins the list on 2026-08-16, when ai33.pro became the primary
// image provider. It belongs here for the same reason "sixtynine_image" does:
// both render the house model (gpt-image-2) against the same style prompt, so
// their stills are interchangeable for reuse. This is NOT the fallback-era
// problem the allow-list was built to solve — that was about FLUX/Gemini stills
// from a DIFFERENT model quietly entering the pool.
export const REUSABLE_IMAGE_PROVIDERS = ["sixtynine_image", "ai33_image"] as const;

// Stills from the REMOVED fallback chain. Distinct from the allow-list above:
// these are the rows we can PROVE are off-style, so they are the only ones
// scripts/purge-fallback-assets.ts will delete. The mislabelled ltx2/heygen
// stills are blocked from reuse by the allow-list but NOT deleted — they are
// probably genuine 69labs output and deletion is irreversible.
export const REMOVED_FALLBACK_PROVIDERS = ["fal_flux_image", "gemini_image"] as const;

export interface ReusableAsset {
  id: string;
  assetUrl: string;
  // For clips: the source still the animation was made from.
  sourceImageUrl: string | null;
  provider: string | null;
  // 'exact' = normalized-prompt hash hit; 'semantic' = embedding NN hit.
  via: "exact" | "semantic";
  // 1 for exact hits; cosine similarity for semantic hits.
  similarity: number;
}

export function isAssetLibraryEnabled(): boolean {
  return getEnv().ASSET_LIBRARY_ENABLED;
}

// One normalization, shared by index + lookup + backfill: lowercase, trim,
// collapse runs of whitespace. Deliberately NOT stripping punctuation — the
// planner emits consistent punctuation, and stripping it would over-merge.
export function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase().trim().replace(/\s+/g, " ");
}

export function promptHash(prompt: string): string {
  return createHash("sha256").update(normalizePrompt(prompt)).digest("hex");
}

// One read of the project's segments serving both per-video guards:
//   - usedUrls: every asset url already present on the project (live columns
//     AND asset_history) — the no-repeat exclusion list, so one video never
//     shows the same asset twice;
//   - total / reusedCount: the reuse budget (see reuseBudgetLeft) — segments
//     whose metadata carries the `reused` marker written by finishSegment.
// Read fresh per lookup: segments complete concurrently and a stale snapshot
// would let two concurrent segments reuse the same asset, or overshoot the cap.
async function projectReuseState(projectId: string): Promise<{
  usedUrls: string[];
  total: number;
  reusedCount: number;
}> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("synthetic_segments")
    .select("image_url, video_url, right_image_url, asset_history, metadata")
    .eq("project_id", projectId);
  const urls = new Set<string>();
  let reusedCount = 0;
  for (const row of data ?? []) {
    for (const u of [row.image_url, row.video_url, row.right_image_url]) {
      if (u) urls.add(u as string);
    }
    if (Array.isArray(row.asset_history)) {
      for (const h of row.asset_history as Array<Record<string, unknown>>) {
        for (const k of ["image_url", "video_url", "right_image_url"]) {
          const u = h?.[k];
          if (typeof u === "string" && u) urls.add(u);
        }
      }
    }
    // A segment counts ONCE however many of its assets came from the library —
    // the marker is a single metadata key, and the cap is expressed in items.
    if ((row.metadata as Record<string, unknown> | null)?.reused) reusedCount += 1;
  }
  return { usedUrls: [...urls], total: (data ?? []).length, reusedCount };
}

/**
 * How many more segments of this project may be served from the library.
 * Budget = floor(total_segments * ASSET_LIBRARY_MAX_REUSE_FRACTION), default
 * 50%. Best-effort under concurrency: several in-flight segments can each see
 * the same pre-write count, so the realized share can overshoot by roughly the
 * number of concurrently running segments before settling at the cap.
 */
function reuseBudgetLeft(state: { total: number; reusedCount: number }, fraction: number): number {
  const allowed = Math.floor(state.total * fraction);
  return allowed - state.reusedCount;
}

// Least-recently-reused pick: nulls (never reused) first, then oldest
// last_reused_at, then lowest reuse_count. This is the rotation that stops one
// popular asset from appearing in every video.
function pickLeastRecentlyReused<T extends { reuse_count: number; last_reused_at: string | null }>(
  candidates: T[],
): T | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const at = a.last_reused_at ? Date.parse(a.last_reused_at) : -1;
    const bt = b.last_reused_at ? Date.parse(b.last_reused_at) : -1;
    if (at !== bt) return at - bt;
    return a.reuse_count - b.reuse_count;
  })[0];
}

/**
 * Look up a reusable prior generation for `prompt`. Returns null when the
 * library is disabled, the project has spent its reuse budget (see
 * reuseBudgetLeft), nothing clears the threshold, everything qualifying is
 * already used in this project, or any error occurs. On a hit, bumps the row's
 * rotation bookkeeping (reuse_count / last_reused_at) before returning.
 */
export async function findReusableAsset(opts: {
  prompt: string;
  assetType: "image" | "clip";
  projectId: string;
}): Promise<ReusableAsset | null> {
  const env = getEnv();
  if (!env.ASSET_LIBRARY_ENABLED) return null;
  const prompt = opts.prompt.trim();
  if (!prompt) return null;

  try {
    const sb = getServerSupabase();
    const isProduct = isProductPrompt(prompt);
    const state = await projectReuseState(opts.projectId);

    // Per-project reuse ceiling — checked BEFORE any query/embedding so an
    // exhausted budget costs nothing. Generation proceeds fresh, as if the
    // library had no match.
    const budget = reuseBudgetLeft(state, env.ASSET_LIBRARY_MAX_REUSE_FRACTION);
    if (budget <= 0) {
      console.log(JSON.stringify({
        msg: "asset_library.reuse_cap_reached",
        projectId: opts.projectId,
        total: state.total,
        reused: state.reusedCount,
        fraction: env.ASSET_LIBRARY_MAX_REUSE_FRACTION,
      }));
      return null;
    }
    const exclude = state.usedUrls;

    // Tier 1: exact normalized-prompt hash.
    // This tier does NOT go through match_generated_assets, so the provider rule
    // migration 0036 added to the RPC has to be repeated here or an exact prompt
    // match would still serve a non-69labs still. See REUSABLE_IMAGE_PROVIDERS.
    let exactQ = sb
      .from("generated_assets")
      .select("id, asset_url, source_image_url, provider, reuse_count, last_reused_at")
      .eq("asset_type", opts.assetType)
      .eq("is_product", isProduct)
      .eq("prompt_hash", promptHash(prompt));
    // Images: 69labs only. Clips: unrestricted (ltx2 is the only clip provider,
    // so a filter here would switch clip reuse off entirely).
    if (opts.assetType === "image") {
      exactQ = exactQ.in("provider", [...REUSABLE_IMAGE_PROVIDERS]);
    }
    const { data: exact, error: exactErr } = await exactQ.limit(50);
    if (exactErr) throw new Error(exactErr.message);
    const exactFree = (exact ?? []).filter((r) => !exclude.includes(r.asset_url as string));
    const exactPick = pickLeastRecentlyReused(
      exactFree as Array<{ reuse_count: number; last_reused_at: string | null } & Record<string, unknown>>,
    );
    if (exactPick) {
      await markReused(exactPick.id as string);
      return {
        id: exactPick.id as string,
        assetUrl: exactPick.asset_url as string,
        sourceImageUrl: (exactPick.source_image_url as string | null) ?? null,
        provider: (exactPick.provider as string | null) ?? null,
        via: "exact",
        similarity: 1,
      };
    }

    // Tier 2: semantic nearest-neighbour. No embedding -> no semantic tier.
    const embedding = await embedPrompt(prompt);
    if (!embedding) return null;
    const { data: matches, error: rpcErr } = await sb.rpc("match_generated_assets", {
      // pgvector's input literal is '[f1,f2,...]' — JSON.stringify of a number
      // array produces exactly that, and PostgREST casts the string to vector.
      query_embedding: JSON.stringify(embedding),
      match_asset_type: opts.assetType,
      match_is_product: isProduct,
      min_similarity: env.ASSET_LIBRARY_REUSE_THRESHOLD,
      match_limit: env.ASSET_LIBRARY_MATCH_LIMIT,
      exclude_urls: exclude,
    });
    if (rpcErr) throw new Error(rpcErr.message);
    const rows = (matches ?? []) as Array<{
      id: string;
      asset_url: string;
      source_image_url: string | null;
      provider: string | null;
      similarity: number;
      reuse_count: number;
      last_reused_at: string | null;
    }>;
    const pick = pickLeastRecentlyReused(rows);
    if (!pick) return null;
    await markReused(pick.id);
    return {
      id: pick.id,
      assetUrl: pick.asset_url,
      sourceImageUrl: pick.source_image_url ?? null,
      provider: pick.provider ?? null,
      via: "semantic",
      similarity: pick.similarity,
    };
  } catch (e) {
    // Includes "relation generated_assets does not exist" before the migration
    // is applied — the library silently stands down and generation proceeds.
    console.warn(JSON.stringify({
      msg: "asset_library.lookup_failed",
      err: (e as Error).message?.slice(0, 200),
    }));
    return null;
  }
}

async function markReused(id: string): Promise<void> {
  const sb = getServerSupabase();
  // Read-modify-write; a lost increment under a rare race only skews rotation
  // bookkeeping slightly, never correctness.
  const { data } = await sb.from("generated_assets").select("reuse_count").eq("id", id).single();
  await sb
    .from("generated_assets")
    .update({ reuse_count: ((data?.reuse_count as number) ?? 0) + 1, last_reused_at: new Date().toISOString() })
    .eq("id", id);
}

/**
 * Index a freshly generated asset into the library (best-effort; never
 * throws). Embeds the prompt when possible; a row without an embedding still
 * serves the exact-hash tier and can be backfilled later. Re-indexing the same
 * asset_url is a no-op (unique index).
 */
export async function indexGeneratedAsset(opts: {
  prompt: string;
  assetType: "image" | "clip";
  assetUrl: string;
  sourceImageUrl?: string | null;
  provider?: string | null;
  projectId?: string | null;
  segmentId?: string | null;
}): Promise<void> {
  const env = getEnv();
  if (!env.ASSET_LIBRARY_ENABLED) return;
  const prompt = opts.prompt.trim();
  if (!prompt || !opts.assetUrl) return;

  try {
    const sb = getServerSupabase();
    const embedding = await embedPrompt(prompt);
    const { error } = await sb.from("generated_assets").insert({
      asset_type: opts.assetType,
      prompt,
      prompt_hash: promptHash(prompt),
      // pgvector accepts its '[f1,f2,...]' literal through PostgREST.
      prompt_embedding: embedding ? JSON.stringify(embedding) : null,
      asset_url: opts.assetUrl,
      source_image_url: opts.sourceImageUrl ?? null,
      provider: opts.provider ?? null,
      source_project_id: opts.projectId ?? null,
      source_segment_id: opts.segmentId ?? null,
      is_product: isProductPrompt(prompt),
    });
    // 23505 = asset_url already indexed (regenerate re-running / backfill
    // overlap) — the intended no-op.
    if (error && error.code !== "23505") throw new Error(error.message);
  } catch (e) {
    console.warn(JSON.stringify({
      msg: "asset_library.index_failed",
      assetUrl: opts.assetUrl.slice(0, 120),
      err: (e as Error).message?.slice(0, 200),
    }));
  }
}

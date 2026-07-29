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
//   - product/brand stills only match other product stills (is_product).
//
// Failure policy: the library is an optimization, never a dependency. Every
// public function catches its own errors (including "migration not applied
// yet") and returns null / no-ops, so generation always proceeds.

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

// Every asset url already present on the project's segments (live columns AND
// asset_history) — the per-video no-repeat exclusion list. Read fresh per
// lookup: segments complete concurrently and a stale list would let two
// concurrent segments reuse the same asset into one video.
async function projectUsedUrls(projectId: string): Promise<string[]> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("synthetic_segments")
    .select("image_url, video_url, right_image_url, asset_history")
    .eq("project_id", projectId);
  const urls = new Set<string>();
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
  }
  return [...urls];
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
 * library is disabled, nothing clears the threshold, everything qualifying is
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
    const exclude = await projectUsedUrls(opts.projectId);

    // Tier 1: exact normalized-prompt hash.
    const { data: exact, error: exactErr } = await sb
      .from("generated_assets")
      .select("id, asset_url, source_image_url, provider, reuse_count, last_reused_at")
      .eq("asset_type", opts.assetType)
      .eq("is_product", isProduct)
      .eq("prompt_hash", promptHash(prompt))
      .limit(50);
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

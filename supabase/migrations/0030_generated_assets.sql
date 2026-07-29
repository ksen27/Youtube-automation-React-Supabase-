-- Cross-project reusable asset library (client cost-reduction ask, 2026-07-28:
-- "store everything we have generated so the AI can fetch older generations of
-- footage and images instead of regenerating").
--
-- One row per generated still / ai_clip, keyed by its CLEAN semantic prompt
-- (the stored image_prompt/animation_prompt WITHOUT the call-time STYLE_PROMPT
-- suffix, so wording — not style boilerplate — drives matching). Two lookup
-- paths, both consulted by lib/synthetic/asset-library.ts BEFORE a provider
-- call:
--   1. prompt_hash  — sha256 of the normalized prompt; exact fast-path that
--      catches verbatim repeats (e.g. the planner's recurring base_prompt)
--      without an embedding round-trip.
--   2. prompt_embedding — 768-dim Gemini text-embedding-004 vector; semantic
--      nearest-neighbour via the match_generated_assets RPC below, gated by
--      ASSET_LIBRARY_REUSE_THRESHOLD in the app.
--
-- Rows reference the ORIGINAL R2 urls (permanent — keys are versioned per
-- generation and never overwritten), so no file copying is involved. Avatars
-- and pitch videos are deliberately NOT indexed (face-locked / site-specific;
-- reusing them across projects would be wrong by construction).
--
-- Apply via the Supabase SQL editor (repo convention). pgvector is available
-- natively on Supabase; `create extension vector` is idempotent.

create extension if not exists vector;

create table if not exists public.generated_assets (
  id uuid primary key default gen_random_uuid(),
  -- 'image' (nano-banana/Gemini/FLUX still) | 'clip' (LTX ai_clip mp4).
  asset_type text not null check (asset_type in ('image', 'clip')),
  -- The clean semantic prompt the asset was generated from (image_prompt for
  -- stills; image_prompt + animation intent for clips). No STYLE_PROMPT suffix.
  prompt text not null,
  -- sha256 hex of lower(trim(collapsed-whitespace(prompt))) — the exact
  -- fast-path key. Computed app-side (lib/synthetic/asset-library.ts) so the
  -- normalization lives in one place.
  prompt_hash text not null,
  -- Gemini text-embedding-004 vector of the prompt. Nullable: a row whose
  -- embedding call failed is still indexed for the exact-hash path and can be
  -- backfilled later.
  prompt_embedding vector(768),
  -- Permanent R2 public URL of the asset (image jpg or clip mp4).
  asset_url text not null,
  -- For clips: the source still the animation started from (lets a future
  -- image lookup reuse a clip's source frame too). Null for images.
  source_image_url text,
  provider text,
  -- Provenance (no FK/cascade on purpose: the library must OUTLIVE its source
  -- project — deleting a project should not delete reusable footage).
  source_project_id uuid,
  source_segment_id uuid,
  -- Product/brand stills (isProductPrompt in lib/synthetic/constants.ts) are
  -- matched only against other product stills, so a branded product shot is
  -- never reused as generic b-roll (and vice versa).
  is_product boolean not null default false,
  -- Rotation bookkeeping for the variety rule: among equally-good matches the
  -- app prefers the LEAST recently reused row, so one popular asset doesn't
  -- recycle into every video.
  reuse_count integer not null default 0,
  last_reused_at timestamptz,
  created_at timestamptz not null default now()
);

-- Same asset re-indexed twice (e.g. backfill re-run) is a no-op.
create unique index if not exists generated_assets_url_uq
  on public.generated_assets (asset_url);

-- Exact fast-path lookup.
create index if not exists generated_assets_hash_idx
  on public.generated_assets (asset_type, is_product, prompt_hash);

-- Semantic nearest-neighbour. HNSW over cosine distance; pgvector's HNSW
-- builds incrementally (no ivfflat training-set requirement), fine at this
-- table's scale (tens of thousands of rows).
create index if not exists generated_assets_embedding_idx
  on public.generated_assets
  using hnsw (prompt_embedding vector_cosine_ops);

comment on table public.generated_assets is
  'Cross-project library of generated stills/clips keyed by semantic prompt; consulted before paid provider calls to reuse prior footage (lib/synthetic/asset-library.ts).';

-- Nearest-neighbour match RPC. PostgREST cannot express vector-distance
-- ordering, so the app calls this function via supabase.rpc(). Returns the
-- closest `match_limit` candidates of the requested type/product class above
-- `min_similarity`, EXCLUDING urls already used in the calling project
-- (variety rule: no repeat within one video). Similarity = 1 - cosine distance.
create or replace function public.match_generated_assets(
  query_embedding vector(768),
  match_asset_type text,
  match_is_product boolean,
  min_similarity double precision,
  match_limit integer,
  exclude_urls text[] default '{}'
)
returns table (
  id uuid,
  asset_url text,
  source_image_url text,
  prompt text,
  provider text,
  similarity double precision,
  reuse_count integer,
  last_reused_at timestamptz
)
language sql
stable
as $$
  select
    ga.id,
    ga.asset_url,
    ga.source_image_url,
    ga.prompt,
    ga.provider,
    1 - (ga.prompt_embedding <=> query_embedding) as similarity,
    ga.reuse_count,
    ga.last_reused_at
  from public.generated_assets ga
  where ga.asset_type = match_asset_type
    and ga.is_product = match_is_product
    and ga.prompt_embedding is not null
    and 1 - (ga.prompt_embedding <=> query_embedding) >= min_similarity
    and not (ga.asset_url = any(exclude_urls))
  order by ga.prompt_embedding <=> query_embedding
  limit match_limit;
$$;

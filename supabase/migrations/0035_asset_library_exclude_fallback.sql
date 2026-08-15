-- Keep FALLBACK-PROVIDER stills out of the reuse pool.
--
-- WHY
-- ---
-- Until 2026-08-15, lib/synthetic/sixtynine-labs.ts fell 69labs -> Gemini ->
-- fal.ai FLUX whenever 69labs failed, and worker/processors/synthetic/
-- imageGenProcessor.ts indexed whatever came back into public.generated_assets.
-- Those FLUX/Gemini stills do not match the house look the STYLE_PROMPT is
-- tuned for, and because match_generated_assets never filtered on provider they
-- kept being recycled into NEW videos indefinitely — one bad outage
-- contaminating every future project. Measured 2026-08-15: 19,454
-- fal_flux_image + 311 gemini_image rows, ~31% of the image library.
--
-- The fallback chain itself is now gone (a 69labs failure throws), so nothing
-- new can enter with these providers. This migration stops the EXISTING rows
-- from being served, independently of whether they are ever deleted — see
-- scripts/purge-fallback-assets.ts for the row cleanup.
--
-- WHY IN THE RPC AND NOT IN THE APP
-- ---------------------------------
-- The function applies `limit match_limit` after ordering by distance. Filtering
-- the returned rows app-side would drop matches AFTER the limit was spent, so a
-- prompt whose nearest 10 neighbours happened to be FLUX stills would fall back
-- to "no match" even when good 69labs rows existed just outside the window.
-- The exclusion has to happen before the limit — i.e. here.
--
-- Clips (ltx2) and avatar frames (heygen) are unaffected: this names only the
-- two dead image-fallback providers rather than whitelisting 69labs, so no other
-- asset kind is caught by it.

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
    -- NEW: never serve a removed-fallback-provider still. `is distinct from`
    -- rather than `not in` so a NULL provider (origin unknown, pre-dates
    -- provider tracking) stays eligible instead of being silently dropped —
    -- `provider not in (...)` evaluates to NULL for those rows and would
    -- exclude them.
    and ga.provider is distinct from 'fal_flux_image'
    and ga.provider is distinct from 'gemini_image'
  order by ga.prompt_embedding <=> query_embedding
  limit match_limit;
$$;

comment on function public.match_generated_assets is
  'Nearest-neighbour reuse lookup over generated_assets. Excludes the dead '
  'fal_flux_image / gemini_image fallback providers (2026-08-15) so an outage''s '
  'off-style stills are never recycled into new videos.';

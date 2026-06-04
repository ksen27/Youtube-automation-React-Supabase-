-- =========================================================================
-- Quota-saving + cross-project memory for subject-first source discovery.
--
-- Two tables, both in service of the YouTube Data API quota ceiling
-- (10k units/day default; each search.list is ~100 units). The subject-first
-- redesign runs many footage queries per project, so without these we exhaust
-- quota after a handful of projects.
--
--   youtube_search_cache    – caches (query[,channel]) -> result video ids so
--                             the SAME query in a later project costs 0 units.
--                             A 7-30 day TTL keeps results fresh enough; the
--                             footage we want ("Simon Cowell interview") is
--                             stable day-to-day.
--
--   approved_source_videos  – cross-project memory of source videos a USER
--                             approved for a given entity. On a new project
--                             featuring the same celebrity, these are seeded as
--                             top-ranked candidates (Phase 3 search tier) and
--                             cost nothing to re-surface.
-- =========================================================================

-- ----- Search result cache -------------------------------------------------
-- cache_key is a normalized "query|channelId" string (channelId empty for
-- open-YouTube searches). We store the hydrated candidate payloads as jsonb so
-- a cache hit can skip BOTH search.list and videos.list entirely. expires_at
-- drives TTL eviction; a lookup treats an expired row as a miss.
create table if not exists public.youtube_search_cache (
  id          uuid primary key default gen_random_uuid(),
  cache_key   text not null unique,
  query       text not null,
  channel_id  text,                       -- null/'' for open-YouTube searches
  candidates  jsonb not null default '[]'::jsonb,  -- YoutubeCandidate[]
  source      text not null default 'api' check (source in ('api', 'ytdlp')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists ysc_cache_key_idx on public.youtube_search_cache (cache_key);
create index if not exists ysc_expires_idx    on public.youtube_search_cache (expires_at);

-- ----- Approved source videos (cross-project) ------------------------------
-- One row per (entity, video) the user has approved. entity_key is the
-- lowercased entity value ("simon cowell") so lookups are case-insensitive and
-- independent of any single project. We keep enough metadata to seed a
-- candidate card without a fresh videos.list call, but the seeding path may
-- still re-hydrate to refresh privacy/duration.
create table if not exists public.approved_source_videos (
  id                uuid primary key default gen_random_uuid(),
  entity_key        text not null,        -- lowercased entity value
  entity_type       text,                 -- 'celebrity' | 'related_person' | ...
  youtube_video_id  text not null,
  url               text,
  title             text,
  channel_id        text,
  channel_title     text,
  duration_seconds  int,
  -- Where it was first approved, for auditing. Not a FK: the source project may
  -- be deleted later but the approval is still valid cross-project memory.
  approved_from_project_id uuid,
  approved_count    int not null default 1,   -- bumped each time re-approved
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (entity_key, youtube_video_id)
);

create index if not exists asv_entity_key_idx on public.approved_source_videos (entity_key);

create trigger approved_source_videos_touch
  before update on public.approved_source_videos
  for each row execute function public.touch_updated_at();

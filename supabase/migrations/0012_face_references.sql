-- Face/entity reference roster for the closed-world matching refactor
-- (Slices 2-6 of the matching-quality work).
--
-- One row per (project, entity) — typically the project celebrity plus every
-- non-celebrity person, company, TV show, movie, song, and place named in
-- the script. The reference_url is the canonical visual we hand to Gemini
-- when verifying a candidate clip/image: "is this picture of THE SAME
-- person/logo/poster/place as this reference?"
--
-- Sources, in priority order:
--   1. Wikipedia infobox image (free, canonical, stable)
--   2. (future) operator-uploaded photo for non-public people
--
-- The matcher (Slice 6) looks up references by (project_id, entity_type,
-- entity_name) when it needs to gate a candidate. A NULL reference_url means
-- we tried but couldn't find one — the matcher falls back to text-match for
-- that entity (Slice 4-5 logic).

create table if not exists public.face_references (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  -- Mirrors the BlockEntityType enum in lib/ai/segments.ts. Stored as text
  -- (not a Postgres enum) because the application is the source of truth
  -- and we don't want a migration every time the enum is extended.
  entity_type     text not null
                  check (entity_type in ('person','company','tv_show','movie','song','place')),
  -- Verbatim name the script uses for this entity. Case-preserved (display)
  -- but compared via lower() in lookups.
  entity_name     text not null,
  -- Where this reference came from. "wikipedia" today; "operator" / "search"
  -- reserved for future fallbacks.
  source          text not null default 'wikipedia'
                  check (source in ('wikipedia','operator','search')),
  -- Canonical reference image URL we feed to Gemini's verification gate.
  -- NULL when we tried every source and found nothing — the matcher should
  -- then bypass face/entity verification for this entity.
  reference_url   text,
  -- Optional source page URL (Wikipedia article, operator note, etc.) for
  -- attribution and debugging.
  source_page_url text,
  -- Free-form metadata: image dimensions, alternate URLs we tried and
  -- skipped, the original Wikipedia title we resolved to, etc.
  metadata        jsonb default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One reference per (project, type, name). Re-running the roster builder
-- upserts on this key.
create unique index if not exists face_references_project_type_name_idx
  on public.face_references (project_id, entity_type, lower(entity_name));

create index if not exists face_references_project_id_idx
  on public.face_references (project_id);

drop trigger if exists face_references_touch on public.face_references;
create trigger face_references_touch
  before update on public.face_references
  for each row execute function public.touch_updated_at();

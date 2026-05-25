-- Verification columns for the closed-world matching refactor
-- (Slices 4-6 of the matching-quality work).
--
-- Goal: when the image / clip pool is built, every entry carries the
-- (entity_type, entity_name) it was fetched for, plus the verification
-- verdict from Gemini. The matcher (Slice 6) reads these columns to
-- enforce "this block's resolved entity must match the asset's
-- entity_name" at assignment time, with the celebrity pool as the
-- universal fallback.
--
-- Schema choice: we add columns to existing tables (timeline_items,
-- video_clips) rather than creating new pool tables, because the matcher
-- already writes assets directly into timeline_items / video_clips. A
-- separate pool table would mean a second migration phase to move reads
-- across. Additive columns keep both old and new matcher paths working.

-- ---------------------------------------------------------------------------
-- timeline_items: image_entity_type, image_entity_name, image_verified
-- ---------------------------------------------------------------------------
-- The "Replace Media" picker reads image_url across all of a project's
-- timeline_items to build the per-scene picker pool. With these columns the
-- picker (and Slice 7 UI work) can scope the pool to the current block's
-- entity instead of showing the whole project's images.
--
--   image_entity_type — one of person/company/tv_show/movie/song/place/
--                       celebrity_default. NULL for legacy rows.
--   image_entity_name — verbatim entity name the image was fetched for.
--                       NULL for legacy rows. For celebrity_default this
--                       is the project celebrity's name.
--   image_verified    — Gemini verification verdict:
--                       'yes' | 'no' | 'uncertain' | 'skipped' | NULL
--                       'skipped' means the matcher fast-pathed past the
--                       gate (no reference available, or asset is the
--                       celebrity-pool fallback). NULL means legacy row
--                       written before verification existed.
--   image_verify_reason — short free-text from Gemini, for debugging the
--                       picker. NULL when not verified.

alter table public.timeline_items
  add column if not exists image_entity_type   text,
  add column if not exists image_entity_name   text,
  add column if not exists image_verified      text,
  add column if not exists image_verify_reason text;

alter table public.timeline_items
  drop constraint if exists timeline_items_image_entity_type_check;
alter table public.timeline_items
  add constraint timeline_items_image_entity_type_check
    check (image_entity_type is null or image_entity_type in (
      'person','company','tv_show','movie','song','place','celebrity_default'
    ));

alter table public.timeline_items
  drop constraint if exists timeline_items_image_verified_check;
alter table public.timeline_items
  add constraint timeline_items_image_verified_check
    check (image_verified is null or image_verified in (
      'yes','no','uncertain','skipped'
    ));

create index if not exists timeline_items_image_entity_idx
  on public.timeline_items (project_id, image_entity_type, image_entity_name);

-- ---------------------------------------------------------------------------
-- video_clips: entity_type, entity_name, person_verified, segment_id hint
-- ---------------------------------------------------------------------------
-- Clips are project-pooled today. We don't move them to per-segment pools
-- (that would require a much larger refactor of matchProcessor); instead we
-- tag each clip with the entity it was DOWNLOADED FOR so the matcher can
-- gate at assignment time. `intended_segment_index` is a soft hint, not a
-- hard partition — clips are still shareable across segments when the
-- entity matches.
--
--   entity_type      — same enum as timeline_items.image_entity_type.
--                      NULL for legacy rows.
--   entity_name      — verbatim entity name (or celebrity name for
--                      celebrity_default clips). NULL for legacy rows.
--   person_verified  — Gemini face verification verdict on the clip's
--                      keyframes / thumbnail:
--                      'yes' | 'no' | 'uncertain' | 'skipped' | NULL
--                      Same semantics as timeline_items.image_verified.
--   verify_reason    — short free-text from Gemini.
--   intended_segment_index — soft hint: which segment's search intent
--                      produced this clip. NULL for legacy rows.

alter table public.video_clips
  add column if not exists entity_type            text,
  add column if not exists entity_name            text,
  add column if not exists person_verified        text,
  add column if not exists verify_reason          text,
  add column if not exists intended_segment_index int;

alter table public.video_clips
  drop constraint if exists video_clips_entity_type_check;
alter table public.video_clips
  add constraint video_clips_entity_type_check
    check (entity_type is null or entity_type in (
      'person','company','tv_show','movie','song','place','celebrity_default'
    ));

alter table public.video_clips
  drop constraint if exists video_clips_person_verified_check;
alter table public.video_clips
  add constraint video_clips_person_verified_check
    check (person_verified is null or person_verified in (
      'yes','no','uncertain','skipped'
    ));

create index if not exists video_clips_entity_idx
  on public.video_clips (project_id, entity_type, entity_name);

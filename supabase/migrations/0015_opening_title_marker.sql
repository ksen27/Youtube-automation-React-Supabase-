-- Add `opening_title` to the project_script_markers.kind CHECK constraint.
--
-- The doc parser previously folded a blue-bold title line at the very top of
-- a script doc into the first intro_card's `text` field, where it was stored
-- but never shown anywhere in the final video. Per user request, that title
-- is now persisted as its own marker so the renderer can prepend a 5s
-- black title-card BEFORE the intro clips play.
--
-- Only the constraint changes; column shape is unchanged. The new kind
-- carries only `text` and `ordinal` — no youtube_url / paragraph_index /
-- char_offset because it's a pure video-prefix card.

alter table public.project_script_markers
  drop constraint if exists project_script_markers_kind_check;

alter table public.project_script_markers
  add constraint project_script_markers_kind_check
    check (kind in (
      'intro_card', 'title_card', 'title_card_clip', 'lower_third',
      'opening_title'
    ));

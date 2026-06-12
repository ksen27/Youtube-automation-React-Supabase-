-- Add `inline_clip` to the project_script_markers.kind CHECK constraint.
--
-- A bare hyperlinked timestamp line in the MIDDLE of the doc's prose (no
-- blue-bold heading above it) was previously unrecognized: the parser let
-- the timestamp text flow into the transcript (where the matcher built a
-- bogus footage block whose script text was a fragment like "46") and the
-- clip never appeared in the final video. The parser now emits these lines
-- as kind='inline_clip' markers: a forced YouTube window played over the
-- following paragraph's narration, with no on-screen title card.
--
-- Column shape is unchanged. inline_clip rows carry youtube_url /
-- start_seconds / end_seconds + paragraph_index (the content paragraph the
-- clip anchors to); text is always ''.

alter table public.project_script_markers
  drop constraint if exists project_script_markers_kind_check;

alter table public.project_script_markers
  add constraint project_script_markers_kind_check
    check (kind in (
      'intro_card', 'title_card', 'title_card_clip', 'lower_third',
      'opening_title', 'inline_clip'
    ));

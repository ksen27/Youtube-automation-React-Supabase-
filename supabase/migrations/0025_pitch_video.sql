-- Sales-pitch video insertion (AI Avatar / synthetic engine).
--
-- THE FEATURE
-- -----------
-- In the synthetic Intake step the user may upload a "sales pitch" video. At
-- render time that video is INSERTED into the timeline near the 3-minute mark
-- (snapped to the nearest segment boundary so it never cuts an avatar part
-- mid-sentence). Everything after the insertion point shifts later by the
-- pitch's duration — the total video gets longer. During the pitch the project
-- voiceover PAUSES and the pitch plays its OWN audio, then the voiceover
-- resumes (the same "consume video time, not voiceover time" behaviour the
-- intro pre-roll and the old mid-timeline forced-clip splice used).
--
-- Three columns on projects, all synthetic-only (null/default for sourced):
--   pitch_video_url               R2 public URL of the uploaded mp4.
--   pitch_video_duration_seconds  Probed length; drives how far the post-3:00
--                                 timeline shifts and how long the voiceover
--                                 pause lasts.
--   pitch_video_insert_seconds    Where to splice it in. Defaults to 180 (3:00)
--                                 but is a column, not a constant, so the insert
--                                 point can be tuned later without a migration.
--
-- The pitch block is a NON-voiceover-bearing segment: like the intro, it is
-- excluded from the render route's timeline-vs-voiceover duration guard, so a
-- pitch that adds video time without voiceover time does not false-fail
-- "Timeline duration must match voiceover."

alter table public.projects
  add column if not exists pitch_video_url               text,
  add column if not exists pitch_video_duration_seconds  double precision,
  add column if not exists pitch_video_insert_seconds     double precision not null default 180;

-- Background music support. The user can upload an audio bed that plays
-- under the voiceover at a low volume. Loops if shorter than the voiceover,
-- and is cut at the final video end if longer (handled in the render filter
-- graph via -stream_loop -1 + amix duration=first + -shortest).
--
--   bg_music_url   -- public URL of the uploaded audio (any audio/* type)
--   bg_music_gain  -- 0..0.5 mix gain. Default 0.15 matches the previous
--                     hard-coded ffmpeg fallback so existing renders are
--                     unchanged in feel.

alter table projects
  add column if not exists bg_music_url text,
  add column if not exists bg_music_gain numeric not null default 0.15;

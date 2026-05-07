-- Intro clip support. The intro plays before the rest of the timeline with
-- the celebrity's original audio (no voiceover during the intro).
--
--   intro_clip_id           -- which video_clip is the intro (from the
--                              existing pool; not a new clip)
--   intro_audio_url         -- public URL of the cut audio segment, populated
--                              at render time after yt-dlp + ffmpeg
--   intro_duration_seconds  -- 5–6s window matching the clip's start/end

alter table projects
  add column if not exists intro_clip_id uuid references video_clips(id) on delete set null,
  add column if not exists intro_audio_url text,
  add column if not exists intro_duration_seconds numeric;

-- User-provided intro source. When set, the renderer downloads the given
-- YouTube video via the proxied yt-dlp path and cuts the intro window from
-- it directly — bypassing the auto-pick-from-existing-clips flow that was
-- selecting visually-good shots with the channel narrator's voice over them.
--
--   intro_source_youtube_url    -- full YouTube URL the user pasted; the
--                                   renderer extracts the video id from it
--   intro_source_start_seconds  -- offset into that source where the intro
--                                   begins (numeric seconds; UI accepts mm:ss
--                                   and converts client-side)
--
-- intro_duration_seconds already exists from 0003_intro_clip.sql and is
-- reused here — the user enters a duration alongside the start time.

alter table projects
  add column if not exists intro_source_youtube_url text,
  add column if not exists intro_source_start_seconds numeric;

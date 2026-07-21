-- AI-generated sales-pitch video (AI Avatar / synthetic engine).
--
-- THE FEATURE
-- -----------
-- Migration 0025 added an UPLOADED sales-pitch video (pitch_video_url) that gets
-- spliced into the timeline near 3:00. The client now wants the AI to GENERATE
-- that pitch video instead of the user uploading a finished mp4. The generated
-- pitch follows the client's reference style: an AVATAR talking-head segment
-- first, then a SCREEN-RECORDING that scrolls through the pitched WEBSITE.
--
-- The user supplies three inputs at intake — website URL, a HeyGen avatar
-- (name/photo), and a pitch script — and a background job:
--   1. renders the avatar half via HeyGen (driven by the pitch script's own TTS),
--   2. records the real website via a headless browser auto-scrolling top→bottom,
--   3. concatenates avatar→website into one mp4, and
--   4. writes the result to pitch_video_url + pitch_video_duration_seconds.
--
-- CRUCIAL: the OUTPUT is the same pitch_video_url the render/timeline/duration
-- pipeline already consumes (migration 0025). Nothing downstream changes — only
-- the SOURCE of the mp4 (AI-generated vs uploaded). Upload mode stays fully
-- supported; pitch_mode selects between them.
--
-- New columns on projects (all synthetic-only, null/default for sourced):
--   pitch_mode              'upload' (default, migration-0025 behaviour) or
--                           'generate' (AI builds the pitch from the inputs below).
--   pitch_website_url       The site to screen-record (e.g. https://themechanicbible.com/).
--   pitch_avatar_image_url  R2 URL of the photo the pitch avatar is generated from.
--                           Kept SEPARATE from the project's main avatar_image_url so
--                           the pitch presenter can differ from the video's narrator.
--   pitch_avatar_name       HeyGen saved-avatar name for the pitch (Avatar III lookup),
--                           mirroring projects.heygen_avatar_name for the main video.
--   pitch_script            The words the pitch avatar speaks (narrated over the
--                           avatar half; the website half plays under the tail / silence).
--   pitch_gen_status        Lifecycle of the generation job so intake can show
--                           progress: null (not started) | 'generating' | 'ready' | 'failed'.
--   pitch_gen_error         User-facing failure message when pitch_gen_status='failed'.

alter table public.projects
  add column if not exists pitch_mode             text not null default 'upload',
  add column if not exists pitch_website_url       text,
  add column if not exists pitch_avatar_image_url  text,
  add column if not exists pitch_avatar_name       text,
  add column if not exists pitch_script            text,
  add column if not exists pitch_gen_status        text,
  add column if not exists pitch_gen_error         text;

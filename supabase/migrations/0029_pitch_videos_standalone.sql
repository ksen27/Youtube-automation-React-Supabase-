-- Sales Pitch — a standalone top-level product (its own sidebar tool), like
-- Thumbnails. INDEPENDENT of the video engines and of projects.
--
-- WHY STANDALONE (client, 2026-07-21): the AI sales-pitch GENERATOR is separated
-- from the AI Avatar workflow so it isn't confusing for the team. The AI Avatar
-- intake keeps ONLY its existing sales-pitch UPLOAD field (migration 0025). This
-- tool generates a pitch video the user can preview/DOWNLOAD and then upload to
-- an avatar project via that existing field. There is no DB link between the two.
--
-- The project-level pitch_* generate columns added in migration 0026 (pitch_mode,
-- pitch_website_url, pitch_avatar_image_url, pitch_avatar_name, pitch_script,
-- pitch_gen_status, pitch_gen_error) are NO LONGER USED by the app after this
-- change; they are harmless if left in place (the upload columns from 0025 —
-- pitch_video_url etc. — are unchanged and still used by the avatar render).
--
-- A generated pitch video = avatar talking-head (HeyGen, from the photo + script,
-- narrated by a 69labs voice) followed by a fixed-length screen-recording that
-- scrolls the real website. Same generation engine as before; only the storage
-- and trigger move here (from a project row to this standalone table).
--
-- Lifecycle of a row:
--   generating -> inserted the moment generation starts
--   ready      -> output_url set (permanent R2 URL of the final mp4)
--   failed     -> error set; generation errored
--
-- Run via the Supabase SQL editor or `supabase db push`.

create table if not exists public.pitch_videos (
  id                 uuid primary key default gen_random_uuid(),
  -- Optional human label so the gallery is scannable (e.g. "Mechanic Bible pitch").
  title              text not null default '',
  -- The website that gets screen-recorded (scheme-normalized on write).
  website_url        text not null,
  -- R2 URL of the photo the pitch avatar is generated from.
  avatar_image_url   text not null,
  -- Optional HeyGen saved-avatar name (Avatar III lookup); usually null.
  avatar_name        text,
  -- The words the pitch avatar speaks.
  script             text not null,
  -- The 69labs voice id the narration uses (null = default voice).
  tts_voice_id       text,
  -- Permanent R2 public URL of the finished pitch mp4. Null until ready.
  output_url         text,
  -- Probed length of the finished mp4 (seconds).
  duration_seconds   double precision,
  status             text not null default 'generating'
                       check (status in ('generating','ready','failed')),
  -- Failure reason when status = 'failed'.
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Gallery is ordered newest-first.
create index if not exists pitch_videos_created_at_idx
  on public.pitch_videos (created_at desc);

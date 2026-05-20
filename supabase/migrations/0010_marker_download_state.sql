-- Pre-download state for script-doc markers. After the intake-time
-- script-doc ingest persists markers, the worker dispatches one job per
-- marker that has a youtube_url (intros + title_cards + title_card_clips),
-- downloads each via proxied yt-dlp, cuts the window to the doc's
-- timestamp range, uploads the cut clip (and audio for intros) to R2, and
-- updates the row below. The intake screen polls these columns so the user
-- sees per-clip status before kicking off the generate/render pipeline,
-- and so a failed download can be retried in place.
alter table public.project_script_markers
  -- pending: row inserted, no job has touched it yet
  -- downloading: the worker is actively fetching/cutting/uploading
  -- ready: clip (and audio for intros) live in R2 and ready to render
  -- failed: terminal failure for this attempt; UI surfaces error + retry
  add column if not exists download_status text
    not null default 'pending'
    check (download_status in ('pending', 'downloading', 'ready', 'failed')),
  -- Human-readable error from the last failed run. Cleared when the job
  -- transitions back to downloading/ready on retry. Keep messages short —
  -- the UI renders them inline next to the status badge.
  add column if not exists download_error text,
  -- Public R2 URL of the cut + normalized .mp4 clip. The renderer prefers
  -- this when set (one HTTP download, no yt-dlp at render time). When null
  -- the renderer falls back to its existing on-the-fly yt-dlp path so old
  -- projects keep working.
  add column if not exists clip_storage_url text,
  -- Public R2 URL of the cut .m4a audio. Only populated for intro_card
  -- markers — title_card and title_card_clip clips reuse the voiceover
  -- audio at render time. Lower_thirds don't have clips at all.
  add column if not exists audio_storage_url text,
  -- Bookkeeping: timestamp of last status transition. Useful for stuck-job
  -- detection in the UI ("downloading for 8 minutes" suggests proxy hang).
  add column if not exists download_updated_at timestamptz;

create index if not exists project_script_markers_status_idx
  on public.project_script_markers (project_id, download_status);

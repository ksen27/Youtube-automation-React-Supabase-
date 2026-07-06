-- Thumbnails — a third top-level product, independent of the video engines.
--
-- The sourced (celebrity) and synthetic (AI avatar) VIDEO engines are LEFT
-- COMPLETELY UNTOUCHED. These tables have no relationship to projects; they
-- back the standalone /thumbnails feature.
--
-- FLOW (two steps):
--   1. ANALYZE — the user pastes a YouTube CHANNEL url. We resolve it, pull
--      ~10 of its recent thumbnails, and Gemini analyzes them into a reusable
--      "style prompt". That channel + style prompt is SAVED (thumbnail_channels)
--      so it can be reused for every future thumbnail on that channel. The
--      style prompt is user-editable.
--   2. GENERATE — the user picks a saved channel, types the new video TITLE,
--      and optionally uploads 1–2 subject images (a celebrity / person, or an
--      AI avatar). Gemini merges the channel style prompt + title into a final
--      (editable) prompt; Pikzels renders the thumbnail.
--
-- IMAGE-SLOT RULE (Pikzels takes a base image + ONE support image only):
--   0 subject images -> base = a representative channel thumbnail; style image
--                       reinforces the look; style also in the text prompt.
--   1 subject image  -> base = the subject photo; support = a channel thumbnail
--                       (style image); style also in the text prompt.
--   2 subject images -> both slots are the two subject photos; NO style image —
--                       the channel style rides entirely in the text prompt.
--
-- Run via the Supabase SQL editor or `supabase db push`.

-- A saved channel = a learned thumbnail style. Created in the Analyze step and
-- reused across generations.
create table if not exists public.thumbnail_channels (
  id             uuid primary key default gen_random_uuid(),
  -- The raw url/handle the user pasted (kept for display + re-analysis).
  channel_input  text not null,
  -- Canonical YouTube channel id (UC…) resolved from channel_input.
  channel_id     text not null,
  -- Channel display name resolved from YouTube.
  channel_title  text not null default '',
  -- The Gemini-extracted, user-editable style prompt describing this channel's
  -- thumbnail format (layout, typography, colour grade, composition, mood).
  style_prompt   text not null default '',
  -- The sample thumbnail urls Gemini analyzed, newest-first. Kept so the UI can
  -- preview what the style was learned from, and so generation can pick a
  -- representative style image without another API call. jsonb array of strings.
  sample_urls    jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One saved style per channel — re-analyzing a channel updates the same row.
create unique index if not exists thumbnail_channels_channel_id_idx
  on public.thumbnail_channels (channel_id);

-- A generated thumbnail.
--
-- Lifecycle of a row:
--   pending    -> inserted the moment generation starts
--   completed  -> output_url set (re-hosted to R2; the Pikzels CDN link
--                 expires in ~24h so we never store the raw provider URL)
--   failed     -> error set; generation errored
create table if not exists public.thumbnails (
  id             uuid primary key default gen_random_uuid(),
  -- The saved channel this thumbnail was generated for (null if the channel
  -- row is later deleted — the thumbnail image itself stays in the gallery).
  channel_id     uuid references public.thumbnail_channels(id) on delete set null,
  -- The new video title the user typed.
  title          text not null default '',
  -- The FINAL prompt sent to Pikzels (Gemini-generated, possibly user-edited).
  prompt         text not null,
  -- The subject images (celebrity/person or AI avatar) supplied for this
  -- generation, as an array of resolved R2/image urls (0–2). jsonb.
  subject_urls   jsonb not null default '[]'::jsonb,
  -- The reference image urls actually sent to Pikzels (subject photos and/or a
  -- channel style thumbnail), for audit/debug. jsonb array of strings.
  reference_urls jsonb not null default '[]'::jsonb,
  -- Permanent R2 public URL of the generated thumbnail. Null until completed.
  output_url     text,
  -- Pikzels request_id echoed back from the generate call, for support/debug.
  request_id     text,
  status         text not null default 'pending'
                   check (status in ('pending','completed','failed')),
  -- Failure reason when status = 'failed'.
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Gallery is ordered newest-first.
create index if not exists thumbnails_created_at_idx
  on public.thumbnails (created_at desc);

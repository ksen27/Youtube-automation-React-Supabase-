-- Per-segment asset version history (synthetic engine only, additive).
--
-- Regenerating a segment's image/clip/avatar used to OVERWRITE the asset: the
-- new url replaced image_url/video_url/right_image_url and (for images/clips)
-- the new file overwrote the same R2 key, so the previous version was lost and
-- the review screen could only ever show the latest one. The client wants to
-- see (and restore) previous versions.
--
-- asset_history holds an ordered list of prior versions, newest LAST. Each entry:
--   {
--     "image_url":       text|null,   -- whichever asset fields this version had
--     "video_url":       text|null,
--     "right_image_url": text|null,
--     "provider":        text|null,
--     "created_at":      iso8601 string   -- when this version was superseded
--   }
-- The CURRENT version stays in the existing image_url/video_url/right_image_url
-- columns; on each regenerate the worker pushes the current trio into this list
-- BEFORE writing the new asset. Restore pops a chosen entry back into the live
-- columns (and pushes the then-current one into history), so nothing is lost.
--
-- We keep ALL versions (client choice). R2 keys are versioned per generation so
-- old files survive; a future cleanup can prune by reading these urls.

alter table public.synthetic_segments
  add column if not exists asset_history jsonb not null default '[]'::jsonb;

comment on column public.synthetic_segments.asset_history is
  'Ordered list (newest last) of prior asset versions {image_url,video_url,right_image_url,provider,created_at}. Current version stays in the image_url/video_url/right_image_url columns.';

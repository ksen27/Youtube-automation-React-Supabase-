-- Image-block content fetched from external sources (Wikipedia, Google
-- Custom Search, YouTube thumbnails). Populated by the image-fetch step
-- between match and render; consumed by the renderer to hold a still.
--
--   image_url      -- public URL of the chosen image
--   image_source   -- 'wikipedia' | 'google_cse' | 'youtube_thumb' | null
--   image_query    -- the entity-derived query that produced this image
--                     (kept for diagnostics + caching keys across runs)

alter table timeline_items
  add column if not exists image_url text,
  add column if not exists image_source text,
  add column if not exists image_query text;

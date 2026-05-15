-- Per-project sound effects. Operator uploads short SFX clips (clicks,
-- swipes, whooshes, ~200-400ms each) that the renderer layers on top of a
-- subset of image->image transitions. Cadence is every 3rd image xfade,
-- rotating through the uploaded list so consecutive triggers don't repeat
-- the same sound. Image<->video boundaries are left untouched.
--
--   sfx_urls   -- jsonb array of public URLs (any audio/* type). Empty/null
--                  disables SFX entirely.
--   sfx_gain   -- 0..1 mix gain. Default 0.7 sits above bg music but under
--                  voiceover.

alter table projects
  add column if not exists sfx_urls jsonb not null default '[]'::jsonb,
  add column if not exists sfx_gain numeric not null default 0.7;

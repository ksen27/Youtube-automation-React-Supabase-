-- Per-avatar-part HeyGen model selection (AI Avatar / synthetic engine).
--
-- THE FEATURE
-- -----------
-- The AI-Avatar Google Doc marks talking-head passages by highlighting them.
-- Previously ANY highlight (red OR orange) became a block_type='avatar' segment
-- rendered with HeyGen's Avatar IV model. Avatar IV is expensive/slow, so the
-- client now wants the highlight COLOR to pick the model:
--   red    -> Avatar IV  (the existing photo-to-video composer)
--   orange -> Avatar III (the cheaper "Create new shots" / Avatar Shots flow)
--
-- avatar_model records which HeyGen model an avatar-bearing segment should use.
-- It is meaningful ONLY for avatar-bearing blocks (block_type in
-- ('avatar','split_2')); it is null for every visual (image/ai_clip) block and
-- for all sourced (celebrity) projects. Null on an avatar block is treated as
-- 'avatar_iv' by the worker (the historical default), so existing rows keep
-- rendering exactly as before.
--
-- The doc parser tags each highlighted range with its model; the planner copies
-- that onto the segment (and never coalesces two adjacent avatar parts of
-- DIFFERENT models into one render). The avatar processor passes it to
-- generateAvatar(), which drives the matching HeyGen composer.

alter table public.synthetic_segments
  add column if not exists avatar_model text
    check (avatar_model is null or avatar_model in ('avatar_iv', 'avatar_iii'));

-- heygen_avatar_name: the NAME of the HeyGen saved avatar to drive the Avatar III
-- ("Create new shots") flow. The user creates that avatar MANUALLY in HeyGen at
-- project setup (one photo per project) and enters its exact name here at intake.
-- The Avatar III automation searches the HeyGen Avatars page for this name to
-- find the right avatar — reliable and concurrency-safe even when several
-- projects render at once (a per-project human-chosen name, not a guessed one).
-- Null for projects with no orange (Avatar III) parts and for sourced projects.
alter table public.projects
  add column if not exists heygen_avatar_name text;

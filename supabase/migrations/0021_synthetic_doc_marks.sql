-- AI-Avatar (synthetic) Google-Doc intake + review gate.
--
-- Additive, synthetic-only. The celebrity engine is untouched.
--
--   avatar_mark_ranges — char ranges in the project transcript that were RED or
--     ORANGE in the source Google Doc. The synthetic planner forces any segment
--     overlapping one of these ranges to block_type = 'avatar'. Shape:
--       [{ "start": 0, "end": 42 }, ...]
--   script_doc_url     — the Google Doc URL the transcript was ingested from
--     (diagnostics + re-ingest).
--
-- The new 'plan_ready' project status (planner finished, assets NOT yet
-- generated — the review gate) lives in the application layer (lib/types.ts),
-- like every other status; projects.status has no DB check constraint.

alter table public.projects
  add column if not exists avatar_mark_ranges jsonb default '[]'::jsonb,
  add column if not exists script_doc_url     text;

-- Timestamp recording the last successful Google Docs ingest for a project.
-- The intake screen uses this together with voiceover_url to decide when the
-- user has provided BOTH inputs and can advance to the analyze step. Without
-- this column the workspace previously advanced on transcript presence
-- alone, which let users skip the Google Doc entirely (Deepgram populates
-- transcript from the uploaded audio).
--
-- We persist this even when the doc had zero structural markers (a pure-
-- prose doc is still a valid ingest), so the gate doesn't false-block users
-- whose script doesn't use blue/red formatting yet.
alter table public.projects
  add column if not exists script_doc_ingested_at timestamptz;

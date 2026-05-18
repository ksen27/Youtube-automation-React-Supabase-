-- Persist Deepgram's per-word timing array so the timeline planner can size
-- each block to the narrator's *actual* spoken duration for its sentence,
-- not the uniform 150-wpm word-count estimate. The estimate accumulates
-- per-sentence drift that compounds across 100+ blocks into a multi-second
-- timeline-vs-voiceover mismatch even when the audio file itself is well-
-- transcribed. Stored as a flat array: [{ word, start, end }, ...].
alter table public.projects
  add column if not exists transcript_words jsonb;

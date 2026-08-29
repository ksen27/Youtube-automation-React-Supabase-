-- =============================================================================
-- 0042 — The extracted style profile of a reference book.
--
-- HOW a reference is written (voice, chapter shape, pacing, devices), separate
-- from WHAT it is about. Cached on the reference rather than recomputed per
-- book: extraction reads a sample of the whole text and costs a model call,
-- while the reference itself never changes. Every book generated from it reuses
-- this.
--
-- `style_input_hash` makes the extraction idempotent — a re-run over unchanged
-- text is a no-op rather than a second bill for the same answer.
-- =============================================================================

set search_path = ebook, public;

alter table reference_books
  add column style_profile    jsonb,
  add column style_input_hash text;

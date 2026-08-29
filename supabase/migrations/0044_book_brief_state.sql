-- =============================================================================
-- 0044 — Database catch-up for the reference-book pipeline.
--
-- Two changes the code needed and the schema never got. Both surfaced only in
-- production, because neither the type-checker nor the test suite touches the
-- real database: the domain's ProjectState union and this enum are two
-- declarations of the same thing with nothing tying them together.
--
-- 1. GENERATING_BOOK_BRIEF — the pipeline's new entry stage. Submitting a book
--    fails outright without it:
--      invalid input value for enum project_status: "GENERATING_BOOK_BRIEF"
--
-- 2. channel_url — was NOT NULL, and nothing writes it any more. The very next
--    insert after the enum is fixed would fail on the constraint instead.
--
-- The column is made NULLABLE rather than dropped, deliberately. Nineteen
-- existing projects still carry their channel, and that is the only remaining
-- record of where those books came from. Dropping it belongs in the same
-- clean-up that drops the videos/transcripts/comments tables, once the
-- replacement has produced a book end to end.
--
-- The removed states (INGESTING_CHANNEL, FETCHING_TRANSCRIPTS, …) are left in
-- the enum. Postgres cannot drop an enum value that rows still use, and those
-- rows are the completed books.
-- =============================================================================

set search_path = ebook, public;

-- BEFORE the strategy stage: the brief is what produces the knowledge base the
-- strategy reads. Ordering in the enum is cosmetic, but it is how the pipeline
-- reads in psql, and 0031 established the convention.
alter type project_status add value if not exists 'GENERATING_BOOK_BRIEF' before 'GENERATING_BOOK_STRATEGY';

alter table projects alter column channel_url drop not null;

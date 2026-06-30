-- Idempotency guard for synthetic timeline materialization.
--
-- THE BUG THIS FIXES
-- ------------------
-- maybeFinalizeSynthetic (worker/processors/synthetic/_shared.ts) materializes
-- synthetic_segments -> timeline_items. To stay idempotent across the several
-- finalize calls a long avatar project triggers (one per asset finish, plus the
-- reconcile sweep), it READS the existing timeline_items, builds a set of
-- already-materialized synthetic_segment_ids (from metadata.synthetic_segment_id),
-- then inserts only the segments not in that set.
--
-- That read-modify-write has no atomicity and nothing at the DB level backs it.
-- When two finalize calls both read the existing rows before either inserts,
-- both see a segment as "missing" and both insert it -> a duplicate timeline row.
-- On a 9-hour avatar project this raced ~once a minute: one project ended up
-- with 459 timeline_items (303 real + 156 duplicates) summing to ~2896s against
-- a 1932s voiceover, which the render route correctly rejected with
-- "Timeline duration must match voiceover."
--
-- THE FIX
-- -------
-- Promote the synthetic_segment_id out of JSONB into a real column and put a
-- UNIQUE index on (project_id, synthetic_segment_id). The index is the
-- authority: a second concurrent insert of the same segment now hits a conflict
-- instead of silently duplicating, so the materialize step's upsert
-- (onConflict: project_id,synthetic_segment_id, ignoreDuplicates) is a true
-- no-op for already-present segments regardless of read timing.
--
-- The index is PARTIAL (where synthetic_segment_id is not null): sourced-engine
-- timeline_items have no segment id, so the column is null for them and a plain
-- unique index would collapse all those nulls. (Postgres treats nulls as
-- distinct in a unique index, but the partial predicate also keeps the index
-- small and synthetic-only.)

alter table public.timeline_items
  add column if not exists synthetic_segment_id uuid
    references public.synthetic_segments(id) on delete set null;

-- Backfill the new column from the existing metadata key so rows materialized
-- before this migration are covered by the index too.
update public.timeline_items
   set synthetic_segment_id = (metadata->>'synthetic_segment_id')::uuid
 where synthetic_segment_id is null
   and metadata ? 'synthetic_segment_id'
   and (metadata->>'synthetic_segment_id') ~ '^[0-9a-fA-F-]{36}$';

-- One timeline row per planned segment per project. Partial so it only governs
-- synthetic rows.
create unique index if not exists timeline_items_project_segment_uq
  on public.timeline_items (project_id, synthetic_segment_id)
  where synthetic_segment_id is not null;

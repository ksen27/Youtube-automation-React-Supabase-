-- Make orphaned timeline_items structurally impossible.
--
-- THE HAZARD
-- ----------
-- Migration 0024 added timeline_items.synthetic_segment_id with
-- `on delete set null`. That choice quietly converts "segment deleted" into
-- "timeline row with a null link" — and a null-linked row is invisible to
-- everything that would otherwise manage it:
--   • 0024's unique index is PARTIAL (where synthetic_segment_id is not null),
--     so the row can never conflict;
--   • maybeFinalizeSynthetic's already-materialized set is keyed on that id, so
--     it neither sees nor cleans the row;
--   • the render route's duration gate, however, sums EVERY duration-bearing
--     row — orphan included.
-- Net effect: deleting segments without first deleting their timeline rows
-- produced a project whose timeline silently summed to ~2x its voiceover and
-- failed with "Timeline duration must match voiceover" and no visible cause.
-- Observed 2026-08-15 across 8 projects / 2342 orphan rows / 13451s.
--
-- Every call site that deletes a segment ALREADY deletes the timeline row first
-- (planner.ts re-plan, the segment DELETE endpoint, fix-zero-window-avatar.ts).
-- So cascade does not change intended behaviour anywhere — it moves the
-- guarantee out of "every author remembers" and into the schema, where new code
-- cannot get it wrong.
--
-- SAFE TO APPLY AFTER THE ORPHAN PURGE, AND BEFORE IT. Cascade governs FUTURE
-- deletes only; it does not retroactively remove rows whose link is ALREADY
-- null (their segment is long gone, so there is nothing left to cascade FROM).
-- Existing orphans still need scripts/purge-orphan-timeline-items.ts.

do $$
declare
  fk_name text;
begin
  -- The constraint was created implicitly by `references` in 0024, so its name
  -- is whatever Postgres generated. Look it up rather than assuming
  -- timeline_items_synthetic_segment_id_fkey.
  select con.conname into fk_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
      and rel.relname = 'timeline_items'
      and con.contype = 'f'
      and con.conkey = array[
        (select attnum from pg_attribute
          where attrelid = rel.oid and attname = 'synthetic_segment_id')
      ]::smallint[];

  if fk_name is not null then
    execute format('alter table public.timeline_items drop constraint %I', fk_name);
  end if;
end $$;

alter table public.timeline_items
  add constraint timeline_items_synthetic_segment_id_fkey
  foreign key (synthetic_segment_id)
  references public.synthetic_segments(id)
  on delete cascade;

comment on column public.timeline_items.synthetic_segment_id is
  'Segment this timeline row materializes. ON DELETE CASCADE (0037): deleting a '
  'synthetic_segment removes its timeline row, so a stale row can never survive '
  'a re-plan and inflate the render duration gate. Was ON DELETE SET NULL (0024), '
  'which produced exactly that bug.';

-- One sales-pitch timeline row per project.
--
-- THE BUG THIS FIXES
-- ------------------
-- reconcileTimelineOrder (lib/synthetic/pitch-timeline.ts) places the sales-pitch
-- video as a single timeline_items row, found across re-runs by
-- metadata->>'kind' = 'pitch_video'. It READS the existing pitch row, and inserts
-- one only when it finds none — the same read-modify-write race migration 0024
-- fixed for segment rows, except the index 0024 added is PARTIAL
-- (where synthetic_segment_id is not null) and the pitch row's
-- synthetic_segment_id is NULL. So nothing at the DB level covered it.
--
-- reconcileTimelineOrder runs from maybeFinalizeSynthetic, which fires on every
-- asset finish plus the 5-minute reconcile sweep, and again from the render
-- gate. Two of those overlapping both saw "no pitch row" and both inserted one.
--
-- The damage is not cosmetic. Both rows are renderable, so the pitch plays twice
-- and its duration is double-counted — and the render's order gate compares the
-- landed row order against an expected order holding exactly ONE pitch row, so
-- it never verifies and the project can never be rendered again. Project
-- 6b0e9ba7 (2026-08-23) sat at 434 rows against 433 expected, failing every
-- render with "timeline is out of order" while its segment order was perfect.
--
-- THE FIX
-- -------
-- The same guard 0024 gave segment rows: let the database be the authority, so a
-- racing second insert conflicts instead of silently duplicating.

-- Clear the rows already duplicated, keeping the lowest id per project — the
-- same survivor the application-side de-dupe picks, so the two agree. The rows
-- are interchangeable by construction (identical payload written from the same
-- projects columns), so which one survives only has to be deterministic.
delete from public.timeline_items t
 where t.metadata->>'kind' = 'pitch_video'
   and t.id > (
     select min(o.id)
       from public.timeline_items o
      where o.project_id = t.project_id
        and o.metadata->>'kind' = 'pitch_video'
   );

-- One pitch row per project. Partial so it governs only pitch rows and stays
-- small; every other timeline row is unaffected.
create unique index if not exists timeline_items_project_pitch_uq
  on public.timeline_items (project_id)
  where metadata->>'kind' = 'pitch_video';

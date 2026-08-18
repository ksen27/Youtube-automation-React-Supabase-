-- Fix: deleting an AI-Avatar (synthetic) project fails with
-- "canceling statement due to statement timeout".
--
-- THE CAUSE
-- ---------
-- `delete from projects where id = $1` cascades into ~10 child tables. Every
-- cascade/set-null is executed by a referential-integrity trigger that fires
<<<<<<< HEAD
-- ONCE PER DELETED PARENT ROW and runs a query keyed on the REFERENCING column:
--
--     delete from timeline_items      where synthetic_segment_id = $1   -- per segment
--     update timeline_items set clip_id = null where clip_id = $1       -- per clip
--     update synthetic_segments set source_job_id = null
--                                     where source_job_id = $1          -- per media_job
--
-- None of those referencing columns had a usable index:
--   * timeline_items.synthetic_segment_id was covered only by the PARTIAL
--     UNIQUE index timeline_items_project_segment_uq (project_id, synthetic_segment_id).
--     project_id leads, so a lookup by synthetic_segment_id alone cannot use it.
--   * timeline_items.clip_id and synthetic_segments.source_job_id had no index at all.
--
-- So each of those RI queries is a SEQUENTIAL SCAN, repeated once per child
-- row. A synthetic project with a few hundred segments / clips / media_jobs
-- turns one DELETE into hundreds of full-table scans and blows through
-- PostgREST's 8s statement_timeout. The sourced engine hits the same code path
-- but has far fewer segments and media_jobs, which is why the avatar tool is
-- where it shows up.
--
-- THE FIX: index every referencing FK column. This is index-only bookkeeping —
-- no data or constraint changes.
--
-- Apply via the Supabase SQL editor (repo convention). CONCURRENTLY is
-- deliberately NOT used so the file stays runnable as a single statement batch;
-- these tables are small enough that the brief write lock is a non-issue. If
-- you would rather not lock at all, run each statement separately with
-- `create index concurrently` (cannot run inside a transaction block).
=======
-- ONCE PER DELETED CHILD ROW and runs a query keyed on the REFERENCING column:
--
--     delete from timeline_items where synthetic_segment_id = $1            -- per segment
--     update timeline_items set clip_id       = null where clip_id = $1     -- per video_clip
--     update timeline_items set source_job_id = null where source_job_id=$1 -- per media_job
--
-- All three referencing columns live on timeline_items, and none of them had a
-- usable index:
--   * synthetic_segment_id was covered only by the PARTIAL UNIQUE index
--     timeline_items_project_segment_uq (project_id, synthetic_segment_id) —
--     project_id leads, so a lookup by synthetic_segment_id alone cannot use it.
--   * clip_id and source_job_id had no index at all.
--
-- So each of those RI queries is a SEQUENTIAL SCAN of timeline_items, repeated
-- once per child row. A synthetic project with a few hundred segments, clips
-- and media_jobs turns one DELETE into thousands of full-table scans and blows
-- through PostgREST's 8s statement_timeout. The sourced engine hits the same
-- code path but has far fewer segments and media_jobs, which is why the avatar
-- tool is where it shows up.
--
-- THE FIX: index every referencing FK column. Index-only bookkeeping — no data
-- or constraint changes.
--
-- Apply via the Supabase SQL editor (repo convention). CONCURRENTLY is
-- deliberately NOT used so the file runs as one statement batch; these tables
-- are small enough that the brief write lock is a non-issue. To avoid locking,
-- run each statement separately with `create index concurrently` (which cannot
-- run inside a transaction block).
>>>>>>> 822a0fd90aca7ea1340a9aa60b54b90ea4ed28ff

create index if not exists timeline_items_synthetic_segment_id_idx
  on public.timeline_items (synthetic_segment_id);

create index if not exists timeline_items_clip_id_idx
  on public.timeline_items (clip_id);

<<<<<<< HEAD
create index if not exists synthetic_segments_source_job_id_idx
  on public.synthetic_segments (source_job_id);
=======
create index if not exists timeline_items_source_job_id_idx
  on public.timeline_items (source_job_id);
>>>>>>> 822a0fd90aca7ea1340a9aa60b54b90ea4ed28ff

-- projects.intro_clip_id -> video_clips(id) on delete set null. `projects` is
-- small so this one is not the bottleneck, but the same per-clip scan happens
-- and the index costs nothing.
create index if not exists projects_intro_clip_id_idx
  on public.projects (intro_clip_id);

analyze public.timeline_items;
<<<<<<< HEAD
analyze public.synthetic_segments;
=======
>>>>>>> 822a0fd90aca7ea1340a9aa60b54b90ea4ed28ff

-- Hotfix for migration 0012. The original migration created a unique INDEX
-- on (project_id, entity_type, lower(entity_name)) — an expression-based
-- index. Postgres's ON CONFLICT clause cannot match an expression index
-- through a column list, so every upsert in face-references.ts fails with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- Two changes:
--   1. Drop the old expression index.
--   2. Add a real UNIQUE CONSTRAINT on plain columns
--      (project_id, entity_type, entity_name). The constraint backs ON
--      CONFLICT and gives us idempotent roster builds.
--
-- Case-insensitive matching for lookups is preserved by lookupReference()
-- which uses .ilike() — no separate functional index is needed for that
-- read path; the table is small (a few dozen rows per project).
--
-- Caveat: the constraint is case-SENSITIVE, which means a roster builder
-- that writes "David Walliams" and a second pass that writes
-- "david walliams" would produce two rows. The roster builder dedups
-- inputs case-insensitively before upserting (face-references.ts line ~120)
-- so this is a non-issue in practice.

drop index if exists public.face_references_project_type_name_idx;

alter table public.face_references
  drop constraint if exists face_references_project_type_name_uq;

alter table public.face_references
  add constraint face_references_project_type_name_uq
    unique (project_id, entity_type, entity_name);

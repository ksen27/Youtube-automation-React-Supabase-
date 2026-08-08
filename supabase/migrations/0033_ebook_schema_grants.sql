-- =============================================================================
-- 0033 — Grant the Data API roles access to the `ebook` schema.
--
-- WHY THIS IS NEEDED (and why 0031 didn't need it):
-- upstream's tables lived in `public`, where Supabase grants anon/authenticated/
-- service_role by default and new tables inherit that automatically. Moving the
-- product into its own `ebook` schema (see the header of 0031) means none of
-- that applies: the schema is created with no privileges for anyone but its
-- owner.
--
-- The symptom is a TWO-STAGE failure, and getting past the first reveals the
-- second:
--   1. Before exposing the schema in the dashboard:
--        PGRST106 "Invalid schema: ebook"        (HTTP 406) — PostgREST refuses
--        to route to it at all.
--   2. After exposing it, but before running THIS file:
--        42501 "permission denied for schema ebook"  (HTTP 403) — PostgREST
--        routes fine, Postgres then rejects the query.
-- Both look like "the ebook feature is broken" from the app.
--
-- Apply via the Supabase SQL editor, after 0031 and 0032.
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

-- USAGE lets a role "see into" the schema; without it nothing inside is
-- reachable regardless of table grants.
grant usage on schema ebook to anon, authenticated, service_role;

-- Table privileges for everything 0031/0032 already created.
grant all privileges on all tables    in schema ebook to anon, authenticated, service_role;
grant all privileges on all sequences in schema ebook to anon, authenticated, service_role;
grant all privileges on all functions in schema ebook to anon, authenticated, service_role;

-- ...and for anything added later. Without these DEFAULT PRIVILEGES, the next
-- migration that creates a table in `ebook` would reintroduce the exact 42501
-- above for that one table — a partial failure surfacing mid-pipeline rather
-- than at submit, which is harder to diagnose than a clean break.
--
-- FOR ROLE postgres: default privileges apply to objects created BY a specific
-- role, and the SQL editor / migrations run as `postgres`. Omitting this clause
-- would silently scope the rule to the role that happens to run this file.
alter default privileges for role postgres in schema ebook
  grant all privileges on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema ebook
  grant all privileges on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema ebook
  grant all privileges on functions to anon, authenticated, service_role;

-- NOTE ON SECURITY: granting `anon` here matches how Supabase treats `public`,
-- and it is what lets PostgREST answer at all. It is not what protects the data
-- — this app has no per-user accounts and the ebook tables carry no RLS (see
-- the note in 0031); every request is already gated by the shared-password
-- check in proxy.ts before it reaches a route handler, and the server-side
-- client uses the service-role key. If per-user access is ever introduced,
-- revoke anon here and add RLS policies rather than relying on this grant.

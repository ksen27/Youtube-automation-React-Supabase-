-- Persistent image-verification verdict cache (Gemini outage / matching-speed
-- work, Fix 3 of 3).
--
-- One row per (entity_type, entity_name, candidate_url) — the answer to
-- "is THIS image really THIS entity?" That answer never changes for a given
-- URL, so it is cached GLOBALLY (no project_id): the same celebrity photo
-- URLs recur across blocks, job retries, worker restarts, and even other
-- projects about the same person. Before this table the verdict cache was a
-- per-process LRU that died on every restart, so a re-run re-paid every
-- Gemini Vision call.
--
-- IMPORTANT: only REAL verdicts are stored — "yes" (confirmed), "no"
-- (rejected), "uncertain" (Gemini looked and could not tell). Infra failures
-- (Gemini 503, fetch timeout, parse error) are NEVER written here; those are
-- retried by the caller, not persisted. See lib/ai/pool-verification.ts.

create table if not exists public.image_verifications (
  id              uuid primary key default gen_random_uuid(),
  -- Mirrors the BlockEntityType enum (minus celebrity_default, which is
  -- never gated). Text, not a Postgres enum — application is source of truth.
  entity_type     text not null
                  check (entity_type in ('person','company','tv_show','movie','song','place')),
  -- Lowercased at write time so lookups are a plain equality match.
  entity_name     text not null,
  candidate_url   text not null,
  -- The collapsed pool verdict (overlay "dirty" already folded into "no" by
  -- the caller) — exactly what verifyPoolAsset would return for this key.
  verdict         text not null
                  check (verdict in ('yes','no','uncertain')),
  reason          text not null default '',
  confidence      numeric not null default 0,
  checked_at      timestamptz not null default now()
);

-- One verdict per (type, name, url). Re-verification upserts on this key.
create unique index if not exists image_verifications_key_idx
  on public.image_verifications (entity_type, entity_name, candidate_url);

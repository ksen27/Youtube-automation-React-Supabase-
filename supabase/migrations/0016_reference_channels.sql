-- =========================================================================
-- Reference channels: extend channel_rules into user-managed, prioritized
-- reference channels.
--
-- Background: channel_rules started as a flat approved/blocked allowlist used
-- only as a scoring bonus. The subject-centric footage pipeline searches
-- reference channels FIRST (scoped to each channelId) and only falls back to
-- open YouTube search to fill the remaining clip count. That requires two new
-- per-channel attributes the original table lacked:
--
--   enabled  – a user toggle so a channel can be kept on file but skipped in
--              search without deleting it.
--   priority – search order. Lower runs first (priority 1 before priority 2).
--              Existing rows default to 100 so they sort after any channel a
--              user explicitly prioritizes, while staying ahead of nothing.
--
-- No data migration is needed: existing approved channels become enabled
-- reference channels at default priority; blocked channels keep their
-- block semantics (enabled/priority are ignored for the 'blocked' rule).
-- =========================================================================

alter table public.channel_rules
  add column if not exists enabled  boolean not null default true,
  add column if not exists priority int     not null default 100;

-- Reference-channel search walks approved rows in (priority asc, created_at asc)
-- order; this index keeps that ordering cheap as the list grows.
create index if not exists channel_rules_priority_idx
  on public.channel_rules (rule, enabled, priority);

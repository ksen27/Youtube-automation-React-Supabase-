-- HeyGen storageState auth + resilient pool management.
--
-- Additive, synthetic-only. The celebrity engine is untouched.
--
-- The redesign stops logging in on every avatar job. Instead a human connects
-- each account ONCE (headed `npm run heygen:connect <email>`), the encrypted
-- Playwright storageState is stored in cookies_json, and workers only RESTORE +
-- VERIFY the session. A session that has expired is flagged 'needs_reauth' — it
-- is taken out of rotation WITHOUT a cooldown and WITHOUT bumping fail_count, so
-- a stale session never burns the pool down to "no available accounts". An
-- operator re-runs the connect script for that one account to clear it.
--
-- New status: 'needs_reauth' (session expired / never connected — awaiting a
-- human re-connect). The existing 'active' | 'cooldown' | 'disabled' are kept.
--
-- New diagnostics columns let the settings UI explain WHY an account is out of
-- rotation, and record when its session was last (re)connected.

alter table public.heygen_accounts
  drop constraint if exists heygen_accounts_status_check;

alter table public.heygen_accounts
  add constraint heygen_accounts_status_check
  check (status in ('active', 'cooldown', 'disabled', 'needs_reauth'));

alter table public.heygen_accounts
  -- Last failure classification (see lib/synthetic/heygen-errors.ts): one of
  -- login_required | session_expired | ui_changed | rate_limit |
  -- credit_exhausted | selector_failure | network | unknown.
  add column if not exists last_error_class text,
  -- Human-readable last failure reason (truncated), for the settings UI.
  add column if not exists last_error       text,
  -- When the storageState was last successfully (re)connected by a human.
  add column if not exists auth_saved_at     timestamptz;

-- Accounts awaiting re-connect should surface first in admin listings.
create index if not exists heygen_accounts_needs_reauth_idx
  on public.heygen_accounts (status)
  where status = 'needs_reauth';

-- =============================================================================
-- 0034 — Storage for the Payhip browser session.
--
-- Payhip has no API for creating products (only coupons and license keys), so
-- listing a finished book is a browser automation against the real dashboard.
-- That browser has to arrive already logged in, and the worker must NEVER log
-- in itself: a headless login walks straight into 2FA / captcha, and typing
-- credentials on a worker means storing credentials on a worker.
--
-- So the same shape the HeyGen pool already uses (lib/synthetic/heygen-auth.ts):
-- a human logs in ONCE in a visible browser via `npm run payhip:connect`, and
-- the resulting Playwright storageState lands here. Every headless run restores
-- it and only VERIFIES it; an expired session is flagged for re-connect rather
-- than repaired.
--
-- WHY THE DATABASE AND NOT A FILE: the workers run on Fly with ephemeral
-- filesystems. A state file written during a connect would not survive the next
-- deploy, and would not reach the worker that needs it anyway — the connect
-- runs on a human's laptop, the automation runs in a container. The shared DB
-- is the only place both can see. It also means there is no session file on
-- disk to accidentally commit.
--
-- The state is stored ENCRYPTED (lib/crypto/secret-box, the same envelope the
-- HeyGen cookies use) because it is a bearer credential: anyone holding it is
-- logged into the seller's store.
--
-- Apply after 0033. Safe to re-run.
-- =============================================================================

set search_path = ebook, public;

create table if not exists payhip_sessions (
  id           uuid primary key default gen_random_uuid(),
  -- Which stored session this is. One row per Payhip account; 'default' is the
  -- single-store case, which is all this app needs today. Unique so a second
  -- connect UPDATES the session rather than quietly adding a rival row that
  -- half the runs would pick up.
  label        text not null unique default 'default',
  -- Encrypted Playwright storageState (secret-box envelope). Null until the
  -- first successful connect.
  storage_state text,
  -- Set when a headless run lands on the login page: the operator must re-run
  -- the connect command. Cleared by a successful connect.
  needs_reauth boolean not null default false,
  -- Why it was flagged, so the operator is told what happened rather than just
  -- that something did.
  note         text,
  -- When the stored state was last written or last confirmed still valid.
  saved_at     timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table payhip_sessions is
  'Encrypted Playwright storageState for the Payhip dashboard automation. Written by `npm run payhip:connect` (headed, human-driven); read by the checkout-product worker, which never logs in.';

-- The single-store case reads this row on every run and does not know its id.
create unique index if not exists payhip_sessions_label_idx on payhip_sessions (label);

-- The default row, so the connect command has something to update and a
-- never-connected deployment reports "not configured" rather than "not found".
insert into payhip_sessions (label) values ('default')
  on conflict (label) do nothing;

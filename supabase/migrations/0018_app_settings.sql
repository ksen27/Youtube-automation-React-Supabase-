-- =========================================================================
-- App settings: a tiny key/value store for runtime-configurable settings that
-- must survive redeploys and be changeable from inside the app (not via env
-- vars + a redeploy).
--
-- First use: the CelebForge access password. It started as the
-- CELEBFORGE_PASSWORD env var, which meant changing it required editing Vercel
-- settings and redeploying. Storing a salted hash here lets the client change
-- their own password at any time from the settings page. We store ONLY a
-- PBKDF2 hash (never the plaintext); see lib/auth.ts for the format.
--
-- The env var still works as a fallback/bootstrap: until a password row exists
-- here, verifyPassword() falls back to CELEBFORGE_PASSWORD so a fresh deploy is
-- never locked out.
-- =========================================================================

create table if not exists public.app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

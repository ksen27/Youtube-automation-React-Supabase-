-- Per-account LEASE for parallel HeyGen avatar generation.
--
-- THE FEATURE
-- -----------
-- Avatar generation is moving from AVATAR_CONCURRENCY=1 (a single warm-browser
-- singleton) to a per-account pool so 3-4 accounts render concurrently — each on
-- its own proxy exit IP, so the parallel browsers don't look like bot activity
-- from one IP. See lib/synthetic/heygen-session.ts (pool) and heygen.ts (claim).
--
-- THE PROBLEM THIS FIXES
-- ----------------------
-- The old getAvailableAccount() did `SELECT ... LIMIT 1` then a SEPARATE
-- `UPDATE last_used_at`. That read-then-write is a RACE: two concurrent avatar
-- jobs can both SELECT the same least-recently-used row before either stamps it,
-- so both drive the SAME account's warm browser at once and corrupt each other's
-- session. Harmless at concurrency=1 (the old code even says "should not happen
-- at avatar concurrency=1"); guaranteed to double-assign under real concurrency.
--
-- THE FIX
-- -------
-- A LEASE. An account is "claimed" for the duration of one avatar job:
--   claimed_until  — when the lease expires. NULL = not claimed.
--   claimed_by     — an opaque worker/job token, for diagnostics only.
-- Claiming is done atomically in claim_heygen_account() below with
-- `FOR UPDATE SKIP LOCKED`, so N concurrent workers each grab a DISTINCT row and
-- never collide. The lease AUTO-EXPIRES (claimed_until in the past is reclaimable)
-- so a crashed worker can't strand an account forever — mirrors how cooldowns
-- self-clear.
--
-- Additive, synthetic-only. The celebrity engine is untouched.

alter table public.heygen_accounts
  -- When the current avatar-job lease on this account expires. NULL = free.
  -- An account is claimable when this is NULL or in the past (crashed-worker
  -- reclaim). Distinct from cooldown_until (a PENALTY window after a failure) —
  -- a lease is a healthy account that is simply busy right now.
  add column if not exists claimed_until timestamptz,
  -- Opaque token for whoever holds the lease (diagnostics / manual release).
  -- Not a foreign key — workers are ephemeral and set their own token.
  add column if not exists claimed_by    text;

-- Partial index over currently-leased rows so the claim query's reclaim scan and
-- any "who is busy" admin lookups stay cheap without indexing the common NULL.
create index if not exists heygen_accounts_claimed_until_idx
  on public.heygen_accounts (claimed_until)
  where claimed_until is not null;

-- Atomically claim the least-recently-used ELIGIBLE account and lease it.
--
-- Eligible = status 'active' (or a 'cooldown' account whose window has elapsed —
-- reactivated inline, same as the old getAvailableAccount) AND not currently
-- leased (claimed_until NULL or already past). `FOR UPDATE SKIP LOCKED` is the
-- key: concurrent callers each lock a DIFFERENT eligible row and skip rows a peer
-- already locked, so two avatar jobs can never be handed the same account.
--
-- On claim it stamps claimed_until = now() + p_lease_seconds, claimed_by, and
-- last_used_at (preserving LRU rotation), flips a rested cooldown row back to
-- 'active', and RETURNS the full row so the caller can decrypt it exactly like
-- the old select-* path. Returns no rows when the pool is exhausted.
--
-- SECURITY DEFINER so it runs with the table owner's rights (the service role
-- already has full access; this keeps behavior identical if RLS is later added).
create or replace function public.claim_heygen_account(
  p_lease_seconds integer,
  p_claimed_by    text
)
returns setof public.heygen_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_id  uuid;
begin
  -- First, opportunistically reactivate accounts whose cooldown has elapsed, so
  -- a rested account re-enters rotation (matches the old getAvailableAccount).
  update public.heygen_accounts
     set status = 'active', cooldown_until = null
   where status = 'cooldown'
     and cooldown_until is not null
     and cooldown_until <= v_now;

  -- Pick ONE eligible, unleased, least-recently-used account and lock it,
  -- skipping any row a concurrent claimer already holds.
  select id
    into v_id
    from public.heygen_accounts
   where status = 'active'
     and (claimed_until is null or claimed_until <= v_now)
   order by last_used_at asc nulls first
   limit 1
   for update skip locked;

  if v_id is null then
    return; -- pool exhausted / everything busy
  end if;

  return query
  update public.heygen_accounts
     set claimed_until = v_now + make_interval(secs => p_lease_seconds),
         claimed_by    = p_claimed_by,
         last_used_at  = v_now
   where id = v_id
   returning *;
end;
$$;

-- Extend the lease on an account held by THIS worker (heartbeat). No-op if the
-- account is no longer held by p_claimed_by (someone else reclaimed it after an
-- expiry) — the caller then treats its own render as orphaned. Returns the number
-- of rows updated (0 or 1).
create or replace function public.renew_heygen_lease(
  p_id            uuid,
  p_lease_seconds integer,
  p_claimed_by    text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.heygen_accounts
     set claimed_until = now() + make_interval(secs => p_lease_seconds)
   where id = p_id
     and claimed_by = p_claimed_by
     and claimed_until is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Release the lease held by THIS worker so the account is immediately claimable
-- again (called in a finally after the job, success OR failure). Scoped to
-- p_claimed_by so a worker never clears a lease a peer has since taken over.
create or replace function public.release_heygen_account(
  p_id         uuid,
  p_claimed_by text
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.heygen_accounts
     set claimed_until = null, claimed_by = null
   where id = p_id
     and claimed_by = p_claimed_by;
$$;

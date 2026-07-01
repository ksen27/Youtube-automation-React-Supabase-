import { getServerSupabase } from "@/lib/supabase/server";
import { getEnv } from "@/lib/env";
import { encryptSecret, decryptSecret, encryptJson, decryptJson } from "@/lib/crypto/secret-box";
import { logJob } from "@/lib/jobs/db";
import type { HeygenAccount } from "@/lib/types";
import type { HeygenDisposition, HeygenErrorClass } from "@/lib/synthetic/heygen-errors";

// HeyGen account pool management — selection, rotation, cooldown, and the
// encrypted credential/cookie round-trip. Kept SEPARATE from the Playwright
// automation (heygen.ts) so this rotation logic is pure DB + crypto and can be
// unit-tested without launching a browser.
//
// Lifecycle:
//   getAvailableAccount() -> least-recently-used 'active' account whose
//                            cooldown (if any) has elapsed.
//   recordSuccess()       -> reset fail_count, stamp last_used_at.
//   recordFailure()       -> bump fail_count; cooldown, or disable past the
//                            HEYGEN_MAX_FAIL_COUNT threshold.
//   markNeedsReauth()     -> session expired: out of rotation, NO cooldown, NO
//                            fail bump (cleared by re-running heygen:connect).
//   applyDisposition()    -> apply a classified failure's disposition (reauth /
//                            cooldown / disable / rotate) and hand back the next
//                            available account (used mid-job on failure).

export interface DecryptedAccount {
  id: string;
  email: string;
  password: string;            // decrypted — never logged
  cookies: unknown | null;     // decrypted Playwright storage state
  proxy: string | null;        // per-account override or null (global pool)
  fail_count: number;
  // The lease token this account was claimed under (parallel avatar generation).
  // Set by claimAccount(); passed back to renewLease()/releaseAccount() so a
  // worker only ever renews or releases a lease it actually holds. null when the
  // account was fetched without a claim (keep-alive sweep, admin lookups).
  leaseToken: string | null;
}

function decrypt(row: HeygenAccount, leaseToken: string | null = null): DecryptedAccount {
  return {
    id: row.id,
    email: row.email,
    password: decryptSecret(row.password_enc),
    cookies: decryptJson(row.cookies_json),
    proxy: row.proxy,
    fail_count: row.fail_count,
    leaseToken,
  };
}

/**
 * Pick the next account to use. Selection order: 'active' accounts, oldest
 * last_used_at first (LRU), excluding any still inside a cooldown window. We
 * also opportunistically clear elapsed cooldowns back to 'active' so a rested
 * account re-enters rotation. Returns null when the pool is empty/exhausted.
 */
export async function getAvailableAccount(): Promise<DecryptedAccount | null> {
  const sb = getServerSupabase();
  const nowIso = new Date().toISOString();

  // Reactivate accounts whose cooldown has elapsed (best-effort).
  await sb
    .from("heygen_accounts")
    .update({ status: "active", cooldown_until: null })
    .eq("status", "cooldown")
    .lte("cooldown_until", nowIso);

  const { data, error } = await sb
    .from("heygen_accounts")
    .select("*")
    .eq("status", "active")
    .order("last_used_at", { ascending: true, nullsFirst: true })
    .limit(1);
  if (error) throw new Error(`getAvailableAccount: ${error.message}`);
  const row = (data ?? [])[0] as HeygenAccount | undefined;
  if (!row) return null;

  // Claim it immediately by stamping last_used_at so a concurrent picker
  // (should not happen at avatar concurrency=1, but defensive) moves on.
  await sb.from("heygen_accounts").update({ last_used_at: nowIso }).eq("id", row.id);
  return decrypt(row);
}

// A short random token identifying one worker's hold on an account. Not the job
// id — a single job may rotate through several accounts, and each hold gets its
// own token so release/renew is scoped to the exact lease. Prefixed with the pid
// for greppability in logs.
function newLeaseToken(): string {
  return `w${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * ATOMICALLY claim the least-recently-used eligible account and LEASE it for
 * `leaseSeconds`. This is the parallel-safe replacement for getAvailableAccount:
 * it runs the whole "reactivate rested cooldowns -> pick LRU active+unleased ->
 * stamp the lease" sequence inside one `FOR UPDATE SKIP LOCKED` transaction
 * (public.claim_heygen_account), so N concurrent avatar jobs each get a DISTINCT
 * account and never drive the same warm browser at once.
 *
 * The lease AUTO-EXPIRES: a crashed worker's account becomes claimable again
 * after `leaseSeconds` without any manual cleanup. Pick a lease comfortably
 * above one avatar render's worst case; renewLease() extends the lease via
 * heartbeat for a genuinely long render.
 *
 * Returns the claimed (decrypted) account carrying its leaseToken, or null when
 * the pool is exhausted / every account is busy. NEVER logs the decrypted fields.
 */
export async function claimAccount(leaseSeconds: number): Promise<DecryptedAccount | null> {
  const sb = getServerSupabase();
  const token = newLeaseToken();
  const { data, error } = await sb.rpc("claim_heygen_account", {
    p_lease_seconds: Math.max(1, Math.round(leaseSeconds)),
    p_claimed_by: token,
  });
  if (error) throw new Error(`claimAccount: ${error.message}`);
  const row = ((data as HeygenAccount[] | null) ?? [])[0];
  if (!row) return null;
  return decrypt(row, token);
}

/**
 * Extend the lease on an account this worker holds (call periodically during a
 * long render so the lease can't expire mid-job and let a peer claim the same
 * account). No-op — returns false — if the lease was already reclaimed by
 * someone else (expired then re-claimed); the caller may then abandon its hold.
 * Requires account.leaseToken to be set (i.e. it came from claimAccount).
 */
export async function renewLease(
  account: DecryptedAccount,
  leaseSeconds: number,
): Promise<boolean> {
  if (!account.leaseToken) return false;
  const sb = getServerSupabase();
  const { data, error } = await sb.rpc("renew_heygen_lease", {
    p_id: account.id,
    p_lease_seconds: Math.max(1, Math.round(leaseSeconds)),
    p_claimed_by: account.leaseToken,
  });
  if (error) throw new Error(`renewLease: ${error.message}`);
  return Number(data ?? 0) > 0;
}

/**
 * Release this worker's lease on an account so it is immediately claimable again.
 * Call in a finally after every avatar job (success OR failure). Scoped to the
 * lease token so a worker never clears a lease a peer has since taken over. A
 * no-token account (fetched without a claim) is a no-op. Never throws — a failed
 * release just means the account waits out its lease TTL, which is safe.
 */
export async function releaseAccount(account: DecryptedAccount): Promise<void> {
  if (!account.leaseToken) return;
  const sb = getServerSupabase();
  await sb
    .rpc("release_heygen_account", { p_id: account.id, p_claimed_by: account.leaseToken })
    .then(({ error }) => {
      if (error) {
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            msg: "heygen.releaseAccount.error",
            accountId: account.id,
            err: error.message?.slice(0, 200),
          }),
        );
      }
    });
}

/**
 * The set of account ids currently under a live lease (claimed_until in the
 * future). The keep-alive sweep uses this to skip EVERY busy account — opening a
 * second concurrent HeyGen browser for an account mid-render is the fingerprint
 * churn the pool design avoids, and with a multi-account pool the old single
 * `warmAccountId()` skip was insufficient. Best-effort: on a query error returns
 * an empty set (the sweep then falls back to its own warm-account skip).
 */
export async function claimedAccountIds(): Promise<Set<string>> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("heygen_accounts")
    .select("id")
    .not("claimed_until", "is", null)
    .gt("claimed_until", new Date().toISOString());
  if (error) return new Set();
  return new Set((data ?? []).map((r) => (r as { id: string }).id));
}

/**
 * All accounts that currently hold a live session worth keeping warm — 'active'
 * or 'cooldown' (a cooled-down account is still authenticated, just resting).
 * needs_reauth / disabled accounts have nothing to refresh, so they're excluded.
 * Used by the server-side keep-alive sweep and the keepalive CLI. Returns
 * decrypted accounts (cookies included) — never log these.
 */
export async function getRefreshableAccounts(): Promise<DecryptedAccount[]> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("heygen_accounts")
    .select("*")
    .in("status", ["active", "cooldown"]);
  if (error) throw new Error(`getRefreshableAccounts: ${error.message}`);
  return (data ?? []).map((row) => decrypt(row as HeygenAccount));
}

/**
 * Persist a fresh Playwright storage state (cookies + localStorage). Worker
 * runs call this to refresh a still-warm session WITHOUT touching status.
 */
export async function saveCookies(accountId: string, storageState: unknown): Promise<void> {
  const sb = getServerSupabase();
  const { error } = await sb
    .from("heygen_accounts")
    .update({ cookies_json: encryptJson(storageState) })
    .eq("id", accountId);
  if (error) throw new Error(`saveCookies: ${error.message}`);
}

/**
 * Save a freshly-connected session (the headed connect script). Unlike
 * saveCookies this also clears any needs_reauth/cooldown/disabled state, resets
 * the failure counters, and stamps auth_saved_at — i.e. it brings a connected
 * account back into rotation in one shot.
 */
export async function saveConnectedSession(accountId: string, storageState: unknown): Promise<void> {
  const sb = getServerSupabase();
  const { error } = await sb
    .from("heygen_accounts")
    .update({
      cookies_json: encryptJson(storageState),
      status: "active",
      fail_count: 0,
      cooldown_until: null,
      last_error_class: null,
      last_error: null,
      auth_saved_at: new Date().toISOString(),
    })
    .eq("id", accountId);
  if (error) throw new Error(`saveConnectedSession: ${error.message}`);
}

/** Fetch one account (decrypted) by email — used by the connect script. */
export async function getAccountByEmail(email: string): Promise<DecryptedAccount | null> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("heygen_accounts")
    .select("*")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();
  return data ? decrypt(data as HeygenAccount) : null;
}

/** Decrypt and return the stored storage state for an account, or null. */
export async function restoreCookies(accountId: string): Promise<unknown | null> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("heygen_accounts")
    .select("cookies_json")
    .eq("id", accountId)
    .single();
  return decryptJson((data?.cookies_json as string | null) ?? null);
}

/** Mark a successful generation: reset failures, refresh last_used_at. */
export async function recordSuccess(accountId: string): Promise<void> {
  const sb = getServerSupabase();
  await sb
    .from("heygen_accounts")
    .update({
      fail_count: 0,
      status: "active",
      cooldown_until: null,
      last_error_class: null,
      last_error: null,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", accountId);
}

/**
 * Record a failure on an account. Below the threshold the account is cooled
 * down (rests for HEYGEN_COOLDOWN_MINUTES then auto-reactivates); at/above the
 * threshold it is disabled (out of rotation until a human re-enables it).
 * Returns the new status so the caller can log it.
 */
export async function recordFailure(
  accountId: string,
  reason: string,
): Promise<"cooldown" | "disabled"> {
  const env = getEnv();
  const sb = getServerSupabase();
  const { data } = await sb
    .from("heygen_accounts")
    .select("fail_count")
    .eq("id", accountId)
    .single();
  const failCount = (data?.fail_count ?? 0) + 1;
  const disable = failCount >= env.HEYGEN_MAX_FAIL_COUNT;
  const cooldownUntil = disable
    ? null
    : new Date(Date.now() + env.HEYGEN_COOLDOWN_MINUTES * 60_000).toISOString();

  await sb
    .from("heygen_accounts")
    .update({
      fail_count: failCount,
      status: disable ? "disabled" : "cooldown",
      cooldown_until: cooldownUntil,
    })
    .eq("id", accountId);

  await logJob({ jobId: undefined }, "synthetic.heygen.account_failure", {
    accountId,
    failCount,
    newStatus: disable ? "disabled" : "cooldown",
    reason: reason.slice(0, 200),
  });
  return disable ? "disabled" : "cooldown";
}

/**
 * Flag an account as needing re-authentication. This is the key fix for the
 * "no available accounts" cascade: an expired session (or one that was never
 * connected) takes the account OUT of rotation but does NOT cool it down and
 * does NOT bump fail_count — there is nothing wrong with the account, its
 * browser session simply lapsed. An operator clears it by re-running
 * `npm run heygen:connect <email>`.
 */
export async function markNeedsReauth(accountId: string, reason: string): Promise<void> {
  const sb = getServerSupabase();
  await sb
    .from("heygen_accounts")
    .update({
      status: "needs_reauth",
      cooldown_until: null,
      last_error_class: "session_expired",
      last_error: reason.slice(0, 300),
    })
    .eq("id", accountId);
  await logJob({ jobId: undefined }, "synthetic.heygen.needs_reauth", {
    accountId,
    reason: reason.slice(0, 200),
  });
}

/** Stamp the last failure classification + reason without changing status. */
export async function recordErrorClass(
  accountId: string,
  klass: HeygenErrorClass,
  reason: string,
): Promise<void> {
  const sb = getServerSupabase();
  await sb
    .from("heygen_accounts")
    .update({ last_error_class: klass, last_error: reason.slice(0, 300) })
    .eq("id", accountId);
}

/**
 * Apply a failure DISPOSITION (from the error classifier) to an account and
 * return the next available account to try, or null if the pool is exhausted.
 * Replaces the old always-cooldown rotateAccount: only genuinely account-level
 * problems (rate limit, credit, repeated unknowns) cool an account down; a UI
 * change or network blip just rotates with no penalty; an expired session is
 * flagged for re-auth.
 */
export async function applyDisposition(
  accountId: string,
  disposition: HeygenDisposition,
  klass: HeygenErrorClass,
  reason: string,
  // How to obtain the NEXT account to try after applying this disposition:
  //   - "claim:<seconds>": atomically CLAIM+lease a fresh account (parallel-safe
  //     path — generateAvatar passes this so rotation never hands two concurrent
  //     jobs the same account). The failed account's lease MUST be released by
  //     the caller separately (it still holds it here).
  //   - "available": legacy un-leased getAvailableAccount (kept for any caller
  //     that isn't lease-managed).
  // Default preserves the historical behavior.
  next: { mode: "available" } | { mode: "claim"; leaseSeconds: number } = { mode: "available" },
): Promise<DecryptedAccount | null> {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: "heygen.applyDisposition",
      accountId,
      disposition,
      klass,
      reason: reason.slice(0, 200),
    }),
  );
  switch (disposition) {
    case "reauth":
      await markNeedsReauth(accountId, reason);
      break;
    case "disable": {
      const sb = getServerSupabase();
      await sb
        .from("heygen_accounts")
        .update({ status: "disabled", last_error_class: klass, last_error: reason.slice(0, 300) })
        .eq("id", accountId);
      break;
    }
    case "cooldown":
      await recordErrorClass(accountId, klass, reason);
      await recordFailure(accountId, reason);
      break;
    case "rotate":
      // No penalty — the account is fine; just note why we moved on.
      await recordErrorClass(accountId, klass, reason);
      break;
  }
  return next.mode === "claim" ? claimAccount(next.leaseSeconds) : getAvailableAccount();
}


// --- admin helpers (used by the settings API route) ---

/**
 * Add a HeyGen account. Password is encrypted before storage. The account
 * starts in 'needs_reauth' — it has no browser session yet, so it is NOT handed
 * to a worker until a human connects it with `npm run heygen:connect <email>`
 * (which flips it to 'active'). This avoids burning an avatar attempt on an
 * account that was always going to be unauthenticated.
 */
export async function addAccount(input: {
  email: string;
  password: string;
  proxy?: string | null;
}): Promise<string> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("heygen_accounts")
    .insert({
      email: input.email.trim().toLowerCase(),
      password_enc: encryptSecret(input.password),
      proxy: input.proxy?.trim() || null,
      status: "needs_reauth",
      last_error: "never connected — run `npm run heygen:connect <email>`",
    })
    .select("id")
    .single();
  if (error) throw new Error(`addAccount: ${error.message}`);
  return data.id as string;
}

export async function removeAccount(accountId: string): Promise<void> {
  const sb = getServerSupabase();
  const { error } = await sb.from("heygen_accounts").delete().eq("id", accountId);
  if (error) throw new Error(`removeAccount: ${error.message}`);
}

export async function setAccountStatus(
  accountId: string,
  status: HeygenAccount["status"],
): Promise<void> {
  const sb = getServerSupabase();
  const patch: Record<string, unknown> = { status };
  if (status === "active") {
    patch.fail_count = 0;
    patch.cooldown_until = null;
  }
  const { error } = await sb.from("heygen_accounts").update(patch).eq("id", accountId);
  if (error) throw new Error(`setAccountStatus: ${error.message}`);
}

/** Listing for the settings UI — NEVER returns secrets, only status fields. */
export async function listAccountsSafe(): Promise<
  Array<
    Pick<
      HeygenAccount,
      | "id"
      | "email"
      | "status"
      | "fail_count"
      | "cooldown_until"
      | "last_used_at"
      | "created_at"
      | "last_error_class"
      | "last_error"
      | "auth_saved_at"
    > & { has_cookies: boolean }
  >
> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("heygen_accounts")
    .select(
      "id, email, status, fail_count, cooldown_until, last_used_at, created_at, last_error_class, last_error, auth_saved_at, cookies_json",
    )
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listAccountsSafe: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    status: r.status,
    fail_count: r.fail_count,
    cooldown_until: r.cooldown_until,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
    last_error_class: r.last_error_class ?? null,
    last_error: r.last_error ?? null,
    auth_saved_at: r.auth_saved_at ?? null,
    has_cookies: Boolean(r.cookies_json),
  }));
}

/**
 * Resolve the proxy for an account. Precedence:
 *   1. per-account override (the optional `proxy` column on the account)
 *   2. HEYGEN_PROXIES        (HeyGen-specific pool)
 *   3. YTDLP_PROXIES         (the shared CelebForge residential pool) — ONLY
 *                             when HEYGEN_USE_YTDLP_PROXIES=true. This fallback
 *                             is opt-in because those proxies are tuned for
 *                             yt-dlp and may reject the browser (seen as a 407
 *                             proxy-auth wall on app.heygen.com), which would
 *                             fail every avatar job. Leave it off unless you
 *                             know the shared pool authenticates a browser.
 * Returns null when no applicable pool is configured. Both pool vars use the
 * same `ip:port:user:pass` (newline/comma-separated) format.
 */
export function resolveProxy(account: DecryptedAccount): string | null {
  if (account.proxy) return account.proxy;
  const env = getEnv();
  const pool = env.HEYGEN_PROXIES || (env.HEYGEN_USE_YTDLP_PROXIES ? env.YTDLP_PROXIES : "");
  if (!pool) return null;
  const list = pool.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return null;
  // Deterministic pick by account id so the same account reuses the same exit
  // IP (HeyGen flags session-IP churn). Hash the id to an index.
  let h = 0;
  for (const ch of account.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

// Parse an `ip:port:user:pass` (or `ip:port`) proxy string into Playwright's
// proxy option shape.
export function parseProxy(raw: string): { server: string; username?: string; password?: string } {
  const parts = raw.split(":");
  if (parts.length >= 4) {
    const [ip, port, username, ...rest] = parts;
    return { server: `http://${ip}:${port}`, username, password: rest.join(":") };
  }
  const [ip, port] = parts;
  return { server: `http://${ip}:${port}` };
}

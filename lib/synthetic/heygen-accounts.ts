import { getServerSupabase } from "@/lib/supabase/server";
import { getEnv } from "@/lib/env";
import { encryptSecret, decryptSecret, encryptJson, decryptJson } from "@/lib/crypto/secret-box";
import { logJob } from "@/lib/jobs/db";
import type { HeygenAccount } from "@/lib/types";

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
//   rotateAccount()       -> cooldown the current account and hand back the
//                            next available one (used mid-job on soft failure).

export interface DecryptedAccount {
  id: string;
  email: string;
  password: string;            // decrypted — never logged
  cookies: unknown | null;     // decrypted Playwright storage state
  proxy: string | null;        // per-account override or null (global pool)
  fail_count: number;
}

function decrypt(row: HeygenAccount): DecryptedAccount {
  return {
    id: row.id,
    email: row.email,
    password: decryptSecret(row.password_enc),
    cookies: decryptJson(row.cookies_json),
    proxy: row.proxy,
    fail_count: row.fail_count,
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

/** Persist a fresh Playwright storage state (cookies + localStorage). */
export async function saveCookies(accountId: string, storageState: unknown): Promise<void> {
  const sb = getServerSupabase();
  const { error } = await sb
    .from("heygen_accounts")
    .update({ cookies_json: encryptJson(storageState) })
    .eq("id", accountId);
  if (error) throw new Error(`saveCookies: ${error.message}`);
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
    .update({ fail_count: 0, status: "active", cooldown_until: null, last_used_at: new Date().toISOString() })
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
 * Cool down the current account and return the next available one. Used when a
 * generation fails on an account that may simply be rate-limited — we don't
 * want to retry the same account immediately.
 */
export async function rotateAccount(
  currentAccountId: string,
  reason: string,
): Promise<DecryptedAccount | null> {
  await recordFailure(currentAccountId, reason);
  return getAvailableAccount();
}

// --- admin helpers (used by the settings API route) ---

/** Add a HeyGen account. Password is encrypted before storage. */
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
      status: "active",
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
  Array<Pick<HeygenAccount, "id" | "email" | "status" | "fail_count" | "cooldown_until" | "last_used_at" | "created_at"> & { has_cookies: boolean }>
> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("heygen_accounts")
    .select("id, email, status, fail_count, cooldown_until, last_used_at, created_at, cookies_json")
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
    has_cookies: Boolean(r.cookies_json),
  }));
}

/**
 * Resolve the proxy for an account. Precedence:
 *   1. per-account override (the optional `proxy` column on the account)
 *   2. HEYGEN_PROXIES        (HeyGen-specific pool, if you want one separate)
 *   3. YTDLP_PROXIES         (the existing CelebForge residential pool — reused
 *                             automatically so you don't have to re-enter the
 *                             same proxies for HeyGen)
 * Returns null only when none of the three is configured. Both pool vars use
 * the same `ip:port:user:pass` (newline/comma-separated) format.
 */
export function resolveProxy(account: DecryptedAccount): string | null {
  if (account.proxy) return account.proxy;
  const env = getEnv();
  // Prefer a dedicated HeyGen pool; otherwise fall back to the shared
  // CelebForge (yt-dlp) residential pool already configured for the celebrity
  // engine. This is what lets HeyGen reuse those proxies with no manual entry.
  const pool = env.HEYGEN_PROXIES || env.YTDLP_PROXIES;
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

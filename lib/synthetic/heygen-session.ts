import { type Browser, type BrowserContext, type Page } from "playwright";
import { getEnv } from "@/lib/env";
import { openAuthedContext, verifyAuthenticated } from "@/lib/synthetic/heygen-auth";
import { HeygenError } from "@/lib/synthetic/heygen-errors";
import type { DecryptedAccount } from "@/lib/synthetic/heygen-accounts";

// Warm HeyGen session singleton.
//
// THE BUG THIS FIXES: avatar generation opened a NEW browser + context per job
// and re-navigated to /home to verify the session every time. Each /home hit is
// a fresh Cloudflare challenge against a headless fingerprint, so after ~3
// back-to-back renders HeyGen invalidated the session ("login required") and the
// account got flagged needs_reauth — even at concurrency=1.
//
// THE FIX (spec point 4): keep ONE browser+context alive for the worker's
// lifetime and reuse it across all jobs. A job opens a cheap fresh PAGE (no
// Cloudflare challenge), drives the composer, and closes only that page. The
// /home verify runs only on first use or after a long idle gap
// (HEYGEN_REVERIFY_AFTER_MINUTES), not every job — so a burst of renders no
// longer triggers a challenge per job.
//
// Cookies are still re-saved to the DB after each render (heygen.ts) so the
// encrypted copy stays fresh for cold start and the keep-alive sweep; we just no
// longer RELOAD storageState per job — the live context already holds the warm
// session.
//
// Safe at concurrency=1: only one job touches the context at a time. We still
// serialize acquire() with an in-flight promise so a re-entrant call can never
// launch two browsers. NEVER logs in (login is human-only via the connect CLI).

function env() {
  return getEnv();
}

interface WarmSession {
  browser: Browser;
  context: BrowserContext;
  accountId: string;
  verifiedAtMs: number;
}

let current: WarmSession | null = null;
// Serializes concurrent acquire() calls so we never launch two browsers for the
// same generation. (Concurrency is 1 today, but a keep-alive sweep or a future
// bump must not race the launch.)
let acquiring: Promise<WarmSession> | null = null;

function reverifyAfterMs(): number {
  return env().HEYGEN_REVERIFY_AFTER_MINUTES * 60_000;
}

// Tear down the held browser/context (best-effort) and clear the singleton.
async function disposeCurrent(): Promise<void> {
  const s = current;
  current = null;
  if (!s) return;
  await s.context.close().catch(() => {});
  await s.browser.close().catch(() => {});
}

// Launch a fresh warm session for the account and verify it once. Throws a
// classified session_expired HeygenError if the restored session is dead, so the
// caller's rotation/needs_reauth path handles it exactly as before.
async function launch(account: DecryptedAccount): Promise<WarmSession> {
  const { browser, context } = await openAuthedContext(account);
  const verifyPage = await context.newPage();
  try {
    const verdict = await verifyAuthenticated(verifyPage);
    if (verdict === "expired") {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      throw new HeygenError(
        "session_expired",
        `heygen: account ${account.email} session expired — reconnect with \`npm run heygen:connect ${account.email}\``,
      );
    }
  } finally {
    // The verify page has done its job; jobs open their own page. Closing it
    // keeps the context lean. The context/browser stay warm.
    await verifyPage.close().catch(() => {});
  }
  return { browser, context, accountId: account.id, verifiedAtMs: Date.now() };
}

/**
 * Get a warm, authenticated browser context for `account`, reusing the held one
 * when possible:
 *   - No session held, or held for a DIFFERENT account (rotation) -> launch a
 *     fresh one (closing the old) and verify /home once.
 *   - Held for the SAME account and verified recently (within
 *     HEYGEN_REVERIFY_AFTER_MINUTES) -> return it WITHOUT touching /home (the
 *     hot path: back-to-back jobs skip the Cloudflare challenge entirely).
 *   - Held for the SAME account but stale -> re-verify /home once (a single
 *     challenge), refresh the timestamp, and keep the SAME context warm. If it's
 *     expired, dispose and throw session_expired.
 *
 * Returns the live context. The caller opens its own page and MUST close that
 * page when done (NOT the context — that stays warm for the next job).
 */
export async function acquireWarmSession(account: DecryptedAccount): Promise<BrowserContext> {
  if (acquiring) await acquiring.catch(() => {});

  // Different account than the one we hold => rotation; rebuild.
  if (current && current.accountId !== account.id) {
    await disposeCurrent();
  }

  // Warm + same account + fresh enough => reuse with no /home hit.
  if (current && current.accountId === account.id) {
    const ageMs = Date.now() - current.verifiedAtMs;
    if (ageMs <= reverifyAfterMs()) {
      return current.context;
    }
    // Stale: re-verify once on a throwaway page, refresh the stamp, keep warm.
    const probe = await current.context.newPage();
    try {
      const verdict = await verifyAuthenticated(probe);
      if (verdict === "expired") {
        await probe.close().catch(() => {});
        await disposeCurrent();
        throw new HeygenError(
          "session_expired",
          `heygen: account ${account.email} session expired — reconnect with \`npm run heygen:connect ${account.email}\``,
        );
      }
      current.verifiedAtMs = Date.now();
      return current.context;
    } finally {
      await probe.close().catch(() => {});
    }
  }

  // Nothing held => launch (serialized so a re-entrant call can't double-launch).
  acquiring = launch(account);
  try {
    current = await acquiring;
    return current.context;
  } finally {
    acquiring = null;
  }
}

/**
 * The session hit a login wall mid-job. Drop the warm singleton so the NEXT
 * acquire rebuilds from the (caller-refreshed) stored cookies instead of reusing
 * a context whose cookies HeyGen just invalidated.
 */
export async function invalidateWarmSession(): Promise<void> {
  await disposeCurrent();
}

/**
 * Open a fresh page on the warm context for one job. Cheap (no navigation /
 * challenge here) — the caller drives it and closes it via the returned closer.
 */
export async function openJobPage(account: DecryptedAccount): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await acquireWarmSession(account);
  const page = await context.newPage();
  return {
    page,
    close: async () => {
      await page.close().catch(() => {});
    },
  };
}

/** Graceful teardown for worker shutdown. Never throws. */
export async function closeWarmSession(): Promise<void> {
  await disposeCurrent();
}

/** Test/diagnostic helper: is a warm session currently held? */
export function hasWarmSession(): boolean {
  return current !== null;
}

/**
 * The account id of the currently-held warm session, or null. The keep-alive
 * sweep uses this to SKIP refreshing the warm account: that account already has
 * a live, in-use browser session, and opening a SECOND concurrent browser to
 * HeyGen for the same account is exactly the fingerprint churn we're avoiding.
 * Its cookies are re-saved after every render anyway, so the sweep adds nothing.
 */
export function warmAccountId(): string | null {
  return current?.accountId ?? null;
}

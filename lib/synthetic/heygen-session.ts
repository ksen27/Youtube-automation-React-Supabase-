import { type Browser, type BrowserContext, type Page } from "playwright";
import { getEnv } from "@/lib/env";
import { openAuthedContext, verifyAuthenticated } from "@/lib/synthetic/heygen-auth";
import { HeygenError } from "@/lib/synthetic/heygen-errors";
import type { DecryptedAccount } from "@/lib/synthetic/heygen-accounts";

function baseUrl() {
  return getEnv().HEYGEN_BASE_URL;
}

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
  // A single page kept warm on /avatar across jobs. Reused so the heavy HeyGen
  // SPA stays hydrated — a fresh blank page would reload /avatar cold each job
  // (the cause of the slow ~minutes-to-start). null until first use / after a
  // crash forces a rebuild.
  jobPage: Page | null;
  // How many renders this warm browser has driven. After
  // HEYGEN_MAX_RENDERS_PER_SESSION renders the whole browser is recycled (fresh
  // fingerprint) BEFORE the next render, so Cloudflare's per-session activity
  // heuristic never trips into the blank-composer challenge. See
  // HEYGEN_MAX_RENDERS_PER_SESSION in lib/env.ts for the why.
  rendersServed: number;
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
    // The verify page has done its job; jobs reuse a dedicated warm page (lazily
    // created in acquireJobPage). Closing this keeps the context lean.
    await verifyPage.close().catch(() => {});
  }
  return {
    browser,
    context,
    accountId: account.id,
    verifiedAtMs: Date.now(),
    jobPage: null,
    rendersServed: 0,
  };
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

  // Render-cap recycle: a warm headless browser only survives a couple of
  // renders before Cloudflare flags it and serves the blank-composer challenge
  // on every /avatar load (observed: exactly 2 renders, then it walls). Tear the
  // whole browser down and rebuild a FRESH one from stored cookies BEFORE the
  // render that would otherwise hit the wall. A fresh browser = a fresh
  // fingerprint, resetting the heuristic. The cap (0 disables) is env-driven.
  const maxRenders = env().HEYGEN_MAX_RENDERS_PER_SESSION;
  if (current && current.accountId === account.id && maxRenders > 0 && current.rendersServed >= maxRenders) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "heygen.session.recycle",
        accountId: account.id,
        rendersServed: current.rendersServed,
        maxRenders,
      }),
    );
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
 * Get the WARM job page for one avatar job. Unlike a fresh page per job (which
 * reloads /avatar cold and made generation take minutes to start), this REUSES a
 * single page parked on /avatar so the SPA stays hydrated between jobs:
 *   - first call (or after a crash): create the page and navigate to /avatar once;
 *   - subsequent calls: hand back the SAME page, re-navigating to /avatar only if
 *     it drifted off the composer (e.g. landed on /projects after a render).
 * The caller drives this page and MUST NOT close it — it stays warm. It's closed
 * only on session teardown / invalidation. Returns the page plus the context (the
 * caller still needs context.request for the project-list API + download).
 */
export async function acquireJobPage(
  account: DecryptedAccount,
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await acquireWarmSession(account);
  const session = current; // set by acquireWarmSession
  if (!session) {
    // Shouldn't happen (acquire throws or sets current), but be defensive.
    const page = await context.newPage();
    return { page, context };
  }

  // Recreate the warm page if it's missing or was closed (crash / prior teardown).
  if (!session.jobPage || session.jobPage.isClosed()) {
    session.jobPage = await context.newPage();
    await session.jobPage
      .goto(`${baseUrl()}/avatar`, { waitUntil: "commit" })
      .catch(() => {});
  } else {
    // Reused page: make sure it's still on the composer. After a successful
    // render HeyGen may have routed it to /projects; bring it back so the job's
    // own composer waits resolve fast against a warm SPA.
    const onComposer = /\/avatar\b/i.test(session.jobPage.url());
    if (!onComposer) {
      await session.jobPage
        .goto(`${baseUrl()}/avatar`, { waitUntil: "commit" })
        .catch(() => {});
    }
  }
  return { page: session.jobPage, context };
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
 * Count one completed render against the warm session's render budget. The
 * caller invokes this AFTER a successful generation so the next acquire can
 * recycle the browser once it has served HEYGEN_MAX_RENDERS_PER_SESSION renders
 * — before Cloudflare flags the session into the blank-composer challenge. No-op
 * if no session is held (e.g. it was torn down on failure).
 */
export function recordRenderServed(): void {
  if (current) current.rendersServed += 1;
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

// Count of avatar renders currently in flight. The keep-alive sweep MUST NOT
// open a second concurrent HeyGen browser while a render is running: two live
// sessions for the same account from the same IP is exactly the activity that
// trips Cloudflare into the blank-composer / page-wipe challenge. The old
// `skipAccountId: warmAccountId()` guard was insufficient on a single-account
// pool — between/just-before jobs warmAccountId() is null, so the sweep would
// refresh the ONLY account right as a render started. This counter is the
// authoritative "a job is active" signal, independent of whether the warm
// session object exists yet.
let activeRenders = 0;

/** Mark an avatar render as started — the keep-alive sweep will skip while >0. */
export function beginRender(): void {
  activeRenders += 1;
}

/** Mark an avatar render as finished (success OR failure). Never goes negative. */
export function endRender(): void {
  activeRenders = Math.max(0, activeRenders - 1);
}

/** True while at least one avatar render is in flight. */
export function isRenderActive(): boolean {
  return activeRenders > 0;
}

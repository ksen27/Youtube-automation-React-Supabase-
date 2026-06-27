import { type Browser, type BrowserContext, type Page } from "playwright";
import { getEnv } from "@/lib/env";
import { openAuthedContext, verifyAuthenticated } from "@/lib/synthetic/heygen-auth";
import { HeygenError } from "@/lib/synthetic/heygen-errors";
import type { DecryptedAccount } from "@/lib/synthetic/heygen-accounts";
import {
  type BrowserHealth,
  newHealth,
  isHealthy,
  markSuccess,
  markFailure,
  markDisconnected,
  markPageError,
} from "@/lib/synthetic/heygen-health";

// Structured, single-line lifecycle logging for the warm browser (Objective #9).
// One helper so every browser-lifecycle event reads the same and is greppable.
//   created | reused | health_updated | unhealthy | recycled
//   composer_recovered | recovery_succeeded | recovery_failed
function logSession(event: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), msg: `heygen.session.${event}`, ...extra }),
  );
}

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
  // How many renders this warm browser has driven. The render count is now a
  // BACKSTOP cap, not the primary recycle trigger: HEYGEN_MAX_RENDERS_PER_SESSION
  // recycles the browser BEFORE it reaches the Cloudflare blank-composer wall on
  // the happy path, while `health` (below) recycles EARLIER if the browser goes
  // bad. 0 disables the cap and relies on health alone. See
  // HEYGEN_MAX_RENDERS_PER_SESSION in lib/env.ts for the why.
  rendersServed: number;
  // Continuous health for this browser (Objective #4). Recycle when unhealthy.
  health: BrowserHealth;
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
  const health = newHealth();
  // Browser-disconnected event (Objective #4): a crashed/evicted browser must
  // be recycled on the next acquire, not re-driven. Mark health; the acquire
  // path reads isHealthy() and rebuilds.
  browser.on("disconnected", () => {
    markDisconnected(health);
    logSession("unhealthy", { accountId: account.id, reason: "browser_disconnected" });
  });
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
  logSession("created", { accountId: account.id });
  return {
    browser,
    context,
    accountId: account.id,
    verifiedAtMs: Date.now(),
    jobPage: null,
    rendersServed: 0,
    health,
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

  // Health-OR-cap recycle (Objectives #1, #4). Two complementary triggers:
  //
  //   1. HEALTH (primary, reactive): the browser went bad — a streak of failed
  //      renders, a blank composer (Cloudflare wall), a page crash, or the
  //      browser disconnected. Recycle immediately so we don't re-drive a known-
  //      broken session and burn another full attempt at it.
  //
  //   2. RENDER CAP (backstop, preemptive): a healthy headless session still
  //      gets Cloudflare-flagged after a number of renders and then walls every
  //      load. Recycling BEFORE that point keeps the happy path from ever hitting
  //      the wall. This is why the cap survives the move to health-based
  //      recycling — health reacts AFTER a wall; the cap avoids reaching it. 0
  //      disables the cap and relies on health alone.
  //
  // Either trigger tears the whole browser down and rebuilds a FRESH one from
  // stored cookies (fresh fingerprint, resetting the heuristic).
  const maxRenders = env().HEYGEN_MAX_RENDERS_PER_SESSION;
  if (current && current.accountId === account.id) {
    const unhealthy = !isHealthy(current.health);
    const capReached = maxRenders > 0 && current.rendersServed >= maxRenders;
    if (unhealthy || capReached) {
      logSession("recycled", {
        accountId: account.id,
        reason: unhealthy ? "unhealthy" : "render_cap",
        rendersServed: current.rendersServed,
        maxRenders,
        health: current.health,
      });
      await disposeCurrent();
    }
  }

  // Warm + same account + fresh enough => reuse with no /home hit.
  if (current && current.accountId === account.id) {
    const ageMs = Date.now() - current.verifiedAtMs;
    if (ageMs <= reverifyAfterMs()) {
      logSession("reused", {
        accountId: account.id,
        rendersServed: current.rendersServed,
        consecutiveFailures: current.health.consecutiveFailures,
      });
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
    // Page-level health listeners (Objective #4/#5): a JS pageerror or a hard
    // page crash both feed the browser's health so a degrading page is recycled
    // rather than re-driven. A crash is treated as a failure tick immediately.
    const sess = session;
    session.jobPage.on("pageerror", () => markPageError(sess.health));
    session.jobPage.on("crash", () => {
      markPageError(sess.health);
      markFailure(sess.health, "blank_composer");
      logSession("unhealthy", { accountId: sess.accountId, reason: "page_crash" });
    });
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
      logSession("composer_recovered", {
        accountId: session.accountId,
        note: "warm page had drifted off /avatar; re-navigated",
      });
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
 * Count one completed render against the warm session's render budget AND mark
 * the browser's health as a success (clears the failure streak). The caller
 * invokes this AFTER a successful generation: the count feeds the backstop cap
 * (recycle before the Cloudflare wall) and the health success keeps a
 * still-healthy browser warm for the next job. No-op if no session is held
 * (e.g. it was torn down on failure).
 */
export function recordRenderServed(): void {
  if (!current) return;
  current.rendersServed += 1;
  markSuccess(current.health);
  logSession("health_updated", {
    accountId: current.accountId,
    outcome: "success",
    rendersServed: current.rendersServed,
    health: current.health,
  });
}

/**
 * Record a FAILED render against the warm browser's health (Objective #4/#6).
 * `klass` is the classified failure (heygen-errors) — a blank_composer flips the
 * browser unhealthy at once (the Cloudflare wall is sticky on a flagged
 * session); other classes flip it after a short streak. This is a BROWSER-level
 * signal only; ACCOUNT disposition (cooldown/reauth/rotate) is decided
 * separately in generateAvatar(), keeping the two systems independent. The next
 * acquireWarmSession() recycles the browser if this made it unhealthy. No-op if
 * no session is held.
 */
export function recordRenderFailure(klass: string): void {
  if (!current) return;
  markFailure(current.health, klass);
  logSession("health_updated", {
    accountId: current.accountId,
    outcome: "failure",
    klass,
    healthy: isHealthy(current.health),
    health: current.health,
  });
  if (!isHealthy(current.health)) {
    logSession("unhealthy", {
      accountId: current.accountId,
      reason: "render_failure",
      klass,
      consecutiveFailures: current.health.consecutiveFailures,
    });
  }
}

/** The current warm browser's health snapshot, or null if none is held. */
export function currentHealth(): BrowserHealth | null {
  return current ? { ...current.health } : null;
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

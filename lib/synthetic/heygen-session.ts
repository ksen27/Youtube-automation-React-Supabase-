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

// Warm HeyGen session POOL — one warm browser per ACCOUNT.
//
// HISTORY: this was a single module-global `current` warm-browser SINGLETON,
// safe only at AVATAR_CONCURRENCY=1. Everything below implicitly acted on that
// one session.
//
// PARALLEL AVATARS: to render 3-4 accounts at once (each on its own proxy exit
// IP so the concurrent headless browsers don't look like one bot IP), the
// singleton becomes a POOL keyed by accountId. Each concurrent avatar job CLAIMS
// a distinct account (public.claim_heygen_account, FOR UPDATE SKIP LOCKED — see
// lib/synthetic/heygen-accounts.ts) and drives ONLY that account's warm browser,
// so two jobs never touch the same session.
//
// WHAT THE WARM BROWSER STILL FIXES (unchanged, now per-account): a job opens a
// cheap fresh PAGE on an already-warm context (no Cloudflare challenge), drives
// the composer, and closes only that page. The /home verify runs only on first
// use or after a long idle gap (HEYGEN_REVERIFY_AFTER_MINUTES), not every job —
// so a burst of renders on one account no longer triggers a challenge per job.
// Cookies are re-saved to the DB after each render (heygen.ts) for cold start.
//
// CONCURRENCY: one job touches one account's context at a time (guaranteed by
// the DB lease — a peer job can't claim the same account). We still serialize
// acquire() PER ACCOUNT with an in-flight promise so a re-entrant call for the
// same account can never launch two browsers. NEVER logs in (login is human-only
// via the connect CLI).

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

// The pool: one warm session per accountId. Replaces the old `current` singleton.
const sessions = new Map<string, WarmSession>();
// Serializes concurrent acquire() calls PER ACCOUNT so we never launch two
// browsers for the same account. (A DB lease already stops two jobs claiming the
// same account, but a keep-alive sweep or a re-entrant call must not race the
// launch either.)
const acquiring = new Map<string, Promise<WarmSession>>();

function reverifyAfterMs(): number {
  return env().HEYGEN_REVERIFY_AFTER_MINUTES * 60_000;
}

// Tear down ONE account's held browser/context (best-effort) and drop it from
// the pool.
async function disposeSession(accountId: string): Promise<void> {
  const s = sessions.get(accountId);
  if (!s) return;
  sessions.delete(accountId);
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
 * for THAT account when possible:
 *   - No session held for this account -> launch a fresh one and verify /home once.
 *   - Held and verified recently (within HEYGEN_REVERIFY_AFTER_MINUTES) -> return
 *     it WITHOUT touching /home (the hot path: back-to-back jobs on the same
 *     account skip the Cloudflare challenge entirely).
 *   - Held but stale -> re-verify /home once (a single challenge), refresh the
 *     timestamp, keep the SAME context warm. If expired, dispose and throw
 *     session_expired.
 *   - Held but UNHEALTHY or over the render cap -> recycle (dispose + relaunch).
 *
 * Each account owns its own pool slot; acquiring account B NEVER evicts account
 * A's warm browser (that eviction was the old singleton's rotation cost).
 *
 * Returns the live context. The caller opens its own page and MUST close that
 * page when done (NOT the context — that stays warm for the next job).
 */
export async function acquireWarmSession(account: DecryptedAccount): Promise<BrowserContext> {
  const id = account.id;
  // If a launch for THIS account is already in flight, wait it out first so we
  // don't double-launch.
  const pending = acquiring.get(id);
  if (pending) await pending.catch(() => {});

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
  //      the wall. 0 disables the cap and relies on health alone.
  //
  // Either trigger tears THIS account's browser down and rebuilds a FRESH one
  // from stored cookies (fresh fingerprint, resetting the heuristic).
  const maxRenders = env().HEYGEN_MAX_RENDERS_PER_SESSION;
  const held = sessions.get(id);
  if (held) {
    const unhealthy = !isHealthy(held.health);
    const capReached = maxRenders > 0 && held.rendersServed >= maxRenders;
    if (unhealthy || capReached) {
      logSession("recycled", {
        accountId: id,
        reason: unhealthy ? "unhealthy" : "render_cap",
        rendersServed: held.rendersServed,
        maxRenders,
        health: held.health,
      });
      await disposeSession(id);
    }
  }

  // Warm + fresh enough => reuse with no /home hit.
  const warm = sessions.get(id);
  if (warm) {
    const ageMs = Date.now() - warm.verifiedAtMs;
    if (ageMs <= reverifyAfterMs()) {
      logSession("reused", {
        accountId: id,
        rendersServed: warm.rendersServed,
        consecutiveFailures: warm.health.consecutiveFailures,
      });
      return warm.context;
    }
    // Stale: re-verify once on a throwaway page, refresh the stamp, keep warm.
    const probe = await warm.context.newPage();
    try {
      const verdict = await verifyAuthenticated(probe);
      if (verdict === "expired") {
        await probe.close().catch(() => {});
        await disposeSession(id);
        throw new HeygenError(
          "session_expired",
          `heygen: account ${account.email} session expired — reconnect with \`npm run heygen:connect ${account.email}\``,
        );
      }
      warm.verifiedAtMs = Date.now();
      return warm.context;
    } finally {
      await probe.close().catch(() => {});
    }
  }

  // Nothing held for this account => launch (serialized PER ACCOUNT so a
  // re-entrant call can't double-launch this account's browser).
  const launchPromise = launch(account);
  acquiring.set(id, launchPromise);
  try {
    const session = await launchPromise;
    sessions.set(id, session);
    return session.context;
  } finally {
    acquiring.delete(id);
  }
}

/**
 * The session for `accountId` hit a login wall mid-job. Drop THAT account's warm
 * slot so the NEXT acquire rebuilds from the (caller-refreshed) stored cookies
 * instead of reusing a context whose cookies HeyGen just invalidated. Other
 * accounts' warm browsers are untouched.
 */
export async function invalidateWarmSession(accountId: string): Promise<void> {
  await disposeSession(accountId);
}

/**
 * Get the WARM job page for one avatar job on `account`. Unlike a fresh page per
 * job (which reloads /avatar cold and made generation take minutes to start),
 * this REUSES a single page parked on /avatar so the SPA stays hydrated between
 * jobs:
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
  const session = sessions.get(account.id); // set by acquireWarmSession
  if (!session) {
    // Shouldn't happen (acquire throws or sets the slot), but be defensive.
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

/** Graceful teardown for worker shutdown — closes EVERY account's warm browser. */
export async function closeWarmSession(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => disposeSession(id)));
}

/** Test/diagnostic helper: is a warm session held for this account (or any)? */
export function hasWarmSession(accountId?: string): boolean {
  return accountId ? sessions.has(accountId) : sessions.size > 0;
}

/**
 * Count one completed render on `accountId` against its warm session's render
 * budget AND mark the browser's health as a success (clears the failure streak).
 * The caller invokes this AFTER a successful generation: the count feeds the
 * backstop cap (recycle before the Cloudflare wall) and the health success keeps
 * a still-healthy browser warm for the next job. No-op if no session is held for
 * the account (e.g. it was torn down on failure).
 */
export function recordRenderServed(accountId: string): void {
  const s = sessions.get(accountId);
  if (!s) return;
  s.rendersServed += 1;
  markSuccess(s.health);
  logSession("health_updated", {
    accountId,
    outcome: "success",
    rendersServed: s.rendersServed,
    health: s.health,
  });
}

/**
 * Record a FAILED render on `accountId` against its warm browser's health
 * (Objective #4/#6). `klass` is the classified failure (heygen-errors) — a
 * blank_composer flips the browser unhealthy at once (the Cloudflare wall is
 * sticky on a flagged session); other classes flip it after a short streak. This
 * is a BROWSER-level signal only; ACCOUNT disposition (cooldown/reauth/rotate) is
 * decided separately in generateAvatar(), keeping the two systems independent.
 * The next acquireWarmSession() recycles the browser if this made it unhealthy.
 * No-op if no session is held for the account.
 */
export function recordRenderFailure(accountId: string, klass: string): void {
  const s = sessions.get(accountId);
  if (!s) return;
  markFailure(s.health, klass);
  logSession("health_updated", {
    accountId,
    outcome: "failure",
    klass,
    healthy: isHealthy(s.health),
    health: s.health,
  });
  if (!isHealthy(s.health)) {
    logSession("unhealthy", {
      accountId,
      reason: "render_failure",
      klass,
      consecutiveFailures: s.health.consecutiveFailures,
    });
  }
}

/** A warm browser's health snapshot for `accountId`, or null if none is held. */
export function currentHealth(accountId: string): BrowserHealth | null {
  const s = sessions.get(accountId);
  return s ? { ...s.health } : null;
}

/**
 * The account ids that currently hold a live warm session. The keep-alive sweep
 * uses this (together with the DB lease set) to SKIP refreshing an account that
 * already has a live, in-use browser: opening a SECOND concurrent browser to
 * HeyGen for the same account is exactly the fingerprint churn we're avoiding.
 * Cookies are re-saved after every render anyway, so the sweep adds nothing.
 */
export function warmAccountIds(): string[] {
  return [...sessions.keys()];
}

// Count of avatar renders currently in flight PER ACCOUNT. The keep-alive sweep
// MUST NOT open a second concurrent HeyGen browser for an account while a render
// is running on it: two live sessions for the same account from the same IP is
// exactly the activity that trips Cloudflare into the blank-composer / page-wipe
// challenge. This map is the authoritative "a job is active on account X" signal,
// independent of whether that account's warm session object exists yet.
const activeRenders = new Map<string, number>();

/** Mark an avatar render as started on `accountId` — the sweep skips it while >0. */
export function beginRender(accountId: string): void {
  activeRenders.set(accountId, (activeRenders.get(accountId) ?? 0) + 1);
}

/** Mark an avatar render finished on `accountId` (success OR failure). >=0. */
export function endRender(accountId: string): void {
  const n = (activeRenders.get(accountId) ?? 0) - 1;
  if (n <= 0) activeRenders.delete(accountId);
  else activeRenders.set(accountId, n);
}

/** True while at least one avatar render is in flight on `accountId`. */
export function isRenderActive(accountId: string): boolean {
  return (activeRenders.get(accountId) ?? 0) > 0;
}

/** All account ids with at least one render in flight (for the sweep skip-set). */
export function activeAccountIds(): string[] {
  return [...activeRenders.keys()];
}

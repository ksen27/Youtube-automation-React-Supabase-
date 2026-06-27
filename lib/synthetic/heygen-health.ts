import type { Page } from "playwright";

// Per-browser HEALTH tracking for the warm HeyGen session (Objectives #1, #4, #5).
//
// WHY THIS EXISTS
// The warm browser was previously recycled on a blunt render COUNT
// (HEYGEN_MAX_RENDERS_PER_SESSION=2) — every 2 renders the whole browser was
// torn down and rebuilt, paying a fresh Cloudflare challenge + SPA hydration
// each time. That fixed churn is the bulk of the observed slowness.
//
// We replace "always recycle after N renders" with "recycle when the browser is
// UNHEALTHY". A browser stays warm and serves many jobs; it is only recycled
// when its health signals say it has gone bad (consecutive failures, a blank
// composer / Cloudflare wall, a page crash, or the browser disconnecting).
//
// IMPORTANT — this does NOT remove the preemptive cap entirely. Production
// showed a headless session gets Cloudflare-flagged after ~2 renders and then
// serves a blank composer on EVERY subsequent load (the SESSION is flagged, not
// just the page). Pure reactive health-recycling would therefore burn one full
// failed attempt at the wall before recycling. So the cap LIVES ON as a
// configurable BACKSTOP (HEYGEN_MAX_RENDERS_PER_SESSION, default raised), while
// health recycling catches a browser that goes bad EARLIER than the cap. The two
// are complementary: health = react fast to early failure; cap = never reach the
// wall on the happy path.

export interface BrowserHealth {
  healthy: boolean;
  /** ms epoch of the last successful render, or 0 if none yet. */
  lastSuccess: number;
  /** Consecutive failed renders since the last success. */
  consecutiveFailures: number;
  /** Page-level JS errors / crashes observed on the warm page since launch. */
  pageErrors: number;
  /** A blank /avatar composer (the Cloudflare-wall signature) was seen. */
  blankComposerDetected: boolean;
  /** The underlying browser emitted `disconnected`. */
  browserDisconnected: boolean;
  /** ms epoch of the last health update (heartbeat). */
  lastHeartbeat: number;
}

export function newHealth(): BrowserHealth {
  return {
    healthy: true,
    lastSuccess: 0,
    consecutiveFailures: 0,
    pageErrors: 0,
    blankComposerDetected: false,
    browserDisconnected: false,
    lastHeartbeat: Date.now(),
  };
}

// How many consecutive failed renders make a browser unhealthy. One transient
// UI failure shouldn't recycle the (expensive) browser; a run of them means the
// session itself is bad. Kept here rather than env so the health policy is one
// readable place — bump if needed.
export const MAX_CONSECUTIVE_FAILURES = 2;

/** Record a successful render: clears the failure streak, stamps the heartbeat. */
export function markSuccess(h: BrowserHealth): void {
  h.lastSuccess = Date.now();
  h.consecutiveFailures = 0;
  h.blankComposerDetected = false;
  h.lastHeartbeat = Date.now();
  // A browser that was only "unhealthy" via failure streak is healthy again once
  // it renders. A hard signal (disconnect) is sticky and handled in isHealthy().
  if (!h.browserDisconnected) h.healthy = true;
}

/**
 * Record a failed render. `klass` is the classified failure (see heygen-errors).
 * A blank composer is the Cloudflare-wall signature — one is enough to mark the
 * browser unhealthy, because the session is flagged and every further load on it
 * will wall too. Other classes only flip unhealthy once the streak crosses the
 * threshold (a single transient UI miss shouldn't waste the warm browser).
 */
export function markFailure(h: BrowserHealth, klass: string): void {
  h.consecutiveFailures += 1;
  h.lastHeartbeat = Date.now();
  if (klass === "blank_composer") h.blankComposerDetected = true;
  if (h.blankComposerDetected || h.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    h.healthy = false;
  }
}

/** The browser process dropped — terminal, always unhealthy. */
export function markDisconnected(h: BrowserHealth): void {
  h.browserDisconnected = true;
  h.healthy = false;
  h.lastHeartbeat = Date.now();
}

/** A page JS error / crash was observed. Counts toward diagnostics. */
export function markPageError(h: BrowserHealth): void {
  h.pageErrors += 1;
  h.lastHeartbeat = Date.now();
}

/** Authoritative "is this browser still usable" check. */
export function isHealthy(h: BrowserHealth): boolean {
  return h.healthy && !h.browserDisconnected;
}

// --- Fast-fail page inspection (Objective #5) ---
//
// Detect a clearly-broken page in SECONDS rather than letting the per-step
// setup/nav timeouts (tens of seconds to minutes) elapse. Returns a short
// reason string when the page is unmistakably broken, or null when it looks
// usable / can't be cheaply judged (caller proceeds with the normal waits).
//
// We only return a positive "broken" verdict on HIGH-CONFIDENCE signals, so a
// merely-slow-but-fine page is never false-failed: a Cloudflare challenge body,
// a crashed/closed page, or a genuinely empty composer root. Anything
// ambiguous returns null and defers to the existing element waits.

const CLOUDFLARE_TEXT =
  /(checking your browser|verify you are human|cloudflare|attention required|needs to review the security|ray id)/i;

export interface FastFailResult {
  broken: boolean;
  reason: string | null;
}

/**
 * Cheap, bounded inspection used to distinguish a genuinely WALLED page from a
 * merely SLOW one — call this ONLY after a short grace wait for the composer has
 * already lapsed (see heygen.ts). It must NOT be called immediately after a
 * `goto(...commit)`: a fresh page is momentarily blank before it paints, and
 * treating that as broken false-fails legitimate loads into a recycle loop.
 *
 * We only return broken=true on HIGH-CONFIDENCE signals — a closed/crashed page
 * or a Cloudflare challenge body — so a slow-but-fine SPA is never mistaken for
 * a wall (the caller then falls through to the full patient composer wait). The
 * old "empty body => broken" heuristic was REMOVED: it fired on still-hydrating
 * fresh pages. "Blank composer" is now proven by the grace wait lapsing AND a
 * positive wall signal here, not by body emptiness alone. Never throws.
 */
export async function inspectPage(page: Page): Promise<FastFailResult> {
  // Closed/crashed page — nothing to wait for.
  if (page.isClosed()) return { broken: true, reason: "page is closed/crashed" };

  // Read a small slice of the body text with a TIGHT timeout, looking ONLY for a
  // positive Cloudflare challenge signature. Anything else (slow paint, partial
  // hydration) is NOT treated as broken — defer to the caller's full wait.
  let bodyText = "";
  try {
    bodyText = (await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")) ?? "";
  } catch {
    return { broken: false, reason: null };
  }

  if (CLOUDFLARE_TEXT.test(bodyText)) {
    return { broken: true, reason: "cloudflare challenge page detected" };
  }

  return { broken: false, reason: null };
}

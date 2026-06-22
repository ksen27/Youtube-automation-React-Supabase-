import type { Page } from "playwright";

// Failure classification for HeyGen automation.
//
// The old code treated EVERY failure identically: cool the account down, bump
// its fail_count, rotate. A single HeyGen UI tweak (a renamed button, a moved
// panel) therefore cascaded — each job cooled down another account until the
// pool reported "no available accounts in pool", even though nothing was wrong
// with the accounts themselves.
//
// We now classify each failure and map it to a DISPOSITION that decides what
// happens to the account. The key insight (spec C/F): a session-expiry or a
// selector/UI failure must NOT cool the account down or count as a failure.

export type HeygenErrorClass =
  | "login_required"     // hit a login wall on the worker (should never happen now)
  | "session_expired"    // stored storageState no longer authenticates
  | "ui_changed"         // an expected element is simply gone — HeyGen changed its frontend
  | "blank_composer"     // /avatar came up BLANK — the warm page is wedged, not a moved selector
  | "selector_failure"   // an element wasn't found/clickable in time (likely UI change)
  | "rate_limit"         // throttled — back off and rotate
  | "credit_exhausted"   // quota/credit wall — this account can't produce more right now
  | "network"            // proxy/network/navigation error
  | "unknown";

// What to do with the CURRENT account when a failure of this class occurs.
//   reauth   — flag needs_reauth: out of rotation, NO cooldown, NO fail bump.
//   cooldown — rest the account for the cooldown window (soft, recoverable).
//   disable  — take it out of rotation until a human re-enables it.
//   rotate   — leave the account as-is; just try the next one (no penalty).
export type HeygenDisposition = "reauth" | "cooldown" | "disable" | "rotate";

export const DISPOSITION_BY_CLASS: Record<HeygenErrorClass, HeygenDisposition> = {
  login_required: "reauth",
  session_expired: "reauth",
  // A UI/selector failure is almost never the account's fault. Don't punish the
  // account — rotate to the next so a flaky render doesn't strand the pool, but
  // leave it eligible. (Repeated UI failures across the pool are visible in the
  // last_error_class column and the diagnostics, which is the real fix path.)
  ui_changed: "rotate",
  // A blank composer is NOT the account's fault (no cooldown/disable), so it
  // rotates like a UI failure — but the real recovery is the warm-session
  // teardown that attemptOnAccount() does for this class, which forces the next
  // attempt onto a FRESH page/context instead of re-driving the wedged one.
  blank_composer: "rotate",
  selector_failure: "rotate",
  rate_limit: "cooldown",
  credit_exhausted: "cooldown",
  network: "rotate",
  // An UNKNOWN failure is, by definition, not confirmed to be the account's
  // fault — cooling the account down on it strands small pools (one mystery
  // failure => "no available accounts"). Rotate with no penalty instead; the
  // last_error_class column + captured diagnostics are how we actually diagnose
  // it, not by punishing the account.
  unknown: "rotate",
};

export class HeygenError extends Error {
  readonly klass: HeygenErrorClass;
  readonly cause?: unknown;
  constructor(klass: HeygenErrorClass, message: string, cause?: unknown) {
    super(message);
    this.name = "HeygenError";
    this.klass = klass;
    this.cause = cause;
  }
  get disposition(): HeygenDisposition {
    return DISPOSITION_BY_CLASS[this.klass];
  }
}

export function isHeygenError(e: unknown): e is HeygenError {
  return e instanceof HeygenError;
}

export function classOf(e: unknown): HeygenErrorClass {
  return isHeygenError(e) ? e.klass : "unknown";
}

export function dispositionOf(e: unknown): HeygenDisposition {
  return isHeygenError(e) ? e.disposition : DISPOSITION_BY_CLASS.unknown;
}

/**
 * Translate an avatar failure into a message safe to show a NON-TECHNICAL end
 * user. The raw error (selectors, `npm run …`, stack-ish text) belongs in logs,
 * never in the UI — a shared-account user can't act on "re-auth with the CLI".
 * These messages tell the user what's happening in plain language; the admin
 * sees the real cause in the worker logs + the heygen_accounts.last_error column.
 */
export function userFacingMessage(e: unknown): string {
  const klass = classOf(e);
  switch (klass) {
    case "session_expired":
    case "login_required":
      // The "no available accounts" / expired-session case the user hit.
      return "Avatar generation is temporarily unavailable. The administrator has been notified — please try again shortly.";
    case "credit_exhausted":
      return "Avatar generation is temporarily at capacity. Please try again later.";
    case "rate_limit":
      return "Too many avatar requests right now. Please wait a moment and try again.";
    case "ui_changed":
    case "blank_composer":
    case "selector_failure":
    case "network":
    case "unknown":
    default:
      return "Avatar generation failed. Please try again — if it keeps happening, contact the administrator.";
  }
}

// Heuristic text/URL signatures. Kept here (not in selectors) because these are
// for READING failure state, not driving the happy path.
const LOGIN_URL = /\/(login|signin|sign-in|auth)\b/i;
const QUOTA_TEXT = /(out of credits|no credits|credit limit|upgrade your plan|reached your limit|quota|exceeded)/i;
const RATE_TEXT = /(too many requests|rate limit|slow down|try again later)/i;

/**
 * Inspect the live page after a failure and produce a best-effort
 * classification. Pass the original error so non-page signals (selector
 * timeouts, navigation errors) still classify when the page is unusable.
 *
 * Order matters: an expired session presents AS a login wall, so the URL/login
 * check wins over generic selector-timeout text.
 */
export async function classifyHeygenFailure(
  page: Page | null,
  err: unknown,
): Promise<HeygenErrorClass> {
  if (isHeygenError(err)) return err.klass;

  const errMsg = err instanceof Error ? err.message : String(err ?? "");

  // Page-derived signals first (most authoritative).
  if (page) {
    let url = "";
    let body = "";
    try {
      url = page.url();
    } catch {
      /* page may be closed */
    }
    if (LOGIN_URL.test(url)) return "session_expired";
    try {
      // Cheap visibility check for a sign-in affordance => session is gone.
      const signIn = page.getByRole("button", { name: /log ?in|sign ?in/i });
      if (await signIn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        return "session_expired";
      }
    } catch {
      /* ignore */
    }
    try {
      body = (await page.locator("body").innerText({ timeout: 2000 }).catch(() => "")) ?? "";
    } catch {
      /* ignore */
    }
    if (QUOTA_TEXT.test(body)) return "credit_exhausted";
    if (RATE_TEXT.test(body)) return "rate_limit";
  }

  // Error-message signals.
  if (QUOTA_TEXT.test(errMsg)) return "credit_exhausted";
  if (RATE_TEXT.test(errMsg)) return "rate_limit";
  if (/timeout|waiting for selector|no on-screen|not found|not visible|locator/i.test(errMsg)) {
    return "selector_failure";
  }
  if (/net::|proxy|ERR_|navigat|ECONN|ETIMEDOUT|socket/i.test(errMsg)) {
    return "network";
  }
  return "unknown";
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { getEnv } from "@/lib/env";
import { uploadBuffer } from "@/lib/storage";
import {
  resolveProxy,
  parseProxy,
  type DecryptedAccount,
} from "@/lib/synthetic/heygen-accounts";
import { HeygenError } from "@/lib/synthetic/heygen-errors";
import { authedMarker, signInMarker, isVisible } from "@/lib/synthetic/heygen-selectors";

// HeyGen authentication manager.
//
// Spec A/B/C: workers NEVER log in. A human connects each account once (headed,
// via scripts/heygen-connect.ts), the encrypted Playwright storageState lives in
// the DB, and the worker only RESTORES that session and VERIFIES it. If the
// session has expired the worker flags the account needs_reauth (handled by the
// caller) — it does not attempt an interactive login and does not cool the
// account down.
//
// This module owns: launching a context from stored storageState (B), verifying
// authenticated state / detecting expiry (C), capturing diagnostics on failure
// (E), and the headed connect flow used only by the CLI (A).

function env() {
  return getEnv();
}

// True when we should run the browser visibly (debugging). In debug mode we
// also apply slowMo. Never true on a headless worker host unless explicitly set.
function debugEnabled(): boolean {
  return env().HEYGEN_DEBUG;
}

// Launch a browser for an account, restoring its stored session + proxy.
// `headedOverride` forces a visible browser regardless of env (the connect
// script passes true). Caller owns closing the returned browser.
export async function openAuthedContext(
  account: DecryptedAccount,
  opts: { withStorageState?: boolean; headedOverride?: boolean; noProxy?: boolean } = {},
): Promise<{ browser: Browser; context: BrowserContext }> {
  const e = env();
  // The one-time manual connect runs from a human's own machine/IP — routing it
  // through the residential proxy pool only invites a 407 (proxy auth) wall and
  // is pointless when a person is logging in by hand. `noProxy` skips it; the
  // worker path still proxies normally.
  const proxyRaw = opts.noProxy ? null : resolveProxy(account);
  const headed = opts.headedOverride || debugEnabled();
  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? e.HEYGEN_SLOWMO_MS : undefined,
    proxy: proxyRaw ? parseProxy(proxyRaw) : undefined,
    // Anti-automation hardening: drop the flags Cloudflare's bot detection keys
    // on. --disable-blink-features=AutomationControlled removes the most obvious
    // navigator.webdriver/automation tell.
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const withState = opts.withStorageState ?? true;
  const context = await browser.newContext({
    // Spec B: reuse the authenticated session — no login steps.
    storageState:
      withState && account.cookies
        ? (account.cookies as Awaited<ReturnType<BrowserContext["storageState"]>>)
        : undefined,
    viewport: { width: 1366, height: 900 },
    // Look like a normal desktop Chrome rather than headless: a real UA, a
    // locale/timezone, and a device scale. These reduce the headless fingerprint
    // Cloudflare scores against.
    userAgent: e.HEYGEN_USER_AGENT,
    locale: "en-US",
    timezoneId: "America/New_York",
    deviceScaleFactor: 1,
  });
  // Mask the residual automation tells before any page script runs.
  await context.addInitScript(() => {
    // navigator.webdriver -> undefined
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // A plausible plugins/languages surface (headless reports empty).
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  context.setDefaultTimeout(e.HEYGEN_NAV_TIMEOUT_MS);
  return { browser, context };
}

export type AuthVerdict = "authed" | "expired";

/**
 * Spec B/C: open HeyGen directly and verify the restored session is still
 * authenticated. Returns "authed" or "expired"; NEVER attempts a login.
 *
 * Expiry is detected by ANY of: redirected to a login URL, a sign-in button
 * visible, or the dashboard nav never appearing. Conversely we only declare
 * "authed" when a positive workspace marker is present — a blank/error page is
 * treated as expired (safer: it routes to re-auth, not to a doomed render).
 */
export async function verifyAuthenticated(page: Page): Promise<AuthVerdict> {
  const e = env();
  // HeyGen is a heavy SPA whose load lifecycle never settles, so navigate with
  // `commit` and then probe concrete elements.
  await page.goto(`${e.HEYGEN_BASE_URL}/home`, { waitUntil: "commit" }).catch(() => {});

  // Give the SPA a bounded chance to render either outcome. Verified 2026-06-19:
  // through the residential proxy the authed nav reliably renders, but only at
  // ~14.5s — right at the edge of the old hardcoded 15s budget, so any extra
  // latency tipped a VALID session into a FALSE "expired" (which then flagged
  // the account needs_reauth and stranded the pool). We give the marker a much
  // more generous budget (env-driven, default 45s) so a slow-but-authenticated
  // workspace is never mistaken for an expired session.
  const markerTimeout = e.HEYGEN_AUTH_MARKER_TIMEOUT_MS;
  const authedFirst = authedMarker(page).locator("visible=true").first();
  const signInFirst = signInMarker(page).locator("visible=true").first();
  await Promise.race([
    authedFirst.waitFor({ state: "visible", timeout: markerTimeout }).catch(() => {}),
    signInFirst.waitFor({ state: "visible", timeout: markerTimeout }).catch(() => {}),
  ]);

  // Authority order, strongest first:
  //   1. On a real auth URL (auth.heygen.com / a *.../login|signin path) => the
  //      session is gone. (Note: app.heygen.com/home is NOT a login URL.)
  let host = "";
  let url = "";
  try {
    url = page.url();
    host = new URL(url).host;
  } catch {
    /* page may be closed */
  }
  if (/auth\.heygen\.com/i.test(host) || /\/(login|signin|sign-in)\b/i.test(url)) {
    return "expired";
  }

  //   2. A positive workspace marker is visible => authed. We check this BEFORE
  //      the sign-in heuristic: a logged-in dashboard can still contain stray
  //      "sign in"-ish nodes (menus, tooltips, hidden auth widgets), and the
  //      false "expired" they caused is exactly what stranded the pool. The
  //      authed marker is the trustworthy positive signal.
  if (await isVisible(authedMarker(page), 3000)) return "authed";

  //   3. No workspace marker AND a sign-in affordance => expired.
  if (await isVisible(signInMarker(page), 1500)) return "expired";

  //   4. Still nothing conclusive. Before defaulting to expired (which strands
  //      the account on needs_reauth), give the authed marker ONE more bounded
  //      chance — the SPA may still be hydrating behind a slow proxy. Only after
  //      this do we treat it as expired.
  if (
    await authedFirst
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    return "authed";
  }

  // 5. Genuinely inconclusive — treat as expired (safer than a doomed render).
  return "expired";
}

/**
 * Spec E: capture diagnostics for a failed automation run — page URL, title, a
 * full-page screenshot, and an HTML snapshot. Written locally to HEYGEN_LOG_DIR
 * and best-effort uploaded to R2. Never throws (diagnostics must not mask the
 * original failure).
 */
export async function captureDiagnostics(
  page: Page | null,
  jobId: string,
  label = "error",
): Promise<{ url?: string; title?: string; dir: string }> {
  const e = env();
  const dir = e.HEYGEN_LOG_DIR;
  const out: { url?: string; title?: string; dir: string } = { dir };
  if (!page) return out;
  try {
    await fs.mkdir(dir, { recursive: true });
    const base = `${jobId}_${label}`;

    try {
      out.url = page.url();
      out.title = await page.title().catch(() => undefined);
    } catch {
      /* page may be closed */
    }

    // Screenshot (spec E example).
    const pngPath = path.join(dir, `${base}.png`);
    await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});

    // HTML snapshot.
    const htmlPath = path.join(dir, `${base}.html`);
    const html = await page.content().catch(() => "");
    if (html) await fs.writeFile(htmlPath, html, "utf8").catch(() => {});

    // url/title metadata.
    const metaPath = path.join(dir, `${base}.json`);
    await fs
      .writeFile(metaPath, JSON.stringify({ url: out.url, title: out.title, label }, null, 2), "utf8")
      .catch(() => {});

    // Best-effort R2 upload for remote audit.
    try {
      const pngBuf = await fs.readFile(pngPath).catch(() => null);
      if (pngBuf) await uploadBuffer(pngBuf, `heygen-diagnostics/${base}.png`, "image/png");
      if (html) {
        await uploadBuffer(Buffer.from(html, "utf8"), `heygen-diagnostics/${base}.html`, "text/html");
      }
    } catch {
      /* R2 optional */
    }
  } catch {
    /* diagnostics are best-effort */
  }
  return out;
}

/**
 * Spec A/G: headed, human-driven login used ONLY by the connect CLI. Opens a
 * visible browser, navigates to the login page, and waits for the human to
 * complete the login (including any captcha / email-code / SSO) until the
 * authenticated workspace appears, then persists the storageState.
 *
 * It does NOT type credentials by default — the most resilient connect flow is
 * to let the human drive the (frequently-changing) login UI by hand. We only
 * detect SUCCESS, which uses the same stable authed marker the worker uses.
 */
export async function interactiveConnect(
  account: DecryptedAccount,
  opts: { maxWaitMs?: number; onProgress?: (msg: string) => void } = {},
): Promise<unknown> {
  const e = env();
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60_000;
  const log = opts.onProgress ?? (() => {});

  const { browser, context } = await openAuthedContext(account, {
    withStorageState: false, // fresh login — ignore any stale stored session
    headedOverride: true,
    // By default connect from the human's own IP (no proxy — avoids 407). Set
    // HEYGEN_CONNECT_USES_PROXY=true (with a WORKING proxy) to connect through
    // the SAME exit IP the worker uses, so HeyGen doesn't see the session's IP
    // jump between login and use — a strong anti-flagging measure.
    noProxy: !e.HEYGEN_CONNECT_USES_PROXY,
  });
  try {
    const page = await context.newPage();
    // Navigate to the login route. HeyGen redirects app.heygen.com/login ->
    // auth.heygen.com on its own; if it doesn't (e.g. the redirect is flaky),
    // fall back to the auth host directly so the human always sees the form.
    await page.goto(`${e.HEYGEN_BASE_URL}/login`, { waitUntil: "commit" }).catch(() => {});
    const onAuth = /auth\.heygen\.com|\/login|\/signin|\/sign-in/i.test(page.url());
    if (!onAuth) {
      await page.goto("https://auth.heygen.com/login", { waitUntil: "commit" }).catch(() => {});
    }
    log(`A browser window opened. Log in to HeyGen as ${account.email} by hand.`);
    log("Complete any captcha / email-code / SSO. Waiting for the workspace to load…");

    // Wait until the authenticated workspace marker appears (any login path).
    await authedMarker(page)
      .locator("visible=true")
      .first()
      .waitFor({ state: "visible", timeout: maxWaitMs })
      .catch(() => {
        throw new HeygenError(
          "login_required",
          `connect: login not completed within ${Math.round(maxWaitMs / 1000)}s`,
        );
      });

    log("Authenticated. Capturing session…");
    // Return the state; the caller persists it (saveConnectedSession) so this
    // function stays a pure "drive the headed login" step.
    return await context.storageState();
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

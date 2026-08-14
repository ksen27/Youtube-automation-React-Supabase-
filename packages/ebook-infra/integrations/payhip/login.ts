import { openPayhipContext, isLoginUrl, loginUrl, type PayhipBrowserConfig } from './PayhipBrowser';
import type { PayhipSessionStore } from './PayhipSessionStore';

/**
 * The one-time, human-driven Payhip login.
 *
 * Opens a VISIBLE browser, waits for a person to log in by hand — including any
 * captcha, email code or 2FA — and captures the resulting Playwright
 * storageState for the store to encrypt and persist. Every headless run then
 * reuses that session.
 *
 * It deliberately does NOT type credentials, even though it could. Payhip's
 * login page changes, adds challenges, and occasionally asks for a code from an
 * inbox this process cannot read; a human driving it by hand is the only version
 * of this that keeps working. What we automate is detecting SUCCESS, which uses
 * the same signal the worker uses to decide a session is alive.
 *
 * Invoked by `npm run payhip:connect` (scripts/payhip-connect.ts).
 */
export async function interactivePayhipLogin(
  sessions: PayhipSessionStore,
  config: PayhipBrowserConfig,
  opts: { maxWaitMs?: number; onProgress?: (message: string) => void } = {},
): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  const log = opts.onProgress ?? (() => {});

  // No stored state: this is a FRESH login, and restoring a stale session would
  // land the human on a half-authenticated dashboard that then expires again.
  const { browser, context } = await openPayhipContext({ ...config, headed: true }, null);
  try {
    const page = await context.newPage();
    const target = loginUrl(config.baseUrl);
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});
    log(`A browser window opened at ${target} — log in by hand.`);
    log('Complete any captcha, 2FA or email code. Waiting for the dashboard to appear…');

    // Success = off the login page AND showing a real dashboard control. The
    // URL alone is not enough: Payhip bounces through intermediate redirects,
    // and a snapshot taken mid-bounce is a session that expires immediately.
    const addProduct = page
      .getByRole('link', { name: /add new product|new product|add product/i })
      .or(page.getByRole('button', { name: /add new product|new product|add product/i }))
      .first();

    const deadline = Date.now() + maxWaitMs;
    let authenticated = false;
    while (Date.now() < deadline) {
      const visible = await addProduct
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (visible && !isLoginUrl(page.url())) {
        authenticated = true;
        break;
      }
      // Nudge to the dashboard once the human is clearly past the login form,
      // since some flows land on a marketing page rather than the app.
      if (!isLoginUrl(page.url()) && !page.url().includes('/dashboard')) {
        await page.goto(`${config.baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }

    if (!authenticated) {
      throw new Error(
        `Login was not completed within ${Math.round(maxWaitMs / 60_000)} minutes — nothing was saved.`,
      );
    }

    log('Authenticated. Capturing the session…');
    await sessions.saveConnected(await context.storageState());
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

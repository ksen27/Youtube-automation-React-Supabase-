import { openPayhipContext, isLoginUrl, type PayhipBrowserConfig } from './PayhipBrowser';
import { LOGGED_IN_MARKER } from './PayhipProductPage';
import type { PayhipSessionStore } from './PayhipSessionStore';

/**
 * Keep the stored Payhip session warm, without listing anything.
 *
 * WHY THIS EXISTS: Payhip's session is a sliding window — it lapses from
 * DISUSE, not from age. Books are listed in bursts, so the session sat
 * untouched for days between them and was routinely dead by the time someone
 * pressed the button. The only cure was a human re-running `payhip:connect`,
 * which is a CLI, on a machine with a display, and every ordinary user of this
 * app has neither.
 *
 * The HeyGen pool solved the identical problem the identical way (see
 * sweepKeepAlive in lib/synthetic/heygen-auth.ts): a periodic visit that
 * restores the session, confirms it still works, and re-saves the now-fresher
 * cookies. That is the whole reason HeyGen rarely asks for a re-connect while
 * Payhip constantly did — not some difference in how the two log in. Neither
 * ever types a password.
 *
 * It NEVER logs in. An expired session is reported and flagged for re-auth, not
 * repaired: repairing it needs a human, and pretending otherwise would mean
 * keeping the seller's store password on a worker.
 */

export type PayhipSessionVerdict = 'alive' | 'expired' | 'error';

export async function keepPayhipSessionAlive(
  sessions: PayhipSessionStore,
  config: PayhipBrowserConfig,
  log: (message: string, meta?: Record<string, unknown>) => void = () => {},
): Promise<PayhipSessionVerdict> {
  const session = await sessions.load().catch(() => null);
  // Nothing stored, or already flagged — either way there is nothing to keep
  // warm, and re-checking a session the operator has been asked to replace
  // would only add pointless traffic to a Cloudflare-protected site.
  if (!session?.storageState || session.needsReauth) return 'expired';

  let browser: Awaited<ReturnType<typeof openPayhipContext>>['browser'] | null = null;
  let context: Awaited<ReturnType<typeof openPayhipContext>>['context'] | null = null;
  try {
    ({ browser, context } = await openPayhipContext(config, session.storageState));
    const page = await context.newPage();
    await page.goto(`${config.baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' }).catch(() => {});

    const authed = await page
      .locator(LOGGED_IN_MARKER)
      .first()
      .waitFor({ state: 'visible', timeout: config.timeoutMs })
      .then(() => true)
      .catch(() => false);

    if (authed) {
      // Re-save so Payhip's sliding window restarts from now. This is the
      // entire point of the sweep.
      await sessions.refresh(await context.storageState()).catch(() => {});
      return 'alive';
    }

    // ONLY a confirmed login redirect counts as expired. A Cloudflare challenge
    // or a slow render also fails the marker check, and flagging on those would
    // send the operator to re-connect a session that was never broken — the
    // most annoying possible false alarm, since re-connecting is the one step
    // that needs a human at a keyboard.
    if (isLoginUrl(page.url())) {
      await sessions.markNeedsReauth('keep-alive: the dashboard redirected to the login page').catch(() => {});
      return 'expired';
    }
    log('payhip.keepalive.inconclusive', { url: page.url() });
    return 'error';
  } catch (err) {
    // Never throws: a keep-alive must not be able to crash the worker loop.
    log('payhip.keepalive.error', { err: (err as Error).message?.slice(0, 200) });
    return 'error';
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

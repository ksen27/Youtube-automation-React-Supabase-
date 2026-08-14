import { describe, it, expect } from 'vitest';
import { extractProductKey } from './PayhipProductPage';
import { isLoginUrl, openPayhipContext } from './PayhipBrowser';

/**
 * The only test that touches a real browser and a real Payhip account.
 *
 * SKIPPED unless PAYHIP_E2E=1. It launches Chromium, restores the connected
 * session and drives the actual dashboard, so it needs a machine with the
 * Playwright browsers installed and a session already connected via
 * `npm run payhip:connect`. In CI it does not run.
 *
 *   PAYHIP_E2E=1 npx vitest run packages/ebook-infra/integrations/payhip
 *
 * WHY IT EXISTS: the unit tests mock the browser, so they assert flow order and
 * error mapping but can prove NOTHING about whether a selector still matches
 * Payhip's markup. Payhip ships UI changes without notice, and the first
 * symptom is a seller pressing a button that times out. This test is the thing
 * that catches a renamed button before they do — run it after any Payhip
 * redesign, and when the automation starts failing for no apparent reason.
 *
 * It deliberately stops SHORT of publishing a product: creating a real listing
 * on the seller's live storefront as a side effect of running the test suite
 * would be worse than the bug it is looking for. It verifies the session is
 * alive and the product form opens with the fields the page object expects,
 * which is where breakages actually happen. The publish + read-link steps are
 * covered by the mocked tests and, ultimately, by real use.
 */

const E2E = process.env.PAYHIP_E2E === '1';
const describeE2E = E2E ? describe : describe.skip;

// Real browser work over a live network; the default 5s is not close to enough.
const E2E_TIMEOUT_MS = 120_000;

describe('parsing a Payhip product link', () => {
  // Pure string work, so this one always runs — it needs no account and it is
  // the piece that decides what gets written into a live page's buy button.
  it('pulls the product key out of a buy link', () => {
    expect(extractProductKey('https://payhip.com/b/AbC12')).toBe('AbC12');
    expect(extractProductKey('payhip.com/b/x_9-Q')).toBe('x_9-Q');
  });

  it('returns null for anything that is not a product link', () => {
    expect(extractProductKey('https://payhip.com/dashboard')).toBeNull();
    expect(extractProductKey('https://gumroad.com/l/thing')).toBeNull();
  });

  it('does not mistake a product slug containing "login" for a login page', () => {
    // The check that decides whether to flag a working session dead, so a false
    // positive here strands the seller on a re-connect they did not need.
    expect(isLoginUrl('https://payhip.com/b/login-course')).toBe(false);
    expect(isLoginUrl('https://payhip.com/login')).toBe(true);
  });
});

describeE2E('the live Payhip dashboard (PAYHIP_E2E=1)', () => {
  it(
    'opens the product form with the fields the page object expects',
    async () => {
      const { PayhipSessionStore } = await import('./PayhipSessionStore');
      const { SupabaseClientFactory } = await import('../../persistence/supabase/SupabaseClientFactory');
      const { PayhipProductPage } = await import('./PayhipProductPage');

      const supabase = SupabaseClientFactory.serviceRole(
        process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
        process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      );
      const sessions = new PayhipSessionStore(supabase);
      const session = await sessions.load();
      if (!session?.storageState) {
        throw new Error('No Payhip session stored. Run `npm run payhip:connect` before this test.');
      }

      const baseUrl = process.env.PAYHIP_BASE_URL ?? 'https://payhip.com';
      const { browser, context } = await openPayhipContext(
        { baseUrl, timeoutMs: 45_000, debugDir: process.env.PAYHIP_DEBUG_DIR ?? '/tmp/payhip-debug' },
        session.storageState,
      );
      try {
        const page = await context.newPage();
        const dashboard = new PayhipProductPage(page, baseUrl);

        // Both of these throw with a precise message when Payhip has moved
        // something, which is the entire value of this test.
        await dashboard.openDashboard();
        await dashboard.startDigitalProduct();

        // Nothing is published: the form is open and correct, and that is where
        // the run stops. See the note at the top of the file.
        expect(page.url()).not.toMatch(/\/login/);
      } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      }
    },
    E2E_TIMEOUT_MS,
  );
});

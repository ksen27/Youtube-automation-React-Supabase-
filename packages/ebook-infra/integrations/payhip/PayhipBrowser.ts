import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  chromium as playwrightChromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import type { PayhipError, PayhipDebugArtifacts } from './PayhipErrors';
import type { PayhipStorageState } from './PayhipSessionStore';

/**
 * The browser layer for the Payhip automation: launching, session restore,
 * login detection and failure diagnostics.
 *
 * Kept separate from the page object (which knows the dashboard's shape) and
 * from the publisher (which knows the retry policy), so a Payhip redesign
 * touches one file and a policy change touches another.
 *
 * Modelled directly on lib/synthetic/heygen-auth.ts, which solves the same
 * problem for HeyGen. Not shared with it on purpose: that module is bound to
 * the HeyGen account pool, its proxy rotation and its cooldown rules, none of
 * which apply to a single self-owned store account.
 */

export interface PayhipBrowserConfig {
  baseUrl: string;
  /** Per-action timeout. Uploads get their own, longer budget in the page object. */
  timeoutMs: number;
  /** Where screenshots + HTML snapshots of failed runs are written. */
  debugDir: string;
  /** Run visibly. Only ever true for the connect CLI, or when debugging. */
  headed?: boolean | undefined;
  slowMoMs?: number | undefined;
}

/**
 * URLs that mean "you are not logged in".
 *
 * Matched as a whole-path check rather than a substring of the whole URL: a
 * product page whose slug happens to contain "login" is not a login page, and
 * treating it as one would flag a perfectly good session for re-auth.
 */
export function isLoginUrl(rawUrl: string): boolean {
  try {
    const { pathname } = new URL(rawUrl);
    return /^\/(login|signin|sign-in|register|signup)\b/i.test(pathname);
  } catch {
    return false;
  }
}

/** Launch a browser and restore the stored session into a fresh context. */
export async function openPayhipContext(
  config: PayhipBrowserConfig,
  storageState: PayhipStorageState | null,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await playwrightChromium.launch({
    headless: !config.headed,
    ...(config.headed && config.slowMoMs ? { slowMo: config.slowMoMs } : {}),
    // The container essentials. No --disable-blink-features=AutomationControlled
    // here: on a self-owned store account there is nothing to hide from, and
    // that flag is itself a signal some detectors look for.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    // The blob round-trips through the DB as opaque JSON, so it is cast back to
    // the shape Playwright wrote — the same cast lib/synthetic/heygen-auth.ts makes.
    ...(storageState
      ? { storageState: storageState as unknown as Awaited<ReturnType<BrowserContext['storageState']>> }
      : {}),
    viewport: { width: 1440, height: 960 },
    locale: 'en-US',
  });
  context.setDefaultTimeout(config.timeoutMs);
  return { browser, context };
}

/**
 * Capture what the page looked like when it failed: a full-page screenshot and
 * an HTML snapshot, written to the debug dir under a run-unique base name.
 *
 * Never throws. Diagnostics that fail must not replace the failure they were
 * trying to explain — that turns a readable "upload timed out" into an
 * unrelated ENOENT and loses the actual bug.
 */
export async function captureDiagnostics(
  page: Page | null,
  debugDir: string,
  label: string,
): Promise<PayhipDebugArtifacts> {
  const out: PayhipDebugArtifacts = {};
  if (!page) return out;
  try {
    await fs.mkdir(debugDir, { recursive: true });
    try {
      out.url = page.url();
    } catch {
      /* page may already be closed */
    }
    const base = path.join(debugDir, label);

    const screenshotPath = `${base}.png`;
    const shot = await page
      .screenshot({ path: screenshotPath, fullPage: true })
      .then(() => true)
      .catch(() => false);
    if (shot) out.screenshotPath = screenshotPath;

    const html = await page.content().catch(() => '');
    if (html) {
      const htmlPath = `${base}.html`;
      const written = await fs
        .writeFile(htmlPath, html, 'utf8')
        .then(() => true)
        .catch(() => false);
      if (written) out.htmlPath = htmlPath;
    }
  } catch {
    /* best-effort by design */
  }
  return out;
}

/** Attach diagnostics to an error on its way up, so the operator gets the paths. */
export async function withDiagnostics<E extends PayhipError>(
  error: E,
  page: Page | null,
  debugDir: string,
  label: string,
): Promise<E> {
  error.debug = await captureDiagnostics(page, debugDir, label);
  return error;
}

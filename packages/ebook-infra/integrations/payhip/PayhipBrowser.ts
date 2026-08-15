import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
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
  /**
   * Use patchright — a stealth-patched Chromium — instead of vanilla Playwright.
   *
   * Payhip sits behind Cloudflare, which serves a "Just a moment... performing
   * security verification" interstitial to browsers it thinks are bots. A
   * headless Playwright Chromium announces itself in a dozen small ways, and on
   * a datacenter IP that is enough to be challenged every time. patchright
   * removes those tells at the engine level and exposes the SAME API, so
   * nothing else in this module changes.
   *
   * The HeyGen automation reached the same conclusion (HEYGEN_USE_STEALTH); the
   * Docker image already installs patchright's browser for it.
   */
  stealth?: boolean | undefined;
  /**
   * Residential proxy for the browser — one `ip:port[:user:pass]` per line, or
   * comma-separated. Only the FIRST is used; see `pickProxy` for why a stable
   * exit beats rotation for a logged-in session.
   *
   * Fingerprint is only half of what Cloudflare scores — IP reputation is the
   * other half, and datacenter ranges like Fly's are challenged on sight
   * however clean the browser looks. A residential exit is what actually moves
   * that needle.
   *
   * Ideally the SAME exit the session was created through: a session whose IP
   * jumps between login and use is itself a signal worth flagging.
   */
  proxy?: string | undefined;
  /**
   * Pin the browser's user agent, so the session is created and used by what
   * looks like the SAME browser.
   *
   * The connect runs on an operator's laptop — Windows, headed — and the worker
   * runs on Fly — Linux, headless. Left alone, those report two different user
   * agents and two different platforms, and a session created by one is being
   * presented by something that looks like another machine entirely. Sites
   * routinely tie a session to that fingerprint, and reject the mismatch with a
   * plain redirect to the login page: identical, from the outside, to the
   * session simply having expired.
   *
   * Unset changes nothing. Set the SAME value for the connect CLI and the
   * worker — a desktop Linux Chrome string is the honest choice, since that is
   * what the worker actually is and it is the side that cannot be changed.
   */
  userAgent?: string | undefined;
  /** Per-action timeout. Uploads get their own, longer budget in the page object. */
  timeoutMs: number;
  /** Where screenshots + HTML snapshots of failed runs are written. */
  debugDir: string;
  /** Run visibly. Only ever true for the connect CLI, or when debugging. */
  headed?: boolean | undefined;
  slowMoMs?: number | undefined;
}

/**
 * Payhip's real login path.
 *
 * It is `/auth/login`, NOT `/login` — the latter 404s. Written down here as a
 * constant because two separate things depend on getting it right: the connect
 * command sends a human to it, and the expiry check has to RECOGNISE it.
 *
 * The `redirect` parameter is what Payhip's own login links carry, and it means
 * a successful login lands on the dashboard rather than a marketing page — which
 * is also the page the connect flow watches for.
 */
export function loginUrl(baseUrl: string): string {
  const redirect = encodeURIComponent(`${baseUrl}/dashboard`);
  return `${baseUrl}/auth/login?redirect=${redirect}`;
}

/**
 * URLs that mean "you are not logged in".
 *
 * Matched as a whole-path check rather than a substring of the whole URL: a
 * product page whose slug happens to contain "login" is not a login page, and
 * treating it as one would flag a perfectly good session for re-auth.
 *
 * The `auth/` prefix is optional because Payhip serves the form at
 * `/auth/login` while older links and redirects still use bare `/login`. Missing
 * the real one is the expensive direction: an expired session would then fall
 * through to a navigation timeout, and the operator would be told the dashboard
 * was slow instead of that they need to log in again.
 */
export function isLoginUrl(rawUrl: string): boolean {
  try {
    const { pathname } = new URL(rawUrl);
    return /^\/(auth\/)?(login|signin|sign-in|register|signup)\b/i.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Load Playwright — lazily, and only when a browser is actually about to run.
 *
 * MUST STAY A DYNAMIC IMPORT. Every type import in this module is erased at
 * compile time, so this function is the single point where the package is
 * really pulled in. A top-level `import { chromium } from 'playwright'` here
 * reaches the web app through a chain nobody would think to look at:
 *
 *   route handler → container() → @ebook/infra → PayhipProductPublisher
 *                 → PayhipBrowser → playwright
 *
 * That builds fine and works in dev, where node_modules is right there, then
 * 500s EVERY ebook route in a serverless deployment — Playwright expects a real
 * filesystem and a browser install, neither of which exists in a Vercel
 * function. The symptom is the whole ebook feature going down, with nothing in
 * the error pointing at Payhip.
 *
 * Keeping it dynamic means the web app constructs the publisher (cheap, just
 * field assignment) without ever loading a browser library, while the worker
 * and the connect CLI — the only two things that actually drive a browser —
 * load it on first use.
 */
async function chromium(stealth: boolean) {
  if (stealth) {
    try {
      // patchright ships the same `chromium` surface, so only the import differs.
      // Required lazily and separately from Playwright because it carries its
      // OWN patched browser build — the Dockerfile installs both.
      const patchright = (await import('patchright')) as unknown as typeof import('playwright');
      return patchright.chromium;
    } catch {
      // A host without patchright installed should degrade to a challenged
      // browser rather than refuse to run at all — the operator sees the
      // Cloudflare page in the error and can act on it.
    }
  }
  const playwright = await import('playwright');
  return playwright.chromium;
}

/**
 * One proxy out of a pool → Playwright's proxy shape.
 *
 * Accepts a LIST (newline- or comma-separated), because proxy providers hand
 * them out in bulk and the HeyGen pool already stores them that way. Entries are
 * `ip:port` or `ip:port:user:pass` — the same format, so one set of credentials
 * serves both. Deliberately a local copy of that parser rather than an import:
 * the HeyGen module reaches into the database and the crypto box, none of which
 * this needs.
 *
 * THE FIRST ENTRY WINS, AND THAT IS THE POINT. The obvious move is to rotate,
 * which is right for scraping and wrong here: this session was created from one
 * IP and Payhip is behind Cloudflare, which treats a logged-in session hopping
 * between a different IP every few minutes as far more suspicious than one that
 * simply stays put. A stable exit is what makes the session look like a person.
 * The rest of the list is there so a dead proxy is a one-line reorder rather
 * than a hunt for new credentials.
 */
/**
 * The exit the browser will use, named without leaking the password.
 *
 * Printed by both the connect CLI and the worker so a MISMATCH is visible
 * rather than inferred. Payhip rejects a session used from a different IP than
 * it was created on, and that failure looks identical to an ordinary expiry —
 * "the dashboard redirected to the login page" — which sends the operator off
 * to re-connect a session that was never stale. Seeing both ends say the same
 * address is the difference between knowing and guessing.
 */
export function describeProxy(raw: string | undefined): string {
  const proxy = raw ? pickProxy(raw) : null;
  return proxy ? proxy.server : 'direct (no proxy)';
}

function pickProxy(raw: string): { server: string; username?: string; password?: string } | null {
  const first = raw
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (!first) return null;

  const parts = first.split(':');
  if (parts.length >= 4) {
    const [ip, port, username, ...rest] = parts;
    return { server: `http://${ip}:${port}`, username, password: rest.join(':') };
  }
  const [ip, port] = parts;
  if (!ip || !port) return null;
  return { server: `http://${ip}:${port}` };
}

/**
 * The public IP this browser actually leaves from.
 *
 * The proxy STRING is not this. Residential providers hand out a fixed gateway
 * that rotates the real exit per connection, so two runs can print the same
 * `ip:port` and still appear to Payhip as two different people in two different
 * places — which is indistinguishable, from the log, from a session that simply
 * expired. Measuring it is the only way to know whether the connect and the
 * worker really share an address.
 *
 * Best-effort and short-timeout: this is diagnostics, and it must never be the
 * reason a listing fails.
 */
export async function readExitIp(context: BrowserContext): Promise<string> {
  const page = await context.newPage().catch(() => null);
  if (!page) return 'unknown';
  try {
    const response = await page.goto('https://api.ipify.org', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    const text = (await response?.text().catch(() => '')) ?? '';
    return text.trim().slice(0, 45) || 'unknown';
  } catch {
    return 'unknown';
  } finally {
    await page.close().catch(() => {});
  }
}

/** Launch a browser and restore the stored session into a fresh context. */
export async function openPayhipContext(
  config: PayhipBrowserConfig,
  storageState: PayhipStorageState | null,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await (await chromium(config.stealth ?? true)).launch({
    headless: !config.headed,
    ...(config.headed && config.slowMoMs ? { slowMo: config.slowMoMs } : {}),
    ...(() => {
      const proxy = config.proxy ? pickProxy(config.proxy) : null;
      return proxy ? { proxy } : {};
    })(),
    // The container essentials only. Notably NOT
    // --disable-blink-features=AutomationControlled: that flag is itself
    // something detectors look for, and patchright already handles the tells it
    // was meant to hide.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    // The blob round-trips through the DB as opaque JSON, so it is cast back to
    // the shape Playwright wrote — the same cast lib/synthetic/heygen-auth.ts makes.
    ...(storageState
      ? { storageState: storageState as unknown as Awaited<ReturnType<BrowserContext['storageState']>> }
      : {}),
    // Everything below is pinned so the connect and the worker present the same
    // browser to Payhip. A session created at one viewport, locale and timezone
    // and used at another is a fingerprint change on a live session, which is
    // the kind of thing that gets it dropped.
    viewport: { width: 1440, height: 960 },
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
    timezoneId: 'UTC',
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

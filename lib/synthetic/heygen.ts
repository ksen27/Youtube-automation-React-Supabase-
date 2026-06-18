import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { getEnv } from "@/lib/env";
import { uploadBuffer } from "@/lib/storage";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import {
  getAvailableAccount,
  saveCookies,
  recordSuccess,
  rotateAccount,
  resolveProxy,
  parseProxy,
  type DecryptedAccount,
} from "@/lib/synthetic/heygen-accounts";

// HeyGen avatar generation via Playwright browser automation (NOT the HeyGen
// API, per spec). Drives the live HeyGen web app to: restore a warm session
// (or log in), create a talking-photo avatar from the uploaded user image,
// drive it with the segment's narration, render, and download the resulting
// MP4 (no audio dependency — the master voiceover is muxed in at render time).
//
// Resilience:
//   * Account rotation — each attempt may run on a different pool account;
//     a soft failure cools down the current account and retries on the next.
//   * Cookie sessions — Playwright storageState is persisted (encrypted) per
//     account so we skip interactive login on subsequent runs.
//   * Proxy support — per-account or global residential proxy.
//   * Screenshot logging — every attempt screenshots key steps + any failure;
//     shots are uploaded to R2 for audit.
//   * Failure detection — explicit checks for login walls, quota/limit
//     banners, and render timeouts, each mapped to a retry/rotate decision.
//
// ⚠️ SELECTORS: HeyGen's DOM is not introspectable from here, so the selectors
// below are best-guess against the current app and are the FIRST thing to
// adjust against the live UI. They are centralized in SELECTORS for that
// reason. Behaviour, rotation, cookies, proxy, and screenshots are complete.

// Selectors verified against the live HeyGen app (auth.heygen.com login +
// app.heygen.com workspace) on 2026-06-18. The login flow is multi-step:
//   landing -> "Use email" -> "Use password" -> fill email+password -> "Log in"
// HeyGen also renders multiple STACKED auth panels in the DOM (only one is
// on-screen), so login interactions must target the on-screen element — see
// clickOnScreen()/fillOnScreen(). Post-login the workspace shows a left nav
// with Home / Avatar / Brand / Apps / Projects.
const SELECTORS = {
  // Logged-in marker: the workspace left-nav items (text is stable; the old
  // data-testid guess was never present on the real app).
  loggedInMarker: 'text="Avatar"',
  useEmail: 'text="Use email"',
  usePassword: 'text="Use password"',
  loginEmail: 'input[type="email"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button:has-text("Log in")',
  createAvatarEntry: 'a[href*="avatar"], button:has-text("Create")',
  photoAvatarUpload: 'input[type="file"]',
  scriptTextarea: 'textarea[placeholder*="script" i], textarea[aria-label*="script" i]',
  generateButton: 'button:has-text("Generate"), button:has-text("Submit")',
  renderDoneMarker: 'video[src], a[download], button:has-text("Download")',
  downloadButton: 'a[download], button:has-text("Download")',
  quotaBanner: ':text("limit"), :text("upgrade"), :text("quota")',
} as const;

// HeyGen's auth widget keeps several panels mounted at once; only one is laid
// out on-screen. Plain Playwright clicks/fills can resolve to an off-screen
// duplicate and either no-op or time out. These helpers pick the first match
// that actually has an on-screen bounding box.
async function clickOnScreen(page: Page, selector: string, timeoutMs: number): Promise<void> {
  const loc = page.locator(selector);
  const deadline = Date.now() + timeoutMs;
  do {
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const box = await loc.nth(i).boundingBox().catch(() => null);
      if (box && box.width > 0 && box.y > 50 && box.y < 850) {
        await loc.nth(i).click({ timeout: timeoutMs });
        return;
      }
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  throw new Error(`heygen: no on-screen element for ${selector}`);
}

async function fillOnScreen(page: Page, selector: string, value: string, timeoutMs: number): Promise<void> {
  const loc = page.locator(selector);
  const deadline = Date.now() + timeoutMs;
  do {
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const box = await loc.nth(i).boundingBox().catch(() => null);
      if (box && box.width > 0 && box.y > 50 && box.y < 850) {
        await loc.nth(i).fill(value);
        return;
      }
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  throw new Error(`heygen: no on-screen field for ${selector}`);
}

export interface GenerateAvatarInput {
  projectId: string;
  segmentId: string;
  jobId: string;
  avatarImageUrl: string;   // public URL of the uploaded user photo
  script: string;           // narration that drives the avatar
}

export interface GenerateAvatarResult {
  videoUrl: string;         // R2 public URL of the downloaded avatar mp4
  accountId: string;        // which account produced it
  seconds: number;          // estimated output length (billing)
}

function env() {
  return getEnv();
}

// Launch a browser context for an account, restoring its warm session +
// proxy. Caller owns closing the returned browser.
async function openContext(account: DecryptedAccount): Promise<{ browser: Browser; context: BrowserContext }> {
  const e = env();
  const proxyRaw = resolveProxy(account);
  const browser = await chromium.launch({
    headless: e.HEYGEN_HEADLESS,
    proxy: proxyRaw ? parseProxy(proxyRaw) : undefined,
  });
  const context = await browser.newContext({
    // Restore the warm session if we have one. Playwright accepts the same
    // object shape it produces from context.storageState().
    storageState: (account.cookies as Awaited<ReturnType<BrowserContext["storageState"]>> | null) ?? undefined,
    viewport: { width: 1366, height: 900 },
  });
  context.setDefaultTimeout(e.HEYGEN_NAV_TIMEOUT_MS);
  return { browser, context };
}

// Capture + upload a screenshot for audit. Best-effort: never throws.
async function shot(page: Page, projectId: string, segmentId: string, label: string): Promise<void> {
  try {
    const dir = env().HEYGEN_SCREENSHOT_DIR;
    await fs.mkdir(dir, { recursive: true });
    const local = path.join(dir, `${segmentId}_${label}.png`);
    await page.screenshot({ path: local, fullPage: false });
    const buf = await fs.readFile(local);
    await uploadBuffer(buf, r2Keys.avatarShot(projectId, segmentId, label), "image/png");
  } catch {
    /* screenshots are diagnostic only */
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  return (await page.locator(SELECTORS.loggedInMarker).count()) > 0;
}

// Interactive login. Persists a fresh storage state on success so future runs
// skip straight past the login wall.
//
// Verified flow (auth.heygen.com, 2026-06-18): the landing screen only offers
// Google/Apple/"Use email"/"Use SSO". We pick the email path, switch it from
// the default magic-link mode to password mode, fill credentials, and submit:
//   /login (commit) -> "Use email" -> "Use password" -> email+password -> "Log in"
async function login(page: Page, context: BrowserContext, account: DecryptedAccount): Promise<void> {
  const e = env();
  // HeyGen is a heavy SPA whose `domcontentloaded`/`load` lifecycle events may
  // never settle (streaming/long-poll connections keep the document "loading"),
  // so we navigate with `commit` (resolves once the response starts) and then
  // wait for the concrete element we need at each step.
  await page.goto(`${e.HEYGEN_BASE_URL}/login`, { waitUntil: "commit" });

  // 1) Landing -> email entry. 2) email mode -> password mode.
  await clickOnScreen(page, SELECTORS.useEmail, e.HEYGEN_NAV_TIMEOUT_MS);
  await clickOnScreen(page, SELECTORS.usePassword, e.HEYGEN_NAV_TIMEOUT_MS);

  // 3) Fill credentials (on-screen panel only) and submit.
  await fillOnScreen(page, SELECTORS.loginEmail, account.email, e.HEYGEN_NAV_TIMEOUT_MS);
  await fillOnScreen(page, SELECTORS.loginPassword, account.password, e.HEYGEN_NAV_TIMEOUT_MS);
  await clickOnScreen(page, SELECTORS.loginSubmit, e.HEYGEN_NAV_TIMEOUT_MS);

  // 4) Success = we leave the auth page and the workspace nav renders. Surface
  // a clear error otherwise (wrong password, captcha, email-code challenge).
  await page
    .waitForURL((u) => !u.toString().includes("/login"), { timeout: e.HEYGEN_NAV_TIMEOUT_MS })
    .catch(() => {
      throw new Error("heygen: login did not complete (still on auth page — bad credentials or a captcha/email-code challenge)");
    });
  await page.waitForSelector(SELECTORS.loggedInMarker, { timeout: e.HEYGEN_NAV_TIMEOUT_MS });

  // Persist the warm session for reuse.
  const state = await context.storageState();
  await saveCookies(account.id, state);
}

// Detect a quota/limit wall so the caller rotates instead of pointlessly
// retrying the same exhausted account.
async function hitQuotaWall(page: Page): Promise<boolean> {
  try {
    return (await page.locator(SELECTORS.quotaBanner).count()) > 0;
  } catch {
    return false;
  }
}

// One full avatar generation attempt on a single account. Throws on failure;
// the public generateAvatar() wraps this with account rotation.
async function attemptOnAccount(
  account: DecryptedAccount,
  input: GenerateAvatarInput,
  imageBytes: Buffer,
): Promise<GenerateAvatarResult> {
  const e = env();
  const { browser, context } = await openContext(account);
  const t0 = Date.now();
  try {
    const page = await context.newPage();

    // 1) Ensure authenticated (restore session, else log in). HeyGen's SPA
    // lifecycle never settles, so navigate with `commit` (see login()) and give
    // the logged-in marker a brief, bounded chance to render before deciding to
    // log in — otherwise the check races the SPA and false-negatives into a
    // needless login.
    await page.goto(`${e.HEYGEN_BASE_URL}/home`, { waitUntil: "commit" });
    await page
      .waitForSelector(SELECTORS.loggedInMarker, { timeout: 15_000 })
      .catch(() => {});
    if (!(await isLoggedIn(page))) {
      await login(page, context, account);
    }
    await shot(page, input.projectId, input.segmentId, "authed");

    // 2) Enter the talking-photo / avatar creation flow.
    await page.click(SELECTORS.createAvatarEntry);

    // 3) Upload the user's photo. Playwright's setInputFiles needs a path, so
    // we stage the in-memory bytes to a temp file.
    const stageDir = path.join(e.TMP_DIR, "heygen-uploads");
    await fs.mkdir(stageDir, { recursive: true });
    const stagePath = path.join(stageDir, `${input.segmentId}.jpg`);
    await fs.writeFile(stagePath, imageBytes);
    await page.setInputFiles(SELECTORS.photoAvatarUpload, stagePath);
    await shot(page, input.projectId, input.segmentId, "uploaded");

    // 4) Drive the avatar with the narration script.
    await page.fill(SELECTORS.scriptTextarea, input.script);

    // 5) Kick off the render.
    if (await hitQuotaWall(page)) {
      throw new Error("heygen: quota/limit wall before generate");
    }
    await page.click(SELECTORS.generateButton);
    await shot(page, input.projectId, input.segmentId, "generating");

    // 6) Wait for the render to complete (separate, longer timeout).
    await page.waitForSelector(SELECTORS.renderDoneMarker, { timeout: e.HEYGEN_RENDER_TIMEOUT_MS });
    if (await hitQuotaWall(page)) {
      throw new Error("heygen: quota/limit wall after generate");
    }

    // 7) Resolve the rendered video URL and download the bytes.
    const videoSrc = await page
      .locator(SELECTORS.renderDoneMarker)
      .first()
      .evaluate((el) => el.getAttribute("src") || el.getAttribute("href"))
      .catch(() => null);

    let videoBytes: Buffer | null = null;
    if (videoSrc && /^https?:/.test(videoSrc)) {
      // Pull it through the authenticated browser context so cookies apply.
      const resp = await context.request.get(videoSrc, { timeout: e.HEYGEN_NAV_TIMEOUT_MS });
      if (resp.ok()) videoBytes = Buffer.from(await resp.body());
    }
    if (!videoBytes) {
      // Fall back to clicking the download control and capturing the download.
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: e.HEYGEN_NAV_TIMEOUT_MS }),
        page.click(SELECTORS.downloadButton),
      ]);
      const dlPath = await download.path();
      if (!dlPath) throw new Error("heygen: download produced no file");
      videoBytes = await fs.readFile(dlPath);
    }
    await shot(page, input.projectId, input.segmentId, "done");

    // 8) Upload to R2.
    const up = await uploadBuffer(
      videoBytes,
      r2Keys.avatarVideo(input.projectId, input.segmentId),
      "video/mp4",
    );

    // Refresh the warm session for the next run.
    await saveCookies(account.id, await context.storageState()).catch(() => {});
    await recordSuccess(account.id);

    // Rough output length from the narration (HeyGen ~ real-time speech).
    const seconds = Math.max(2, Math.round(input.script.split(/\s+/).filter(Boolean).length / 2.5));
    await logProviderCall({
      projectId: input.projectId,
      jobId: input.jobId,
      segmentId: input.segmentId,
      provider: "heygen_avatar",
      phase: "response",
      durationMs: Date.now() - t0,
      cost: { provider: "heygen_avatar", seconds },
      extra: { accountId: account.id },
    });

    return { videoUrl: up.publicUrl, accountId: account.id, seconds };
  } catch (err) {
    // Capture the failure frame for audit before tearing down.
    try {
      const page = context.pages()[0];
      if (page) await shot(page, input.projectId, input.segmentId, "error");
    } catch {
      /* ignore */
    }
    await logProviderCall({
      projectId: input.projectId,
      jobId: input.jobId,
      segmentId: input.segmentId,
      provider: "heygen_avatar",
      phase: "error",
      durationMs: Date.now() - t0,
      extra: { accountId: account.id, err: (err as Error).message?.slice(0, 200) },
    });
    throw err;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Generate an avatar video, rotating through the account pool on failure. Each
 * account gets one attempt; a failure cools down that account (or disables it
 * past the threshold) and the next available account is tried, up to
 * `maxAccounts` distinct accounts. Throws when the pool is exhausted or no
 * account succeeds — the avatar processor decides how to degrade.
 */
export async function generateAvatar(
  input: GenerateAvatarInput,
  imageBytes: Buffer,
  maxAccounts = 3,
): Promise<GenerateAvatarResult> {
  let account = await getAvailableAccount();
  if (!account) throw new Error("heygen: no available accounts in pool");

  let lastErr: unknown;
  for (let i = 0; i < maxAccounts; i++) {
    try {
      return await attemptOnAccount(account, input, imageBytes);
    } catch (err) {
      lastErr = err;
      const next = await rotateAccount(account.id, (err as Error).message);
      if (!next) break; // pool exhausted
      account = next;
    }
  }
  throw new Error(
    `heygen: avatar generation failed across ${maxAccounts} account(s): ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}

// Re-export account helpers so callers can `from "@/lib/synthetic/heygen"`.
export {
  getAvailableAccount,
  rotateAccount,
  saveCookies,
  restoreCookies,
} from "@/lib/synthetic/heygen-accounts";

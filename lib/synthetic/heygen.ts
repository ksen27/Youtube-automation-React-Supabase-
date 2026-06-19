import { promises as fs } from "node:fs";
import path from "node:path";
import { type Page, type BrowserContext } from "playwright";
import { getEnv } from "@/lib/env";
import { uploadBuffer } from "@/lib/storage";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import {
  getAvailableAccount,
  saveCookies,
  recordSuccess,
  applyDisposition,
  type DecryptedAccount,
} from "@/lib/synthetic/heygen-accounts";
import {
  openAuthedContext,
  verifyAuthenticated,
  captureDiagnostics,
} from "@/lib/synthetic/heygen-auth";
import {
  HeygenError,
  classifyHeygenFailure,
  dispositionOf,
  classOf,
} from "@/lib/synthetic/heygen-errors";
import {
  photoToVideoTab,
  photoUpload,
  uploadTrigger,
  removePhoto,
  selectedPhoto,
  scriptField,
  generateButton,
  voicePickerButton,
  projectVideoCards,
  cardStillRendering,
  projectVideoElement,
  projectDownloadButton,
  moreActionsButton,
  clickFirstVisible,
  fillFirstVisible,
  waitFirstVisible,
  isVisible,
} from "@/lib/synthetic/heygen-selectors";

// HeyGen avatar generation via Playwright browser automation (NOT the HeyGen
// API, per spec). Drives the live HeyGen web app to: RESTORE a warm session
// (never log in here — see below), create a talking-photo avatar from the
// uploaded user image, drive it with the segment's narration, render, and
// download the resulting MP4.
//
// Resilience redesign (no per-job login):
//   * Auth is connected ONCE per account by a human (`npm run heygen:connect`).
//     The encrypted storageState lives in the DB and is reused on every job —
//     this worker NEVER opens the login page, so login-page UI changes can no
//     longer break generation or strand the pool. See lib/synthetic/heygen-auth.
//   * Session expiry is detected (verifyAuthenticated) and flagged needs_reauth
//     WITHOUT cooldown / fail-count — a stale session never burns the pool.
//   * Every failure is CLASSIFIED (heygen-errors) and mapped to a disposition
//     (reauth / cooldown / disable / rotate) so a selector/UI failure no longer
//     looks like an account failure.
//   * Diagnostics (url, title, screenshot, HTML) are captured on every failure.
//   * Per-account or global residential proxy; screenshots uploaded to R2.

function env() {
  return getEnv();
}

export interface GenerateAvatarInput {
  projectId: string;
  segmentId: string;
  jobId: string;
  avatarImageUrl: string; // public URL of the uploaded user photo
  script: string; // narration that drives the avatar
}

export interface GenerateAvatarResult {
  videoUrl: string; // R2 public URL of the downloaded avatar mp4
  accountId: string; // which account produced it
  seconds: number; // estimated output length (billing)
}

// Capture + upload a step screenshot for audit. Best-effort: never throws.
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

// Upload a staged file by clicking the upload control and answering the native
// file chooser it opens. This is more robust than setInputFiles against HeyGen's
// on-demand (modal) file input, which often doesn't exist until the control is
// clicked. Throws a classified HeygenError if no chooser appears.
async function uploadViaChooser(page: Page, filePath: string, timeoutMs: number): Promise<void> {
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: timeoutMs }),
      clickFirstVisible(uploadTrigger(page), timeoutMs, "upload control"),
    ]);
    await chooser.setFiles(filePath);
  } catch (err) {
    // Last resort: a file input may have been injected by the click even if no
    // chooser event fired (some flows mount a visible <input>).
    if ((await photoUpload(page).count()) > 0) {
      await photoUpload(page).first().setInputFiles(filePath);
      return;
    }
    throw new HeygenError("ui_changed", "heygen: could not open photo upload", err);
  }
}

// Ensure a usable voice is selected before generating, WITHOUT opening the
// voice-detail modal. HeyGen's avatar composer already has a voice selected by
// default (the toolbar pill, e.g. "Japan - Voice 2"), and our pipeline discards
// HeyGen's audio at render anyway (the 69labs master voiceover is muxed in), so
// the specific voice is irrelevant — we only need SOME voice set so HeyGen
// doesn't block with "Please select the voice id".
//
// IMPORTANT: do NOT click the voice pill here. Clicking it opens a "Voice for
// <name>" detail modal (Switch / Speed / Accent / Save changes) that has no
// search box and would strand the flow. We just confirm a voice pill exists and
// move on; if a future avatar truly has none, the generate step's error is
// captured + classified normally rather than hanging in a modal.
async function ensureVoicePresent(page: Page): Promise<void> {
  // The toolbar voice pill (any "... Voice ..." button) being present means a
  // voice is already selected. Best-effort, short budget, never opens a modal.
  await isVisible(voicePickerButton(page), 3000);
}

// Retrieve the finished avatar video from HeyGen's Projects page. HeyGen renders
// asynchronously and drops the result into /projects (newest first), so we:
//   1) navigate to /projects and open the newest video card,
//   2) wait (up to the render timeout) for it to finish rendering,
//   3) capture the mp4 — primarily by sniffing the CDN response the player
//      loads (most robust), falling back to the Download control.
// Returns the video bytes or throws a classified HeygenError.
async function retrieveRenderedVideo(
  page: Page,
  context: BrowserContext,
): Promise<Buffer> {
  const e = env();

  // Start sniffing for the rendered mp4 as soon as we navigate — HeyGen's player
  // streams it from a CDN; catching that response is more reliable than DOM.
  const mp4Promise = page
    .waitForResponse((r) => /\.mp4(\?|$)/i.test(r.url()) && r.status() < 400, {
      timeout: e.HEYGEN_RENDER_TIMEOUT_MS,
    })
    .catch(() => null);

  // Go to Projects (newest first) and open the most recent video card. Poll
  // until the newest card has finished rendering (no spinner / has a duration).
  const deadline = Date.now() + e.HEYGEN_RENDER_TIMEOUT_MS;
  let opened = false;
  while (Date.now() < deadline) {
    await page.goto(`${e.HEYGEN_BASE_URL}/projects`, { waitUntil: "commit" }).catch(() => {});
    const newest = projectVideoCards(page).locator("visible=true").first();
    if (await newest.isVisible({ timeout: 10_000 }).catch(() => false)) {
      // If the newest card is still rendering, wait and re-poll.
      if (await isVisible(cardStillRendering(newest), 1500)) {
        await page.waitForTimeout(5000);
        continue;
      }
      await newest.click({ timeout: e.HEYGEN_NAV_TIMEOUT_MS }).catch(() => {});
      opened = true;
      break;
    }
    await page.waitForTimeout(5000);
  }
  if (!opened) {
    throw new HeygenError("ui_changed", "heygen: rendered video never appeared in Projects");
  }

  // Prefer the sniffed CDN url (pull it through the authed context so cookies
  // apply); else read the <video> src; else click Download and capture the file.
  const sniffed = await mp4Promise;
  let videoUrl: string | null = sniffed?.url() ?? null;
  if (!videoUrl) {
    videoUrl = await projectVideoElement(page)
      .first()
      .evaluate((el) => (el as HTMLVideoElement).currentSrc || el.getAttribute("src"))
      .catch(() => null);
  }

  if (videoUrl && /^https?:/.test(videoUrl)) {
    const resp = await context.request.get(videoUrl, { timeout: e.HEYGEN_NAV_TIMEOUT_MS });
    if (resp.ok()) return Buffer.from(await resp.body());
  }

  // Fallback: open the more-actions menu if needed, click Download, capture it.
  if (!(await isVisible(projectDownloadButton(page), 2000))) {
    await clickFirstVisible(moreActionsButton(page), 10_000, "more actions").catch(() => {});
  }
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: e.HEYGEN_NAV_TIMEOUT_MS }),
    clickFirstVisible(projectDownloadButton(page), e.HEYGEN_NAV_TIMEOUT_MS, "download control"),
  ]).catch(() => [null] as const);
  if (download) {
    const dlPath = await download.path();
    if (dlPath) return await fs.readFile(dlPath);
  }
  throw new HeygenError("ui_changed", "heygen: could not retrieve rendered video from Projects");
}

// One full avatar generation attempt on a single account. Throws a classified
// HeygenError on failure; generateAvatar() wraps this with disposition-aware
// account rotation.
async function attemptOnAccount(
  account: DecryptedAccount,
  input: GenerateAvatarInput,
  imageBytes: Buffer,
): Promise<GenerateAvatarResult> {
  const e = env();
  const { browser, context } = await openAuthedContext(account);
  const t0 = Date.now();
  let page: Page | null = null;
  try {
    page = await context.newPage();
    const p = page; // non-null alias for use inside async callbacks below

    // 1) Reuse the stored session and verify it (spec B/C). NO login here. An
    // expired session is a classified, no-penalty needs_reauth — not a failure.
    const verdict = await verifyAuthenticated(p);
    if (verdict === "expired") {
      throw new HeygenError(
        "session_expired",
        `heygen: account ${account.email} session expired — reconnect with \`npm run heygen:connect ${account.email}\``,
      );
    }
    await shot(p, input.projectId, input.segmentId, "authed");

    // 2) Go straight to the avatar "Quick create" workspace. (verifyAuthenticated
    // left us on /home; the avatar composer lives at /avatar.)
    await p.goto(`${e.HEYGEN_BASE_URL}/avatar`, { waitUntil: "commit" }).catch(() => {});
    await waitFirstVisible(scriptField(p), e.HEYGEN_NAV_TIMEOUT_MS, "avatar composer");

    // 3) Select the "Photo to video" mode (vs. "Script to video") so the photo
    // upload pane is active. Best-effort: if it's already the active tab the
    // click is harmless; if the tab isn't present the upload step still runs.
    if (await isVisible(photoToVideoTab(p), 3000)) {
      await clickFirstVisible(photoToVideoTab(p), e.HEYGEN_NAV_TIMEOUT_MS, "photo-to-video tab").catch(
        () => {},
      );
    }

    // 4) Upload the user's photo. Stage the bytes to a temp file first
    // (setInputFiles / filechooser both need a path).
    const stageDir = path.join(e.TMP_DIR, "heygen-uploads");
    await fs.mkdir(stageDir, { recursive: true });
    const stagePath = path.join(stageDir, `${input.segmentId}.jpg`);
    await fs.writeFile(stagePath, imageBytes);

    // A photo may already be selected from a prior session — remove it so we
    // drive the avatar with OUR image, not a stale one.
    if (await isVisible(selectedPhoto(p), 2000)) {
      await clickFirstVisible(removePhoto(p), 10_000, "remove existing photo").catch(() => {});
    }

    // HeyGen creates the file <input> on demand (inside an upload modal), so a
    // direct setInputFiles often has nothing to target. Prefer catching the
    // native file chooser that the upload control opens; fall back to a hidden
    // input if one is already present.
    const existingInput = (await photoUpload(p).count()) > 0;
    if (existingInput) {
      await photoUpload(p).first().setInputFiles(stagePath).catch(async () => {
        await uploadViaChooser(p, stagePath, e.HEYGEN_NAV_TIMEOUT_MS);
      });
    } else {
      await uploadViaChooser(p, stagePath, e.HEYGEN_NAV_TIMEOUT_MS);
    }

    // Confirm the upload landed (our photo shows in the preview pane).
    await waitFirstVisible(selectedPhoto(p), e.HEYGEN_NAV_TIMEOUT_MS, "uploaded photo preview");
    await shot(p, input.projectId, input.segmentId, "uploaded");

    // 5) Drive the avatar with the narration script.
    await fillFirstVisible(scriptField(p), input.script, e.HEYGEN_NAV_TIMEOUT_MS, "script field");

    // 6) Confirm a voice is already selected (does NOT open the voice modal —
    // see ensureVoicePresent). HeyGen's audio is discarded at render anyway.
    await ensureVoicePresent(p);

    // 7) Kick off the render. HeyGen renders ASYNCHRONOUSLY: clicking Generate
    // does not produce the file on this page — it sends the avatar to the
    // /projects grid where it appears (and finishes rendering) minutes later.
    await clickFirstVisible(generateButton(p), e.HEYGEN_NAV_TIMEOUT_MS, "generate button");
    await shot(p, input.projectId, input.segmentId, "generating");

    // 8–9) Retrieve the finished video from the Projects page (the only place
    // the rendered mp4 exists). Returns the downloaded bytes.
    const videoBytes = await retrieveRenderedVideo(p, context);
    await shot(p, input.projectId, input.segmentId, "done");

    // 8) Upload to R2.
    const up = await uploadBuffer(
      videoBytes,
      r2Keys.avatarVideo(input.projectId, input.segmentId),
      "video/mp4",
    );

    // Refresh the warm session for the next run (status untouched).
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
    // Classify against the live page, then re-throw a typed HeygenError so the
    // rotation layer can apply the right (often no-penalty) disposition.
    const klass = await classifyHeygenFailure(page, err);
    const typed =
      err instanceof HeygenError
        ? err
        : new HeygenError(klass, (err as Error)?.message ?? "heygen: unknown failure", err);

    // Spec E: full diagnostics on every failure (url, title, screenshot, HTML).
    await captureDiagnostics(page, input.jobId, "error");
    if (page) await shot(page, input.projectId, input.segmentId, "error");

    await logProviderCall({
      projectId: input.projectId,
      jobId: input.jobId,
      segmentId: input.segmentId,
      provider: "heygen_avatar",
      phase: "error",
      durationMs: Date.now() - t0,
      extra: {
        accountId: account.id,
        errorClass: typed.klass,
        err: typed.message?.slice(0, 200),
      },
    });
    throw typed;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Generate an avatar video, rotating through the account pool on failure. Each
 * account gets one attempt; the FAILURE CLASS decides what happens to it:
 *   - session_expired  -> flagged needs_reauth (no cooldown, no fail bump)
 *   - rate_limit/credit -> cooldown
 *   - ui_changed/selector/network -> rotate with NO penalty (not the account's
 *     fault — surfaced via last_error_class + diagnostics instead)
 * then the next available account is tried, up to `maxAccounts`. Throws when
 * the pool is exhausted or none succeed — the avatar processor decides how to
 * degrade.
 */
export async function generateAvatar(
  input: GenerateAvatarInput,
  imageBytes: Buffer,
  maxAccounts = 3,
): Promise<GenerateAvatarResult> {
  // Anti-bot pacing: space serial avatar jobs apart so a back-to-back burst
  // doesn't trip HeyGen's Cloudflare protection (which kills the session).
  const spacingMs = env().HEYGEN_JOB_SPACING_SECONDS * 1000;
  if (spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));

  let account = await getAvailableAccount();
  if (!account) {
    throw new HeygenError(
      "session_expired",
      "heygen: no available accounts in pool — connect or re-auth one with `npm run heygen:connect <email>`",
    );
  }

  let lastErr: unknown;
  for (let i = 0; i < maxAccounts; i++) {
    try {
      return await attemptOnAccount(account, input, imageBytes);
    } catch (err) {
      lastErr = err;
      const next = await applyDisposition(
        account.id,
        dispositionOf(err),
        classOf(err),
        (err as Error).message ?? "unknown",
      );
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
  applyDisposition,
  saveCookies,
  restoreCookies,
} from "@/lib/synthetic/heygen-accounts";

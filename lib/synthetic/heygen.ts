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
  generateButtonEnabled,
  landscapeRatioButton,
  portraitRatioButton,
  voiceRows,
  voiceConfirmEnabled,
  voiceRequiredToast,
  audioUploadTrigger,
  audioModalHeading,
  uploadAudioTab,
  audioDropzone,
  audioFileInput,
  audioConfirmButton,
  audioConfirmHeading,
  clickFirstVisible,
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
  // Path to a local audio file (sliced from the 69labs master voiceover for
  // this avatar part). When set, the avatar is driven by UPLOADING this audio
  // to HeyGen instead of typing the script — HeyGen lip-syncs to it, so the
  // rendered video length equals the audio length (the fix for the avatar /
  // voiceover duration mismatch). When absent, we fall back to the legacy
  // script-text path. `script` is still passed through for diagnostics/billing.
  audioFilePath?: string;
  // Duration (seconds) of the uploaded audio slice, when known. Used for the
  // cost/billing estimate (the render length == this) instead of guessing from
  // the script word count. Ignored on the legacy script path.
  audioDurationSeconds?: number;
  // Composer aspect ratio. "landscape" (16:9) for full-frame avatar blocks — the
  // synthetic render canvas is 1280×720. "portrait" (9:16) for split_2 avatars:
  // there the avatar fills only a tall LEFT half-cell (640×720) at render, so a
  // portrait source fits naturally while a landscape one would be heavily
  // side-cropped. Defaults to "landscape" when unset.
  aspectRatio?: "landscape" | "portrait";
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

// Drive the avatar with an UPLOADED audio file (the sliced 69labs voiceover for
// this avatar part) instead of typed script. Opens the Script panel's "↑ Upload"
// button -> "Upload Audio" modal -> uploads the staged audio via the native file
// chooser (falling back to a hidden <input>), then commits. Throws a classified
// HeygenError if the modal / upload control never appears. On success the modal
// closes and the composer is driven by the uploaded audio; we then skip the
// script-fill and voice-picker steps entirely.
async function uploadAudioTrack(page: Page, audioPath: string, timeoutMs: number): Promise<void> {
  // 1) Open the audio-upload modal from the Script panel header. The modal is a
  // portal-rendered div (NOT role="dialog"), so we detect "open" by its visible
  // "Upload Audio" heading. CRITICAL: use waitFor({state:"visible"}), NOT
  // isVisible() — isVisible() returns the CURRENT state immediately (the timeout
  // only bounds locator resolution, it does NOT poll for appearance), so right
  // after the click it returned false before the modal animated in, falsely
  // reporting "modal did not open" even though it opened a beat later. waitFor
  // actually polls up to the timeout.
  await clickFirstVisible(audioUploadTrigger(page), timeoutMs, "audio upload button");
  const heading = audioModalHeading(page).locator("visible=true").first();
  try {
    await heading.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new HeygenError("ui_changed", "heygen: Upload Audio modal did not open");
  }

  // 2) Make sure the "Upload Audio" tab (not "Record Audio") is active. The
  // modal usually opens already on this tab; the click is a harmless no-op then.
  if (await isVisible(uploadAudioTab(page), 3000)) {
    await clickFirstVisible(uploadAudioTab(page), timeoutMs, "Upload Audio tab").catch(() => {});
  }

  // 3) Upload the file. Prefer catching the native file chooser the dropzone
  // opens; fall back to setInputFiles on a hidden <input> if one is mounted.
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: timeoutMs }),
      clickFirstVisible(audioDropzone(page), timeoutMs, "audio dropzone"),
    ]);
    await chooser.setFiles(audioPath);
  } catch (err) {
    if ((await audioFileInput(page).count()) > 0) {
      await audioFileInput(page).first().setInputFiles(audioPath);
    } else {
      throw new HeygenError("ui_changed", "heygen: could not open audio file chooser", err);
    }
  }

  // 4) Commit. Picking a file advances to a SECOND modal, "Confirm Audio", which
  // previews the uploaded track and has a "Back" / "Add audio" pair. Wait for
  // that confirm modal (it processes the upload first — the player has to load
  // the duration), then click "Add audio". Use waitFor (polls) rather than
  // isVisible (instant). Tolerate the no-confirm-modal case (some builds may
  // commit directly) by falling through to the close check.
  const confirmHeading = audioConfirmHeading(page).locator("visible=true").first();
  const confirmBtn = audioConfirmButton(page).locator("visible=true").first();
  await confirmHeading.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
  // The "Add audio" button can stay disabled until the track finishes processing;
  // poll a few times, re-checking, before giving up.
  let committed = false;
  for (let i = 0; i < 8 && !committed; i++) {
    try {
      await confirmBtn.waitFor({ state: "visible", timeout: 4000 });
      await confirmBtn.click({ timeout: 6000 });
      committed = true;
    } catch {
      await page.waitForTimeout(2000);
    }
  }
  if (!committed) {
    throw new HeygenError("ui_changed", "heygen: 'Add audio' confirm button never became clickable");
  }

  // 5) Both modals must be gone for the audio to be committed to the composer.
  // Wait for the Upload/Confirm headings to disappear; if either lingers the
  // audio didn't attach and Generate would stay disabled.
  await heading.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
  await confirmHeading.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  if (await isVisible(audioConfirmHeading(page), 1000)) {
    throw new HeygenError("ui_changed", "heygen: 'Confirm Audio' modal never closed after committing");
  }
}

// FALLBACK ONLY: explicitly commit a voice via the picker. Used when Generate
// flashed "Please select a voice" (a state race — a voice is already shown). We
// open the picker, click the first voice row, and confirm. Any voice is fine —
// HeyGen's audio is discarded at render (the 69labs master voiceover is muxed
// in). Best-effort and self-contained; never leaves a modal open.
async function commitVoice(page: Page): Promise<void> {
  const e = env();
  const dialog = page.getByRole("dialog");
  const pill = page.locator('button:has(svg use[href="#audio"])').locator("visible=true").first();
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    await pill.click({ timeout: 10_000, force: i > 0 }).catch(() => {});
    opened = await isVisible(dialog, 6000);
  }
  if (!opened) return;
  const firstRow = voiceRows(page).locator("visible=true").first();
  await firstRow.click({ timeout: e.HEYGEN_NAV_TIMEOUT_MS }).catch(() => {});
  await voiceConfirmEnabled(page).first().click({ timeout: e.HEYGEN_NAV_TIMEOUT_MS }).catch(() => {});
  await dialog.first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
}

// HeyGen's project-list API. The Projects PAGE is a flaky SPA (hover-only card
// menus, portaled dialogs, stale/blank grids, no card hrefs) that proved
// unreliable to scrape. Instead we call the SAME JSON API the page itself uses
// (verified 2026-06-19): it returns avatar videos newest-first, each with a
// stable `video_id`, a `status` ("completed" when done), and a directly
// downloadable signed `video_url`. Far more robust than the DOM.
const HEYGEN_ITEMS_API =
  "https://api2.heygen.com/v1/project/items?limit=20&filter_groups=avatar_video&sort_key=created_ts&sort_order=desc";

interface HeygenProjectItem {
  video_id: string;
  status: string; // "completed" | "processing" | "pending" | "failed" | ...
  duration?: number;
  created_ts?: number;
  video_url?: string;
  video_download_url?: string;
  error_message?: string;
}

// Fetch the avatar-video list via the authed browser context (cookies apply).
async function fetchProjectItems(context: BrowserContext): Promise<HeygenProjectItem[]> {
  const resp = await context.request.get(HEYGEN_ITEMS_API, { timeout: env().HEYGEN_NAV_TIMEOUT_MS }).catch(() => null);
  if (!resp || !resp.ok()) return [];
  const json = (await resp.json().catch(() => null)) as { data?: { items?: HeygenProjectItem[] } } | null;
  return json?.data?.items ?? [];
}

// The newest item's video_id (the baseline taken just before we generate, so we
// can tell OUR render apart from prior ones). "" when the list is empty.
async function newestItemId(context: BrowserContext): Promise<string> {
  const items = await fetchProjectItems(context);
  return items[0]?.video_id ?? "";
}

// Retrieve the finished avatar video via the project-list API. Polls until OUR
// render (newest item whose video_id != baseline) reaches status "completed",
// then downloads its signed video_url. Throws a classified HeygenError on
// timeout / failure. `baselineId` is the newest video_id captured pre-generate.
async function retrieveRenderedVideo(
  page: Page,
  context: BrowserContext,
  baselineId = "",
): Promise<Buffer> {
  const e = env();
  const deadline = Date.now() + e.HEYGEN_RENDER_TIMEOUT_MS;
  const appearDeadline = Date.now() + 180_000; // our item must show up within 3 min

  let ours: HeygenProjectItem | null = null;
  let everSawOurs = false;
  while (Date.now() < deadline) {
    const items = await fetchProjectItems(context);
    // OUR render is the newest item whose id differs from the pre-generate
    // baseline. (At avatar concurrency=1 nobody else is adding items.)
    const candidate = items.find((it) => it.video_id && it.video_id !== baselineId) ?? null;

    if (candidate) {
      everSawOurs = true;
      const status = (candidate.status ?? "").toLowerCase();
      if (status === "completed" || status === "success" || status === "done") {
        ours = candidate;
        break;
      }
      if (status === "failed" || status === "error") {
        throw new HeygenError(
          "ui_changed",
          `heygen: render failed on HeyGen side${candidate.error_message ? ` — ${candidate.error_message}` : ""}`,
        );
      }
      // Still processing — wait and re-poll within the render budget.
      await page.waitForTimeout(5000);
      continue;
    }

    // Our item hasn't appeared yet. If it never does within the appear window,
    // generation likely never produced a project.
    if (!everSawOurs && Date.now() > appearDeadline) {
      throw new HeygenError(
        "ui_changed",
        "heygen: our render never appeared in the project list within 3 min — generation likely never started",
      );
    }
    await page.waitForTimeout(5000);
  }

  if (!ours) {
    throw new HeygenError("ui_changed", "heygen: render did not complete within the render budget");
  }

  const url = ours.video_url || ours.video_download_url;
  if (!url || !/^https?:/.test(url)) {
    throw new HeygenError("ui_changed", "heygen: completed render has no downloadable video_url");
  }

  // Download the signed mp4 through the authed context.
  const resp = await context.request.get(url, { timeout: e.HEYGEN_NAV_TIMEOUT_MS }).catch(() => null);
  if (!resp || !resp.ok()) {
    throw new HeygenError("ui_changed", `heygen: failed to download rendered mp4 (HTTP ${resp?.status() ?? "n/a"})`);
  }
  const buf = Buffer.from(await resp.body());
  if (buf.length < 1024) {
    throw new HeygenError("ui_changed", `heygen: downloaded mp4 implausibly small (${buf.length} bytes)`);
  }
  return buf;
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

    // 1.5) Record the NEWEST project's video_id (via the project-list API)
    // BEFORE we generate, so the retrieval step can tell OUR new render apart
    // from prior renders already at the top of the list. Best-effort: "" on any
    // hiccup just means retrieval treats the first new completed item as ours.
    const baselineId = await newestItemId(context).catch(() => "");

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

    // 4.5) Set the composer aspect ratio.
    //   - Full-frame avatar  -> 16:9 LANDSCAPE (the synthetic canvas is 1280×720;
    //     a portrait avatar would be letterboxed/cropped in the final video).
    //   - split_2 avatar      -> 9:16 PORTRAIT: the avatar fills only a tall LEFT
    //     half-cell (640×720) at render, so a portrait source fits naturally
    //     while a landscape one would be heavily side-cropped.
    // Best-effort: a no-op if already in the wanted ratio; if the toggle isn't
    // found we proceed (the render still composites what we get).
    const wantPortrait = input.aspectRatio === "portrait";
    const ratioBtn = wantPortrait ? portraitRatioButton(p) : landscapeRatioButton(p);
    const ratioLabel = wantPortrait ? "9:16 portrait toggle" : "16:9 landscape toggle";
    if (await isVisible(ratioBtn, 3000)) {
      await clickFirstVisible(ratioBtn, 10_000, ratioLabel).catch(() => {});
      await p.waitForTimeout(800); // let the canvas re-render to the new ratio
      await shot(p, input.projectId, input.segmentId, wantPortrait ? "portrait" : "landscape");
    }

    // 5) Drive the avatar. Two paths:
    //
    //   AUDIO-DRIVEN (input.audioFilePath set): upload the sliced 69labs
    //   voiceover for this avatar part. HeyGen lip-syncs to it, so the rendered
    //   video length equals the audio length — fixing the avatar/voiceover
    //   duration mismatch. The uploaded audio replaces BOTH the script text AND
    //   the voice picker, so we skip those steps entirely.
    //
    //   SCRIPT-DRIVEN (legacy fallback, no audioFilePath): type the narration
    //   into the script box and let HeyGen's own TTS speak it. Kept so a missing
    //   audio slice degrades to the old behavior rather than failing the render.
    //
    // Done LAST, right before Generate: the photo upload re-renders the composer,
    // and a script filled (or audio attached) before that re-render can get
    // wiped (observed 2026-06-19: the script textarea was empty at Generate).
    if (input.audioFilePath) {
      await uploadAudioTrack(p, input.audioFilePath, e.HEYGEN_NAV_TIMEOUT_MS);
      await shot(p, input.projectId, input.segmentId, "audio_uploaded");
      // Settle so React flushes the photo + audio into form state before submit.
      await p.waitForTimeout(1500);
    } else {
      // NOTE: we do NOT touch the voice in the legacy path. The composer already
      // has a real voice committed by default (the toolbar pill, e.g. "Japan -
      // Voice 2") — opening the voice picker is unnecessary and only risks
      // stranding the flow. HeyGen's audio is discarded at render anyway.
      //
      // The script box is a CONTROLLED React <textarea>; a bare .fill() sets the
      // DOM value but React can overwrite it on the next render. We fill, then
      // VERIFY the value stuck, and fall back to real keystrokes if it didn't.
      const scriptBox = scriptField(p).locator("visible=true").first();
      await scriptBox.fill(input.script, { timeout: e.HEYGEN_NAV_TIMEOUT_MS }).catch(() => {});
      const stuck = await scriptBox.inputValue().catch(() => "");
      if (stuck.trim() !== input.script.trim()) {
        // Re-type with real keystrokes so React's onChange fires per character.
        await scriptBox.fill("").catch(() => {});
        await scriptBox.pressSequentially(input.script, { delay: 1, timeout: e.HEYGEN_NAV_TIMEOUT_MS });
        const stuck2 = await scriptBox.inputValue().catch(() => "");
        if (stuck2.trim().length === 0) {
          await captureDiagnostics(p, input.jobId, "script_not_set");
          throw new HeygenError("ui_changed", "heygen: script field would not accept text");
        }
      }

      // Let the composer SETTLE before submitting. Blur the script box (commit
      // its value) and pause so React flushes the photo + script + voice into
      // form state. Verified 2026-06-19: clicking Generate too fast races the
      // state and HeyGen flashes "Please select a voice" even though a voice IS
      // selected.
      await p.keyboard.press("Tab").catch(() => {});
      await p.waitForTimeout(1500);
    }

    // 7) Kick off the render.
    //
    // IMPORTANT (verified 2026-06-19 against the live /avatar UI): the Generate
    // button — accessible name "Generate for 1 credit" — is ENABLED even when no
    // photo is uploaded. So "button enabled" is NOT proof the composer is ready;
    // the trustworthy readiness signal is the uploaded-photo PREVIEW, which we
    // already waited for at step 4 (selectedPhoto). We re-assert it here so a
    // silently-failed upload fails LOUD now instead of as an empty Projects poll
    // 90s later.
    if (!(await isVisible(selectedPhoto(p), 3000))) {
      await captureDiagnostics(p, input.jobId, "no_photo_before_generate");
      throw new HeygenError(
        "ui_changed",
        "heygen: photo preview missing before Generate — upload did not register",
      );
    }
    const genEnabled = generateButtonEnabled(p);
    try {
      await genEnabled.first().waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      await captureDiagnostics(p, input.jobId, "generate_disabled");
      throw new HeygenError(
        "ui_changed",
        "heygen: Generate button never enabled — photo or script/audio did not register",
      );
    }
    // Click Generate and CONFIRM it took. The button is the SAME element in both
    // visual states — a wide "Generate for 1 credit" text pill OR a compact
    // circular ↑ icon (layout-dependent) — and BOTH carry aria-label="Generate
    // for 1 credit" (verified 2026-06-19). The click is FLAKY: the button's class
    // list includes `data-[loading=true]:tw-pointer-events-none`, so if we click
    // during a transient loading/disabled frame the click silently no-ops and the
    // composer just sits there. We therefore target the stable aria-label, escalate
    // through normal -> force -> DOM click, and RE-CLICK until a positive start
    // signal appears (the button leaving its enabled state / a route to projects).
    const genByLabel = p
      .getByRole("button", { name: /generate/i })
      .locator("visible=true")
      .first();
    let started = false;
    let everClicked = false;
    for (let attempt = 0; attempt < 4 && !started; attempt++) {
      // Make sure it's actually clickable (not mid-loading) before clicking.
      await genByLabel.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      let clicked = false;
      try {
        await genByLabel.click({ timeout: 15_000 });
        clicked = true;
      } catch {
        // Bypass actionability (overlay / pointer-events) on retry.
        try {
          await genByLabel.click({ timeout: 5000, force: true });
          clicked = true;
        } catch {
          // Last resort: dispatch a DOM click straight to the element.
          clicked = await genByLabel
            .evaluate((el) => {
              (el as HTMLElement).click();
              return true;
            })
            .catch(() => false);
        }
      }
      everClicked = everClicked || clicked;
      if (attempt === 0) await shot(p, input.projectId, input.segmentId, "generating");

      // If HeyGen flashed "Please select a voice", the voice didn't commit in
      // time (a state race — a voice IS shown in the toolbar). Explicitly commit
      // one via the picker, then loop to re-click Generate. Best-effort: if the
      // picker flow fails we still retry the click.
      if (await isVisible(voiceRequiredToast(p), 2500)) {
        await commitVoice(p).catch(() => {});
        await p.waitForTimeout(1000);
        continue;
      }

      started = await Promise.race([
        genEnabled
          .first()
          .waitFor({ state: "hidden", timeout: 12_000 })
          .then(() => true)
          .catch(() => false),
        p
          .waitForURL((u) => /\/(projects|video)\b/i.test(u.toString()), { timeout: 12_000 })
          .then(() => true)
          .catch(() => false),
      ]);
    }
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "synthetic.heygen.generate_click",
        projectId: input.projectId,
        segmentId: input.segmentId,
        everClicked,
        started,
      }),
    );
    // SAFEGUARD: do NOT hard-fail when started-detection is unsure. Observed
    // 2026-06-19: HeyGen frequently DID start rendering (the finished video
    // showed up in Projects, costing credits) even on runs we classified as
    // "did not start". Throwing here orphaned those renders and wasted credits.
    // The Projects retrieval below has its own bounded 90s appear-deadline, so
    // it is the safe source of truth: if a NEW card appears we capture it; if
    // none ever appears, retrieveRenderedVideo throws the no_card error. So when
    // unsure, we capture diagnostics, log, and PROCEED to Projects anyway.
    if (!started) {
      await captureDiagnostics(p, input.jobId, "generate_no_start");
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          msg: "synthetic.heygen.generate_uncertain",
          projectId: input.projectId,
          segmentId: input.segmentId,
          note: "started-signal not seen; checking Projects anyway (render may have started)",
        }),
      );
    }

    // Give HeyGen a moment to REGISTER the new project before we poll /projects.
    // Navigating instantly after the click can beat the backend creating the
    // project row, so the grid shows only prior cards. A short settle lets our
    // render appear (the poll loop below still tolerates it being mid-render).
    await p.waitForTimeout(4000);

    // 8–9) Retrieve the finished video from the Projects page (the only place
    // the rendered mp4 exists). Returns the downloaded bytes.
    const videoBytes = await retrieveRenderedVideo(p, context, baselineId);
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

    // Output length. For audio-driven renders the render length equals the
    // uploaded audio, so use its known duration; otherwise fall back to the
    // rough word-count estimate (HeyGen ~ real-time speech).
    const seconds =
      input.audioDurationSeconds && input.audioDurationSeconds > 0
        ? Math.max(2, Math.round(input.audioDurationSeconds))
        : Math.max(2, Math.round(input.script.split(/\s+/).filter(Boolean).length / 2.5));
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

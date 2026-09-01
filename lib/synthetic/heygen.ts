import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { type Page, type BrowserContext, type Locator } from "playwright";
import { getEnv } from "@/lib/env";
import { probeFile } from "@/lib/media/probe";
import { uploadBuffer } from "@/lib/storage";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import {
  claimAccount,
  countUsableAccounts,
  renewLease,
  releaseAccount,
  saveCookies,
  recordSuccess,
  applyDisposition,
  type DecryptedAccount,
} from "@/lib/synthetic/heygen-accounts";
import {
  captureDiagnostics,
} from "@/lib/synthetic/heygen-auth";
import {
  acquireJobPage,
  invalidateWarmSession,
  recordRenderServed,
  recordRenderFailure,
  beginRender,
  endRender,
} from "@/lib/synthetic/heygen-session";
import { inspectPage } from "@/lib/synthetic/heygen-health";
import {
  generateAvatarViaApi,
  heygenApiFallbackEnabled,
  heygenApiFirstEnabled,
} from "@/lib/synthetic/heygen-api";
import { projectAvatarName } from "@/lib/synthetic/avatar-name";
import {
  HeygenError,
  PoolBusyError,
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
  activeRatio,
  ratioButtonsFallback,
  dumpRatioToolbar,
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
  // Avatar III ("Create new shots") flow + Avatar IV avatar-naming.
  avatarsNavEntry,
  avatarShotsNavEntry,
  avatarsSearchBox,
  avatarsLoadError,
  avatarTileByName,
  firstAvatarTile,
  createVideoWithAvatarButton,
  createNewShotsMenuItem,
  avatarMoreMenuOpen,
  avatarModelDropdownTrigger,
  avatarIIIOption,
  avatarModelIsIII,
  avatarShotsLookPreview,
  avatarShotsSwitchLookButton,
  avatarShotsLookModal,
  avatarShotsLookUploadButton,
  avatarShotsLookValidating,
  avatarShotsPhotoAvatarTiles,
  avatarShotsLookTileImages,
  avatarShotsPhotoAvatarTileImage,
  avatarShotsTileClickTarget,
  avatarShotsChooseLookButton,
  avatarShotsLookTileMoreButton,
  avatarShotsLookDeleteMenuItem,
  avatarShotsLookDeleteConfirm,
  avatarLooksDetailReady,
  avatarShotsOrientationTrigger,
  avatarShotsOrientationOption,
  avatarShotsOrientationConfirmed,
  avatarShotsUploadAudioLink,
  avatarShotsAudioInput,
  avatarShotsAudioAttached,
  avatarShotsGenerateButton,
  // Per-project named avatar (Create-Avatar) flow — the wrong-face fix.
  lookModalMyAvatarsCrumb,
  chooseAvatarModal,
  chooseAvatarSearch,
  createAvatarButton,
  createAvatarUploadPhotoItem,
  createVirtualCharacterCard,
  processingAvatarModal,
  nameAvatarDialog,
  avatarNameInput,
  avatarNameCreateButton,
  chooseAvatarTileByName,
  avatarTileMoreButton,
  avatarDeleteMenuItem,
  avatarDeleteConfirmButton,
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
  // Public URL of the SAME audio slice (it's cached to R2 when staged). Used ONLY
  // by the API fallback (generateAvatarViaApi), which can pass audio_url directly
  // instead of re-uploading the bytes as an asset — one fewer API call / failure
  // point. The browser path ignores this (it uploads the local file). Optional:
  // when absent the API path falls back to uploading audioFilePath as an asset.
  audioUrl?: string;
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
  // Which HeyGen model to render with, picked from the doc-highlight color:
  //   "avatar_iv"  (red)    — the Photo-to-video composer that uploads the photo
  //                           directly (the historical default).
  //   "avatar_iii" (orange) — the cheaper "Create new shots" / Avatar-Shots flow
  //                           that reuses a SAVED avatar and applies lip-sync to
  //                           the uploaded audio.
  // Defaults to "avatar_iv" when unset (legacy segments).
  avatarModel?: "avatar_iv" | "avatar_iii";
  // The NAME of the HeyGen saved avatar to use for the Avatar III flow. Set by
  // the user at intake (they create the avatar in HeyGen with this exact name).
  // Avatar III searches the Avatars page for it. Required when avatarModel is
  // "avatar_iii"; ignored by the Avatar IV path (which uploads the photo).
  heygenAvatarName?: string | null;
  // FORCE the API fallback, skipping the browser pool entirely (client 2026-07-07).
  // Set by the avatar worker AFTER a clip has WAITED for a free account past the
  // client's threshold (2 wait cycles OR 30 min with no account available). At
  // that point the clip has been queued long enough that we stop waiting for a
  // browser account and render it via the HeyGen API directly. Ignored (no-op)
  // unless the API fallback is enabled + configured + the job is audio-driven, in
  // which case generateAvatar throws so the clip surfaces the original error.
  forceApi?: boolean;
}

export interface GenerateAvatarResult {
  videoUrl: string; // R2 public URL of the downloaded avatar mp4
  accountId: string; // which account produced it
  seconds: number; // estimated output length (billing)
  // Avatar III only: the post-selection face-verify outcome (see verifySelectedLook).
  // Persisted to job metadata by the processor for durable ground truth on the
  // wrong-avatar-face bug. Absent on the Avatar IV path (no look upload there).
  faceCheck?: FaceCheck;
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
async function uploadAudioTrack(
  page: Page,
  audioPath: string,
  timeoutMs: number,
  audioDurationSeconds?: number,
): Promise<void> {
  // 1) Open the audio-upload modal from the Script panel header. The modal is a
  // portal-rendered div (NOT role="dialog"), so we detect "open" by its visible
  // "Upload Audio" heading. CRITICAL: use waitFor({state:"visible"}), NOT
  // isVisible() — isVisible() returns the CURRENT state immediately (the timeout
  // only bounds locator resolution, it does NOT poll for appearance), so right
  // after the click it returned false before the modal animated in, falsely
  // reporting "modal did not open" even though it opened a beat later. waitFor
  // actually polls up to the timeout.
  // The trigger click can land on a not-yet-settled page (esp. the first segment
  // after a session.recycle, where the SPA is still painting through the proxy):
  // the click is consumed but the modal never animates in, and a single wait then
  // false-fails "modal did not open" — burning the whole ~4min attempt before the
  // rotate. Re-click + re-wait a few times so a slow/settling page recovers in
  // place instead of throwing. Each wait is short; the loop is the real budget.
  const heading = audioModalHeading(page).locator("visible=true").first();
  let modalOpen = false;
  // 4 attempts (was 3): right after a session recycle the SPA paints slowly
  // through the stealth+proxy path, and the first click or two can land before
  // the modal animates in. The extra re-click cheaply recovers that case in
  // place instead of throwing "modal did not open" and burning the attempt.
  for (let attempt = 0; attempt < 4 && !modalOpen; attempt++) {
    await clickFirstVisible(audioUploadTrigger(page), timeoutMs, "audio upload button").catch(() => {});
    try {
      await heading.waitFor({ state: "visible", timeout: 15_000 });
      modalOpen = true;
    } catch {
      // not open yet — let the page settle, then re-click the trigger
      await page.waitForTimeout(2_000);
    }
  }
  if (!modalOpen) {
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
  // Wait for the Confirm-Audio modal to appear — BUT race it against the audio
  // already being attached (the Upload-Audio modal closing). On the fast-attach
  // build the Confirm modal never appears at all; blocking the full setup budget
  // (timeoutMs, up to 90s) for a heading that will never show needlessly stalled
  // every such job. So resolve as soon as EITHER the Confirm heading shows OR the
  // Upload heading is gone (audio committed directly). The commit loop below then
  // detects the already-committed state via modalsGone() and returns immediately.
  await Promise.race([
    confirmHeading.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
    audioModalHeading(page).first().waitFor({ state: "hidden", timeout: timeoutMs }).catch(() => {}),
  ]);
  // The "Add audio" button stays disabled until HeyGen finishes PROCESSING the
  // uploaded track (it has to decode the file and load its duration into the
  // preview player). That processing time scales with the audio LENGTH: a 3s clip
  // enables the button in a couple seconds, but a 25-30s clip can take well over a
  // minute. The old fixed ~40s poll (8 × ~5s) was fine for short parts but
  // false-failed long ones with "'Add audio' never became clickable" — and with a
  // single-account pool there is no other account to rotate to, so the job looped
  // until the stall-sweeper killed it. So budget the poll by duration: a generous
  // floor for short clips, growing ~6× the audio length, capped so a genuinely
  // stuck modal still fails in bounded time.
  //
  // Floor raised 45s -> 90s on 2026-06-26: with stealth, a SHORT clip
  // (segment e1176845, ~$0.10 render) still false-failed "Add audio never
  // clickable" at 45s because the whole modal paints slowly through the proxy —
  // it then rotated and succeeded, wasting a ~4min attempt.
  // Floor raised 90s -> 120s and cap 180s -> 240s on 2026-06-29: the observed
  // false-fail ("'Add audio' confirm button never became clickable", segment
  // e1176845) still hit the 90s floor right after a recycle, where the whole
  // modal paints especially slowly. Degrading to the script path there shipped
  // WRONG (HeyGen TTS) audio. A more generous floor lets the correct-audio
  // commit finish; the 240s cap still bounds a genuinely stuck modal.
  const dur = Number.isFinite(audioDurationSeconds) ? Math.max(0, audioDurationSeconds as number) : 0;
  const confirmBudgetMs = Math.min(240_000, Math.max(120_000, Math.round(dur * 6_000)));
  const perPollMs = 3_000;
  const maxPolls = Math.ceil(confirmBudgetMs / (perPollMs + 4_000));
  // Commit + VERIFY (hardened 2026-06-29). The old loop set committed=true as soon
  // as click() returned — but a click that landed on a stale/wrong button (the old
  // broad page-scoped selector) returned fine WITHOUT closing the modal, so we
  // proceeded with the audio never attached and later degraded to HeyGen TTS =
  // WRONG audio on the clip. Now a poll counts as committed ONLY when the Confirm
  // Audio modal actually CLOSES after the click. If it doesn't, we keep polling
  // (re-finding the button each iteration) until the budget runs out — so an
  // intermittent mis-click self-heals instead of silently producing wrong audio.
  //
  // We also gate the click on isEnabled(): the button is VISIBLE the whole time
  // but DISABLED while HeyGen decodes the track. Waiting on "visible" returned
  // instantly and leaned on click()'s implicit enabled-wait; polling isEnabled()
  // explicitly makes "still processing" vs "stuck" observable and avoids firing a
  // click into a disabled button.
  // ALREADY-COMMITTED detection (added 2026-06-29). Some HeyGen builds — and the
  // common fast-decode case for a SHORT clip — attach the audio DIRECTLY without
  // ever surfacing a separate, persistent "Confirm Audio" modal with a clickable
  // "Add audio" button: the file is picked, the track lands in the Script panel,
  // and there is no button left to click. The old loop kept polling for a
  // "Add audio" button that no longer exists, exhausted the whole 120-240s budget,
  // and threw "'Add audio' confirm button never became clickable" — a FALSE
  // failure (the audio was already attached; see the segment 6a1f54f2 error
  // screenshot: audio track present in the Script panel, NO modal, NO button).
  // So before/while hunting the button, treat "both upload modals gone" as
  // success: if neither the Upload-Audio heading nor the Confirm-Audio heading is
  // visible, the audio has already committed to the composer.
  const modalsGone = async (): Promise<boolean> => {
    const uploadVisible = await isVisible(audioModalHeading(page), 500);
    const confirmVisible = await isVisible(audioConfirmHeading(page), 500);
    return !uploadVisible && !confirmVisible;
  };

  let committed = false;
  // If the audio attached instantly (no lingering modal), we're already done.
  if (await modalsGone()) {
    committed = true;
  }
  for (let i = 0; i < maxPolls && !committed; i++) {
    try {
      // If the modal(s) closed since the last poll, the audio committed — done.
      // (Handles the fast-attach build where no clickable button ever appears.)
      if (await modalsGone()) {
        committed = true;
        break;
      }
      // Re-resolve the button each poll: .first() is evaluated lazily, so a modal
      // that finished painting between polls is picked up without a stale handle.
      const btn = confirmBtn;
      await btn.waitFor({ state: "visible", timeout: 4000 });
      if (!(await btn.isEnabled())) {
        // Track still decoding — not stuck. Wait and re-poll.
        await page.waitForTimeout(perPollMs);
        continue;
      }
      await btn.click({ timeout: 6000 });
      // Verify the click actually committed: the Confirm Audio modal must close.
      // If it lingers, the click hit the wrong element (or didn't register) — do
      // NOT mark committed; loop and try again.
      const closed = await confirmHeading
        .waitFor({ state: "hidden", timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (closed) {
        committed = true;
      } else {
        await page.waitForTimeout(perPollMs);
      }
    } catch {
      // The button wasn't visible this round. That's the EXPECTED state for the
      // fast-attach build (no button at all) — so re-check the modals-gone signal
      // before sleeping, otherwise we'd burn the whole budget waiting for a button
      // that will never appear on an already-committed composer.
      if (await modalsGone()) {
        committed = true;
        break;
      }
      await page.waitForTimeout(perPollMs);
    }
  }
  if (!committed) {
    throw new HeygenError("ui_changed", "heygen: 'Add audio' confirm button never became clickable");
  }

  // 5) Both modals must be gone for the audio to be committed to the composer.
  // The Confirm heading was already verified hidden inside the commit loop; here
  // we also clear the Upload modal heading and do a final guard against either
  // modal lingering (which would leave the audio unattached and Generate disabled).
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
//
// LEGACY V1 (cookie-authed, api2 internal host). Still used when HEYGEN_RETRIEVAL_V3
// is off. This is the last /v1/ call in the codebase — the one that trips HeyGen's
// "still on V1/V2 APIs" deprecation notice — so it is on its way out; see
// fetchProjectItems + the HEYGEN_RETRIEVAL_V3 flag in env.ts.
const HEYGEN_ITEMS_API =
  "https://api2.heygen.com/v1/project/items?limit=20&filter_groups=avatar_video&sort_key=created_ts&sort_order=desc";

// PUBLIC v3 auth header (same as heygen-api.ts). x-api-key, not a cookie.
const HEYGEN_V3_AUTH_HEADER = "x-api-key";

interface HeygenProjectItem {
  video_id: string;
  status: string; // "completed" | "processing" | "pending" | "failed" | ...
  duration?: number;
  // HeyGen inserts a PLACEHOLDER row the instant Generate is clicked: it has a
  // created_ts but NO video_id and a null/processing status, and is promoted to a
  // real video_id ~10s+ later (longer under load). We treat a fresh placeholder as
  // proof OUR render started — see awaitNewItemId / everSawOurs. Verified against
  // the live /v1/project/items API 2026-07-10. NOTE (v3): the public /v3/videos
  // list did not surface any pre-completion rows in probing, so on the v3 path the
  // placeholder branch simply never fires — the title-filtered poll below is the
  // signal that our render exists instead (see fetchProjectItems).
  created_ts?: number;
  video_url?: string;
  video_download_url?: string;
  error_message?: string;
  // The render's TITLE. Browser + API renders are both titled
  // "synthetic <projectId> <segmentId>" (see heygen-api.ts createAvatarIiiVideo).
  // On the v3 path this is the pinning lever: GET /v3/videos?title=<segmentId>
  // filters server-side to just our segment's render(s) — probe-confirmed.
  title?: string;
  // HeyGen V1 reports the render's shape directly on the item (verified 2026-07):
  //   aspect_ratio: "16:9" | "9:16" | ...   orientation: "landscape" | "portrait"
  // Both Avatar IV and Avatar III (Avatar-Shots) renders appear in the SAME
  // avatar_video list, so orientation is the cleanest signal to skip a wrong-
  // aspect render BEFORE downloading it (the file probe remains the final gate).
  // NOTE (v3): GET /v3/videos does NOT return these fields (probe-confirmed), so on
  // the v3 path the early aspect gate no-ops and the file probe is the sole aspect
  // authority — which it already was.
  aspect_ratio?: string;
  orientation?: string;
}

// A single row from GET /v3/videos (public REST). Mapped into HeygenProjectItem by
// fetchProjectItems so every downstream gate is source-agnostic.
interface HeygenV3VideoRow {
  id?: string;
  status?: string;
  title?: string | null;
  created_at?: number | null;
  duration?: number | null;
  video_url?: string | null;
  error?: { message?: string } | string | null;
}

// HeyGen's created_ts is Unix SECONDS, but be defensive: normalize a value that
// looks like milliseconds (13+ digits) down to seconds so the freshness guard
// can't silently mis-compare units. Returns null when absent/non-numeric so the
// caller falls back to the baseline-only test rather than over-rejecting.
function createdSeconds(it: HeygenProjectItem): number | null {
  const v = it.created_ts;
  if (typeof v !== "number" || !isFinite(v) || v <= 0) return null;
  return v > 1e12 ? Math.floor(v / 1000) : v;
}

// Fetch the avatar-video list. Two sources behind the HEYGEN_RETRIEVAL_V3 flag:
//   • v3 (public REST, x-api-key): GET /v3/videos, optionally filtered to a single
//     segment by `titleFilter` (server-side substring match — probe-confirmed). No
//     browser cookie needed; `context` is ignored on this path. v3 returns no sort,
//     so we sort the mapped rows newest-first in memory to preserve the ordering
//     the downstream gates assume (candidates[0] == newest).
//   • v1 (legacy, cookie-authed internal api2 host): the original call, unchanged.
// Both return the SAME HeygenProjectItem shape, so every caller/gate is agnostic.
async function fetchProjectItems(
  context: BrowserContext,
  titleFilter?: string,
): Promise<HeygenProjectItem[]> {
  const e = env();
  if (e.HEYGEN_RETRIEVAL_V3) {
    const key = e.HEYGEN_API_KEY;
    if (!key) {
      // Misconfiguration guard: v3 retrieval is on but no key. Return empty so the
      // caller keeps polling / falls back rather than throwing on every tick; the
      // startup log (attemptOnAccount) surfaces the missing key loudly.
      return [];
    }
    const q = new URLSearchParams({ limit: "100" });
    if (titleFilter) q.set("title", titleFilter);
    const url = `${e.HEYGEN_API_BASE_URL}/v3/videos?${q}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { [HEYGEN_V3_AUTH_HEADER]: key },
      signal: AbortSignal.timeout(e.HEYGEN_NAV_TIMEOUT_MS),
    }).catch(() => null);
    if (!resp || !resp.ok) return [];
    const json = (await resp.json().catch(() => null)) as { data?: HeygenV3VideoRow[] } | null;
    const rows = json?.data ?? [];
    const mapped: HeygenProjectItem[] = rows
      .filter((r): r is HeygenV3VideoRow & { id: string } => typeof r.id === "string" && r.id.length > 0)
      .map((r) => {
        const errMsg =
          typeof r.error === "string" ? r.error : r.error?.message ? r.error.message : undefined;
        return {
          video_id: r.id,
          status: String(r.status ?? ""),
          duration: typeof r.duration === "number" ? r.duration : undefined,
          created_ts: typeof r.created_at === "number" ? r.created_at : undefined,
          video_url: r.video_url ?? undefined,
          // v3 has no separate download URL; video_url is the signed CDN link.
          video_download_url: undefined,
          error_message: errMsg,
          title: r.title ?? undefined,
          // v3 does not report shape — leave aspect fields undefined so the early
          // aspect gate no-ops and the file probe stays authoritative.
          aspect_ratio: undefined,
          orientation: undefined,
        };
      });
    // v3 gives no sort param; replicate v1's created_ts DESC so "newest-first"
    // assumptions (candidates[0]) hold.
    mapped.sort((a, b) => (b.created_ts ?? 0) - (a.created_ts ?? 0));
    return mapped;
  }

  // Legacy v1 path (cookie-authed). titleFilter is ignored — the v1 endpoint has no
  // title filter; downstream baseline/created_ts/pin gates do the scoping.
  const resp = await context.request.get(HEYGEN_ITEMS_API, { timeout: e.HEYGEN_NAV_TIMEOUT_MS }).catch(() => null);
  if (!resp || !resp.ok()) return [];
  const json = (await resp.json().catch(() => null)) as { data?: { items?: HeygenProjectItem[] } } | null;
  return json?.data?.items ?? [];
}

// The FULL set of video_ids present before we generate. Used to pin retrieval to
// the EXACT render we just made: after clicking Generate, the one id that is NOT
// in this set is unambiguously ours — no inference from "newest" or duration.
// `titleFilter` (the segmentId) scopes the v3 query to just our segment; on v1 it
// is ignored (the whole avatar list is the baseline, as before).
async function baselineItemIds(
  context: BrowserContext,
  titleFilter?: string,
): Promise<Set<string>> {
  const items = await fetchProjectItems(context, titleFilter);
  return new Set(items.map((it) => it.video_id).filter(Boolean));
}

// After Generate, poll the list until a NEW video_id (not in the pre-generate
// baseline set) appears, and return it. This is OUR render's stable id. Polls
// within `appearMs` — but note HeyGen first inserts a null-id PLACEHOLDER and only
// promotes it to a real video_id ~10s+ later (much longer under load), so callers
// must allow a generous appearMs (~120s) or the pin misses on a slow promotion.
// Returns "" if no real video_id appears (caller falls back to the gated
// newest-non-baseline retrieval, so a missed pin degrades, never hard-fails).
async function awaitNewItemId(
  context: BrowserContext,
  baseline: Set<string>,
  appearMs: number,
  waitMs: number,
  sleep: (ms: number) => Promise<void>,
  // Unix SECONDS just before our Generate click. A candidate must be both
  // not-in-baseline AND created at/after this time to be OURS — created_ts is the
  // authoritative guard against pinning a sibling project's render from the shared
  // account list. 0 disables the time guard (legacy behavior).
  minCreatedTs = 0,
  // The segmentId — scopes the v3 query server-side to just our segment's render(s)
  // so the poll sees ~1 row instead of the whole account. Ignored on v1.
  titleFilter?: string,
): Promise<string> {
  const deadline = Date.now() + appearMs;
  while (Date.now() < deadline) {
    const items = await fetchProjectItems(context, titleFilter);
    // Newest-first list: the first id that is NOT in the baseline AND was created
    // at/after our Generate click is the freshest new render that is genuinely
    // ours. (A single avatar Generate creates exactly one new item.) The
    // created_ts gate rejects a neighbor project's render that is also
    // non-baseline but was created before we clicked.
    const fresh = items.find((it) => {
      if (!it.video_id || baseline.has(it.video_id)) return false;
      if (minCreatedTs <= 0) return true;
      const ts = createdSeconds(it);
      // If HeyGen omits created_ts, fall back to the baseline-only test rather
      // than rejecting a valid render.
      return ts === null || ts >= minCreatedTs;
    });
    if (fresh) return fresh.video_id;
    await sleep(waitMs);
  }
  return "";
}

// Retrieve the finished avatar video via the project-list API. Polls until OUR
// render reaches status "completed", then downloads its signed video_url. Throws
// a classified HeygenError on timeout / failure.
//
// IDENTITY: the strongest signal is `pinnedVideoId` (see below) — the exact id
// of the render we just created. When present we poll only that item. `baselineId`
// (the newest pre-generate id) and the duration/aspect gates remain as the
// fallback identity when no pin was captured.
//
// `expectedSeconds` is the duration we EXPECT (the uploaded audio slice length).
// It's the permanent fix for a real bug: when a segment is REGENERATED, HeyGen's
// project list holds several renders of the same segment (one per attempt).
// Picking "newest non-baseline completed" grabbed whichever item happened to be
// at the top — which could be a STALE shorter render (e.g. a prior 10s attempt)
// while the fresh 25s render was still processing. HeyGen reported the right 25s
// on its side, but we downloaded the wrong 10s item.
//
// Defense in depth, both gated on expectedSeconds (legacy script path with no
// expectation keeps the old newest-non-baseline behavior):
//   1) Candidate filter on HeyGen's reported `duration` — skip items whose
//      length is materially OFF (a stale 10s render, or a too-long 48s one).
//   2) POST-DOWNLOAD PROBE — after downloading, ffprobe the ACTUAL file and
//      reject it if its length is materially off (too short OR too long). This
//      catches the case HeyGen's metadata is wrong or the signed URL serves a
//      partial: we never RETURN a mismatched file, we keep polling within the
//      render budget for the one whose length matches the uploaded audio.
//      The gate is TWO-SIDED — a 48s file returned for a 25.3s audio slice
//      (an older/multi-part or different-segment render in the same list) is
//      the duration-mismatch bug this gate exists to prevent.
// Only #2 is authoritative (bytes don't lie); #1 just avoids wasted downloads.
//
// `expectedAspect` adds the same defense for ORIENTATION. A regenerate (or a
// prior run that used the other aspect) leaves renders of BOTH orientations in
// the list — same segment, same ~duration — so the duration gate alone can't
// tell a 16:9 landscape avatar from a 9:16 portrait one. We probe the actual
// file's width/height and reject the wrong orientation, so a full-frame avatar
// (landscape) never gets a portrait file and vice versa. null = no aspect gate.
// `pinnedVideoId` is the EXACT render we just created (captured at generate time
// by diffing the project list — the one new id that appeared). When set, we poll
// ONLY that item to completion and ignore every other render in the shared list,
// which removes the "newest matching" ambiguity entirely: a same-length render
// of a DIFFERENT segment can no longer be picked. The duration/aspect probe
// gates still run on the pinned item as a last-resort integrity check. "" = no
// pin (the pin wasn't captured); falls back to the gated newest-non-baseline scan.
async function retrieveRenderedVideo(
  page: Page,
  context: BrowserContext,
  baselineId = "",
  expectedSeconds = 0,
  expectedAspect: "landscape" | "portrait" | null = null,
  pinnedVideoId = "",
  // Unix SECONDS just before our Generate click. On the no-pin fallback (newest-
  // non-baseline scan) this rejects any candidate created BEFORE we clicked —
  // i.e. a sibling project's render in the shared list. 0 disables the guard.
  minCreatedTs = 0,
  // The segmentId — on the v3 path, scopes the project-list poll server-side to
  // just our segment's render(s). Ignored on v1.
  titleFilter?: string,
): Promise<Buffer> {
  const e = env();
  const deadline = Date.now() + e.HEYGEN_RENDER_TIMEOUT_MS;
  const appearDeadline = Date.now() + 180_000; // our item must show up within 3 min
  // Tolerance: a render within ~2s (or 15%) of the expected length is accepted.
  // The gate is TWO-SIDED — a render that is materially SHORTER is a partial/
  // stale render, and one that is materially LONGER is a different/older render
  // (e.g. a pre-coalesce multi-part avatar, or another segment's longer video
  // sitting in the same account's project list). Both must be rejected: a 48s
  // file returned for a 25.3s audio slice is exactly the duration-mismatch bug
  // this gate exists to prevent. We keep polling for the render that actually
  // matches the uploaded audio length.
  const tol = expectedSeconds > 0 ? Math.max(2, expectedSeconds * 0.15) : 0;
  const minAcceptable = expectedSeconds > 0 ? expectedSeconds - tol : 0;
  const maxAcceptable = expectedSeconds > 0 ? expectedSeconds + tol : 0;
  const durOk = (d: number | undefined): boolean => {
    if (minAcceptable <= 0) return true; // no expectation
    if (typeof d !== "number" || d <= 0) return true; // HeyGen didn't report — defer to the probe
    return d >= minAcceptable && d <= maxAcceptable;
  };
  // Orientation of a probed file: landscape (w>h), portrait (h>w), or null.
  const aspectOf = (w: number | null, h: number | null): "landscape" | "portrait" | null => {
    if (!w || !h || w === h) return null;
    return w > h ? "landscape" : "portrait";
  };
  const probeGateOn = minAcceptable > 0 || expectedAspect != null;

  // Download a signed URL and probe its REAL duration + dimensions. Returns null
  // on a failed download so the caller keeps polling rather than throwing.
  const downloadAndProbe = async (
    url: string,
  ): Promise<{ buf: Buffer; seconds: number; aspect: "landscape" | "portrait" | null } | null> => {
    // v3's video_url is a signed CDN link — no cookie needed, so use a plain fetch
    // (keeps retrieval independent of the browser context). v1 downloads through the
    // authed browser context as before.
    let buf: Buffer;
    if (e.HEYGEN_RETRIEVAL_V3) {
      const resp = await fetch(url, { signal: AbortSignal.timeout(e.HEYGEN_NAV_TIMEOUT_MS) }).catch(
        () => null,
      );
      if (!resp || !resp.ok) return null;
      buf = Buffer.from(await resp.arrayBuffer());
    } else {
      const resp = await context.request.get(url, { timeout: e.HEYGEN_NAV_TIMEOUT_MS }).catch(() => null);
      if (!resp || !resp.ok()) return null;
      buf = Buffer.from(await resp.body());
    }
    if (buf.length < 1024) return null;
    if (!probeGateOn) return { buf, seconds: 0, aspect: null }; // legacy path: no probe gate
    const tmpPath = path.join(os.tmpdir(), `heygen_probe_${Date.now()}_${Math.round(buf.length)}.mp4`);
    try {
      await fs.writeFile(tmpPath, buf);
      const probed = await probeFile(tmpPath).catch(() => ({ durationSeconds: 0, width: null, height: null }));
      return { buf, seconds: probed.durationSeconds, aspect: aspectOf(probed.width, probed.height) };
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  };

  let everSawOurs = false;
  let sawShort = false; // saw a completed/downloaded item that was too short
  let sawWrongLength = false; // saw a completed item that was too LONG
  let sawWrongAspect = false; // saw a completed item with the wrong orientation
  let lastShortSeconds = 0;
  let lastWrongLengthSeconds = 0;
  while (Date.now() < deadline) {
    const items = await fetchProjectItems(context, titleFilter);
    // Candidates. When we captured the exact id of OUR render at generate time,
    // poll ONLY that item — no other render in the shared list can be mistaken
    // for ours. Otherwise fall back to "every item that isn't the pre-generate
    // baseline" (a regenerate leaves several of our own prior renders in the
    // list), disambiguated downstream by the duration/aspect gates.
    const createdOk = (it: HeygenProjectItem): boolean => {
      // Only enforce when we have a click time AND HeyGen reported created_ts;
      // otherwise defer to the baseline/duration gates rather than over-reject.
      if (minCreatedTs <= 0) return true;
      const ts = createdSeconds(it);
      return ts === null || ts >= minCreatedTs;
    };
    const candidates = pinnedVideoId
      ? items.filter((it) => it.video_id === pinnedVideoId)
      : // No pin: newest non-baseline render that was ALSO created at/after our
        // Generate click — the created_ts guard stops the shared-account list
        // from handing us a previous project's render on the fallback path.
        items.filter((it) => it.video_id && it.video_id !== baselineId && createdOk(it));

    // PLACEHOLDER PRESENT = our render started. HeyGen inserts a null-id row at
    // Generate time and promotes it to a real video_id ~10s+ later. That row has
    // NO video_id (so it's not a `candidate` above), but a created_ts at/after our
    // click uniquely identifies it as OURS on a per-account render (avatar
    // concurrency is 1). Seeing it means generation IS running — so we must NOT
    // trip the "never appeared … generation likely never started" early-exit while
    // it's still promoting. Only meaningful with the created_ts guard on.
    if (minCreatedTs > 0 && !everSawOurs) {
      const sawPlaceholder = items.some((it) => {
        if (it.video_id) return false; // real rows are handled as candidates
        const ts = createdSeconds(it);
        return ts !== null && ts >= minCreatedTs;
      });
      if (sawPlaceholder) {
        everSawOurs = true;
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            msg: "synthetic.heygen.render_placeholder_seen",
            note: "HeyGen placeholder row present — render started, awaiting video_id promotion",
          }),
        );
      }
    }
    const completed = candidates.filter((it) => {
      const s = (it.status ?? "").toLowerCase();
      return s === "completed" || s === "success" || s === "done";
    });

    // Try each completed candidate whose HeyGen-reported duration looks right
    // (or unknown), newest first. Download + probe; accept the first whose ACTUAL
    // file duration AND orientation match. This is the authoritative gate.
    for (const cand of completed) {
      if (!durOk(cand.duration)) {
        sawShort = true;
        lastShortSeconds = cand.duration ?? lastShortSeconds;
        continue;
      }
      // EARLY orientation gate using the item's OWN aspect_ratio/orientation (no
      // download needed). Both Avatar IV and Avatar III renders share the list, so
      // a wrong-orientation render (e.g. a 9:16 render when we asked for 16:9) is
      // skipped here BEFORE spending a download — the file probe below is still the
      // final authority when the item doesn't report a shape.
      if (expectedAspect) {
        const itemAspect =
          cand.orientation === "landscape" || cand.orientation === "portrait"
            ? (cand.orientation as "landscape" | "portrait")
            : cand.aspect_ratio === "16:9"
            ? "landscape"
            : cand.aspect_ratio === "9:16"
            ? "portrait"
            : null;
        if (itemAspect && itemAspect !== expectedAspect) {
          sawWrongAspect = true;
          continue;
        }
      }
      const url = cand.video_url || cand.video_download_url;
      if (!url || !/^https?:/.test(url)) continue;
      const got = await downloadAndProbe(url);
      if (!got) continue; // transient download issue — re-poll
      if (minAcceptable > 0 && got.seconds > 0 && got.seconds < minAcceptable) {
        // The file itself is short — HeyGen's metadata lied or it served a
        // partial. Do NOT return it; keep waiting for the full render.
        sawShort = true;
        lastShortSeconds = got.seconds;
        continue;
      }
      if (maxAcceptable > 0 && got.seconds > maxAcceptable) {
        // The file is materially LONGER than the uploaded audio — a different or
        // older render (e.g. a pre-coalesce multi-part avatar, or another
        // segment's video in this account's list). Returning it is the 48s-for-
        // 25.3s mismatch bug. Reject and keep polling for the matching render.
        sawWrongLength = true;
        lastWrongLengthSeconds = got.seconds;
        continue;
      }
      if (expectedAspect && got.aspect && got.aspect !== expectedAspect) {
        // Wrong orientation — a stale render of the other aspect ratio. Skip it
        // and keep looking for the one matching this block's expected aspect.
        sawWrongAspect = true;
        continue;
      }
      everSawOurs = true;
      return got.buf; // verified duration + orientation (or legacy path)
    }

    if (candidates.length > 0) {
      everSawOurs = true;
      // Surface a hard HeyGen-side failure on the newest candidate.
      const newest = candidates[0];
      const ns = (newest.status ?? "").toLowerCase();
      if (ns === "failed" || ns === "error") {
        throw new HeygenError(
          "ui_changed",
          `heygen: render failed on HeyGen side${newest.error_message ? ` — ${newest.error_message}` : ""}`,
        );
      }
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

  throw new HeygenError(
    "ui_changed",
    sawWrongAspect
      ? `heygen: only a wrong-orientation render appeared within the render budget — expected ${expectedAspect}, the matching render never finalized`
      : sawWrongLength
      ? `heygen: only a wrong-length render (~${Math.round(lastWrongLengthSeconds)}s vs expected ${Math.round(expectedSeconds)}s) was available within the render budget — the matching-length render never finalized`
      : sawShort
      ? `heygen: only a short render (~${Math.round(lastShortSeconds)}s < expected ${Math.round(expectedSeconds)}s) was available within the render budget — the full-length render never finalized`
      : "heygen: render did not complete within the render budget",
  );
}

// Upload the sliced 69labs audio on the Avatar-Shots (Avatar III) page. Unlike
// the /avatar Photo-to-video composer (a two-step Upload-Audio/Confirm-Audio
// modal handled by uploadAudioTrack), the Avatar-Shots page attaches audio via a
// "upload/record" link that opens the native file chooser directly; the track
// then appears INLINE (name + play control + a "Voice Mirroring" checkbox) with
// no confirm modal. Throws a classified HeygenError if the audio never attaches.
async function uploadAvatarShotsAudio(
  page: Page,
  audioPath: string,
  timeoutMs: number,
): Promise<void> {
  // 1) Click the "upload/record" affordance to open the audio modal. This is the
  // SAME "Record Audio / Upload Audio" modal as the /avatar composer — it opens
  // DEFAULTED TO THE "Record Audio" TAB, which prompts for the microphone and
  // strands the run (observed 2026-07). So opening the modal is only step one; we
  // MUST switch to the Upload Audio tab next.
  const heading = audioModalHeading(page).locator("visible=true").first();
  let modalOpen = false;
  for (let attempt = 0; attempt < 4 && !modalOpen; attempt++) {
    await clickFirstVisible(avatarShotsUploadAudioLink(page), timeoutMs, "Avatar Shots upload/record link").catch(() => {});
    modalOpen = await heading
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!modalOpen) await page.waitForTimeout(2_000);
  }
  if (!modalOpen) {
    throw new HeygenError("ui_changed", "heygen: Avatar Shots audio modal did not open");
  }

  // 2) Switch to the "Upload Audio" tab (away from the default "Record Audio",
  // which is what triggered the mic-permission prompt). Retry a couple of times —
  // the tab must be active before the dropzone/file input exists.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await isVisible(uploadAudioTab(page), 3000)) {
      await clickFirstVisible(uploadAudioTab(page), timeoutMs, "Upload Audio tab").catch(() => {});
    }
    // The dropzone / file input only mounts on the Upload tab; use it as the
    // "tab is active" signal.
    if (await isVisible(audioDropzone(page), 2500)) break;
    await page.waitForTimeout(800);
  }

  // 3) Upload the file via the native chooser the dropzone opens; fall back to a
  // hidden <input type=file>.
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: timeoutMs }),
      clickFirstVisible(audioDropzone(page), timeoutMs, "audio dropzone"),
    ]);
    await chooser.setFiles(audioPath);
  } catch (err) {
    if ((await audioFileInput(page).count()) > 0) {
      await audioFileInput(page).first().setInputFiles(audioPath);
    } else if ((await avatarShotsAudioInput(page).count()) > 0) {
      await avatarShotsAudioInput(page).first().setInputFiles(audioPath);
    } else {
      throw new HeygenError("ui_changed", "heygen: could not open Avatar Shots audio file chooser", err);
    }
  }

  // 4) Commit: picking a file advances to a "Confirm Audio" step; click its
  // commit button once enabled, then confirm the modal closed. Mirrors the
  // /avatar Upload-Audio flow. Tolerates a build that attaches directly (no
  // confirm modal) by treating the modal closing as success.
  await Promise.race([
    audioConfirmHeading(page).locator("visible=true").first().waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {}),
    audioModalHeading(page).first().waitFor({ state: "hidden", timeout: timeoutMs }).catch(() => {}),
  ]);
  const confirmBtn = audioConfirmButton(page).locator("visible=true").first();
  const modalsGone = async () =>
    !(await isVisible(audioModalHeading(page), 500)) && !(await isVisible(audioConfirmHeading(page), 500));
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await modalsGone()) break;
    if (await confirmBtn.isEnabled().catch(() => false)) {
      await confirmBtn.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(3000);
  }

  // 5) Confirm the track attached — an <audio> element / the file name / a "Voice
  // Mirroring" affordance appears once HeyGen decoded it.
  await avatarShotsAudioAttached(page)
    .locator("visible=true")
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .catch(() => {
      throw new HeygenError("ui_changed", "heygen: Avatar Shots audio did not attach after upload");
    });
}

// Normalize an <img> src for look-tile identity comparison: origin + pathname,
// dropping the query string. HeyGen serves look thumbnails via SIGNED urls whose
// query params refresh between reads/sessions — a raw string compare makes an
// UNCHANGED tile look "new" (and a re-read of our own tile look foreign).
export function lookSrcKey(s: string): string {
  try {
    const u = new URL(s);
    return u.origin + u.pathname;
  } catch {
    return s;
  }
}

// The STABLE, surface-independent identity of a look photo: HeyGen embeds a
// `/talking_photo/<group>/<hash>` segment in every rendition of a look's
// thumbnail (the `tr:…` transform prefix and query differ between the modal,
// the composer preview, and the detail page, so a full-URL compare fails across
// surfaces — but this path segment is identical everywhere). Returns "" when the
// src has no talking_photo segment (e.g. the seed avatar's default preview).
//
// Used to record which look each Avatar III render committed (the clicked tile's
// key), persisted to job metadata for durable diagnosis of the wrong-avatar-face
// bug — see FaceCheck. Independent of the "Validating photo" text (which never
// appears on some accounts, or is skipped when HeyGen DEDUPES a repeat photo to an
// existing asset — the exact case that dropped us onto the unsound new-src fallback
// and rendered another project's face).
export function lookAssetKey(s: string): string {
  const m = /talking_photo\/([^/?#]+)\/([^/?#.]+)/.exec(s);
  return m ? `talking_photo/${m[1]}/${m[2]}` : "";
}

// Durable record of which avatar a render committed, persisted to job metadata so
// the wrong-avatar-face bug can be diagnosed from the DB (not ephemeral worker
// logs). `avatarName` is the render's per-project NAMED avatar (projectAvatarName);
// `ok:false` means the pre-Generate verify POSITIVELY saw a different avatar
// committed (the caller throws — never render a stranger's face). Inconclusive
// verifies stay ok:true with a reason: selection is by exact-name search, which is
// already strong, and we never hard-fail a good render on an unreadable modal.
export interface FaceCheck {
  ok: boolean;
  reason?: string;
  avatarName?: string;
}

// projectAvatarName (`va-<projectId8>-<imageSha6>`) moved to avatar-name.ts so
// the API fallback can derive the same name without a circular import — it
// looks avatars up by this exact name to reuse the ones this browser flow
// creates. Re-exported here for existing callers.
export { projectAvatarName };


// Collect the srcs of ALL look tiles in the open Switch-look grid — including
// tiles currently VIRTUALIZED out of view — by scrolling the grid container
// end-to-end and accumulating at each step. The grid renders only ~9 tiles at a
// time, so a single snapshot misses off-screen tiles; that incomplete baseline
// is exactly what let a PRE-EXISTING tile (another project's uploaded face) that
// scrolled/lazy-loaded in later pass as "new" and get selected as the look —
// the wrong-avatar-face bug (2026-07-18). Returns NORMALIZED keys (see
// lookSrcKey; the same normalization is inlined below because this runs in page
// context). Restores the scroll position when done. Best-effort: an unscrollable
// or missing grid returns whatever is visible.
// TSX/ESBUILD CONSTRAINT (verified live 2026-07-18): the worker AND scripts run
// via tsx, whose esbuild transform wraps NAMED function declarations (including
// `const f = () => {}`) in a `__name()` helper — which does NOT exist inside the
// browser page, so any evaluate/evaluateAll callback that declares an inner named
// helper throws "ReferenceError: __name is not defined" at runtime. Every
// page-context callback below therefore INLINES its logic (the src-normalization
// block is deliberately duplicated instead of factored into a helper).
export async function sweepLookTileSrcs(p: Page): Promise<string[]> {
  return p.evaluate(async () => {
    const cardSel = '[data-pacific-component="PrivatePhotoAvatarCard"]';
    const seen = new Set<string>();
    for (const img of Array.from(document.querySelectorAll(`${cardSel} img`))) {
      const im = img as HTMLImageElement;
      const s = im.currentSrc || im.src || "";
      if (!s) continue;
      let k = s;
      try {
        const u = new URL(s, location.href);
        k = u.origin + u.pathname;
      } catch {}
      seen.add(k);
    }
    const first = document.querySelector(cardSel);
    if (!first) return [...seen];
    // Walk up to the scrollable ancestor that virtualizes the grid.
    let scroller: HTMLElement | null = first.parentElement;
    while (scroller && scroller !== document.body) {
      if (scroller.scrollHeight > scroller.clientHeight + 10) break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === document.body) return [...seen];
    const orig = scroller.scrollTop;
    const step = Math.max(200, scroller.clientHeight - 80);
    for (let y = 0, guard = 0; guard < 40; y += step, guard++) {
      scroller.scrollTop = y;
      await new Promise((r) => setTimeout(r, 180)); // let virtualized rows mount
      for (const img of Array.from(document.querySelectorAll(`${cardSel} img`))) {
        const im = img as HTMLImageElement;
        const s = im.currentSrc || im.src || "";
        if (!s) continue;
        let k = s;
        try {
          const u = new URL(s, location.href);
          k = u.origin + u.pathname;
        } catch {}
        seen.add(k);
      }
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
    }
    scroller.scrollTop = orig;
    await new Promise((r) => setTimeout(r, 120));
    return [...seen];
  });
}

// Drive the Avatar III render through the "Create new shots" / Avatar-Shots flow
// and CLICK Generate. Returns once the render is kicked off; the SHARED
// retrieval in attemptOnAccount (Projects poll + download) then collects the
// output exactly as for Avatar IV. Steps (verified against the live UI 2026-07):
//   1) Avatars page -> search the project's saved-avatar name -> open its tile's
//      "Create video with this avatar" (▷) -> "Create new shots".
//   2) On Avatar Shots: pick model "Avatar III", set orientation, upload audio.
//   3) Click "Generate for 1 credit".
// Throws a classified HeygenError on any missing control.
// Returns the uploaded look's img src (normalizable via lookSrcKey) so the
// caller can DELETE exactly that look after the render — see
// cleanupUploadedLook. "" = the look src could not be captured.
async function driveAvatarIIIComposer(
  page: Page,
  input: GenerateAvatarInput,
  audioPath: string,
  imageBytes: Buffer,
): Promise<{ avatarName: string; faceCheck: FaceCheck }> {
  const e = env();
  const p = page;
  const wantPortrait = input.aspectRatio === "portrait";
  // NAME-INDEPENDENT entry. Avatar III used to require a user-supplied HeyGen
  // avatar name (searched on the Avatars page) — but users don't know HeyGen's
  // internal avatar names, so they entered it wrong and every Avatar III segment
  // failed. We no longer need a name: we enter the composer from the FIRST avatar
  // that exists in this account, then OVERRIDE its look with the project's own
  // photo via Switch-look (step 5.5 below, now unconditional). The starting
  // avatar's identity is irrelevant — only the uploaded look renders. Every
  // account is kept seeded with at least one avatar for exactly this entry step.
  // (input.heygenAvatarName is now ignored; the intake field is left in place.)

  // 1) ENTER THE AVATAR-SHOTS COMPOSER. Two entry paths, tried in order — the
  // readiness tell for BOTH is the composer's model pill:
  //
  //   (A) NEW UI (July-2026 accounts): a dedicated "Avatar Shots" link in the left
  //       sidebar opens the composer DIRECTLY. On these accounts clicking a tile
  //       opens the avatar's looks-detail page instead of a ▷ "Create video" menu,
  //       so the old (B) path can't reach the composer at all.
  //   (B) OLD UI (pre-July accounts): the composer is reached only via the Avatars
  //       grid -> hover a tile -> ▷ "Create video with this avatar" -> "Create new
  //       shots". The sidebar has no "Avatar Shots" link.
  //
  // HeyGen rolls its redesign out account-by-account, so both UIs coexist across
  // our pool. We try the direct sidebar link first (it's the simpler, more stable
  // path and covers the accounts that were FAILING), and fall back to the tile
  // dance only if the sidebar link isn't present / doesn't open the composer.
  const composerReady = (): Promise<boolean> =>
    avatarModelDropdownTrigger(p)
      .locator("visible=true")
      .first()
      .waitFor({ state: "visible", timeout: e.HEYGEN_SETUP_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

  let inComposer = false;

  // (A) DIRECT SIDEBAR ENTRY. Navigate to the Avatar-Shots page (sidebar link, else
  // a direct URL) and see if the composer's model pill appears. If it does we're in
  // — skip the whole tile dance.
  await clickFirstVisible(avatarShotsNavEntry(p), 8000, "Avatar Shots nav").catch(async () => {
    // No sidebar link matched — try the stable URL directly (old-UI accounts just
    // won't render the composer here and we fall through to (B)).
    await p.goto(`${e.HEYGEN_BASE_URL}/avatar/avatar-shots`, { waitUntil: "commit" }).catch(() => {});
  });
  inComposer = await composerReady();
  if (inComposer) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "synthetic.heygen.avatar3_entry",
        projectId: input.projectId,
        segmentId: input.segmentId,
        path: "sidebar_avatar_shots",
      }),
    );
  }

  // (B) TILE FALLBACK (old-UI accounts). Only runs if the direct entry didn't land
  // in the composer. Open the Avatars grid and pick the FIRST tile (any one) to
  // enter from — no name search, since the look is replaced with the project photo
  // below. HeyGen's grid sometimes fails to load with a transient "Couldn't load
  // your avatars. Please refresh and try again." (the account HAS avatars, the API
  // just hiccuped), so on that banner (or a no-tile timeout) we RELOAD and retry a
  // few times before giving up.
  if (!inComposer) {
    const tile = firstAvatarTile(p).first();
    let tileReady = false;
    for (let attempt = 0; attempt < 4 && !tileReady; attempt++) {
      // (Re)navigate to the Avatars grid. First attempt is the warm in-SPA nav; a
      // retry after a load error does a genuine reload to re-fetch the grid.
      if (attempt === 0) {
        await p.goto(`${e.HEYGEN_BASE_URL}/avatar/avatars`, { waitUntil: "commit" }).catch(() => {});
        if (!(await isVisible(avatarsSearchBox(p), 8000))) {
          await clickFirstVisible(avatarsNavEntry(p), e.HEYGEN_SETUP_TIMEOUT_MS, "Avatars nav").catch(() => {});
        }
      } else {
        await p.reload({ waitUntil: "commit" }).catch(() => {});
      }
      await waitFirstVisible(avatarsSearchBox(p), e.HEYGEN_SETUP_TIMEOUT_MS, "Avatars search box").catch(() => {});

      // If HeyGen shows the transient load-error banner, this attempt has no tiles —
      // reload and retry rather than concluding the account is empty.
      if (await isVisible(avatarsLoadError(p), 2500)) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            msg: "synthetic.heygen.avatar3_avatars_load_error",
            projectId: input.projectId,
            segmentId: input.segmentId,
            attempt,
            note: "'Couldn't load your avatars' — reloading and retrying",
          }),
        );
        await p.waitForTimeout(2500);
        continue;
      }

      tileReady = await tile
        .waitFor({ state: "visible", timeout: e.HEYGEN_SETUP_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      // A no-tile timeout might still be a slow/failed grid load — one more reload.
      if (!tileReady) {
        await p.waitForTimeout(2000);
      }
    }
    if (!tileReady) {
      // Persisted past retries: neither the direct sidebar entry NOR a tile is
      // available — the grid keeps failing to load, or this account genuinely has
      // no seed avatar. Surface both possibilities; the caller rotates.
      await captureDiagnostics(p, input.jobId, "avatar_iii_no_avatar_tile");
      throw new HeygenError(
        "ui_changed",
        "heygen: could not enter the Avatar-Shots composer for Avatar III — the direct " +
          "'Avatar Shots' entry did not open the composer AND no avatar tile is available " +
          "on the Avatars page (grid failed to load, or the account is missing its seed avatar)",
      );
    }
    await shot(p, input.projectId, input.segmentId, "avatar3_tile");

    // Hover the tile to reveal its actions, click the ▷ "Create video with this
    // avatar" icon, then "Create new shots" in the menu it opens.
    //
    // The tile also has a "..." more-menu (Edit/Share/Delete/Copy Identity) and a
    // ♡ favorite icon right next to the ▷. A mis-click on "..." opens the WRONG
    // menu (no "Create new shots"), so we VERIFY the right menu appeared and retry
    // the ▷ if the "..." menu opened instead — closing it first with Escape.
    let menuOpen = false;
    for (let attempt = 0; attempt < 3 && !menuOpen; attempt++) {
      await tile.hover().catch(() => {});
      await clickFirstVisible(
        createVideoWithAvatarButton(tile),
        e.HEYGEN_SETUP_TIMEOUT_MS,
        "Create video with this avatar",
      ).catch(() => {});
      // Wait for EITHER the right item or the wrong "..." menu to resolve.
      menuOpen = await createNewShotsMenuItem(p)
        .locator("visible=true")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (!menuOpen && (await isVisible(avatarMoreMenuOpen(p), 1500))) {
        // We opened the "..." menu by mistake — dismiss it and retry the ▷.
        await p.keyboard.press("Escape").catch(() => {});
        await p.waitForTimeout(400);
      }
    }
    if (!menuOpen) {
      await captureDiagnostics(p, input.jobId, "avatar_iii_create_menu_not_open");
      throw new HeygenError(
        "ui_changed",
        "heygen: the avatar tile's 'Create video' menu (with 'Create new shots') never opened",
      );
    }
    await clickFirstVisible(createNewShotsMenuItem(p), e.HEYGEN_SETUP_TIMEOUT_MS, "Create new shots");

    // Wait for the Avatar-Shots composer (the model pill is the readiness tell).
    inComposer = await composerReady();
    if (!inComposer) {
      await captureDiagnostics(p, input.jobId, "avatar_iii_composer_not_ready");
      throw new HeygenError(
        "ui_changed",
        "heygen: Avatar Shots model pill never appeared",
      );
    }
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "synthetic.heygen.avatar3_entry",
        projectId: input.projectId,
        segmentId: input.segmentId,
        path: "tile_create_new_shots",
      }),
    );
  }
  await shot(p, input.projectId, input.segmentId, "avatar3_composer");

  // 5) MODEL + LOOK are COUPLED on this HeyGen build — setting one RESETS the
  // other (observed 2026-07): selecting the model reverts the look to the model's
  // default avatar, and uploading a look reverts the model to Avatar IV. So a
  // single pass in either order leaves one wrong at Generate. We therefore define
  // both as idempotent helpers, run model-then-look once, then a FINAL GUARD loop
  // that re-checks BOTH and re-applies whichever got clobbered — model first, look
  // last (look is what renders, so it must be the last write to survive).

  // Stage the project photo once. CRITICAL: this file must stay ON DISK until any
  // Create-Avatar upload has observably completed — that flow's browser-side S3
  // PUT reads the file DEFERRED (seconds after setFiles), and unlinking early is
  // exactly what caused the infinite "Processing avatar…" hang + "Failed to
  // upload file" toast (root-caused live 2026-07-20, see
  // [[heygen-create-avatar-unlink-bug]]). It is unlinked only after the
  // model/avatar sequence below has fully committed.
  const lookDir = path.join(e.TMP_DIR, "heygen-uploads");
  await fs.mkdir(lookDir, { recursive: true });
  const lookPath = path.join(lookDir, `${input.segmentId}_look.jpg`);
  await fs.writeFile(lookPath, imageBytes);

  // This render's PER-PROJECT NAMED AVATAR. Deterministic on (project, image), so
  // the first clip on an account CREATES it and every later clip of the same
  // project on that account finds and REUSES it by exact-name search — no shared
  // shelf, no "which tile is new" inference, no wrong face to pick.
  const avatarName = projectAvatarName(input.projectId, imageBytes);

  // Result of the post-selection avatar-name verify (see applyProjectAvatar).
  // Threaded out to the caller so the processor persists it to job metadata for
  // durable ground truth (the worker's own logs are ephemeral). Defaults to a
  // "not run" state so a code path that never reaches the verify still returns a
  // well-formed value.
  let faceCheck: FaceCheck = { ok: true, reason: "not_run", avatarName };

  // Select the Avatar III model, verifying the pill reads "Avatar III". Idempotent
  // — returns immediately if already set.
  const selectModelIII = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await isVisible(avatarModelIsIII(p), 2000)) return true;
      await clickFirstVisible(avatarModelDropdownTrigger(p), e.HEYGEN_SETUP_TIMEOUT_MS, "model dropdown").catch(() => {});
      await clickFirstVisible(avatarIIIOption(p), 10_000, "Avatar III option").catch(() => {});
      if (
        await avatarModelIsIII(p)
          .locator("visible=true")
          .first()
          .waitFor({ state: "visible", timeout: 6000 })
          .then(() => true)
          .catch(() => false)
      )
        return true;
    }
    return false;
  };

  // ---------------------------------------------------------------------------
  // applyProjectAvatar — select this render's PER-PROJECT NAMED AVATAR, creating
  // it on this account if it doesn't exist yet. Replaces the shared-shelf
  // applyLook (upload a look, then INFER which tile is ours), whose tile
  // inference mis-fired on accounts where the "Validating photo" pin never shows
  // and HeyGen dedupes repeat photos — selecting ANOTHER PROJECT'S face (the
  // wrong-avatar-face bug, recurred 2026-07-19/20). Here identity is the exact
  // avatar NAME (projectAvatarName — unique per project+image), so there is
  // nothing to infer: find-by-name, else create-by-name, then verify-by-name.
  //
  // Flow (verified live on bonniekim182, 2026-07-20): composer → Switch look →
  // looks detail ("My Avatars > <current>") → "My Avatars" crumb → "Choose
  // Avatar" modal (search box + "Create Avatar" dropdown) → search our name →
  //   * found: click the tile → its looks detail → commit its look (modal-closed
  //     is the commit signal, same as the old flow), or
  //   * missing: Create Avatar → Upload photo → "Processing avatar…" (~7-10s;
  //     the staged file MUST stay on disk — the browser's S3 PUT reads it
  //     DEFERRED, and an early unlink is exactly what caused the infinite
  //     "Processing" hang + "Failed to upload file", see
  //     [[heygen-create-avatar-unlink-bug]]) → "Name your avatar" → our unique
  //     name → Create (HeyGen typically auto-selects the new avatar), then
  //     select it explicitly if the modal is still open.
  // VERIFY: reopen Switch look — its detail header names the CURRENTLY-committed
  // avatar ("My Avatars > <name>"); assert OUR unique name is shown. A POSITIVE
  // mismatch throws (rotate account; never render a stranger); an unreadable
  // modal stays ok (selection was by exact name — already strong).
  // ---------------------------------------------------------------------------

  // Open the Choose Avatar modal from the composer. Returns false if it never
  // appeared (caller retries once, then throws ui_changed).
  const openChooseAvatar = async (): Promise<boolean> => {
    await avatarShotsLookPreview(p).first().hover().catch(() => {});
    await clickFirstVisible(avatarShotsSwitchLookButton(p), e.HEYGEN_SETUP_TIMEOUT_MS, "Switch look").catch(() => {});
    await waitFirstVisible(avatarShotsLookModal(p), e.HEYGEN_SETUP_TIMEOUT_MS, "Switch-look modal").catch(() => {});
    await p.waitForTimeout(800);
    await lookModalMyAvatarsCrumb(p).first().click({ timeout: 10_000, force: true }).catch(() => {});
    return chooseAvatarModal(p)
      .first()
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
  };

  // Search the Choose Avatar grid for our exact name, POLLING up to `pollMs` —
  // a FRESHLY-CREATED avatar takes a while to become searchable (it processes /
  // validates before appearing in the grid), so a single read right after Create
  // reports "missing" and, unguarded, that mis-read caused a CREATE LOOP
  // (duplicate avatars — observed live by the user 2026-07-20). Returns the tile
  // locator, or null when the deadline passes without it.
  const searchOurTile = async (pollMs: number): Promise<Locator | null> => {
    const deadline = Date.now() + pollMs;
    do {
      await chooseAvatarSearch(p).first().fill(avatarName).catch(() => {});
      await p.waitForTimeout(1500);
      const tile = chooseAvatarTileByName(p, avatarName);
      if (await isVisible(tile, 3000)) return tile;
      await p.waitForTimeout(2000);
    } while (Date.now() < deadline);
    return null;
  };

  // Create our named avatar via Create Avatar → Upload photo → name → Create.
  const createOurAvatar = async (): Promise<void> => {
    // Clear the search filter so the Create button / grid are in their normal state.
    await chooseAvatarSearch(p).first().fill("").catch(() => {});
    await p.waitForTimeout(500);
    // Entry A (populated grid): the "Create Avatar" dropdown. Entry B (empty
    // shelf, "Create Your First Avatar" screen): hover the "Create a virtual
    // character" card to reveal its Upload photo button.
    if (await isVisible(createAvatarButton(p), 3000)) {
      await createAvatarButton(p).first().click({ timeout: 8000, force: true }).catch(() => {});
      await p.waitForTimeout(800);
    } else {
      await createVirtualCharacterCard(p).first().hover().catch(() => {});
      await p.waitForTimeout(600);
    }
    try {
      const [chooser] = await Promise.all([
        p.waitForEvent("filechooser", { timeout: 15_000 }),
        clickFirstVisible(createAvatarUploadPhotoItem(p), 10_000, "Create-Avatar Upload photo"),
      ]);
      await chooser.setFiles(lookPath);
    } catch (err) {
      const input2 = p.locator('input[type="file"]');
      if ((await input2.count()) > 0) await input2.first().setInputFiles(lookPath);
      else throw new HeygenError("ui_changed", "heygen: Create-Avatar Upload photo chooser did not open", err);
    }
    // NOTE: lookPath deliberately NOT unlinked here — the S3 PUT reads it in a
    // few seconds. It is unlinked after the model/look sequence completes.
    await shot(p, input.projectId, input.segmentId, "avatar3_create_uploading");

    // "Processing avatar…" appears (~1s) then clears when the build finishes
    // (~7-10s healthy). Missing-appear is tolerated (fast builds); the hard gate
    // is the Name dialog.
    const procSeen = await processingAvatarModal(p)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (procSeen) {
      await processingAvatarModal(p)
        .first()
        .waitFor({ state: "hidden", timeout: 240_000 })
        .catch(() => {});
    }
    const named = await nameAvatarDialog(p)
      .first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (!named) {
      await captureDiagnostics(p, input.jobId, "avatar_iii_create_no_name_dialog");
      throw new HeygenError(
        "ui_changed",
        "heygen: Create-Avatar upload did not reach the 'Name your avatar' dialog " +
          "(photo upload/build likely failed)",
      );
    }
    await avatarNameInput(p).first().fill(avatarName).catch(() => {});
    await avatarNameCreateButton(p).first().click({ timeout: 8000, force: true }).catch(() => {});
    await nameAvatarDialog(p)
      .first()
      .waitFor({ state: "hidden", timeout: 60_000 })
      .catch(() => {});
    await p.waitForTimeout(1500);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "synthetic.heygen.avatar3_project_avatar_created",
        projectId: input.projectId,
        segmentId: input.segmentId,
        avatarName,
      }),
    );
  };

  // Commit a found tile: click it (opens its looks detail inside the modal), then
  // commit its look. Modal-closed is the commit signal (HeyGen closes the "My
  // Avatars" modal ONLY when a look is applied — same signal as the old flow; a
  // composer-preview compare gives false negatives, see the old applyLook notes).
  const selectTile = async (tile: Locator): Promise<boolean> => {
    await tile.click({ timeout: 8000, force: true }).catch(() => {});
    await p.waitForTimeout(1200);
    for (let attempt = 0; attempt < 3; attempt++) {
      const lookTile = avatarShotsPhotoAvatarTiles(p).first();
      await lookTile.hover().catch(() => {});
      await p.waitForTimeout(150);
      await avatarShotsChooseLookButton(lookTile).first().click({ timeout: 4000, force: true }).catch(() => {});
      if (await isVisible(avatarShotsLookModal(p), 500)) {
        await avatarShotsTileClickTarget(lookTile).first().click({ timeout: 3000, force: true }).catch(() => {});
      }
      const closed = await avatarShotsLookModal(p)
        .first()
        .waitFor({ state: "hidden", timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (closed) return true;
      await p.waitForTimeout(600);
    }
    return false;
  };

  // VERIFY which avatar is committed: reopen Switch look and read the detail
  // header ("My Avatars > <currentName>"). Returns "verified" | "mismatch" |
  // "inconclusive" (modal unreadable). Always closes the modal again.
  const verifyCommitted = async (): Promise<"verified" | "mismatch" | "inconclusive"> => {
    await avatarShotsLookPreview(p).first().hover().catch(() => {});
    await clickFirstVisible(avatarShotsSwitchLookButton(p), 15_000, "Switch look (verify)").catch(() => {});
    const opened = await avatarShotsLookModal(p)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    let verdict: "verified" | "mismatch" | "inconclusive" = "inconclusive";
    if (opened) {
      const exact = new RegExp(`^${avatarName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
      const nameShown = await p
        .getByText(exact)
        .first()
        .waitFor({ state: "visible", timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      verdict = nameShown ? "verified" : "mismatch";
    }
    await p.keyboard.press("Escape").catch(() => {});
    await avatarShotsLookModal(p)
      .first()
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {});
    await p.waitForTimeout(500);
    return verdict;
  };

  const applyProjectAvatar = async (): Promise<void> => {
    let lastVerdict: "verified" | "mismatch" | "inconclusive" = "inconclusive";
    // CREATE AT MOST ONCE per call. A freshly-created avatar is not immediately
    // searchable AND is auto-selected by HeyGen only AFTER SOME TIME — treating
    // either lag as "avatar missing" made the retry loop CREATE AGAIN, endlessly
    // (duplicate avatars, observed live by the user 2026-07-20). After creating,
    // we only ever WAIT (poll search / poll verify), never re-create.
    let created = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await openChooseAvatar())) {
        if (attempt < 2) continue;
        await captureDiagnostics(p, input.jobId, "avatar_iii_choose_avatar_not_open");
        throw new HeygenError("ui_changed", "heygen: the Choose Avatar modal never opened");
      }
      // Post-create the grid needs time to index the new avatar — poll longer.
      let tile = await searchOurTile(created ? 90_000 : 12_000);
      const found = !!tile;
      if (!tile && !created) {
        await createOurAvatar();
        created = true;
        // HeyGen usually auto-selects the fresh avatar (after a beat) and closes
        // the modals on its own. If a modal is still open, select explicitly —
        // polling the search generously while the new avatar becomes visible.
        const modalStillOpen =
          (await isVisible(chooseAvatarModal(p), 2000)) || (await isVisible(avatarShotsLookModal(p), 1000));
        if (modalStillOpen) tile = await searchOurTile(90_000);
      }
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          msg: "synthetic.heygen.avatar3_project_avatar",
          projectId: input.projectId,
          segmentId: input.segmentId,
          avatarName,
          found,
          created,
          attempt,
        }),
      );
      if (tile) {
        if (!(await selectTile(tile))) {
          await captureDiagnostics(p, input.jobId, "avatar_iii_named_select_not_applied");
          if (attempt < 2) continue;
          throw new HeygenError(
            "ui_changed",
            "heygen: the project's named avatar did not commit (modal never closed)",
          );
        }
      } else {
        // Post-create with all modals closed: HeyGen auto-selected. Close any
        // stray overlay and fall through to the verify, which is the arbiter.
        await p.keyboard.press("Escape").catch(() => {});
        await p.waitForTimeout(500);
      }
      // VERIFY — patiently right after a create: the auto-select lands "after
      // some time", so an immediate single read can see the OLD avatar still
      // committed and false-flag a mismatch. Re-read a few times before judging.
      const verifyReads = created ? 3 : 2;
      for (let read = 0; read < verifyReads; read++) {
        lastVerdict = await verifyCommitted();
        if (lastVerdict !== "mismatch") break;
        await p.waitForTimeout(8000); // give the auto-select/commit time to land
      }
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          msg: "synthetic.heygen.avatar3_face_verify",
          projectId: input.projectId,
          segmentId: input.segmentId,
          avatarName,
          verdict: lastVerdict,
          attempt,
        }),
      );
      if (lastVerdict !== "mismatch") break; // verified or inconclusive → done
      // mismatch → loop again for an explicit re-selection (never a re-create)
    }
    if (lastVerdict === "mismatch") {
      faceCheck = { ok: false, reason: "mismatch", avatarName };
      await captureDiagnostics(p, input.jobId, "avatar_iii_face_mismatch");
      throw new HeygenError(
        "ui_changed",
        `heygen: committed avatar is not this project's named avatar (${avatarName}) — ` +
          "would render the wrong face",
      );
    }
    faceCheck = {
      ok: true,
      reason: lastVerdict === "verified" ? "verified" : "verify_inconclusive",
      avatarName,
    };
  };

  // ORDER: AVATAR FIRST, MODEL LAST. Verified on the current build (2026-07):
  // committing a look/avatar resets the model back to the default (Avatar IV),
  // but selecting the MODEL does NOT change the avatar. So the convergent order is
  // to apply the project avatar FIRST, then select Avatar III LAST — the model is
  // the final write and nothing after it disturbs it, and the avatar survives
  // because model-select doesn't touch it.
  await applyProjectAvatar();
  await shot(p, input.projectId, input.segmentId, "avatar3_look_selected");

  if (!(await selectModelIII())) {
    await captureDiagnostics(p, input.jobId, "avatar_iii_model_not_selected");
    throw new HeygenError("ui_changed", "heygen: could not select the Avatar III model");
  }

  // Final assertion — never Generate on the wrong model. Model was the LAST write
  // and look-select is what resets the model (not vice-versa), so both should hold.
  if (!(await isVisible(avatarModelIsIII(p), 3000))) {
    await captureDiagnostics(p, input.jobId, "avatar_iii_model_look_unstable");
    throw new HeygenError(
      "ui_changed",
      "heygen: Avatar III model not selected after applying the look",
    );
  }
  await shot(p, input.projectId, input.segmentId, "avatar3_model_look_stable");
  // Best-effort cleanup of the staged look file.
  await fs.unlink(lookPath).catch(() => {});

  // 6) Set orientation. split_2 avatars -> Portrait (9:16); full-frame -> Landscape
  // (16:9). HeyGen DEFAULTS to Portrait, so for a full-frame avatar this MUST flip
  // to Landscape — a silently-missed toggle renders 9:16 (observed 2026-07). So we
  // open the menu, click the wanted option, and VERIFY it's marked selected;
  // retry a few times. For the wanted==default case (portrait) the verify still
  // confirms rather than assuming.
  const wantOrientation: "landscape" | "portrait" = wantPortrait ? "portrait" : "landscape";
  // split_2 wants PORTRAIT, which is exactly HeyGen's Avatar-Shots default. Client
  // 2026-07-09: for split_2, leave that 9:16 default alone — do NOT touch the
  // orientation control at all (never open the menu, never click a toggle). Only
  // full-frame parts need the explicit flip to Landscape.
  let orientationSet = wantPortrait;
  for (let attempt = 0; attempt < 3 && !orientationSet; attempt++) {
    // Already in the wanted orientation? (Portrait is the default — this skips a
    // needless toggle.) The trigger's own sprite is the source of truth.
    if (await isVisible(avatarShotsOrientationConfirmed(p, wantOrientation), 1500)) {
      orientationSet = true;
      break;
    }
    // Open the orientation menu (the 📱 phone-sprite trigger — NOT the model pill)
    // and click the wanted option.
    await clickFirstVisible(avatarShotsOrientationTrigger(p), 8000, "orientation pill").catch(() => {});
    await p.waitForTimeout(400); // let the menu open
    await clickFirstVisible(
      avatarShotsOrientationOption(p, wantOrientation),
      8000,
      `${wantOrientation} orientation`,
    ).catch(() => {});
    await p.waitForTimeout(700); // let the toolbar sprite + layout re-render
    // Verify by the TRIGGER SPRITE flipping to the wanted orientation.
    orientationSet = await isVisible(avatarShotsOrientationConfirmed(p, wantOrientation), 3000);
    if (!orientationSet) {
      await p.keyboard.press("Escape").catch(() => {}); // close a stray-open menu, retry
      await p.waitForTimeout(300);
    }
  }
  if (!orientationSet) {
    // Don't hard-fail: the retrieval's aspect probe still guards the final output
    // (it rejects a wrong-orientation render and keeps polling / the job fails
    // cleanly). But log loudly so we can pin the selector if this recurs.
    await captureDiagnostics(p, input.jobId, "avatar_iii_orientation_unconfirmed");
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "synthetic.heygen.avatar3_orientation_unconfirmed",
        projectId: input.projectId,
        segmentId: input.segmentId,
        wanted: wantOrientation,
        note: "orientation toggle could not be confirmed; aspect probe still guards output",
      }),
    );
  }
  await shot(p, input.projectId, input.segmentId, wantPortrait ? "avatar3_portrait" : "avatar3_landscape");

  // 7) Upload the sliced 69labs audio (lip-sync source; render length == audio).
  await uploadAvatarShotsAudio(p, audioPath, e.HEYGEN_SETUP_TIMEOUT_MS);
  await shot(p, input.projectId, input.segmentId, "avatar3_audio_uploaded");
  await p.waitForTimeout(1200); // settle before submit

  // 8) Generate. Click + confirm it took (button leaves enabled state / route
  // changes), escalating through normal -> force -> DOM click like the IV path.
  const gen = avatarShotsGenerateButton(p).locator("visible=true").first();
  try {
    await gen.waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    await captureDiagnostics(p, input.jobId, "avatar_iii_generate_missing");
    throw new HeygenError("ui_changed", "heygen: Avatar III Generate button never appeared");
  }
  let started = false;
  for (let attempt = 0; attempt < 4 && !started; attempt++) {
    await gen.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    try {
      await gen.click({ timeout: 15_000 });
    } catch {
      try {
        await gen.click({ timeout: 5000, force: true });
      } catch {
        await gen.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
      }
    }
    if (attempt === 0) await shot(p, input.projectId, input.segmentId, "generating");
    started = await Promise.race([
      gen
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
      msg: "synthetic.heygen.avatar3_generate_click",
      projectId: input.projectId,
      segmentId: input.segmentId,
      started,
    }),
  );
  if (!started) {
    // Same SAFEGUARD as the IV path: HeyGen often DID start even when the signal
    // is uncertain, so proceed to the shared Projects retrieval (bounded) rather
    // than orphaning a paid render.
    await captureDiagnostics(p, input.jobId, "avatar_iii_generate_no_start");
  }
  return { avatarName, faceCheck };
}

// Delete OTHER projects' machine-made avatars (va-* — see projectAvatarName) from
// this account, AFTER the render has been retrieved and stored. Named avatars
// accumulate one per (project, image) per account, and HeyGen caps instant-avatar
// slots (v1/avatar_group/slot_info.get), so without pruning, avatar CREATION
// eventually starts failing. Pruning is LAZY — done by the NEXT render on the
// account rather than at project finalize (finalize has no browser session):
// every va-* avatar that is NOT this render's own is deleted; our own is KEPT so
// this project's later clips reuse it (a future project's cleanup removes it).
// Human-made seed avatars (no va- prefix) are NEVER touched — the composer is
// entered through them.
//
// WHERE DELETE LIVES (tile menu verified live 2026-07-20): Avatars grid → hover
// tile → "..." more-menu (Edit / Share / Delete / Copy Avatar Identity ID) →
// Delete → confirm dialog → Delete.
//
// BEST-EFFORT BY DESIGN: the render is already safe in R2 when this runs, so a
// cleanup failure must NEVER fail the job — every step swallows and the outcome
// is logged (synthetic.heygen.avatar3_va_cleanup), with diagnostics captured when
// a delete misses. Deletions per run are capped to bound job time.
export async function cleanupProjectAvatars(
  p: Page,
  input: GenerateAvatarInput,
  keepAvatarName: string,
): Promise<void> {
  const e = env();
  const deleted: string[] = [];
  const failed: string[] = [];
  try {
    // Navigate to the Avatars grid — same production pattern as the composer's
    // tile-fallback entry (direct URL, sidebar nav fallback, search-box readiness).
    await p.goto(`${e.HEYGEN_BASE_URL}/avatar/avatars`, { waitUntil: "commit" }).catch(() => {});
    if (!(await isVisible(avatarsSearchBox(p), 8000))) {
      await clickFirstVisible(avatarsNavEntry(p), 15_000, "Avatars nav (va-cleanup)").catch(() => {});
    }
    const gridReady = await avatarsSearchBox(p)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!gridReady) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          msg: "synthetic.heygen.avatar3_va_cleanup",
          projectId: input.projectId,
          segmentId: input.segmentId,
          note: "avatars grid not ready — skipped",
        }),
      );
      return;
    }
    await p.waitForTimeout(1500);
    // Enumerate machine-made avatar names on the grid. Tile text concatenates
    // name + "N looks", so extract by our exact va-<8hex>-<6hex> shape — a strict
    // match also guarantees a human-named avatar can never be caught by accident.
    const names: string[] = await p
      .locator('[class*="card" i], [data-testid*="avatar" i], [role="button"]')
      .evaluateAll((cards) => {
        const out: string[] = [];
        for (const card of cards) {
          const m = /(va-[0-9a-f]{8}-[0-9a-f]{6})\b/i.exec(card.textContent || "");
          if (m) out.push(m[1].toLowerCase());
        }
        return Array.from(new Set(out));
      })
      .catch(() => [] as string[]);
    const targets = names.filter((n) => n !== keepAvatarName.toLowerCase()).slice(0, 4);
    for (const name of targets) {
      try {
        const tile = avatarTileByName(p, name).first();
        if (!(await isVisible(tile, 3000))) {
          failed.push(name);
          continue;
        }
        await tile.hover().catch(() => {});
        await p.waitForTimeout(400);
        await avatarTileMoreButton(tile).click({ timeout: 4000, force: true }).catch(() => {});
        const menuOpen = await avatarMoreMenuOpen(p)
          .first()
          .waitFor({ state: "visible", timeout: 4000 })
          .then(() => true)
          .catch(() => false);
        if (!menuOpen) {
          await p.keyboard.press("Escape").catch(() => {});
          failed.push(name);
          continue;
        }
        await avatarDeleteMenuItem(p).first().click({ timeout: 4000, force: true }).catch(() => {});
        await p.waitForTimeout(600);
        await avatarDeleteConfirmButton(p).first().click({ timeout: 5000, force: true }).catch(() => {});
        // Deleted when the tile disappears from the grid.
        const gone = await tile
          .waitFor({ state: "hidden", timeout: 8000 })
          .then(() => true)
          .catch(() => false);
        (gone ? deleted : failed).push(name);
        await p.waitForTimeout(600);
      } catch {
        failed.push(name);
      }
    }
    if (failed.length > 0) {
      await captureDiagnostics(p, input.jobId, "avatar_iii_va_cleanup_missed").catch(() => {});
    }
  } catch {
    // best-effort — never fail the job over cleanup
  }
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: "synthetic.heygen.avatar3_va_cleanup",
      projectId: input.projectId,
      segmentId: input.segmentId,
      keep: keepAvatarName,
      deleted,
      failed,
    }),
  );
}

// Delete the look a render uploaded, AFTER the render has been retrieved and
// stored. The look grid is SHARED per account across every project: without
// cleanup each render leaves its project's face behind, the grid grows unbounded
// (a live account showed 470 looks, 2026-07-18), and tile selection has to pick
// "ours" out of a pile of other projects' faces — the wrong-avatar-face bug.
// Keeping the grid small makes selection trivially reliable.
//
// WHERE DELETE LIVES (verified from live UI screenshots 2026-07-18): the
// Avatar-Shots "Switch look" modal has NO delete control (hover shows only
// "Choose look" — probed live). Looks are deleted from the avatar's looks-DETAIL
// page: Avatars → click the FIRST avatar tile (the seed the composer uploads
// into) → its looks grid → hover a tile → three icon buttons mount top-right
// ("..." more / select / ♡) → "..." → Delete → "Delete Look? This action cannot
// be revoked." dialog → red Delete. New uploads land FIRST in that grid.
//
// BEST-EFFORT BY DESIGN: the render is already safe in R2 when this runs, so a
// cleanup failure must NEVER fail the job — every step swallows and the outcome
// is logged (synthetic.heygen.avatar3_look_cleanup), with diagnostics captured
// when a step misses. Deletion is IRREVERSIBLE → we act only on a tile whose img
// carries the uploaded look's stable talking_photo asset path (the tr:…
// transform prefix and query differ between surfaces, so a full-url compare
// can't work across pages).
// Exported for scripts/heygen-debug-look-cleanup.ts (headed test of the delete
// flow without burning a render).
export async function cleanupUploadedLook(
  p: Page,
  input: GenerateAvatarInput,
  lookSrc: string,
): Promise<void> {
  if (!lookSrc) return;
  const e = env();
  // Stable identity: every rendition of the look's thumbnail embeds the same
  // /talking_photo/<avatar_id>/<image_hash> path segment.
  const idMatch = /talking_photo\/([^/?#]+)\/([^/?#.]+)/.exec(lookSrc);
  const identity = idMatch ? `talking_photo/${idMatch[1]}/${idMatch[2]}` : "";
  const outcome = (ok: boolean, note: string) =>
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "synthetic.heygen.avatar3_look_cleanup",
        projectId: input.projectId,
        segmentId: input.segmentId,
        ok,
        note,
      }),
    );
  if (!identity) {
    outcome(false, "no_identity_in_src");
    return;
  }
  try {
    // 1) Open the Avatars page.
    await p.goto(`${e.HEYGEN_BASE_URL}/avatar/avatars`, { waitUntil: "commit" }).catch(() => {});
    if (!(await isVisible(avatarsSearchBox(p), 10_000))) {
      await clickFirstVisible(avatarsNavEntry(p), 15_000, "Avatars nav (cleanup)").catch(() => {});
    }
    // 2) Open the FIRST avatar's looks-detail page (the seed avatar the composer
    // entered from — uploads always attach to it). On the new UI a plain tile
    // click opens the detail page; old-UI accounts where it doesn't just skip
    // cleanup this round (best-effort).
    const avatarTile = firstAvatarTile(p).first();
    await avatarTile.waitFor({ state: "visible", timeout: 20_000 });
    await avatarTile.click({ timeout: 8000 });
    await waitFirstVisible(avatarLooksDetailReady(p), 20_000, "avatar looks-detail page");
    await p.waitForTimeout(800); // let the grid render

    // 3) Stamp OUR look's card by identity. Our upload is the NEWEST look and
    // lands FIRST in the grid, so no scroll sweep is needed — if it's not in the
    // initially rendered set, something is off and we bail rather than guess.
    // (Identity match logic INLINED — no inner named helpers in page callbacks;
    // tsx's __name wrapper doesn't exist in the page, see sweepLookTileSrcs.)
    const matches = await p.evaluate((ident) => {
      for (const el of Array.from(document.querySelectorAll("[data-va-cleanup]")))
        el.removeAttribute("data-va-cleanup");
      let count = 0;
      const cardSel = '[data-pacific-component="PrivatePhotoAvatarCard"]';
      for (const img of Array.from(document.querySelectorAll("img"))) {
        const im = img as HTMLImageElement;
        const s = im.currentSrc || im.src || "";
        if (!s || s.indexOf(ident) === -1) continue;
        const card =
          im.closest(cardSel) ??
          im.closest('[class*="card" i]');
        if (card && !card.hasAttribute("data-va-cleanup")) {
          card.setAttribute("data-va-cleanup", "1");
          count++;
        }
      }
      return count;
    }, identity);
    if (matches < 1) {
      await captureDiagnostics(p, input.jobId, "avatar3_look_cleanup_no_match").catch(() => {});
      outcome(false, `match_count_${matches}`);
      return;
    }
    // >1 match means the page HEADER/preview also shows our look (it's the
    // currently-selected one), or the same photo was uploaded twice. The header
    // sits BEFORE the grid in DOM order, so take the LAST stamped card — a grid
    // tile either way (and duplicates carry identical bytes, so any grid match
    // is a correct delete target).
    const tile = p.locator('[data-va-cleanup="1"]').last();
    await tile.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await tile.hover().catch(() => {});
    await p.waitForTimeout(500); // let the hover-mounted icon buttons render

    // 4) Open the tile's "..." more-menu. The three hover buttons are icon-only,
    // so a name-based selector may miss: try the aria-haspopup trigger first,
    // then each button in turn, accepting whichever reveals a Delete item.
    // Escape/goBack out of any wrong click (one icon navigates to the composer).
    let deleteItemVisible = false;
    await clickFirstVisible(avatarShotsLookTileMoreButton(tile), 4000, "look tile more-menu").catch(
      () => {},
    );
    deleteItemVisible = await isVisible(avatarShotsLookDeleteMenuItem(p), 2000);
    if (!deleteItemVisible) {
      const btns = tile.locator('button, [role="button"]');
      const n = Math.min(await btns.count().catch(() => 0), 5);
      for (let i = 0; i < n && !deleteItemVisible; i++) {
        await tile.hover().catch(() => {});
        await p.waitForTimeout(300);
        const b = btns.nth(i);
        const bHtml = (await b.evaluate((el) => el.outerHTML).catch(() => "")) ?? "";
        if (/choose look|create/i.test(bHtml)) continue; // never commit/navigate on purpose
        await b.click({ timeout: 2500, force: true }).catch(() => {});
        deleteItemVisible = await isVisible(avatarShotsLookDeleteMenuItem(p), 2000);
        if (!deleteItemVisible) {
          await p.keyboard.press("Escape").catch(() => {});
          // A wrong icon may have navigated away (e.g. a create-video shortcut).
          if (!(await isVisible(avatarLooksDetailReady(p), 1500))) {
            await p.goBack().catch(() => {});
            await waitFirstVisible(avatarLooksDetailReady(p), 10_000, "looks-detail (back)").catch(
              () => {},
            );
            await tile.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          }
        }
      }
    }
    if (!deleteItemVisible) {
      await captureDiagnostics(p, input.jobId, "avatar3_look_cleanup_no_menu").catch(() => {});
      outcome(false, "no_delete_menu");
      await p.keyboard.press("Escape").catch(() => {});
      return;
    }

    // 5) Delete → confirm ("Delete Look? This action cannot be revoked." →
    // red Delete button).
    await clickFirstVisible(avatarShotsLookDeleteMenuItem(p), 5000, "look Delete item");
    await clickFirstVisible(avatarShotsLookDeleteConfirm(p), 8000, "look Delete confirm").catch(
      () => {},
    );
    // Verify: the stamped tile should leave the DOM.
    const gone = await p
      .waitForFunction(() => !document.querySelector('[data-va-cleanup="1"]'), undefined, {
        timeout: 12_000,
      })
      .then(() => true)
      .catch(() => false);
    if (!gone) {
      await captureDiagnostics(p, input.jobId, "avatar3_look_cleanup_not_deleted").catch(() => {});
    }
    outcome(gone, gone ? "deleted" : "delete_unconfirmed");
    await p.keyboard.press("Escape").catch(() => {});
  } catch (err) {
    await captureDiagnostics(p, input.jobId, "avatar3_look_cleanup_failed").catch(() => {});
    outcome(false, (err as Error).message?.slice(0, 200) ?? "unknown");
    await p.keyboard.press("Escape").catch(() => {});
  }
}

// SHARED post-Generate retrieval (steps 8–9), used by BOTH the Avatar IV and
// Avatar III composers. After Generate is clicked, the finished mp4 lives only
// on the Projects page — this pins OUR render, polls until it finalizes,
// downloads it, uploads to R2, records success, and returns the result.
//
// `genClickTs` (unix seconds, minus a small skew) is the wall-clock just before
// Generate; retrieval only accepts an item created at/after it, so a neighbor
// project's earlier render on the shared account can't be mistaken for ours.
// `usedAudioPath` gates the duration probe: true when the render length equals
// the uploaded audio slice (both new composers are audio-driven), false on the
// IV script fallback (HeyGen TTS sets the length, so the probe is disabled).
async function finishRenderRetrieval(
  p: Page,
  context: BrowserContext,
  account: DecryptedAccount,
  input: GenerateAvatarInput,
  baselineId: string,
  baselineIds: Set<string>,
  genClickTs: number,
  usedAudioPath: boolean,
  t0: number,
): Promise<GenerateAvatarResult> {
  // Give HeyGen a moment to REGISTER the new project before we poll /projects.
  await p.waitForTimeout(4000);

  // PIN our exact render: the ONE video_id that appeared since the pre-generate
  // snapshot. "" degrades to the gated newest-non-baseline scan.
  //
  // WINDOW: HeyGen first inserts a null-id PLACEHOLDER and only promotes it to a
  // real video_id ~10s+ later — much longer when the account/HeyGen is under load
  // (measured against the live items API 2026-07-10). A 30s window was too tight:
  // a slow promotion left pinned:false, and the retrieval below then false-failed
  // with "never appeared", burning an ~8-min attempt before rotating. 120s covers
  // the slow-promotion tail so we pin on the first attempt instead of retrying.
  const pinnedVideoId = await awaitNewItemId(
    context,
    baselineIds,
    120_000,
    3000,
    (ms) => p.waitForTimeout(ms),
    genClickTs,
    input.segmentId,
  ).catch(() => "");
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: "synthetic.heygen.render_pinned",
      projectId: input.projectId,
      segmentId: input.segmentId,
      pinnedVideoId: pinnedVideoId || null,
      pinned: !!pinnedVideoId,
    }),
  );

  // Expected orientation matches what we asked HeyGen to compose: full-frame
  // avatar = landscape, split_2 avatar-half = portrait.
  const expectedAspect: "landscape" | "portrait" =
    input.aspectRatio === "portrait" ? "portrait" : "landscape";
  const videoBytes = await retrieveRenderedVideo(
    p,
    context,
    baselineId,
    usedAudioPath ? (input.audioDurationSeconds ?? 0) : 0,
    expectedAspect,
    pinnedVideoId,
    genClickTs,
    input.segmentId,
  );
  await shot(p, input.projectId, input.segmentId, "done");

  // Upload to R2 under a VERSIONED (timestamped) key so a regenerate gets a fresh
  // URL with nothing stale cached.
  const up = await uploadBuffer(
    videoBytes,
    r2Keys.avatarVideo(input.projectId, input.segmentId, Date.now()),
    "video/mp4",
  );

  await saveCookies(account.id, await context.storageState()).catch(() => {});
  await recordSuccess(account.id);
  recordRenderServed(account.id);

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
}

// One full avatar generation attempt on a single account. Throws a classified
// HeygenError on failure; generateAvatar() wraps this with disposition-aware
// account rotation. Exported for the headed debug script, which pins a SPECIFIC
// account (bypassing the pool claim) so it can drive the account that actually
// holds a given saved avatar — never used by the production worker path.
export async function attemptOnAccount(
  account: DecryptedAccount,
  input: GenerateAvatarInput,
  imageBytes: Buffer,
  // When true, ignore input.audioFilePath and drive via the legacy script path.
  // generateAvatar() sets this on the final retry after an audio-upload failure
  // so a single-account pool still produces an avatar (HeyGen TTS speaks the
  // script) instead of looping on the same broken "Add audio" step until the
  // stall-sweeper kills the job. The render length then follows HeyGen's TTS, not
  // the sliced audio — a worse duration match, but a produced video beats none.
  forceScriptPath = false,
): Promise<GenerateAvatarResult> {
  const e = env();
  // Reuse the WARM session (spec point 4): one browser+context+page is kept alive
  // and shared across jobs, so we do NOT launch a browser, re-verify /home, or
  // open a fresh page per job. acquireJobPage verifies the session ONCE on first
  // use / after a long idle gap (throwing a classified session_expired if dead)
  // and hands back a page already warm on /avatar — so back-to-back jobs skip both
  // the /home Cloudflare challenge (was burning the session after ~3 renders) and
  // the cold /avatar reload (was making generation take minutes to start). The
  // page is NOT closed in finally — it stays warm for the next job.
  const { page: warmPage, context } = await acquireJobPage(account);
  const t0 = Date.now();
  const page: Page = warmPage;
  try {
    const p = page; // alias for use inside async callbacks below

    // 1) Session was already restored + verified by acquireWarmSession. NO login
    // here. An expired session surfaced there as a classified, no-penalty
    // needs_reauth — not a failure.
    await shot(p, input.projectId, input.segmentId, "authed");

    // 1.5) Snapshot the project list BEFORE we generate, so the retrieval step
    // can tell OUR new render apart from prior renders already in the list.
    //   - baselineId: the newest id (legacy fallback used when no pin is found).
    //   - baselineIds: the FULL id set, so after Generate we can pin to the ONE
    //     new id that appears — our render's exact identity, no inference.
    // Best-effort: an empty/"" snapshot just degrades to the gated newest-non-
    // baseline retrieval; it never hard-fails.
    // V3 retrieval requires an API key. If the flag is on but the key is missing,
    // fetchProjectItems returns empty on every poll and retrieval would false-fail;
    // surface it loudly here (once per attempt) rather than silently degrading.
    if (e.HEYGEN_RETRIEVAL_V3 && !e.HEYGEN_API_KEY) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          msg: "synthetic.heygen.retrieval_v3_missing_key",
          note: "HEYGEN_RETRIEVAL_V3 is on but HEYGEN_API_KEY is unset — v3 retrieval cannot work",
        }),
      );
    }
    const baselineIds = await baselineItemIds(context, input.segmentId).catch(() => new Set<string>());
    const baselineId = [...baselineIds][0] ?? "";

    // AVATAR III (orange marks): drive the "Create new shots" / Avatar-Shots
    // composer instead of the /avatar Photo-to-video one, then fall through to the
    // SHARED retrieval below. This path REQUIRES the sliced audio (the whole point
    // is lip-sync to the 69labs voiceover). It NO LONGER needs a user-supplied
    // avatar name: it enters the composer from any seed avatar and overrides the
    // look with the project photo (see driveAvatarIIIComposer). forceScriptPath
    // never applies here.
    if (input.avatarModel === "avatar_iii") {
      if (!input.audioFilePath || forceScriptPath) {
        throw new HeygenError(
          "ui_changed",
          "heygen: Avatar III requires an uploaded audio slice (no script fallback)",
        );
      }
      // Wall-clock just before Generate fires inside the composer, minus skew —
      // the freshness floor for pinning OUR render in the shared Projects list.
      const genClickTs = Math.floor(Date.now() / 1000) - 10;
      const { avatarName, faceCheck } = await driveAvatarIIIComposer(
        p,
        input,
        input.audioFilePath,
        imageBytes,
      );
      // Steps 8–9 (Projects poll + download) are shared; jump straight to them.
      // Always audio-driven on this path (audioFilePath asserted above).
      const result = await finishRenderRetrieval(
        p,
        context,
        account,
        input,
        baselineId,
        baselineIds,
        genClickTs,
        true,
        t0,
      );
      result.faceCheck = faceCheck; // durable ground truth → job metadata (processor)
      // POST-RENDER HYGIENE: delete OTHER projects' machine-made (va-*) avatars
      // from this account so they don't accumulate into HeyGen's avatar-slot
      // limit. Our OWN named avatar is kept — later clips of this project reuse
      // it; a future project's cleanup removes it. Best-effort: the render is
      // already safe in R2, so cleanup never fails the job.
      await cleanupProjectAvatars(p, input, avatarName);
      return result;
    }

    // 2) Re-navigate to the avatar "Quick create" workspace for a CLEAN composer
    // each job. The page is warm (reused across jobs), so this is a fast in-SPA
    // reload — not a cold load — but it still resets any photo/script/audio the
    // previous render left behind. The avatar composer lives at /avatar.
    await p.goto(`${e.HEYGEN_BASE_URL}/avatar`, { waitUntil: "commit" }).catch(() => {});
    // Wait for the composer's script field, the readiness signal. FAST-FAIL
    // (Objective #5) is layered correctly here: we do NOT pre-empt the load —
    // `goto(...commit)` returns before ANY content paints, so a fresh page is
    // ALWAYS momentarily blank, and inspecting it then false-failed legitimate
    // loads (observed: brand-new sessions killed ~3s after launch in a recycle
    // loop). Instead we give the field a SHORT grace wait first; only if that
    // lapses do we inspect the page to decide whether it's genuinely WALLED
    // (Cloudflare/crash -> fail now, ~seconds) or merely SLOW (fall through to
    // the full HEYGEN_SETUP_TIMEOUT_MS wait). The grace wait is the happy path;
    // the inspection only gates the slow/broken branch.
    const graceMs = Math.min(e.HEYGEN_SETUP_TIMEOUT_MS, 12_000);
    const composerReadyFast = await scriptField(p)
      .locator("visible=true")
      .first()
      .waitFor({ state: "visible", timeout: graceMs })
      .then(() => true)
      .catch(() => false);
    if (!composerReadyFast) {
      // Grace lapsed — is the page WALLED, or just slow? Inspect now (cheap).
      const fast = await inspectPage(p);
      if (fast.broken) {
        throw new HeygenError(
          "blank_composer",
          `heygen: avatar composer unusable (fast-fail: ${fast.reason})`,
        );
      }
    }
    try {
      // Already confirmed ready on the happy path; otherwise this is the full
      // patient wait for a slow-but-fine composer (page wasn't walled above).
      if (!composerReadyFast) {
        await waitFirstVisible(scriptField(p), e.HEYGEN_SETUP_TIMEOUT_MS, "avatar composer");
      }
    } catch (err) {
      // The composer never rendered — the /avatar SPA came up BLANK (observed:
      // empty toolbar HTML, no script field). This is almost always the WARM PAGE
      // itself being wedged (a stale render, a silent Cloudflare interstitial, a
      // half-dead context), NOT a moved selector. Reusing the same page on the next
      // retry reproduces the blank page forever — which is exactly the continuous
      // "avatar composer never appeared" loop on a single-account pool. Throw the
      // distinct `blank_composer` class so the catch below tears the warm session
      // down (AFTER capturing diagnostics) and the next attempt rebuilds a fresh
      // page/context from stored cookies instead of re-driving the broken one.
      throw new HeygenError(
        "blank_composer",
        "heygen: avatar composer never appeared (blank /avatar)",
        err,
      );
    }

    // 3) Select the "Photo to video" mode (vs. "Script to video") so the photo
    // upload pane is active. Best-effort: if it's already the active tab the
    // click is harmless; if the tab isn't present the upload step still runs.
    if (await isVisible(photoToVideoTab(p), 3000)) {
      await clickFirstVisible(photoToVideoTab(p), e.HEYGEN_SETUP_TIMEOUT_MS, "photo-to-video tab").catch(
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
        await uploadViaChooser(p, stagePath, e.HEYGEN_SETUP_TIMEOUT_MS);
      });
    } else {
      await uploadViaChooser(p, stagePath, e.HEYGEN_SETUP_TIMEOUT_MS);
    }

    // Confirm the upload landed (our photo shows in the preview pane).
    await waitFirstVisible(selectedPhoto(p), e.HEYGEN_SETUP_TIMEOUT_MS, "uploaded photo preview");
    await shot(p, input.projectId, input.segmentId, "uploaded");

    // 4.5) Set the composer aspect ratio.
    //   - Full-frame avatar  -> 16:9 LANDSCAPE (the synthetic canvas is 1280×720;
    //     a portrait avatar would be letterboxed/cropped in the final video).
    //   - split_2 avatar      -> 9:16 PORTRAIT: the avatar fills only a tall LEFT
    //     half-cell (640×720) at render, so a portrait source fits naturally
    //     while a landscape one would be heavily side-cropped.
    //
    // HeyGen DEFAULTS to 9:16 portrait, so for a full-frame avatar we MUST flip
    // it to landscape and CONFIRM it took — historically this was best-effort
    // and a missed/renamed toggle silently produced a 9:16 letterboxed avatar.
    // For portrait we keep it best-effort: portrait IS the default, so a missed
    // toggle is harmless (the source is already pre-cropped 9:16 either way).
    const wantPortrait = input.aspectRatio === "portrait";
    const wantRatio: "landscape" | "portrait" = wantPortrait ? "portrait" : "landscape";
    const ratioBtn = wantPortrait ? portraitRatioButton(p) : landscapeRatioButton(p);
    const ratioLabel = wantPortrait ? "9:16 portrait toggle" : "16:9 landscape toggle";

    // Click the toggle if it isn't already in the wanted state. These are
    // ICON-ONLY buttons, so the attribute-based locator can miss on a new build;
    // when it does, fall back to a POSITIONAL match (the orientation pair is two
    // adjacent icon buttons in the preview toolbar, landscape left / portrait
    // right). Re-check after each click so a flaky single click gets a retry.
    let toggleEverFound = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await activeRatio(p)) === wantRatio) break;
      // Prefer the attribute-based button; if not visible, try positional.
      let target = ratioBtn;
      if (await isVisible(ratioBtn, 3000)) {
        toggleEverFound = true;
      } else {
        const fallback = await ratioButtonsFallback(p, wantRatio);
        if (fallback) {
          target = fallback;
          toggleEverFound = true;
        } else {
          break; // no toggle locatable at all; handled below
        }
      }
      await clickFirstVisible(target, 10_000, ratioLabel).catch(() => {});
      await p.waitForTimeout(800); // let the canvas re-render to the new ratio
    }
    await shot(p, input.projectId, input.segmentId, wantRatio);

    // If we never located the toggle by ANY means, dump the toolbar HTML once so
    // we can read the real attributes and pin an exact selector. (One-shot
    // diagnostic — cheap, best-effort.)
    if (!toggleEverFound) {
      const html = await dumpRatioToolbar(p).catch(() => "");
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          msg: "synthetic.heygen.ratio_toolbar_not_found",
          projectId: input.projectId,
          segmentId: input.segmentId,
          toolbarHtml: html,
        }),
      );
    }

    // Verify the composer landed in the wanted ratio. We DISTINGUISH two cases:
    //   - confirmed WRONG (e.g. wanted landscape, read portrait): fail loudly so
    //     we don't emit a 9:16 letterboxed full-frame avatar.
    //   - UNCONFIRMED (activeRatio returns null — no readable state/geometry on
    //     this HeyGen build): we already clicked the landscape toggle above, so
    //     PROCEED with a logged warning rather than throwing. Hard-failing on an
    //     unreadable signal was killing otherwise-fine landscape jobs (the toggle
    //     very likely DID apply; we just can't read it back). The render output is
    //     the real source of truth, and a rare wrong-ratio render is far cheaper
    //     than failing every full-frame avatar.
    if (!wantPortrait) {
      const got = await activeRatio(p);
      if (got === "portrait") {
        throw new HeygenError(
          "ui_changed",
          "heygen: composer is confirmed 9:16 portrait after the landscape toggle; " +
            "a full-frame avatar would render letterboxed",
        );
      }
      if (got === null) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            msg: "synthetic.heygen.ratio_unconfirmed",
            projectId: input.projectId,
            segmentId: input.segmentId,
            note: "landscape toggle clicked but active ratio unreadable; proceeding",
          }),
        );
      }
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
    if (input.audioFilePath && !forceScriptPath) {
      await uploadAudioTrack(p, input.audioFilePath, e.HEYGEN_SETUP_TIMEOUT_MS, input.audioDurationSeconds);
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
    // Wall-clock just BEFORE we click Generate. The project list is SHARED across
    // every project on this HeyGen account, so "an id not in the pre-generate
    // baseline" is not enough to identify OUR render: a sibling project's render
    // created around now would also be non-baseline, and on the empty-pin fallback
    // we'd grab it (the "wrong avatar from a previous project" bug). created_ts on
    // each item is the authoritative freshness signal — we only pin/accept an item
    // created AT OR AFTER this moment, so a neighbor's earlier render can never be
    // mistaken for ours. Minus a small skew so a clock difference / a click that
    // fired a beat early can't exclude our own render.
    const genClickTs = Math.floor(Date.now() / 1000) - 10; // seconds (HeyGen created_ts unit)
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

    // 8–9) SHARED retrieval: pin our render, poll Projects until it finalizes,
    // download, upload to R2, record success, and return. usedAudioPath is true
    // only when the render length == the uploaded audio (the probe gate is valid);
    // on the forced-script fallback HeyGen's own TTS sets the length, so disable it.
    const usedAudioPath = !!input.audioFilePath && !forceScriptPath;
    return await finishRenderRetrieval(
      p,
      context,
      account,
      input,
      baselineId,
      baselineIds,
      genClickTs,
      usedAudioPath,
      t0,
    );
  } catch (err) {
    // Classify against the live page, then re-throw a typed HeygenError so the
    // rotation layer can apply the right (often no-penalty) disposition.
    const klass = await classifyHeygenFailure(page, err);
    const typed =
      err instanceof HeygenError
        ? err
        : new HeygenError(klass, (err as Error)?.message ?? "heygen: unknown failure", err);

    // BROWSER-health bookkeeping (Objective #4/#6): record this failure against
    // the warm browser's health BEFORE we decide account disposition. A
    // blank_composer flips the browser unhealthy at once; other classes after a
    // streak. The next acquireWarmSession() recycles the browser if so. This is
    // independent of the ACCOUNT disposition applied in generateAvatar() — a
    // browser problem recycles the browser; an account problem rotates the
    // account. Keyed by accountId so it hits THIS account's warm browser.
    recordRenderFailure(account.id, typed.klass);

    // Spec E: full diagnostics on every failure (url, title, screenshot, HTML).
    await captureDiagnostics(page, input.jobId, "error");
    await shot(page, input.projectId, input.segmentId, "error");

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

    // Drop the warm singleton so the next attempt rebuilds a FRESH page/context
    // (from stored cookies) instead of re-driving a broken one, for the two cases
    // where the held session is the actual problem:
    //   - session_expired/login_required: HeyGen invalidated the cookies mid-job.
    //   - blank_composer: /avatar came up blank — the warm page is wedged, and
    //     reusing it reproduces the blank composer on every retry (the continuous
    //     "composer never appeared" loop, acute on a single-account pool).
    // Other classes (ui_changed, network, …) are NOT the session's fault — keep the
    // warm context so we don't pay a fresh Cloudflare challenge to rebuild it.
    if (
      typed.klass === "session_expired" ||
      typed.klass === "login_required" ||
      typed.klass === "blank_composer"
    ) {
      await invalidateWarmSession(account.id).catch(() => {});
    }
    throw typed;
  }
  // NOTE: no finally that closes the page. The warm page (and its context +
  // browser) are REUSED across jobs — that reuse is the fix for both the session
  // expiry and the slow start. Teardown happens on worker shutdown
  // (closeWarmSession) or when a session_expired invalidation rebuilds it.
}

// Attempt the OFFICIAL HeyGen API path for this clip. Shared by the two triggers
// that route here: the EARLY speed switch (mid-rotation, if enabled) and the
// pool-exhausted last resort. Renders AVATAR III via a saved photo-avatar look
// (found/created by va- name — see heygen-api.ts; client 2026-07-20: Avatar IV
// is too expensive). Returns the result on success, or null when the API path
// is not
// applicable (flag/key off, or no sliced audio) OR the API render itself failed —
// the caller then continues the browser rotation / throws the original error.
// Never throws: an API failure must not mask the underlying browser error.
async function tryApiFallback(
  input: GenerateAvatarInput,
  imageBytes: Buffer,
  reason: string,
): Promise<GenerateAvatarResult | null> {
  // Scope guard: requires the flag/key AND the sliced audio (never HeyGen TTS —
  // wrong audio is unusable). Otherwise the API path is unavailable → return null.
  //
  // ENGINE: renders as Avatar III via the saved photo-avatar route (the one-shot
  // type:"image" path is not used — it has no engine choice and bills Avatar IV;
  // probed live 2026-07-21, see heygen-api.ts).
  if (
    (!heygenApiFallbackEnabled() && !heygenApiFirstEnabled()) ||
    (!input.audioUrl && !input.audioFilePath)
  ) {
    return null;
  }
  try {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "heygen.api_fallback.attempt",
        projectId: input.projectId,
        segmentId: input.segmentId,
        reason,
      }),
    );
    return await generateAvatarViaApi(input, imageBytes);
  } catch (apiErr) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "heygen.api_fallback.failed",
        projectId: input.projectId,
        segmentId: input.segmentId,
        reason,
        err: (apiErr as Error)?.message?.slice(0, 200),
      }),
    );
    return null;
  }
}

/**
 * Generate an avatar video, rotating through the account pool on failure. Each
 * account gets one attempt; the FAILURE CLASS decides what happens to it:
 *   - session_expired  -> flagged needs_reauth (no cooldown, no fail bump)
 *   - rate_limit/credit -> cooldown
 *   - ui_changed/selector/network -> rotate with NO penalty (not the account's
 *     fault — surfaced via last_error_class + diagnostics instead)
 * then the next available account is tried, up to `maxAccounts`. When
 * `maxAccounts` is omitted it defaults to the WHOLE usable pool
 * (countUsableAccounts) so rotation tries EVERY account before failing — adding a
 * 4th/5th account is picked up automatically, no code change. Throws when the
 * pool is exhausted or none succeed — the avatar processor decides how to
 * degrade.
 */
export async function generateAvatar(
  input: GenerateAvatarInput,
  imageBytes: Buffer,
  maxAccounts?: number,
): Promise<GenerateAvatarResult> {
  // FORCE-API (client 2026-07-07): the worker has already made this clip WAIT for a
  // free browser account past the threshold (2 wait cycles / 30 min). Stop waiting
  // and render via the API directly, skipping the pool entirely — no anti-bot
  // spacing, no account claim (the API doesn't trip Cloudflare). If the API path
  // isn't usable (flag off / not audio-driven) tryApiFallback returns null and we
  // surface PoolBusyError so the clip fails visibly rather than looping forever.
  if (input.forceApi) {
    const apiResult = await tryApiFallback(
      input,
      imageBytes,
      "forced to API after waiting for a free browser account past threshold",
    );
    if (apiResult) return apiResult;
    throw new PoolBusyError(
      "heygen: no free browser account and API fallback unavailable for this clip",
    );
  }

  // API-FIRST (client 2026-09-01: the headless-browser automation "is not needed
  // now" — render avatar clips through the official API). The API becomes the
  // PRIMARY route: no account claim, no anti-bot spacing, no Chromium. The browser
  // pool is kept intact behind it purely as a safety net, so clearing
  // HEYGEN_API_FIRST restores the old behaviour with no code change.
  //
  // Aspect ratio is honoured explicitly by this path — heygen-api.ts maps
  // input.aspectRatio to aspect_ratio 16:9 (full-frame) / 9:16 (split_2) in the
  // create-video body, which is stricter than the browser path's reliance on
  // HeyGen's UI defaults.
  //
  // Records that the API was already tried as the PRIMARY route, so the
  // last-resort block at the end of this function doesn't bill a second render,
  // and so an API-only deployment reports the real API error.
  let apiFirstAttempted = false;
  let apiFirstError: Error | null = null;

  // (forceApi is necessarily falsy here — the block above always returns or throws.)
  if (heygenApiFirstEnabled()) {
    // Audio-driven only, exactly as everywhere else: a clip with no sliced
    // voiceover would render HeyGen's own TTS = wrong audio, which the client has
    // called worse than no render. Such a clip falls through to the browser path
    // rather than being spoken by the wrong voice.
    if (input.audioUrl || input.audioFilePath) {
      apiFirstAttempted = true;
      try {
        return await generateAvatarViaApi(input, imageBytes);
      } catch (apiErr) {
        apiFirstError = apiErr as Error;
        // The API is primary, so its failure is NOT swallowed the way
        // tryApiFallback swallows a last-resort failure. Log it, then let the
        // browser pool below try to rescue the clip; if the pool also fails, the
        // error thrown at the end of this function reports the browser failure and
        // this one is preserved here in the logs for diagnosis.
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            msg: "heygen.api_first.failed",
            projectId: input.projectId,
            segmentId: input.segmentId,
            aspectRatio: input.aspectRatio ?? "landscape",
            err: (apiErr as Error)?.message?.slice(0, 300),
          }),
        );
      }
    } else {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          msg: "heygen.api_first.skipped_no_audio",
          projectId: input.projectId,
          segmentId: input.segmentId,
        }),
      );
    }
  }

  // Default the rotation cap to the full usable pool so we never stop short of an
  // account that WOULD succeed (the "only 3 of 4 tried" gap). An explicit
  // maxAccounts (e.g. the debug script's 1) still wins.
  const rotationCap = maxAccounts ?? (await countUsableAccounts());

  // Anti-bot pacing: space serial avatar jobs apart so a back-to-back burst
  // doesn't trip HeyGen's Cloudflare protection (which kills the session).
  const spacingMs = env().HEYGEN_JOB_SPACING_SECONDS * 1000;
  if (spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));

  // PARALLEL-SAFE ACCOUNT CLAIM. With AVATAR_CONCURRENCY > 1 several avatar jobs
  // run at once; each must drive a DISTINCT account or they'd corrupt each
  // other's warm browser. claimAccount() leases one account atomically (FOR
  // UPDATE SKIP LOCKED in the DB), so two concurrent jobs can never get the same
  // one. The lease AUTO-EXPIRES (a crashed worker frees its account), and we
  // release it in the finally below. Lease length = the render timeout plus
  // headroom, so a normal render never outlives its lease; a genuinely long one
  // is kept alive by renewLease() heartbeats between attempts.
  const leaseSeconds = env().HEYGEN_ACCOUNT_LEASE_SECONDS;
  let account = await claimAccount(leaseSeconds);
  if (!account) {
    // POOL CONTENTION (client 2026-07-07): "Retry all failed" / a burst enqueues
    // MORE avatar jobs than there are accounts, so the overflow jobs find every
    // account busy rendering. This is NOT an account defect and must NOT hard-fail
    // the clip. Signal PoolBusyError so the avatar worker RE-DELAYS the job and the
    // clip WAITS in the queue for an account to free (a browser render is ~150s, so
    // one usually frees within a wait cycle → the clip then renders on the cheap
    // browser path). The worker switches the clip to the API only after the
    // client's threshold (2 wait cycles / 30 min). See avatarProcessor.
    //
    // EXCEPT under API-FIRST: the API was already the primary route and it FAILED,
    // so no browser account is going to help and the pool-wait cycle would just
    // re-delay the clip (and eventually set forceApi, re-billing the same failing
    // render) instead of surfacing the real cause. This also covers the
    // decommissioned-pool case, where countUsableAccounts()'s floor of 1 means we
    // reach here with no accounts configured at all. Fail with the API's error.
    if (apiFirstAttempted) {
      throw new Error(
        `heygen: API render failed and no browser account was available — ${
          apiFirstError?.message ?? "unknown"
        }`,
      );
    }
    throw new PoolBusyError(
      "heygen: all accounts are busy rendering — waiting for one to free up",
    );
  }

  // SPEED SWITCH thresholds (client 2026-07-06): route to the API EARLY — before
  // the whole pool exhausts — once either fires. A failed account count of 0 or a
  // minutes of 0 disables that trigger. Both are inert unless the API fallback is
  // enabled + configured (heygenApiFallbackEnabled), so production is unchanged
  // until the key + flag are set.
  const switchAfterAccounts = env().HEYGEN_API_SWITCH_AFTER_ACCOUNTS;
  const switchAfterMs = env().HEYGEN_API_SWITCH_AFTER_MINUTES * 60_000;
  const clipStartMs = Date.now();
  // Reason recorded when an early switch fires, so the loop can attempt the API
  // after releasing the account (mirrors the pool-exhausted path's ordering).
  let earlySwitchReason: string | null = null;

  let lastErr: unknown;
  try {
    // NEVER degrade an audio-driven job to the script (HeyGen TTS) path. The audio
    // path attaches the sliced 69labs voiceover so the render carries the CORRECT
    // audio; the script path speaks HeyGen's own TTS = WRONG audio on the clip,
    // which is UNUSABLE and still burns a HeyGen credit. The client made clear that
    // a wrong-audio render is worse than no render (wasted credit, unusable output).
    //
    // So an audio-upload failure is treated like any other failure: we ROTATE to a
    // fresh account and retry the SAME audio path (a fresh session usually uploads
    // the same audio cleanly). If every account's fresh session still fails the
    // upload, we throw — the job hard-fails and no credit is spent on a wrong-audio
    // render. `forceScriptPath` is left false on every attempt for audio-driven
    // jobs; it stays available only for genuinely script-only inputs (no
    // audioFilePath), which were never audio-driven to begin with.
    for (let i = 0; i < rotationCap; i++) {
      // Extend the lease before each attempt so a multi-minute render can't lapse
      // it and let a peer job claim the same account mid-render.
      await renewLease(account, leaseSeconds).catch(() => {});
      const attemptAccount = account;
      // Mark a render in flight ON THIS ACCOUNT so the keep-alive sweep won't
      // open a second concurrent HeyGen browser on top of it (the Cloudflare
      // page-wipe trigger). Per-account now (was a global flag) since several
      // accounts render at once; cleared on success AND failure.
      beginRender(attemptAccount.id);
      try {
        return await attemptOnAccount(attemptAccount, input, imageBytes, false);
      } catch (err) {
        lastErr = err;
        // Rotate: apply this account's disposition AND atomically claim+lease the
        // NEXT account in one step (applyDisposition claim mode). Then release the
        // FAILED account's lease so it's free again once its penalty allows.
        const next = await applyDisposition(
          attemptAccount.id,
          dispositionOf(err),
          classOf(err),
          (err as Error).message ?? "unknown",
          { mode: "claim", leaseSeconds },
        );
        await releaseAccount(attemptAccount).catch(() => {});
        if (!next) break; // pool exhausted
        account = next;

        // EARLY SPEED SWITCH. Only when the API path is actually usable — no point
        // aborting the browser rotation for an API that would no-op. `i` is
        // 0-indexed, so after the (i+1)-th failure `i + 1` browser accounts have
        // failed. When the client's "after N tries" or "after M minutes" threshold
        // is crossed, stop rotating and hand this clip to the API instead of
        // grinding through the remaining accounts (and the outer BullMQ retries).
        if (heygenApiFallbackEnabled()) {
          const accountsFailed = i + 1;
          const elapsedMs = Date.now() - clipStartMs;
          const countHit = switchAfterAccounts > 0 && accountsFailed >= switchAfterAccounts;
          const timeHit = switchAfterMs > 0 && elapsedMs >= switchAfterMs;
          if (countHit || timeHit) {
            earlySwitchReason = countHit
              ? `speed switch: ${accountsFailed} browser account(s) failed (>= ${switchAfterAccounts})`
              : `speed switch: ${Math.round(elapsedMs / 60_000)} min elapsed (>= ${env().HEYGEN_API_SWITCH_AFTER_MINUTES})`;
            break;
          }
        }
      } finally {
        endRender(attemptAccount.id);
      }
    }
  } finally {
    // Release whatever account we currently hold (the successful one on the happy
    // path — the return above runs this finally first; the last-tried one on the
    // exhausted path). Failed accounts mid-loop were already released above, and
    // releaseAccount is a no-op for one whose lease we no longer own, so this is
    // safe to call unconditionally.
    await releaseAccount(account).catch(() => {});
  }

  // API FALLBACK (now reachable two ways, both released the account in the finally
  // above so the API never runs on top of a held browser lease):
  //   * EARLY SPEED SWITCH — a trigger fired mid-rotation (client's "after 2 tries
  //     / after 30 min" rule); switch instead of exhausting the pool + BullMQ
  //     retries. This is the fast-recovery path for the "temporarily unavailable"
  //     account failures that fail in seconds.
  //   * LAST RESORT — the browser pool exhausted with no early trigger; produce a
  //     clip that would otherwise HARD-FAIL.
  // Both bill API credits (pricier than the browser renders), so tryApiFallback is
  // a no-op unless enabled + configured and audio-driven. On an API
  // failure it returns null and we fall through to the original error below.
  // When API-FIRST already attempted (and failed) the API at the top of this
  // function, re-running it here would bill a second render for the same clip and
  // almost certainly fail the same way. Skip straight to the error.
  if (!apiFirstAttempted) {
    const apiReason =
      earlySwitchReason ??
      `pool exhausted: ${(lastErr as Error)?.message?.slice(0, 200) ?? "unknown"}`;
    const apiResult = await tryApiFallback(input, imageBytes, apiReason);
    if (apiResult) return apiResult;
  }

  // Report the API error when that was the primary route and the browser pool
  // never produced a real attempt of its own — otherwise an API-only deployment
  // (no browser accounts configured) would surface a confusing "failed across 1
  // account(s): all accounts are busy" instead of the actual API failure.
  if (apiFirstAttempted && apiFirstError && !lastErr) {
    throw new Error(`heygen: API render failed — ${apiFirstError.message}`);
  }

  throw new Error(
    `heygen: avatar generation failed across ${rotationCap} account(s): ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}

// Re-export account helpers so callers can `from "@/lib/synthetic/heygen"`.
export {
  getAvailableAccount,
  applyDisposition,
  saveCookies,
  restoreCookies,
} from "@/lib/synthetic/heygen-accounts";

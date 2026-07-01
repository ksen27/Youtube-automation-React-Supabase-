import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { type Page, type BrowserContext } from "playwright";
import { getEnv } from "@/lib/env";
import { probeFile } from "@/lib/media/probe";
import { uploadBuffer } from "@/lib/storage";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import {
  claimAccount,
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

// HeyGen's created_ts is Unix SECONDS, but be defensive: normalize a value that
// looks like milliseconds (13+ digits) down to seconds so the freshness guard
// can't silently mis-compare units. Returns null when absent/non-numeric so the
// caller falls back to the baseline-only test rather than over-rejecting.
function createdSeconds(it: HeygenProjectItem): number | null {
  const v = it.created_ts;
  if (typeof v !== "number" || !isFinite(v) || v <= 0) return null;
  return v > 1e12 ? Math.floor(v / 1000) : v;
}

// Fetch the avatar-video list via the authed browser context (cookies apply).
async function fetchProjectItems(context: BrowserContext): Promise<HeygenProjectItem[]> {
  const resp = await context.request.get(HEYGEN_ITEMS_API, { timeout: env().HEYGEN_NAV_TIMEOUT_MS }).catch(() => null);
  if (!resp || !resp.ok()) return [];
  const json = (await resp.json().catch(() => null)) as { data?: { items?: HeygenProjectItem[] } } | null;
  return json?.data?.items ?? [];
}

// The FULL set of video_ids present before we generate. Used to pin retrieval to
// the EXACT render we just made: after clicking Generate, the one id that is NOT
// in this set is unambiguously ours — no inference from "newest" or duration.
async function baselineItemIds(context: BrowserContext): Promise<Set<string>> {
  const items = await fetchProjectItems(context);
  return new Set(items.map((it) => it.video_id).filter(Boolean));
}

// After Generate, poll the list until a NEW video_id (not in the pre-generate
// baseline set) appears, and return it. This is OUR render's stable id. Polls
// within `appearMs` — HeyGen registers the new project row a few seconds after
// the click. Returns "" if none appears (caller falls back to the gated
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
): Promise<string> {
  const deadline = Date.now() + appearMs;
  while (Date.now() < deadline) {
    const items = await fetchProjectItems(context);
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
    const resp = await context.request.get(url, { timeout: e.HEYGEN_NAV_TIMEOUT_MS }).catch(() => null);
    if (!resp || !resp.ok()) return null;
    const buf = Buffer.from(await resp.body());
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
    const items = await fetchProjectItems(context);
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

// One full avatar generation attempt on a single account. Throws a classified
// HeygenError on failure; generateAvatar() wraps this with disposition-aware
// account rotation.
async function attemptOnAccount(
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
    const baselineIds = await baselineItemIds(context).catch(() => new Set<string>());
    const baselineId = [...baselineIds][0] ?? "";

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

    // Give HeyGen a moment to REGISTER the new project before we poll /projects.
    // Navigating instantly after the click can beat the backend creating the
    // project row, so the grid shows only prior cards. A short settle lets our
    // render appear (the poll loop below still tolerates it being mid-render).
    await p.waitForTimeout(4000);

    // PIN our exact render: find the ONE video_id that appeared since the pre-
    // generate snapshot. That id IS our render — retrieval then polls only it and
    // can never pick a same-length render of another segment from the shared
    // account list. Best-effort within ~30s; "" degrades to the gated newest-non-
    // baseline scan (still protected by the duration/aspect probe gates).
    const pinnedVideoId = await awaitNewItemId(
      context,
      baselineIds,
      30_000,
      3000,
      (ms) => p.waitForTimeout(ms),
      genClickTs,
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

    // 8–9) Retrieve the finished video from the Projects page (the only place
    // the rendered mp4 exists). Returns the downloaded bytes.
    //
    // expectedSeconds gates the duration validation. ONLY pass it on the
    // audio-driven path: there the render length == the uploaded audio, so the
    // probe gate is correct. On the forced-script fallback HeyGen's own TTS sets
    // the length (not our audio), so passing audioDurationSeconds would let the
    // probe wrongly reject a valid render — pass 0 to keep the legacy behavior.
    const usedAudioPath = !!input.audioFilePath && !forceScriptPath;
    // Expected orientation always matches what we asked HeyGen to compose:
    // full-frame avatar = landscape, split_2 avatar-half = portrait. Defaults to
    // landscape when unset (the full-frame default). This guards against picking
    // a stale render of the OTHER aspect ratio for the same segment.
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
    );
    await shot(p, input.projectId, input.segmentId, "done");

    // 8) Upload to R2 under a VERSIONED key (timestamp) so a regenerate writes a
    // NEW URL. Overwriting the same key left the CDN/browser serving the stale
    // cached video (old aspect ratio/duration) after a regenerate; a fresh URL
    // has nothing cached. The new URL is persisted to the segment row by the
    // caller, so the app always points at this file.
    const up = await uploadBuffer(
      videoBytes,
      r2Keys.avatarVideo(input.projectId, input.segmentId, Date.now()),
      "video/mp4",
    );

    // Persist the now-fresh cookies to the DB (status untouched) so a cold start
    // or the keep-alive sweep has the latest session. The LIVE context already
    // holds these cookies and stays warm for the next job — we save, we do not
    // reload.
    await saveCookies(account.id, await context.storageState()).catch(() => {});
    await recordSuccess(account.id);
    // Mark this render a success: clears the warm browser's failure streak
    // (keeps a healthy browser warm) and counts it against the backstop render
    // cap. Once the cap is reached — or health degrades earlier — the NEXT
    // acquire recycles the browser to a fresh fingerprint before Cloudflare walls
    // it into a blank composer. Keyed by accountId so it targets THIS account's
    // warm browser in the pool.
    recordRenderServed(account.id);

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
    throw new HeygenError(
      "session_expired",
      "heygen: no available accounts in pool — every account is busy or awaiting re-auth; " +
        "connect or re-auth one with `npm run heygen:connect <email>`",
    );
  }

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
    for (let i = 0; i < maxAccounts; i++) {
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

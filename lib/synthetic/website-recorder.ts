import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { getEnv } from "@/lib/env";

// WEBSITE SCROLL-RECORDER for the AI-generated sales pitch (migration 0026).
//
// The client's reference pitch shows the pitched WEBSITE being scrolled through
// on screen. Rather than have an image model INVENT a website UI (unreliable —
// it hallucinates a fake-looking site), we load the REAL site in a headless
// Chromium and record a video while auto-scrolling top→bottom. The capture IS
// the real site, so the UI is always pixel-correct.
//
// This is a plain public-web browser session — NO HeyGen auth, NO proxy, NO
// stored cookies. It reuses vanilla Playwright (already a dependency for the
// HeyGen automation), so no new infrastructure is added. The avatar worker host
// already ships Chromium, which is why the pitch job runs there.
//
// Output is a WEBM (Playwright's native recording format) at the requested
// viewport size. The caller normalizes it to the render canvas + concatenates it
// after the avatar half. Recording length ≈ scrollSeconds + small head/tail
// pauses so the page has a beat to settle before and after the scroll.

export interface RecordWebsiteScrollOptions {
  url: string;
  // Local file path to write the recorded .webm to. The parent dir is created.
  outputPath: string;
  // Capture viewport. Defaults to a 1280×720 landscape frame matching the
  // synthetic render canvas so the downstream normalize is a near-no-op.
  width?: number;
  height?: number;
  // FIXED target duration (seconds) for the scroll from top to bottom. This is
  // the PRIMARY control for the pitch: the website clip must always be a set
  // length (client rule: the pitch shows the website for exactly the last N
  // seconds). The scroll PACE is derived to fit the whole page into this time —
  // a tall page scrolls faster, a short page slower — so the clip is always
  // ~targetScrollSeconds regardless of page height. Defaults to 10s.
  targetScrollSeconds?: number;
  // ALT MODE (only used when targetScrollSeconds is not set): scroll at this
  // constant pace (px/s) and let the duration fall out of the page height, capped
  // by maxScrollSeconds. Kept for a "readable constant pace" use; the pitch does
  // NOT use this — it pins the duration via targetScrollSeconds.
  scrollPixelsPerSecond?: number;
  maxScrollSeconds?: number;
  // DEPRECATED alias for maxScrollSeconds (old callers).
  scrollSeconds?: number;
  signal?: AbortSignal;
}

export interface RecordWebsiteScrollResult {
  // Absolute path of the recorded .webm (same as opts.outputPath, resolved).
  videoPath: string;
  // Wall-clock recording length actually captured, seconds (best-effort — the
  // caller re-probes the file for the authoritative duration).
  approxSeconds: number;
  // Seconds from the START of the recording to the moment the smooth scroll
  // begins (page load + eager-image settle + head pause all happen before this).
  // The caller trims the recording to start here so the final clip opens on the
  // scroll instead of holding static dead-air on the top of the page.
  scrollStartSeconds: number;
}

// A short settle at the start (let the page paint / fonts load / lazy images
// begin) and at the end (hold the footer a beat before we cut) so the scroll
// doesn't begin on a half-rendered page or end on an abrupt cut.
const HEAD_PAUSE_MS = 1500;
const TAIL_PAUSE_MS = 1000;

/**
 * Load `url` in a headless browser and record a top→bottom auto-scroll to a
 * .webm. Best-effort on page quirks: navigation uses "domcontentloaded" (not
 * "networkidle", which never fires on sites with long-poll / analytics beacons),
 * and the scroll is driven by measuring the live scrollHeight each step so lazy-
 * loaded content that grows the page is still covered.
 *
 * Throws only on a hard failure (launch failed, navigation threw, nothing
 * recorded). The caller treats a throw as "website half unavailable" and fails
 * the pitch job with a clear message.
 */
export async function recordWebsiteScroll(
  opts: RecordWebsiteScrollOptions,
): Promise<RecordWebsiteScrollResult> {
  const env = getEnv();
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  // DURATION mode (the pitch default): record a FIXED number of seconds (default
  // 10s) of scrolling at a COMFORTABLE, CONSTANT reading pace — then stop. The
  // scroll does NOT try to reach the bottom: it just moves at a calm human speed
  // for the window and cuts. On a tall page that means only the top portion is
  // shown, which is fine — the client wants a watchable pace over full coverage.
  // So the pace is FIXED (pixelsPerSecond), NOT derived from page height.
  const targetScrollMs = opts.targetScrollSeconds && opts.targetScrollSeconds > 0
    ? Math.max(2000, Math.round(opts.targetScrollSeconds * 1000))
    : opts.scrollPixelsPerSecond && !opts.targetScrollSeconds
      ? null // explicit constant-pace-until-bottom mode (no fixed window)
      : 10_000; // default: 10s window at a comfortable pace
  // Comfortable reading pace. ~200 px/s scrolls ~2.7 viewport-heights over a 10s
  // window — brisk enough to feel alive, still readable, and it never rushes to
  // fit the whole page into the window.
  const pixelsPerSecond = Math.max(40, opts.scrollPixelsPerSecond ?? 200);
  // scrollSeconds (deprecated) folds into the cap so old callers still bound it.
  const maxScrollMs = Math.max(4000, Math.round((opts.maxScrollSeconds ?? opts.scrollSeconds ?? 25) * 1000));

  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  // Playwright names the recording file itself (a hash) inside recordVideo.dir,
  // so we record into a dedicated temp dir and move the single produced file to
  // outputPath afterwards.
  const recordDir = `${opts.outputPath}.rec`;
  await fs.mkdir(recordDir, { recursive: true });

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      // Container essentials — same flags the HeyGen path uses on the worker.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      locale: "en-US",
      // Record the whole session; we trim implicitly by how long the page stays
      // open (close → recording finalizes).
      recordVideo: { dir: recordDir, size: { width, height } },
    });
    // Cap every wait so a slow/hanging site can't stall the worker indefinitely.
    context.setDefaultTimeout(env.HEYGEN_NAV_TIMEOUT_MS);

    const page = await context.newPage();
    // Playwright's video recording begins at page creation, so this is ~t=0 of
    // the recorded stream. We measure the scroll-start offset against it so the
    // caller can trim the pre-scroll dead-air off the front.
    const recStartMs = Date.now();
    const abortHandler = () => { void browser?.close(); };
    opts.signal?.addEventListener("abort", abortHandler);

    // domcontentloaded, NOT networkidle: many marketing sites keep a socket /
    // analytics beacon open forever, so networkidle would time out on a page
    // that is visually done. We add an explicit settle pause below instead.
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: env.HEYGEN_NAV_TIMEOUT_MS });

    // Dismiss the most common cookie/consent overlays so they don't sit on top
    // of the whole recording. Best-effort: click the first visible match, ignore
    // if none. Kept as literal button text (no site-specific selectors).
    await dismissConsent(page);

    // STABILIZE PAGE HEIGHT before scrolling — WITHOUT a visible jog. Marketing
    // pages lazy-load images/sections as you approach them, which grows the page
    // mid-scroll and makes the content jump under the moving viewport (the
    // "unstable screen" you saw). Rather than jump the viewport to the bottom and
    // back (that jumpy jog was itself recorded), we force every deferred image to
    // load in place — flip loading="lazy"→"eager", trigger native lazy loaders by
    // toggling loading, and hint the browser to fetch — all while the viewport
    // stays at the top. Then we wait for the network + layout to settle, so the
    // real scroll below runs over a page whose height no longer changes.
    // No inner function declarations (tsx __name trap — see tsx-evaluate-name-error).
    await page.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll("img"));
      for (const img of imgs) {
        try {
          img.loading = "eager";
          // Some lazy loaders swap data-src → src on intersection; do it eagerly.
          const ds = img.getAttribute("data-src");
          if (ds && !img.src) img.src = ds;
          const dss = img.getAttribute("data-srcset");
          if (dss && !img.srcset) img.srcset = dss;
        } catch { /* ignore a locked property */ }
      }
      // Give the browser a moment to kick off the now-eager fetches.
      await new Promise((r) => setTimeout(r, 400));
    });
    // Wait for those image fetches to finish so the page height is final before
    // the scroll. Best-effort: networkidle can hang on beacon sockets, so cap it
    // and fall through on timeout (the height is usually settled by then anyway).
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(HEAD_PAUSE_MS);

    // Offset (from recording start) at which the smooth scroll begins. Everything
    // before this — page load, eager-image settle, networkidle wait, head pause —
    // is static top-of-page dead-air the caller trims off the front.
    const scrollStartMs = Date.now();

    // SMOOTH, CONSTANT-PACE scroll top→bottom, driven from the NODE side with
    // REAL WHEEL INPUT (page.mouse.wheel), NOT window.scrollTo in the page.
    //
    // WHY WHEEL, NOT scrollTo: many modern marketing sites use a smooth-scroll /
    // scroll-hijacking library (Lenis, Locomotive, GSAP ScrollSmoother, …) that
    // intercepts native scrolling and moves the content via CSS transform in
    // response to WHEEL/TOUCH events. On those pages window.scrollTo is a NO-OP
    // (measured on themechanicbible.com: window.scrollTo(0,500) left scrollY at 0)
    // — which is why the earlier scrollTo-based versions recorded a page that
    // never moved (the "paused, then a fast rush" you saw). Dispatching real wheel
    // deltas is what those libraries honour, and it also works on plain pages.
    //
    // We measure the real scrolled distance each tick (works for both window
    // scroll and transform-based hijackers via the fallbacks in scrollProgress)
    // and stop when we reach the bottom OR hit the time cap. Constant delta per
    // tick = constant, readable pace; a short ramp on the first few ticks avoids a
    // jarring initial jump.
    // Position the pointer over the page so wheel events land on the content
    // (some scroll libraries only capture wheels over the scroll container).
    await page.mouse.move(width / 2, height / 2);
    const totalHeight = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    );
    const viewportH = height;
    const distance = Math.max(0, totalHeight - viewportH);
    if (distance > 0) {
      // How long to RECORD scrolling.
      //   DURATION MODE (pitch default): a fixed window (10s). We scroll at a
      //     constant comfortable pace for this long and then STOP — we do NOT try
      //     to reach the bottom. On a tall page only the top portion is shown; the
      //     client wants a calm, readable speed over full coverage.
      //   CONSTANT-PACE-TO-BOTTOM MODE: run until the bottom at the given pace,
      //     capped by maxScrollMs.
      const runMs = targetScrollMs != null
        ? targetScrollMs
        : Math.min(maxScrollMs, (distance / pixelsPerSecond) * 1000);
      const tickMs = 40;
      const loopStart = Date.now();

      // CLOSED-LOOP POSITION TRACKING at a CONSTANT PACE. Desired position advances
      // at pixelsPerSecond × elapsed-time (with a brief ease-in so it starts
      // softly), clamped to the page bottom. Each tick we read the ACTUAL scrolled
      // position and fire a wheel delta to close the gap — feedback cancels the
      // momentum overshoot that smooth-scroll libraries (Lenis/Locomotive/GSAP)
      // add, so the pace stays steady and calm instead of lurching. The loop stops
      // at runMs regardless of where on the page we are (duration mode) — that's
      // the whole point: a fixed watchable window, not a race to the footer.
      const easeInMs = 800; // soft start
      let stuckChecks = 0;
      let lastY = -1;
      for (;;) {
        const elapsed = Date.now() - loopStart;
        // Constant-pace target position: pace × time, with a gentle ease-in ramp
        // over the first easeInMs so the scroll doesn't jerk into motion.
        const ramp = Math.min(1, elapsed / easeInMs);
        const paced = (pixelsPerSecond * elapsed / 1000) * (0.5 + 0.5 * ramp);
        const desiredY = Math.min(distance, paced);
        // Read the effective scroll position (native OR transform-based hijacker).
        const y = await page.evaluate(() => {
          const winY = window.scrollY || document.documentElement.scrollTop || 0;
          if (winY > 0) return winY;
          const scroller = document.querySelector("[data-scroll-container], .smooth-scroll, main") as HTMLElement | null;
          if (scroller) {
            const m = getComputedStyle(scroller).transform;
            if (m && m !== "none") {
              const parts = m.match(/matrix.*\((.+)\)/);
              if (parts) { const v = parts[1].split(", "); return Math.abs(parseFloat(v[v.length - 1])) || 0; }
            }
          }
          return winY;
        });
        // Fire only the gap. Clamp per-tick to ~¼ viewport so a correction can't
        // itself trigger a momentum lurch; small gaps advance smoothly.
        const gap = desiredY - y;
        if (gap > 0.5) await page.mouse.wheel(0, Math.min(viewportH / 4, gap));
        await page.waitForTimeout(tickMs);
        if (elapsed >= runMs) break; // fixed window elapsed — stop wherever we are
        // Safety only: if the page can't scroll further (already at its bottom, or
        // un-scrollable) keep holding position for the rest of the window rather
        // than spinning — but DON'T break, so the clip still fills the full time.
        if (desiredY >= distance) { /* at bottom: hold here for the remaining time */ }
        else if (Math.abs(y - lastY) < 1) { stuckChecks++; } else stuckChecks = 0;
        lastY = y;
        void stuckChecks;
      }
    }

    await page.waitForTimeout(TAIL_PAUSE_MS);

    // Closing the context finalizes the .webm. Grab its path before closing.
    const video = page.video();
    await context.close();
    opts.signal?.removeEventListener("abort", abortHandler);

    const recordedPath = video ? await video.path() : null;
    if (!recordedPath) throw new Error("website-recorder: no video was recorded");

    // Move the single recorded file to the requested output path.
    await fs.rename(recordedPath, opts.outputPath).catch(async () => {
      // Cross-device rename can fail; fall back to copy.
      await fs.copyFile(recordedPath, opts.outputPath);
      await fs.unlink(recordedPath).catch(() => {});
    });

    // Best-effort estimate — the caller re-probes the file for the real length.
    // In duration mode the scroll runs ~targetScrollMs; otherwise it's bounded by
    // maxScrollMs (an upper bound).
    const scrollPhaseMs = targetScrollMs ?? maxScrollMs;
    const approxSeconds = (HEAD_PAUSE_MS + scrollPhaseMs + TAIL_PAUSE_MS) / 1000;
    // Trim a little BEFORE the measured scroll start so the cut lands during the
    // head pause (a beat of the static page) rather than mid-motion — keeps a
    // clean lead-in without the long dead-air.
    const scrollStartSeconds = Math.max(0, (scrollStartMs - recStartMs) / 1000 - 0.5);
    return { videoPath: path.resolve(opts.outputPath), approxSeconds, scrollStartSeconds };
  } finally {
    await browser?.close().catch(() => {});
    // Clean up the (now-empty) record dir; ignore if the rename already emptied it.
    await fs.rm(recordDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Best-effort cookie/consent dismissal. Tries a few common accept-button labels;
// clicks the first visible one and returns. Never throws — a leftover banner is
// cosmetically imperfect but not a failure.
async function dismissConsent(page: import("playwright").Page): Promise<void> {
  const labels = [
    "Accept all",
    "Accept All",
    "Accept",
    "I agree",
    "Got it",
    "Allow all",
    "Agree",
  ];
  for (const label of labels) {
    try {
      const btn = page.getByRole("button", { name: label, exact: false }).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click({ timeout: 1000 }).catch(() => {});
        return;
      }
    } catch {
      // ignore and try the next label
    }
  }
}

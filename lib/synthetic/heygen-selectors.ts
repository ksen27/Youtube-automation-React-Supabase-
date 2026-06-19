import type { Page, Locator } from "playwright";
import { HeygenError } from "@/lib/synthetic/heygen-errors";

// Resilient HeyGen selectors.
//
// Spec D: prefer getByRole / getByLabel / getByPlaceholder and stable
// attributes over brittle getByText("Use email")-style marketing strings.
//
// Each "selector" here is a FUNCTION returning a Locator, often combining
// several strategies via Playwright's `.or()` so that a single renamed label or
// reordered panel does not break the whole flow. When none match, the helpers
// throw a classified HeygenError("selector_failure" | "ui_changed") rather than
// a bare timeout, so the pool can make the right (no-penalty) decision.
//
// The LOGIN selectors live here too but are used ONLY by the headed connect
// script (scripts/heygen-connect.ts) — never by the headless worker. The worker
// path only needs authed-state detection + the generation controls.

// ---------------------------------------------------------------------------
// Authenticated-state detection (worker hot path)
// ---------------------------------------------------------------------------

// A logged-in workspace shows the left-nav (Home / Avatar / Brand / Apps /
// Projects) and a "Create New" action. We match the concrete nav items first
// (most reliable on the real dashboard), then fall back to nav landmarks /
// stable hrefs. Any one matching => authed.
export function authedMarker(page: Page): Locator {
  return page
    .getByRole("link", { name: /^(home|avatar|brand|apps|projects)$/i })
    .or(page.getByRole("button", { name: /create new/i }))
    .or(page.getByRole("navigation"))
    .or(page.locator('a[href*="/home"], a[href*="/avatar"], a[href*="/projects"], a[href*="/brand"]'))
    .or(page.locator('[data-testid*="sidebar"], [data-testid*="workspace"], nav'));
}

// A sign-in affordance visible => the session is NOT authenticated. Matched by
// role+accessible-name (case-insensitive) so "Log in" / "Sign in" both work,
// plus a redirect to an auth URL.
export function signInMarker(page: Page): Locator {
  return page
    .getByRole("button", { name: /log ?in|sign ?in/i })
    .or(page.getByRole("link", { name: /log ?in|sign ?in/i }));
}

// ---------------------------------------------------------------------------
// Generation controls (worker hot path)
//
// Verified against the real /avatar "Quick create" UI (2026-06-18):
//   - Left nav "Avatar" -> /avatar, "Quick create" is the default view.
//   - A tab pair toggles "Script to video" | "Photo to video".
//   - "Photo to video" shows a Script textarea (placeholder "Type or paste your
//     script here...") on the left and a photo upload/preview pane on the right.
//   - The render kickoff is an ICON-ONLY circular up-arrow button (no text)
//     bottom-right — so the generate selector must NOT rely on button text.
// ---------------------------------------------------------------------------

// Reaching the avatar workspace is done by URL navigation (page.goto /avatar) in
// attemptOnAccount; this locator is the in-page fallback (left-nav "Avatar").
export function createAvatarEntry(page: Page): Locator {
  return page
    .getByRole("link", { name: /^avatar$/i })
    .or(page.getByRole("link", { name: /avatar|create|quick create/i }))
    .or(page.locator('a[href*="/avatar"]'));
}

// The "Photo to video" mode tab — must be selected so the photo-upload pane
// (vs. "Script to video") is the active one.
export function photoToVideoTab(page: Page): Locator {
  return page
    .getByRole("tab", { name: /photo to video/i })
    .or(page.getByRole("button", { name: /photo to video/i }))
    .or(page.getByText(/photo to video/i));
}

// The hidden <input type=file>. HeyGen creates it ON DEMAND (inside an upload
// modal), so it is usually absent until the upload control is clicked — callers
// must trigger uploadTrigger() / use the filechooser event rather than assume
// this exists. accept="image/*" narrows it when several inputs are mounted.
export function photoUpload(page: Page): Locator {
  return page.locator('input[type="file"][accept*="image"], input[type="file"]');
}

// The control that opens the photo upload. On the current /avatar "Photo to
// video" UI this is a DIV with role="button", text "Upload", and an
// svg use[href="#to-top"] icon (NOT a <button>) — so matching must not assume
// the button tag. We also accept the "Upload photo or drag and drop here"
// dropzone, and the legacy icon-button variants, for resilience across builds.
export function uploadTrigger(page: Page): Locator {
  return page
    .getByRole("button", { name: /^upload$|upload|add (photo|image)|choose|browse/i })
    .or(page.getByText(/upload photo or drag and drop/i))
    .or(page.locator('[role="button"]:has(svg use[href="#to-top"])'))
    .or(page.locator(':is(button,[role="button"]):has(svg use[href="#to-top"])'))
    .or(page.locator(':is(button,[role="button"]):has(svg use[href="#add-image"])'))
    .or(page.locator(':is(button,[role="button"]):has(svg use[href="#upload"])'));
}

// The "remove selected photo" X button overlaid on the photo preview
// (svg use href="#close" on a small absolute top-right button).
export function removePhoto(page: Page): Locator {
  return page.locator('button.tw-absolute:has(svg use[href="#close"]), button:has(svg use[href="#close"])');
}

// A photo is currently selected in the pane (so we don't need to upload, or we
// should remove it first to swap in our own).
export function selectedPhoto(page: Page): Locator {
  return page.locator('img[alt="Selected photo"], img[src^="blob:"]');
}

// The script box — placeholder "Type or paste your script here...".
export function scriptField(page: Page): Locator {
  return page
    .getByPlaceholder(/type or paste your script|script here/i)
    .or(page.getByRole("textbox", { name: /script/i }))
    .or(page.getByPlaceholder(/script|type|paste/i))
    .or(page.locator("textarea"));
}

// The voice picker in the bottom toolbar (the "Japan - Voice 2"-style pill).
// It's a button carrying an #audio icon, opening a voice modal. We match the
// audio-icon button, then any toolbar button whose text looks like a voice
// selection ("... Voice ...").
export function voicePickerButton(page: Page): Locator {
  return page
    .locator('button:has(svg use[href="#audio"])')
    .or(page.getByRole("button", { name: /voice/i }));
}

// The search box inside HeyGen's voice modal.
export function voiceSearchInput(page: Page): Locator {
  return page
    .getByRole("dialog")
    .getByPlaceholder(/search/i)
    .or(page.getByPlaceholder(/search( a)? voice|search/i))
    .or(page.locator('[role="dialog"] input[type="text"], [role="dialog"] input[type="search"]'));
}

// A voice option/card matching the configured name, inside the voice modal.
export function voiceOption(page: Page, name: string): Locator {
  const dlg = page.getByRole("dialog");
  const rx = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return dlg
    .getByRole("button", { name: rx })
    .or(dlg.getByText(rx))
    .or(page.getByRole("option", { name: rx }));
}

// A selectable voice ROW in the modal's "My voices" list. Verified 2026-06-19:
// each row has a ▶ play button (svg use[href="#play-s"] / "#play"), the voice
// name + meta ("Japan - Voice 2 / ElevenLabs, Multilingual, Male"), and a "..."
// menu. Clicking the row (NOT the play button) selects it, which ENABLES the
// "Select voice" confirm button. We target rows that contain a play control so
// we don't match the header tiles ("Clone your voice" etc.). Caller picks
// .first() — any voice works (HeyGen audio is discarded at render).
export function voiceRows(page: Page): Locator {
  const dlg = page.getByRole("dialog");
  return dlg
    .locator('[role="option"]')
    .or(dlg.locator(':is(li,[role="row"],div):has(svg use[href="#play-s"])'))
    .or(dlg.locator(':is(li,[role="row"],div):has(svg use[href="#play"])'));
}

// The "Please select a voice" validation toast HeyGen flashes when Generate is
// clicked before the voice has committed into form state (a RACE — the toolbar
// pill shows a voice, but the controlled state lagged). Detecting it lets the
// caller re-commit the voice and retry rather than abandoning the render.
export function voiceRequiredToast(page: Page): Locator {
  return page.getByText(/please select (a |the )?voice/i);
}

// "Use"/"Select"/"Confirm" button in the voice modal (commit the chosen voice).
// The current UI's button reads "Select voice" and is DISABLED until a row is
// clicked — so callers must select a row first, then wait for this to enable.
export function voiceConfirm(page: Page): Locator {
  return page
    .getByRole("dialog")
    .getByRole("button", { name: /select voice|^use$|^select$|confirm|apply|done/i });
}

export function voiceConfirmEnabled(page: Page): Locator {
  return page
    .getByRole("dialog")
    .getByRole("button", { name: /select voice|^use$|^select$|confirm|apply|done/i, disabled: false });
}

// The render kickoff. Verified in the real DOM: a button with aria-label
// "Generate" (icon-only, no text). CRITICAL: HeyGen DISABLES this button until
// it considers the composer complete (photo + script present) — the disabled
// state carries `disabled` / tw-*-disabled classes. We must only click it once
// ENABLED, else the click no-ops and the flow proceeds to a doomed Projects
// poll. generateButtonEnabled() narrows to the clickable instance.
export function generateButton(page: Page): Locator {
  // The real accessible name is "Generate for 1 credit" (the cost is appended),
  // so anchor on a LEADING /generate/ rather than an exact /^generate$/ match.
  return page
    .getByRole("button", { name: /^generate\b/i })
    .or(page.getByRole("button", { name: /generate|submit|send|create video|render/i }))
    .or(page.locator('button[type="submit"]'));
}

// The Generate button restricted to its ENABLED state. It's the bright blue
// circular ↑ submit button in the bottom-right of the composer (aria-label
// "Generate", primary brand color when enabled). Playwright's disabled:false
// excludes [disabled]/aria-disabled. We add a brand-colored enabled-button
// fallback in case the accessible name differs across HeyGen builds.
export function generateButtonEnabled(page: Page): Locator {
  // Name is "Generate for 1 credit" — anchor on leading /generate/, NOT exact.
  // The button is a plain pill (prism:tw-rounded-[100px]), NOT brand-colored, so
  // the old .tw-bg-brand fallback never matched it. We instead fall back to an
  // enabled button whose ACCESSIBLE NAME contains "generate" (the credit suffix
  // varies: "for 1 credit", "for N credits", or none on paid plans).
  return page
    .getByRole("button", { name: /^generate\b/i, disabled: false })
    .or(page.getByRole("button", { name: /generate|create video|render/i, disabled: false }))
    .or(page.locator('button:not([disabled]):not(.tw-cursor-not-allowed)', { hasText: /generate/i }));
}

export function renderDoneMarker(page: Page): Locator {
  return page
    .getByRole("button", { name: /download/i })
    .or(page.getByRole("link", { name: /download/i }))
    .or(page.locator("video[src], a[download]"));
}

export function downloadControl(page: Page): Locator {
  return page
    .getByRole("button", { name: /download/i })
    .or(page.getByRole("link", { name: /download/i }))
    .or(page.locator("a[download]"));
}

// ---------------------------------------------------------------------------
// Projects page (async result retrieval)
//
// HeyGen renders asynchronously: clicking Generate sends the avatar to the
// /projects grid where it appears as a card ("Avatar IV Video" + thumbnail +
// relative time + a duration badge). "Newest" sort is the default, so the most
// recent render is the FIRST card. A card mid-render shows a spinner/"Processing"
// instead of a duration badge; once done it shows the duration ("9s") and a
// playable thumbnail.
// ---------------------------------------------------------------------------

// All project video cards, newest first (matches the default sort).
export function projectVideoCards(page: Page): Locator {
  return page
    .getByRole("link", { name: /avatar.*video|video/i })
    .or(page.locator('a[href*="/video/"], a[href*="/projects/"]'))
    .or(page.locator('[data-pacific-component*="Card"], [class*="video-card"], [data-testid*="video"]'));
}

// A card that is still rendering (spinner / "Processing" / "Generating" text).
export function cardStillRendering(card: Locator): Locator {
  return card
    .getByText(/processing|generating|rendering|in progress/i)
    .or(card.locator('[class*="spinner"], [class*="loading"], svg[class*="spin"]'));
}

// The <video> element on an opened video page, and the download control there.
export function projectVideoElement(page: Page): Locator {
  return page.locator("video[src], video source[src]");
}

export function projectDownloadButton(page: Page): Locator {
  return page
    .getByRole("button", { name: /download/i })
    .or(page.getByRole("menuitem", { name: /download/i }))
    .or(page.getByRole("link", { name: /download/i }))
    .or(page.locator('a[download]'));
}

// The "..." / more-actions button on a card or video page that reveals Download.
export function moreActionsButton(page: Page): Locator {
  return page
    .getByRole("button", { name: /more|options|actions/i })
    .or(page.locator('button:has(svg use[href="#more"])'));
}

// ---------------------------------------------------------------------------
// LOGIN selectors — connect script ONLY (headed, human-driven)
// ---------------------------------------------------------------------------

export const login = {
  useEmail: (page: Page): Locator =>
    page.getByRole("button", { name: /use email|continue with email|email/i }),
  usePassword: (page: Page): Locator =>
    page.getByRole("button", { name: /use password|password|sign in with password/i }),
  email: (page: Page): Locator =>
    page
      .getByRole("textbox", { name: /email/i })
      .or(page.getByLabel(/email/i))
      .or(page.getByPlaceholder(/email/i))
      .or(page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]')),
  password: (page: Page): Locator =>
    page
      .getByLabel(/password/i)
      .or(page.getByPlaceholder(/password/i))
      .or(page.locator('input[type="password"], input[autocomplete="current-password"]')),
  submit: (page: Page): Locator =>
    page
      .getByRole("button", { name: /log ?in|sign ?in|continue|submit/i })
      .or(page.locator('button[type="submit"]')),
};

// ---------------------------------------------------------------------------
// Resilient interaction helpers
// ---------------------------------------------------------------------------

/**
 * Click the first VISIBLE match of a locator, picking the on-screen element
 * when HeyGen mounts several stacked duplicates (its auth widget does). Throws
 * a classified HeygenError on timeout so the caller never sees a bare Playwright
 * timeout it has to re-parse.
 */
export async function clickFirstVisible(
  loc: Locator,
  timeoutMs: number,
  label: string,
): Promise<void> {
  try {
    const target = loc.locator("visible=true").first();
    await target.click({ timeout: timeoutMs });
  } catch (err) {
    throw new HeygenError("selector_failure", `heygen: could not click ${label}`, err);
  }
}

export async function fillFirstVisible(
  loc: Locator,
  value: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  try {
    const target = loc.locator("visible=true").first();
    await target.fill(value, { timeout: timeoutMs });
  } catch (err) {
    throw new HeygenError("selector_failure", `heygen: could not fill ${label}`, err);
  }
}

/** Wait for the first visible match; classified error on timeout. */
export async function waitFirstVisible(
  loc: Locator,
  timeoutMs: number,
  label: string,
): Promise<void> {
  try {
    await loc.locator("visible=true").first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (err) {
    throw new HeygenError("ui_changed", `heygen: ${label} never appeared`, err);
  }
}

/** Is at least one match visible within the (short) timeout? Never throws. */
export async function isVisible(loc: Locator, timeoutMs: number): Promise<boolean> {
  return loc
    .locator("visible=true")
    .first()
    .isVisible({ timeout: timeoutMs })
    .catch(() => false);
}

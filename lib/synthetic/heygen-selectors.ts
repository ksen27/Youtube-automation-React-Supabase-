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

// Aspect-ratio / orientation toggle in the composer's bottom toolbar. These are
// ICON-ONLY buttons (no text, no aria-label — confirmed against the live UI on
// 2026-06-22), so a name-based locator alone misses them. The CONFIRMED markup is:
//   <button class="… tw-bg-fill-general tw-text-brand tw-shadow-md …">  ← when SELECTED
//     <div data-state="closed">
//       <svg><use href="#landscape-phone"></use></svg>   (portrait => #portrait-phone)
//     </div>
//   </button>
// So the PRIMARY, exact locator is the svg sprite id. We keep broader fallbacks
// (token-in-any-attr, then positional ratioButtonsFallback) only as a safety net
// against future renames. The selected STATE is read separately by activeRatio()
// via the tw-bg-fill-general/tw-text-brand/tw-shadow-md active classes.
const LANDSCAPE_SPRITE = '#landscape-phone';
const PORTRAIT_SPRITE = '#portrait-phone';

export function landscapeRatioButton(page: Page): Locator {
  return page
    .locator(`:is(button,[role="button"]):has(svg use[href="${LANDSCAPE_SPRITE}"])`)
    .or(page.getByRole("button", { name: /landscape|16\s*:\s*9|horizontal|widescreen/i }))
    .or(page.locator('button[title*="16:9" i], button[title*="landscape" i], [role="button"][aria-label*="landscape" i]'))
    .or(
      page.locator(
        ':is(button,[role="button"]):has(svg use[href*="landscape" i], svg use[href*="horizontal" i], svg use[href*="16-9"], svg use[href*="16_9"])',
      ),
    )
    .or(page.locator(':is(button,[role="button"])[class*="landscape" i], :is(button,[role="button"])[data-ratio*="16" i]'));
}

export function portraitRatioButton(page: Page): Locator {
  return page
    .locator(`:is(button,[role="button"]):has(svg use[href="${PORTRAIT_SPRITE}"])`)
    .or(page.getByRole("button", { name: /portrait|9\s*:\s*16|vertical/i }))
    .or(page.locator('button[title*="9:16" i], button[title*="portrait" i], [role="button"][aria-label*="portrait" i]'))
    .or(
      page.locator(
        ':is(button,[role="button"]):has(svg use[href*="portrait" i], svg use[href*="vertical" i], svg use[href*="9-16"], svg use[href*="9_16"])',
      ),
    )
    .or(page.locator(':is(button,[role="button"])[class*="portrait" i], :is(button,[role="button"])[data-ratio*="9" i]'));
}

// Positional last-resort: the two orientation toggles sit ADJACENT in the
// preview pane's bottom toolbar, landscape (wide rectangle) on the LEFT, portrait
// (tall phone) on the RIGHT. When the attribute-based locators above all miss on
// a new build, we find the small icon-only buttons inside the composer preview
// and pick by horizontal position. `which` selects landscape (leftmost of the
// pair) or portrait (rightmost). Returns null if we can't identify a clean pair.
export async function ratioButtonsFallback(
  page: Page,
  which: "landscape" | "portrait",
): Promise<Locator | null> {
  // Icon-only buttons: a button with an svg child and (almost) no text. Scope to
  // the preview pane so we don't grab unrelated toolbar icons.
  const candidates = composerPreview(page)
    .locator("xpath=ancestor-or-self::*[1]")
    .locator(':is(button,[role="button"]):has(svg)');
  // Fall back to a page-wide search if the scoped one finds nothing.
  const scope = (await candidates.count().catch(() => 0)) > 0 ? candidates : page.locator(':is(button,[role="button"]):has(svg)');

  const boxes = await scope
    .locator("visible=true")
    .evaluateAll((els) =>
      els
        .map((el, i) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const text = (el.textContent ?? "").trim();
          return { i, x: r.x, y: r.y, w: r.width, h: r.height, hasText: text.length > 2 };
        })
        // Small, square-ish, text-free icon buttons (the orientation toggles).
        .filter((b) => !b.hasText && b.w > 12 && b.w < 64 && b.h > 12 && b.h < 64),
    )
    .catch(() => [] as Array<{ i: number; x: number; y: number; w: number; h: number; hasText: boolean }>);
  if (boxes.length < 2) return null;

  // The orientation pair is two such icons on (roughly) the same row, adjacent in
  // x. Find the closest horizontal pair on a shared baseline.
  boxes.sort((a, b) => a.x - b.x);
  let best: { left: number; right: number } | null = null;
  let bestGap = Infinity;
  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i];
    const b = boxes[i + 1];
    if (Math.abs(a.y - b.y) > 12) continue; // not on the same row
    const gap = b.x - (a.x + a.w);
    if (gap >= 0 && gap < bestGap) {
      bestGap = gap;
      best = { left: a.i, right: b.i };
    }
  }
  if (!best) return null;
  const idx = which === "landscape" ? best.left : best.right;
  return scope.locator("visible=true").nth(idx);
}

// One-time diagnostic: dump the composer preview toolbar's outerHTML so we can
// read the REAL attributes of the orientation toggles on the live build and pin
// an exact selector. Logged (truncated) — never throws.
export async function dumpRatioToolbar(page: Page): Promise<string> {
  return composerPreview(page)
    .locator("xpath=ancestor-or-self::*[2]")
    .first()
    .evaluate((el) => (el as HTMLElement).outerHTML)
    .catch(() => "")
    .then((h) => (h || "").slice(0, 4000));
}

// Read which orientation the composer is ACTUALLY in, rather than trusting that
// a click landed. Returns "landscape" | "portrait" | null (unknown). We can't
// rely on a single signal because HeyGen marks the active toggle differently
// across builds, so we try, in order:
//   1) the toggle's pressed/selected state (aria-pressed / data-state /
//      aria-checked / a *selected*/*active* class) — the most direct signal;
//   2) the composer preview canvas geometry (wider-than-tall => landscape).
// Best-effort: never throws. A null result means "couldn't confirm" and the
// caller decides whether that's acceptable.
export async function activeRatio(page: Page): Promise<"landscape" | "portrait" | null> {
  // CONFIRMED 2026-06-22: the SELECTED orientation toggle carries HeyGen's active
  // styling — tw-bg-fill-general + tw-text-brand + tw-shadow-md — while the
  // unselected one does not. There is NO aria-pressed/data-state="active" signal
  // (the button's data-state="closed" is an unrelated Radix tooltip state), which
  // is why the old generic check returned null. We read the real active classes
  // first, then the generic aria/state signals as a forward-compat fallback.
  const pressed = async (loc: Locator): Promise<boolean> => {
    const el = loc.locator("visible=true").first();
    if (!(await el.count().catch(() => 0))) return false;
    const pressedAttr = await el.getAttribute("aria-pressed").catch(() => null);
    const checkedAttr = await el.getAttribute("aria-checked").catch(() => null);
    const stateAttr = await el.getAttribute("data-state").catch(() => null);
    const cls = (await el.getAttribute("class").catch(() => "")) ?? "";
    // HeyGen's confirmed active styling. tw-text-brand (brand-color icon) +
    // tw-bg-fill-general (filled background) are the strongest tells; require the
    // brand text color AND either the fill or shadow to avoid a false positive
    // from a shared utility class.
    const heygenActive =
      /\btw-text-brand\b/.test(cls) && /\b(tw-bg-fill-general|tw-shadow-md)\b/.test(cls);
    return (
      heygenActive ||
      pressedAttr === "true" ||
      checkedAttr === "true" ||
      stateAttr === "on" ||
      stateAttr === "active" ||
      stateAttr === "selected" ||
      /\b(selected|active|is-active|is-selected)\b/.test(cls)
    );
  };

  // Read BOTH toggles' selected state. The svg-sprite locators are exact, so this
  // is deterministic. If exactly one is active, that's the answer.
  const landscapeActive = await pressed(landscapeRatioButton(page));
  const portraitActive = await pressed(portraitRatioButton(page));
  if (landscapeActive && !portraitActive) return "landscape";
  if (portraitActive && !landscapeActive) return "portrait";

  // Fallback: measure the LARGEST visible preview box. The broad composerPreview
  // selector can match several nodes (stray canvases, tiny thumbnails), and the
  // FIRST one is often not the main frame — so we scan the visible matches and
  // take the biggest by area, which is the composer's preview. We also require a
  // clear non-square aspect (>10% off square) before deciding; a near-square box
  // is ambiguous and returns null (unknown) so the caller doesn't act on noise.
  const boxes = await composerPreview(page)
    .locator("visible=true")
    .evaluateAll((els) =>
      els
        .map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return { w: r.width, h: r.height };
        })
        .filter((b) => b.w > 40 && b.h > 40),
    )
    .catch(() => [] as Array<{ w: number; h: number }>);
  if (boxes.length > 0) {
    const biggest = boxes.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
    const ratio = biggest.w / biggest.h;
    if (ratio >= 1.1) return "landscape";
    if (ratio <= 0.9) return "portrait";
    // Near-square: ambiguous — don't guess.
  }
  return null;
}

// The composer preview pane (the framed area showing the uploaded photo / avatar
// before Generate). Used to measure the active aspect ratio as a fallback.
export function composerPreview(page: Page): Locator {
  return page
    .locator('[data-testid*="preview"], [data-testid*="canvas"], [class*="preview" i], [class*="canvas" i]')
    .or(page.locator("video, canvas"));
}

// ---------------------------------------------------------------------------
// Audio-driven avatar (worker hot path) — drive the avatar with an UPLOADED
// audio file instead of typed script, so HeyGen lip-syncs to the exact 69labs
// voiceover and the rendered length matches the audio.
//
// Verified against the live /avatar "Photo to video" composer (2026-06-20, via
// a headed debug run + the captured error screenshot/HTML):
//   - The Script panel header has a mic icon and an up-arrow "↑ Upload" button
//     (shows the label "Upload" on hover). Clicking it opens an "Upload Audio"
//     modal.
//   - The modal is NOT an ARIA dialog (role="dialog" count = 0 in the captured
//     DOM) — it's a plain portal-rendered div titled "Upload Audio" with a
//     "Record Audio" / "Upload Audio" tab pair and a dashed dropzone "Upload a
//     file or drag and drop here — Audio: MP3, WAV up to 100MB". So EVERY
//     selector here matches by VISIBLE TEXT scoped to the page, never by
//     getByRole("dialog") (which silently matched nothing and made the
//     modal-open check fail even though the modal was on screen).
// ---------------------------------------------------------------------------

// The "↑ Upload" audio button in the Script panel header. Verified 2026-06-20
// against the live DOM: it is a button with visible text "Upload" carrying
// svg use[href="#to-top"], in the script toolbar next to the mic. Clicking it
// opens the "Upload Audio" modal. There is a SECOND #to-top button (the photo
// dropzone's) but it is only present/visible when no photo is uploaded — by the
// time we reach this step a photo IS uploaded, so that one is detached/invisible
// and clickFirstVisible reliably lands on the script-header "Upload" button.
// (#arrow-up is the Generate button — never match it here; and we don't match a
// bare "Upload" accessible name alone since the photo control can also read it.)
export function audioUploadTrigger(page: Page): Locator {
  return page.locator(':is(button,[role="button"]):has(svg use[href="#to-top"])');
}

// The OPEN audio modal, detected by its visible "Upload Audio" heading. The
// modal renders in a React portal and is NOT role="dialog", so we anchor on the
// heading text and walk up to a container that also holds the dropzone. The
// presence of this locator IS the "modal is open" signal.
export function audioModalHeading(page: Page): Locator {
  return page.getByText(/^upload audio$/i);
}

// The "Upload Audio" tab inside the modal (vs. "Record Audio"). Both tabs are
// plain text nodes; clicking this guarantees the file-dropzone tab is active.
// (The modal usually opens already on Upload Audio, per the screenshot.)
export function uploadAudioTab(page: Page): Locator {
  return page
    .getByRole("tab", { name: /upload audio/i })
    .or(page.getByText(/^upload audio$/i));
}

// The dashed dropzone inside the modal. The visible affordance is the blue
// "Upload a file" link within "Upload a file or drag and drop here"; clicking it
// opens the native file chooser. We match that text, plus the dropzone wrapper
// and any audio <input type=file>, page-scoped (no dialog role).
export function audioDropzone(page: Page): Locator {
  return page
    .getByText(/upload a file/i)
    .or(page.getByText(/drag and drop here/i))
    .or(page.locator('input[type="file"][accept*="audio"], input[type="file"][accept*="mp3"], input[type="file"][accept*="wav"]'));
}

// The hidden <input type=file> for audio (accept includes audio/mp3/wav). Used
// as the setInputFiles fallback when the filechooser event doesn't fire. Falls
// back to any file input on the page if the accept attr isn't audio-specific.
export function audioFileInput(page: Page): Locator {
  return page.locator(
    'input[type="file"][accept*="audio"], input[type="file"][accept*="mp3"], ' +
      'input[type="file"][accept*="wav"], input[type="file"][accept*=".mp3"], ' +
      'input[type="file"][accept*=".wav"]',
  );
}

// After picking a file the flow advances to a SECOND modal "Confirm Audio" (it
// shows the uploaded track + its duration, with "Back" and "Add audio" actions).
// Verified 2026-06-20: the commit button reads "Add audio" — so we match that
// explicitly (a bare /^add$/ missed it and left the modal open, blocking the
// composer so Generate never enabled).
//
// SCOPED TO THE DIALOG (2026-06-29): previously this was page-scoped with a broad
// /add audio|^add$|^save$|.../ regex. That intermittently matched the WRONG button
// — a stale modal/button elsewhere in the DOM, picked by .first() in DOM order —
// so the click "succeeded" without committing the audio. The run then degraded to
// the HeyGen-TTS script path, producing a clip with the WRONG (non-69labs) audio.
// Scoping to the role=dialog Confirm-Audio modal AND leading the regex with the
// exact "Add audio" label removes that ambiguity: only the real commit button in
// the open modal can match. The broad fallbacks are kept but ONLY inside the
// dialog, so they can no longer match a button on the composer behind the modal.
//
// NOTE: deliberately does NOT match "Upload" — that's the trigger button still on
// the composer; clicking it would re-open the modal instead of committing.
export function audioConfirmButton(page: Page): Locator {
  // Scope to the Confirm-Audio dialog when one is present (the normal flow); fall
  // back to page scope only if HeyGen renders the confirm step without a dialog
  // role, so older/edge builds still work.
  const dialog = page.getByRole("dialog").filter({ has: page.getByText(/^confirm audio$/i) });
  const name = /^add audio$|^use$|^add$|^confirm$|^done$|^select$|^apply$|^save$/i;
  const inDialog = dialog.getByRole("button", { name });
  // .or() yields a locator that resolves to the dialog-scoped button when the
  // dialog exists, else the page-scoped one. The caller still filters to visible
  // + enabled before clicking.
  return inDialog.or(page.getByRole("button", { name }));
}

// The "Confirm Audio" review modal heading (the 2nd step, after file pick). Used
// to detect that we've advanced to the confirm step and, after committing, that
// it has closed.
export function audioConfirmHeading(page: Page): Locator {
  return page.getByText(/^confirm audio$/i);
}

// A "first audio" empty-state hint in the modal ("Please upload your first
// audio"). Seen when the account has no prior uploads — informational; confirms
// we're on the Upload Audio tab.
export function audioEmptyStateHint(page: Page): Locator {
  return page.getByText(/please upload your first audio/i);
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
// Avatar III (orange marks) — "Create new shots" / Avatar-Shots flow
//
// Red doc-highlights render with Avatar IV via the /avatar Photo-to-video
// composer above. Orange highlights render with the cheaper Avatar III model,
// which HeyGen only exposes through a DIFFERENT flow (verified against the live
// UI 2026-07 via the user's captured screenshots):
//
//   1) Open the Avatars page (left-nav "Avatars", /avatar/avatars). It lists the
//      account's SAVED avatars as named tiles (e.g. "Japan", "Earl"). The user
//      creates this avatar MANUALLY in HeyGen at project setup and enters its
//      exact name in the app (projects.heygen_avatar_name); we search for it.
//   2) Search the grid by that name, hover the tile, click its "Create video with
//      this avatar" (▷) icon, then "Create new shots" in the dropdown.
//   3) That lands on the Avatar-Shots "Presenter" page (/avatar/avatar-shots).
//      There a model pill (defaulting to "Avatar IV") opens a dropdown with
//      Avatar V / IV / III — pick "Avatar III". An orientation pill toggles
//      Portrait/Landscape. The "upload/record" link attaches the audio, and
//      "Generate for 1 credit" kicks off the render.
//
// Retrieval (Projects list poll + download) is SHARED with the Avatar IV path;
// only the composer differs.
// ---------------------------------------------------------------------------

// Left-nav "Avatars" entry (MANAGE section). Distinct from the top-level
// "Avatar" nav (which opens Quick create). We match the exact "Avatars" label
// and the stable my-avatars href.
export function avatarsNavEntry(page: Page): Locator {
  return page
    .getByRole("link", { name: /^avatars$/i })
    .or(page.locator('a[href*="/avatar/avatars"], a[href*="/my-avatars"]'));
}

// The search box on the Avatars page ("Search"). Used to filter the grid to the
// project's saved avatar by name.
export function avatarsSearchBox(page: Page): Locator {
  return page
    .getByRole("searchbox")
    .or(page.getByPlaceholder(/search/i))
    .or(page.getByRole("textbox", { name: /search/i }));
}

// A saved-avatar tile on the Avatars page, located by its visible NAME. HeyGen
// renders each tile as a card whose label is the avatar name; we match the card
// container that holds that text. Exact (case-insensitive) match on the name so
// "Japan" doesn't also match "Japan 2".
export function avatarTileByName(page: Page, name: string): Locator {
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  return page
    .getByRole("link", { name: exact })
    .or(page.getByRole("button", { name: exact }))
    // Fallback: a card element that CONTAINS the exact name text node.
    .or(
      page
        .locator('[class*="card" i], [data-testid*="avatar" i], a, [role="button"]')
        .filter({ has: page.getByText(exact) }),
    );
}

// HeyGen's transient "Couldn't load your avatars. Please refresh and try again."
// error state on the Avatars page (observed 2026-07): the grid API failed, so NO
// tiles render even though the account HAS avatars. Detecting this lets us reload
// + retry instead of falsely concluding "no seed avatar".
export function avatarsLoadError(page: Page): Locator {
  return page.getByText(/couldn't load your avatars|couldn.t load your avatars|failed to load|please refresh and try again/i);
}

// The FIRST avatar tile on the Avatars grid, used name-INDEPENDENTLY: Avatar III
// no longer needs a user-supplied avatar name because it enters the composer from
// whatever avatar exists, then OVERRIDES the look with the project's own photo via
// Switch-look. So the starting tile's identity is irrelevant — we just need any
// tile to open the "Create new shots" composer. Matches the same card shapes as
// avatarTileByName but with no name filter. Requires the account to hold at least
// one saved avatar (a seed avatar is kept in every account for exactly this).
export function firstAvatarTile(page: Page): Locator {
  return page
    .locator('[class*="card" i], [data-testid*="avatar" i], [role="button"]')
    .filter({ has: page.locator('img, video') })
    .first();
}

// The "Create video with this avatar" (▷ play) icon revealed on tile hover.
// Scoped to a given tile locator.
//
// CRITICAL (2026-07): the tile has THREE hover icons in DOM order — "..." (more:
// Edit/Share/Delete/Copy Identity), then ▷ (create video), then ♡ (favorite).
// The old blind `:has(svg)` fallback matched the FIRST icon button, i.e. the
// "..." menu — which opens Edit/Share/Delete and has NO "Create new shots",
// stranding the flow. So we target the ▷ PRECISELY and never fall back to a bare
// icon button. Order of preference:
//   1) tooltip / accessible name "Create video with this avatar" (most stable);
//   2) a play/arrow sprite id;
//   3) any icon button EXCLUDING the "..." (more/options) and ♡ (favorite/like)
//      ones — identified by their own names/sprites — so a nameless ▷ still wins
//      without ever re-matching the "..." menu.
export function createVideoWithAvatarButton(tile: Locator): Locator {
  return tile
    .getByRole("button", { name: /create video with this avatar/i })
    .or(tile.getByRole("button", { name: /create video|make video/i }))
    .or(tile.locator('button[aria-label*="create video" i], [role="button"][aria-label*="create video" i]'))
    .or(tile.locator(':is(button,[role="button"]):has(svg use[href*="play" i], svg use[href*="triangle" i])'))
    // Nameless-icon fallback: any icon button that is NOT the "..." more-menu and
    // NOT the heart/favorite. The CSS :not(:has(...)) is evaluated PER candidate
    // (relative to each button), so it excludes those two siblings by their sprite
    // ids and leaves only the ▷ — never re-selecting the "..." menu.
    .or(
      tile.locator(
        ':is(button,[role="button"]):has(svg)' +
          ':not(:has(svg use[href*="more" i]))' +
          ':not(:has(svg use[href*="ellipsis" i]))' +
          ':not(:has(svg use[href*="dots" i]))' +
          ':not(:has(svg use[href*="heart" i]))' +
          ':not(:has(svg use[href*="like" i]))' +
          ':not(:has(svg use[href*="favorite" i]))' +
          ':not([aria-label*="more" i]):not([aria-label*="option" i]):not([aria-label*="favorite" i]):not([aria-label*="like" i])',
      ),
    );
}

// The "Create new shots" item in the dropdown opened by the ▷ icon. Sits next to
// "Build scene-by-scene" / "Add a script" / "Use with prompt".
export function createNewShotsMenuItem(page: Page): Locator {
  return page
    .getByRole("menuitem", { name: /create new shots/i })
    .or(page.getByRole("button", { name: /create new shots/i }))
    .or(page.getByText(/^create new shots$/i));
}

// The WRONG "..." (more-options) menu, detected by its distinctive items
// (Edit / Delete / Copy Avatar Identity ID). If this is open, we clicked the
// three-dots button instead of the ▷ — close it and retry the ▷. "Copy Avatar
// Identity ID" is unique to this menu, so it's the cleanest tell.
export function avatarMoreMenuOpen(page: Page): Locator {
  return page
    .getByRole("menuitem", { name: /copy avatar identity id|^delete$/i })
    .or(page.getByText(/copy avatar identity id/i));
}

// The model-selector pill on the Avatar-Shots (and Quick-create) toolbar. Its
// visible label is the CURRENT model — "Avatar IV" by default, "Avatar III" once
// selected, etc. Clicking it opens the model dropdown. We match a button whose
// text is an "Avatar <roman>" label.
export function avatarModelDropdownTrigger(page: Page): Locator {
  return page
    .getByRole("button", { name: /avatar\s+(v|iv|iii|ii|i)\b/i })
    .or(page.locator(':is(button,[role="button"])', { hasText: /avatar\s+(v|iv|iii|ii|i)\b/i }));
}

// The "Avatar III" option inside the model dropdown ("Avatar III — Applies lip
// sync."). Anchor on the exact "Avatar III" label so it never matches "Avatar
// IV". A menuitem/option first, then any clickable row containing the text.
export function avatarIIIOption(page: Page): Locator {
  const name = /avatar\s+iii\b/i;
  return page
    .getByRole("menuitem", { name })
    .or(page.getByRole("option", { name }))
    .or(page.getByRole("button", { name }))
    .or(page.getByText(/^avatar\s+iii\b/i));
}

// Confirmation that the model pill now reads "Avatar III" (i.e. the selection
// took). Used to verify the dropdown click landed before generating.
export function avatarModelIsIII(page: Page): Locator {
  return page.locator(':is(button,[role="button"])', { hasText: /avatar\s+iii\b/i });
}

// --- Avatar-Shots "look" selection ---------------------------------------
//
// The avatar preview shows the currently-selected LOOK. HeyGen defaults it to a
// prior look which may be PORTRAIT (9:16) — rendering that into a 16:9 frame
// center-crops the face (observed 2026-07). So for a full-frame (landscape)
// avatar we ensure the selected look is 16:9: if it isn't, we UPLOAD the project
// photo (which lands as a landscape "Photo Avatar" look) and select it.

// The avatar preview thumbnail on the Avatar-Shots composer (left of the script
// box). We read its box size to tell portrait vs landscape, and hover it to
// reveal the "Switch look" button.
export function avatarShotsLookPreview(page: Page): Locator {
  return page
    .locator('img[alt*="avatar" i], img[class*="avatar" i], [class*="preview" i] img')
    .or(page.locator("video"))
    .first();
}

// The "Switch look" button revealed on hovering the avatar preview.
export function avatarShotsSwitchLookButton(page: Page): Locator {
  return page
    .getByRole("button", { name: /switch look|change look|choose look/i })
    .or(page.getByText(/^switch look$/i));
}

// The open "Switch look" modal (header "My Avatars > <name>"). Presence == open.
export function avatarShotsLookModal(page: Page): Locator {
  return page
    .getByText(/my avatars/i)
    .or(page.getByRole("dialog").filter({ has: page.getByText(/my avatars/i) }));
}

// The "Upload" control INSIDE the Switch-look modal (uploads a new look image).
// Distinct from "Design with AI". Opens the native file chooser.
export function avatarShotsLookUploadButton(page: Page): Locator {
  return page
    .getByRole("button", { name: /^upload$/i })
    .or(page.locator(':is(button,[role="button"])', { hasText: /^upload$/i }))
    .or(page.getByText(/^upload$/i));
}

// The IN-TILE "Validating photo" state. Verified from the live UI (2026-07): after
// the green "Image uploaded successfully" toast, the NEW look tile itself shows
// "Validating photo / This will take a few seconds." over a blurred preview. The
// tile is NOT selectable until this clears. This in-tile text (appearing then
// disappearing) is the authoritative "validation finished" signal — it is NOT a
// toast and NOT the same as the success toast. Match its exact wording.
export function avatarShotsLookValidating(page: Page): Locator {
  return page.getByText(/validating photo|this will take a few seconds|validating/i);
}

// The green success TOAST shown right after the upload is accepted ("Image uploaded
// successfully"). This fires BEFORE validation — it means "upload received", not
// "ready to select". Verified 2026-07.
export function avatarShotsLookUploadSuccess(page: Page): Locator {
  return page.getByText(/image uploaded successfully|uploaded successfully|upload complete/i);
}

// The look tiles in the "Switch look" modal. Verified against the LIVE DOM
// (2026-07): each tile is `<div data-pacific-component="PrivatePhotoAvatarCard">`
// wrapping a `tw-cursor-pointer tw-group` card with the look <img> and a caption.
// The stable `data-pacific-component` anchor is FAR more reliable than the old
// text/class heuristics (which matched giant wrapper DIVs and picked dead space).
// The "Design with AI"/"Upload" action cell is NOT a PrivatePhotoAvatarCard, so it
// is naturally excluded. Tiles are in DOM = visual order; the just-uploaded photo
// is the first PrivatePhotoAvatarCard (HeyGen prepends the fresh upload and even
// auto-selects it — the selected tile carries a brand-colored border).
export function avatarShotsPhotoAvatarTiles(page: Page): Locator {
  return page
    .locator('[data-pacific-component="PrivatePhotoAvatarCard"]')
    // Fallback for a build without the data attr: a captioned image card.
    .or(
      page
        .locator('[class*="card" i]')
        .filter({ has: page.locator('img[alt*="photo avatar" i]') }),
    );
}

// All look-tile thumbnail <img>s in the Switch-look grid, in DOM order. Used to
// identify OUR just-uploaded look by NEW src (snapshot before upload → the one src
// that appears after is ours) — the only reliable identity when the seed avatar
// has many identically-captioned looks and the upload's grid position varies.
export function avatarShotsLookTileImages(page: Page): Locator {
  return page.locator(
    '[data-pacific-component="PrivatePhotoAvatarCard"] img[alt*="photo avatar" i], ' +
      '[data-pacific-component="PrivatePhotoAvatarCard"] img',
  );
}

// The look tile HeyGen has AUTO-SELECTED (verified 2026-07: after upload, the
// fresh photo tile gets a brand-colored border — `tw-border-brand` — while the
// rest stay `tw-border-transparent`). Since HeyGen auto-selects the just-uploaded
// look, targeting the brand-bordered tile is the most reliable way to act on OUR
// upload regardless of its grid position.
export function avatarShotsSelectedLookTile(page: Page): Locator {
  return page.locator(
    '[data-pacific-component="PrivatePhotoAvatarCard"]:has(.tw-border-brand), ' +
      '[data-pacific-component="PrivatePhotoAvatarCard"].tw-border-brand, ' +
      '[data-pacific-component="PrivatePhotoAvatarCard"] .tw-border-brand',
  );
}

// The clickable INNER card of a tile. From the live DOM the `tw-cursor-pointer`
// group div IS the click target (the whole card selects the look); the hover
// "Choose look" button sits in a `pointer-events-none` overlay and can't be
// clicked directly, and there's a transparent `z-[8]` hit-layer over the image.
// We target the cursor-pointer group, falling back to the tile itself.
export function avatarShotsTileClickTarget(tile: Locator): Locator {
  return tile.locator('.tw-cursor-pointer').first().or(tile);
}

// The clickable IMAGE inside a look tile — a secondary click target.
export function avatarShotsPhotoAvatarTileImage(tile: Locator): Locator {
  return tile.locator("img").first();
}

// The "Choose look" button revealed on HOVER over a look tile. NOTE (live DOM
// 2026-07): its container is `tw-pointer-events-none tw-opacity-0` until
// group-hover, so a direct click is unreliable — prefer clicking the tile card
// (avatarShotsTileClickTarget). Kept as a last-resort target.
export function avatarShotsChooseLookButton(scope: Page | Locator): Locator {
  return scope
    .locator('button:has-text("Choose look")')
    .or(scope.getByText(/^choose look$/i));
}

// The orientation pill on the Avatar-Shots toolbar. Verified against the LIVE
// HTML 2026-07: it's a div with aria-haspopup="menu" containing an svg sprite —
// `#portrait-phone` when portrait, `#landscape-phone` when landscape — plus a
// `#down` caret. Clicking it opens a Portrait / Landscape menu. HeyGen DEFAULTS
// to Portrait (9:16), so a full-frame avatar MUST flip to Landscape.
//
// CRITICAL: the OLD selector matched the MODEL pill instead (it also has
// aria-haspopup + an icon), which is why "Landscape" was never in the opened
// menu and the render stayed 9:16. We now anchor STRICTLY on the phone sprites,
// which the model pill (an <img> avatar, no phone sprite) never has.
export function avatarShotsOrientationTrigger(page: Page): Locator {
  return page.locator(
    ':is(button,[role="button"],[aria-haspopup="menu"]):has(svg use[href="#portrait-phone"]), ' +
      ':is(button,[role="button"],[aria-haspopup="menu"]):has(svg use[href="#landscape-phone"]), ' +
      // Forward-compat: any element with the popup role carrying a phone-ish sprite.
      '[aria-haspopup="menu"]:has(svg use[href*="phone" i])',
  );
}

// The "Landscape" / "Portrait" item inside the orientation menu. Radix menuitems
// (role="menuitem") whose visible label is the orientation name.
export function avatarShotsOrientationOption(page: Page, which: "landscape" | "portrait"): Locator {
  const name = which === "landscape" ? /^landscape$/i : /^portrait$/i;
  return page
    .getByRole("menuitem", { name })
    .or(page.getByRole("menuitemradio", { name }))
    .or(page.locator('[role="menuitem"]', { hasText: name }))
    .or(page.getByText(name));
}

// Read-back verification: after selecting an orientation, the TRIGGER's own sprite
// flips to match — `#landscape-phone` once Landscape is active, `#portrait-phone`
// for Portrait. Reading the trigger sprite is far more reliable than hunting a
// checkmark inside the (now-closed) menu. Returns a locator that exists only when
// the trigger shows the wanted orientation.
export function avatarShotsOrientationConfirmed(page: Page, which: "landscape" | "portrait"): Locator {
  const sprite = which === "landscape" ? "#landscape-phone" : "#portrait-phone";
  return page.locator(`[aria-haspopup="menu"]:has(svg use[href="${sprite}"])`);
}

// The "upload/record" audio affordance on the Avatar-Shots page. In the VIDEO
// SCRIPT box the placeholder reads "Type your script, or upload/record" where
// "upload/record" is a link. Clicking it opens a "Record Audio / Upload Audio"
// modal (the SAME modal as the /avatar composer), DEFAULTED to the Record tab —
// so the caller must switch to the Upload Audio tab (uploadAudioTab) before
// uploading, else HeyGen prompts for the microphone and the run stalls.
//
// We prefer an "upload"-worded target so we're more likely to land on the upload
// path directly, but the combined "upload/record" link is a single element so the
// tab switch is still the reliable step.
export function avatarShotsUploadAudioLink(page: Page): Locator {
  return page
    .getByText(/upload\/record/i)
    .or(page.getByRole("link", { name: /upload/i }))
    .or(page.getByRole("button", { name: /upload\/record|upload/i }))
    .or(page.getByRole("link", { name: /record/i }))
    .or(page.getByRole("button", { name: /record/i }));
}

// A hidden audio <input type=file> on the Avatar-Shots page (setInputFiles
// fallback when the filechooser event doesn't fire).
export function avatarShotsAudioInput(page: Page): Locator {
  return page.locator(
    'input[type="file"][accept*="audio"], input[type="file"][accept*="mp3"], ' +
      'input[type="file"][accept*="wav"], input[type="file"]',
  );
}

// After the audio attaches, the script box shows the uploaded track name + a
// play control and a "Voice Mirroring" checkbox. Presence of this text confirms
// the audio committed (the readiness signal before Generate on this flow).
export function avatarShotsAudioAttached(page: Page): Locator {
  return page
    .getByText(/voice mirroring/i)
    .or(page.locator("audio[src]"))
    .or(page.getByText(/\.mp3\b|\.wav\b/i));
}

// The Avatar-Shots Generate button ("Generate for 1 credit"). Enabled once a
// model, orientation and audio/script are set.
export function avatarShotsGenerateButton(page: Page): Locator {
  return page
    .getByRole("button", { name: /^generate\b/i })
    .or(page.getByRole("button", { name: /generate/i }));
}

// NOTE: the saved avatar used by Avatar III is created MANUALLY by the user in
// HeyGen at project setup, under a name they enter into the app at intake
// (projects.heygen_avatar_name). The app never creates/names avatars itself — it
// only SEARCHES for that name (avatarTileByName above) — so no New-Avatar / name
// modal selectors are needed here.

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

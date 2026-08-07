import { contrastRatio, hsl, parseHexColor, rgbToHsl, type Rgb } from './Palette';
import type { ThemeTokens } from './TemplateManifest';

/**
 * Controlled colour adaptation for a cloned template.
 *
 * The requirement is narrow and deliberate: the page must stay recognisably the
 * template while the branding moves to the book. So this changes ONE thing —
 * the accent — and takes only the HUE from the book's cover. Lightness and
 * saturation stay the template's.
 *
 * That constraint is what makes it safe. A navy-covered book on a warm-orange
 * template gets a navy CTA at the template's own lightness and saturation, not
 * a dark navy page. Backgrounds, section grounds, text colours, borders and the
 * template's light/dark polarity are never written to, so they cannot drift.
 *
 * The previous pipeline derived an entire palette from a single histogram bin
 * of the cover and applied it to everything, which is how a page copied from a
 * dark template came back light — the largest single "this doesn't look like
 * the template" defect, and one this function cannot produce.
 */

/** Minimum contrast between the new accent and the text sitting on it. */
const MIN_ACCENT_CONTRAST = 4.5;

/**
 * How far the new accent's lightness may drift from the template's to recover
 * contrast. Beyond this the result stops reading as the same design, and
 * keeping the template's own accent is the better failure.
 */
const MAX_LIGHTNESS_DRIFT = 0.22;

export interface ThemeAdaptation {
  /** False when the template's own accent is kept. */
  applied: boolean;
  /** The accent the page will use, either adapted or the template's original. */
  accentHex: string | null;
  /**
   * A `:root` override to append after the CSS bundle, when the template uses a
   * custom property for its accent. Empty when it does not — the caller then
   * substitutes `literalFrom` → `accentHex` in the bundle instead.
   */
  overrideCss: string;
  /**
   * The exact colour to replace in the bundle when there is no token to
   * override. Only ever this one value: never a family, never a range.
   */
  literalFrom: string | null;
  /** Why the adaptation did or did not apply, for the fidelity report. */
  reason: string;
}

function notApplied(theme: ThemeTokens, reason: string): ThemeAdaptation {
  return { applied: false, accentHex: theme.accentValue, overrideCss: '', literalFrom: null, reason };
}

/**
 * Derives the theme override for one book on one template.
 *
 * Pure: no I/O, no clock, no randomness. The same template and cover always
 * produce the same accent, which is what lets the visual diff treat a colour
 * change as expected rather than as drift.
 */
export function adaptTheme(input: { theme: ThemeTokens; coverAccent: Rgb | null }): ThemeAdaptation {
  const { theme, coverAccent } = input;

  if (!theme.accentValue) {
    return notApplied(theme, 'The template has no detected accent colour; nothing was changed.');
  }
  if (!coverAccent) {
    return notApplied(theme, "The book's cover yielded no accent colour; the template's own accent was kept.");
  }

  const templateRgb = parseHexColor(theme.accentValue);
  if (!templateRgb) {
    return notApplied(theme, `The template accent "${theme.accentValue}" could not be parsed.`);
  }

  const templateHsl = rgbToHsl(templateRgb);
  const coverHsl = rgbToHsl(coverAccent);

  // A near-grey cover has no meaningful hue to borrow — rotating the template's
  // accent to an arbitrary hue read off a neutral is noise, not branding.
  if (coverHsl.s < 0.12) {
    return notApplied(theme, "The cover's accent is near-neutral, so there is no hue worth borrowing.");
  }

  // The template's own text-on-accent decides readability. Without one there is
  // nothing to measure against, so the swap is refused rather than guessed at.
  const onAccent = theme.onAccentValue;
  if (!onAccent || !parseHexColor(onAccent)) {
    return notApplied(theme, 'The template does not state a text colour for its accent; the swap was refused.');
  }

  // Hue from the book, lightness and saturation from the template.
  const candidate = hsl(coverHsl.h, templateHsl.s, templateHsl.l);
  const chosen =
    contrastRatio(candidate, onAccent) >= MIN_ACCENT_CONTRAST
      ? candidate
      : recoverContrast(coverHsl.h, templateHsl.s, templateHsl.l, onAccent);

  if (!chosen) {
    return notApplied(
      theme,
      `A ${Math.round(coverHsl.h)}° accent could not reach ${MIN_ACCENT_CONTRAST}:1 against the template's ` +
        `button text within ±${Math.round(MAX_LIGHTNESS_DRIFT * 100)}% lightness; the template's accent was kept.`,
    );
  }

  const drifted = chosen !== candidate;
  return {
    applied: true,
    accentHex: chosen,
    overrideCss: theme.accentToken ? `:root { ${theme.accentToken}: ${chosen}; }\n` : '',
    literalFrom: theme.accentToken ? null : theme.accentValue,
    reason: drifted
      ? `Accent hue taken from the cover (${Math.round(coverHsl.h)}°); lightness adjusted from ` +
        `${Math.round(templateHsl.l * 100)}% to keep ${MIN_ACCENT_CONTRAST}:1 against the button text.`
      : `Accent hue taken from the cover (${Math.round(coverHsl.h)}°); the template's lightness and ` +
        'saturation were kept unchanged.',
  };
}

/**
 * Walks lightness outward from the template's own until the accent is readable
 * against the template's button text, or the drift cap is reached.
 *
 * Outward from the template's value, alternating directions, so the result is
 * the SMALLEST change that works rather than the first one found in an
 * arbitrary direction.
 */
function recoverContrast(hue: number, sat: number, from: number, onAccent: string): string | null {
  for (let step = 0.02; step <= MAX_LIGHTNESS_DRIFT; step += 0.02) {
    for (const direction of [-1, 1]) {
      const l = from + direction * step;
      if (l <= 0.05 || l >= 0.97) continue;
      const candidate = hsl(hue, sat, l);
      if (contrastRatio(candidate, onAccent) >= MIN_ACCENT_CONTRAST) return candidate;
    }
  }
  return null;
}

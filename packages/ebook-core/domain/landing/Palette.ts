import { ValueObject } from '../shared/ValueObject';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface PaletteProps {
  /** True when the cover is dark enough that the page renders on a dark ground. */
  dark: boolean;
  background: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  heading: string;
  accent: string;
  /** Text colour that sits ON the accent (button labels). */
  accentContrast: string;

  // ── band tones ─────────────────────────────────────────────────────────────
  // A sales page needs rhythm, not one flat field. These give the layout three
  // grounds to alternate between — deep, tinted, plain — all on the cover's hue.
  /** Always-dark ground for the hero, the closing CTA and the footer. */
  deep: string;
  /** Body text on `deep`. */
  onDeep: string;
  /** Secondary text on `deep`. */
  onDeepMuted: string;
  /** Hairlines on `deep`. */
  deepBorder: string;
  /** The accent, shifted until it is readable as text on `deep`. */
  accentOnDeep: string;
  /** A lightly tinted ground, for bands that sit between the plain ones. */
  tint: string;

  /** The raw sampled colour, kept for debugging and for regeneration diffs. */
  seed: string;
}

/**
 * The landing page's colour scheme, derived entirely from the book's own cover
 * art so the page looks like it belongs to the book.
 *
 * Raw sampled pixels make terrible UI colours — a muddy dark-olive cover yields
 * dark-olive body text on a dark-olive ground. So the sampled colour is used
 * only for its HUE; every actual colour is generated at a controlled lightness
 * and saturation, and then each text/background pair is nudged until it clears
 * WCAG AA. That makes an unreadable page structurally impossible rather than
 * merely unlikely.
 */
export class Palette extends ValueObject<PaletteProps> {
  /**
   * `seed` is the book cover's dominant colour and decides everything by
   * default. `opts.accentSeed` — when the reference page the client nominated
   * has a readable brand colour — takes over the HUE and SATURATION of the
   * whole scheme, so a warm orange reference produces a warm orange page even
   * over a navy cover. The cover still decides light-vs-dark: that follows the
   * artwork the page actually displays.
   */
  static fromSeed(seed: Rgb, opts?: { accentSeed?: Rgb | undefined }): Palette {
    const base = opts?.accentSeed ?? seed;
    const { h, s } = rgbToHsl(base);
    // Greyscale sources (s≈0) would produce a colourless page with an invisible
    // accent, so give them a restrained neutral-blue accent instead of grey.
    const hue = s < 0.06 ? 214 : h;
    const sat = s < 0.06 ? 0.5 : clamp(s, 0.35, 0.8);
    const dark = relativeLuminance(seed) < 0.42;

    // Light grounds carry their tint at a much lower perceived strength than
    // dark ones, so they need noticeably more saturation and a little less
    // lightness to read as the cover's colour rather than as plain white.
    // Dark grounds need a WIDER value spread than light ones, not a narrower
    // one: at 5-10% lightness the eye can barely tell two greys apart, and the
    // first real run rendered as one undifferentiated black mass. Deep sits at
    // ~4%, the page at ~8.5%, tint at ~12.5%, cards at ~13.5% — close enough to
    // feel like one family, far enough apart to read as separate bands.
    const background = dark ? hsl(hue, sat * 0.28, 0.085) : hsl(hue, sat * 0.34, 0.962);
    const surface = dark ? hsl(hue, sat * 0.26, 0.135) : hsl(hue, sat * 0.32, 0.925);
    const border = dark ? hsl(hue, sat * 0.24, 0.26) : hsl(hue, sat * 0.3, 0.84);

    // Accent lightness is pinned to the side of the wheel that can actually
    // carry a readable button label against this background. On a dark ground
    // the saturation floor is raised well above the cover's own: the dominant
    // colour of a dark cover is usually a desaturated field tone, and an accent
    // inheriting it produces the washed-grey buy button the first real run
    // shipped with. Sales pages need the accent to be the loudest thing on the
    // page, not the politest.
    const accentSat = dark ? clamp(sat * 1.4, 0.62, 0.9) : sat;
    const accent = hsl(hue, accentSat, dark ? 0.6 : 0.44);
    const heading = ensureContrast(dark ? hsl(hue, sat * 0.2, 0.97) : hsl(hue, sat * 0.35, 0.13), background, 4.5);
    const text = ensureContrast(dark ? hsl(hue, sat * 0.12, 0.9) : hsl(hue, sat * 0.15, 0.2), background, 4.5);
    // Muted text is still body copy, so it gets the full 4.5:1 treatment too —
    // "secondary" is not a licence to be unreadable.
    const muted = ensureContrast(dark ? hsl(hue, sat * 0.12, 0.68) : hsl(hue, sat * 0.12, 0.42), background, 4.5);

    // The deep band is dark on every cover, light or not — it is what gives the
    // page its anchor points. Kept on the cover's hue so it reads as the book's
    // own colour rather than as generic black.
    const deep = hsl(hue, sat * 0.5, dark ? 0.04 : 0.11);
    const onDeep = ensureContrast(hsl(hue, sat * 0.1, 0.95), deep, 4.5);
    const onDeepMuted = ensureContrast(hsl(hue, sat * 0.14, 0.74), deep, 4.5);

    return new Palette({
      dark,
      background,
      surface,
      border,
      text,
      muted,
      heading,
      accent,
      accentContrast: pickReadable(accent),
      deep,
      onDeep,
      onDeepMuted,
      deepBorder: hsl(hue, sat * 0.3, dark ? 0.2 : 0.22),
      // The page accent is tuned against the PAGE ground; on the deep band it
      // often falls under 4.5:1, so it gets its own corrected variant.
      accentOnDeep: ensureContrast(accent, deep, 4.5),
      tint: dark ? hsl(hue, sat * 0.24, 0.1) : hsl(hue, sat * 0.36, 0.935),
      seed: toHex(seed),
    });
  }

  /** Neutral fallback for a book whose cover art is missing or unreadable. */
  static neutral(): Palette {
    return Palette.fromSeed({ r: 24, g: 74, b: 138 });
  }

  static rehydrate(props: PaletteProps): Palette {
    return new Palette(props);
  }

  get dark() {
    return this.props.dark;
  }
  get accent() {
    return this.props.accent;
  }
  toJSON(): PaletteProps {
    return { ...this.props };
  }

  /** The palette as CSS custom properties, ready to drop into `:root`. */
  toCssVariables(): string {
    const p = this.props;
    return [
      `--bg: ${p.background}`,
      `--surface: ${p.surface}`,
      `--border: ${p.border}`,
      `--text: ${p.text}`,
      `--muted: ${p.muted}`,
      `--heading: ${p.heading}`,
      `--accent: ${p.accent}`,
      `--accent-contrast: ${p.accentContrast}`,
      `--deep: ${p.deep}`,
      `--on-deep: ${p.onDeep}`,
      `--on-deep-muted: ${p.onDeepMuted}`,
      `--deep-border: ${p.deepBorder}`,
      `--accent-on-deep: ${p.accentOnDeep}`,
      `--tint: ${p.tint}`,
    ].join(';\n      ');
  }
}

// ── colour maths ─────────────────────────────────────────────────────────────
// Self-contained on purpose: the domain layer takes no dependencies, and these
// are the only four conversions the palette needs.

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function toHex({ r, g, b }: Rgb): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

/**
 * HSL → `#rrggbb`. Exported because the cloned-template theme adaptation
 * (ThemeAdaptation.ts) rebuilds a colour from a borrowed hue and needs exactly
 * this conversion — and duplicating it there is how `romanYear` ended up
 * implemented twice.
 */
export function hsl(h: number, s: number, l: number): string {
  return toHex(hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1)));
}

function parseHex(hex: string): Rgb {
  const v = hex.replace('#', '');
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

/** Lenient public parser for e.g. a reference page's detected accent. */
export function parseHexColor(value: string | null | undefined): Rgb | null {
  if (!value) return null;
  const m = value.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m?.[1]) return null;
  return parseHex(`#${m[1]}`);
}

/** WCAG 2.1 relative luminance (0 = black, 1 = white). */
export function relativeLuminance(c: Rgb): number {
  const channel = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio between two colours (1:1 … 21:1). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseHex(a));
  const lb = relativeLuminance(parseHex(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Walk a foreground colour's lightness away from the background until it clears
 * `target`, preserving its hue. Steps are small so the result stays as close to
 * the cover's own colour as readability allows; if even pure black/white can't
 * reach the target (impossible for real backgrounds) the extreme is returned.
 */
export function ensureContrast(foreground: string, background: string, target: number): string {
  if (contrastRatio(foreground, background) >= target) return foreground;
  const { h, s } = rgbToHsl(parseHex(foreground));
  const lighten = relativeLuminance(parseHex(background)) < 0.5;
  for (let step = 1; step <= 40; step++) {
    const { l } = rgbToHsl(parseHex(foreground));
    const next = hsl(h, s, clamp(lighten ? l + step * 0.025 : l - step * 0.025, 0, 1));
    if (contrastRatio(next, background) >= target) return next;
  }
  return lighten ? '#ffffff' : '#000000';
}

/** Black or white — whichever reads better on the given colour. */
export function pickReadable(background: string): string {
  return contrastRatio('#ffffff', background) >= contrastRatio('#111111', background) ? '#ffffff' : '#111111';
}

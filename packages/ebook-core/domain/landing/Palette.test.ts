import { describe, it, expect } from 'vitest';
import { Palette, contrastRatio, type Rgb } from './Palette';

/** Covers span the whole gamut, so the palette has to survive all of them. */
const SEEDS: Array<{ name: string; rgb: Rgb }> = [
  { name: 'near-black', rgb: { r: 8, g: 8, b: 10 } },
  { name: 'near-white', rgb: { r: 248, g: 246, b: 240 } },
  { name: 'mid grey', rgb: { r: 128, g: 128, b: 128 } },
  { name: 'saturated red', rgb: { r: 200, g: 20, b: 24 } },
  { name: 'deep navy', rgb: { r: 12, g: 26, b: 74 } },
  { name: 'muddy olive', rgb: { r: 86, g: 92, b: 40 } },
  { name: 'bright yellow', rgb: { r: 250, g: 232, b: 40 } },
  { name: 'pale pink', rgb: { r: 246, g: 214, b: 226 } },
  { name: 'teal', rgb: { r: 18, g: 132, b: 128 } },
];

describe('Palette.fromSeed', () => {
  // The whole point of deriving colours rather than copying pixels: an
  // unreadable page must be structurally impossible, not merely unlikely.
  it.each(SEEDS)('keeps body text at WCAG AA on a $name cover', ({ rgb }) => {
    const p = Palette.fromSeed(rgb).toJSON();
    expect(contrastRatio(p.text, p.background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SEEDS)('keeps headings at WCAG AA on a $name cover', ({ rgb }) => {
    const p = Palette.fromSeed(rgb).toJSON();
    expect(contrastRatio(p.heading, p.background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SEEDS)('keeps muted/secondary text at WCAG AA on a $name cover', ({ rgb }) => {
    const p = Palette.fromSeed(rgb).toJSON();
    expect(contrastRatio(p.muted, p.background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SEEDS)('keeps the CTA label readable on the accent for a $name cover', ({ rgb }) => {
    const p = Palette.fromSeed(rgb).toJSON();
    // Buttons are large text, where AA is 3:1.
    expect(contrastRatio(p.accentContrast, p.accent)).toBeGreaterThanOrEqual(3);
  });

  // The deep band carries the hero, the comparison and the closing CTA, so its
  // text has to clear AA on every cover — including light ones, where the page
  // ground is bright but the band still is not.
  it.each(SEEDS)('keeps deep-band text at WCAG AA on a $name cover', ({ rgb }) => {
    const p = Palette.fromSeed(rgb).toJSON();
    expect(contrastRatio(p.onDeep, p.deep)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.onDeepMuted, p.deep)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.accentOnDeep, p.deep)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SEEDS)('keeps body text readable on the tinted band for a $name cover', ({ rgb }) => {
    const p = Palette.fromSeed(rgb).toJSON();
    expect(contrastRatio(p.text, p.tint)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.heading, p.tint)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SEEDS)('keeps the deep band genuinely dark on a $name cover', ({ rgb }) => {
    // Whatever the cover, the band must anchor the page — a "deep" band that
    // came out pale would collapse the whole layout into one flat field.
    const p = Palette.fromSeed(rgb).toJSON();
    expect(contrastRatio(p.deep, '#ffffff')).toBeGreaterThan(10);
  });

  it('gives the three grounds visibly different values', () => {
    const p = Palette.fromSeed({ r: 234, g: 221, b: 200 }).toJSON();
    expect(p.deep).not.toBe(p.tint);
    expect(p.tint).not.toBe(p.background);
    expect(contrastRatio(p.background, p.tint)).toBeGreaterThan(1.01);
  });

  it('follows the cover into dark mode and back', () => {
    expect(Palette.fromSeed({ r: 10, g: 12, b: 30 }).dark).toBe(true);
    expect(Palette.fromSeed({ r: 245, g: 244, b: 240 }).dark).toBe(false);
  });

  it('gives a greyscale cover a real accent instead of grey', () => {
    // A grey accent on a grey page leaves the buy button invisible.
    const { accent, background } = Palette.fromSeed({ r: 130, g: 130, b: 130 }).toJSON();
    const [r, g, b] = [accent.slice(1, 3), accent.slice(3, 5), accent.slice(5, 7)].map((h) => parseInt(h, 16));
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeGreaterThan(20);
    expect(contrastRatio(accent, background)).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic — the same cover always yields the same page', () => {
    const seed = { r: 40, g: 90, b: 160 };
    expect(Palette.fromSeed(seed).toJSON()).toEqual(Palette.fromSeed(seed).toJSON());
  });

  it('survives a round trip through persistence', () => {
    const original = Palette.fromSeed({ r: 40, g: 90, b: 160 });
    expect(Palette.rehydrate(original.toJSON()).toJSON()).toEqual(original.toJSON());
  });

  it('emits CSS custom properties the template can consume', () => {
    const css = Palette.fromSeed({ r: 40, g: 90, b: 160 }).toCssVariables();
    const names = ['--bg', '--text', '--accent', '--accent-contrast', '--heading', '--muted',
      '--deep', '--on-deep', '--on-deep-muted', '--deep-border', '--accent-on-deep', '--tint'];
    for (const name of names) {
      expect(css).toContain(`${name}: #`);
    }
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});

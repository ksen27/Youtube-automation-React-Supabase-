import { describe, it, expect } from 'vitest';
import { adaptTheme } from './ThemeAdaptation';
import { contrastRatio, parseHexColor, rgbToHsl } from './Palette';
import type { ThemeTokens } from './TemplateManifest';

/** themechanicbible.com's measured accent: a warm orange on white text. */
function theme(overrides: Partial<ThemeTokens> = {}): ThemeTokens {
  return {
    accentToken: '--brand-primary',
    accentValue: '#da5e25',
    onAccentValue: '#ffffff',
    isDark: true,
    rootTokens: {},
    ...overrides,
  };
}

const NAVY = { r: 26, g: 42, b: 92 };
const GREY = { r: 128, g: 128, b: 130 };

describe('adaptTheme', () => {
  it('takes the hue from the cover and keeps the template lightness and saturation', () => {
    const templateHsl = rgbToHsl(parseHexColor('#da5e25')!);
    const result = adaptTheme({ theme: theme(), coverAccent: NAVY });

    expect(result.applied).toBe(true);
    const adapted = rgbToHsl(parseHexColor(result.accentHex!)!);
    expect(adapted.h).toBeCloseTo(rgbToHsl(NAVY).h, 0);
    expect(adapted.s).toBeCloseTo(templateHsl.s, 2);
    expect(adapted.l).toBeCloseTo(templateHsl.l, 2);
  });

  it('emits a :root override when the template uses a custom property', () => {
    const result = adaptTheme({ theme: theme(), coverAccent: NAVY });
    expect(result.overrideCss).toContain('--brand-primary:');
    expect(result.literalFrom).toBeNull();
  });

  it('reports the literal to replace when the template writes a raw colour', () => {
    const result = adaptTheme({ theme: theme({ accentToken: null }), coverAccent: NAVY });
    expect(result.overrideCss).toBe('');
    expect(result.literalFrom).toBe('#da5e25');
  });

  it('never returns an accent the template button text cannot be read on', () => {
    // Yellow at the template's lightness would fail against white.
    const yellowCover = { r: 240, g: 220, b: 20 };
    const result = adaptTheme({ theme: theme(), coverAccent: yellowCover });
    if (result.applied) {
      expect(contrastRatio(result.accentHex!, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    } else {
      expect(result.accentHex).toBe('#da5e25');
    }
  });

  it('keeps the template accent rather than borrowing a hue from a neutral cover', () => {
    const result = adaptTheme({ theme: theme(), coverAccent: GREY });
    expect(result.applied).toBe(false);
    expect(result.accentHex).toBe('#da5e25');
    expect(result.reason).toContain('near-neutral');
  });

  it('refuses the swap when the template states no text colour to measure against', () => {
    const result = adaptTheme({ theme: theme({ onAccentValue: null }), coverAccent: NAVY });
    expect(result.applied).toBe(false);
    expect(result.accentHex).toBe('#da5e25');
  });

  it('keeps the template accent when the book has no cover to sample', () => {
    const result = adaptTheme({ theme: theme(), coverAccent: null });
    expect(result.applied).toBe(false);
    expect(result.accentHex).toBe('#da5e25');
  });

  // The largest single "this doesn't look like the template" defect in v1: a
  // dark template flipped to light because the cover happened to be pale. This
  // function never writes a background, so it cannot produce that outcome.
  it('never changes the page polarity', () => {
    const paleCover = { r: 240, g: 238, b: 230 };
    const result = adaptTheme({ theme: theme({ isDark: true }), coverAccent: paleCover });
    expect(result.overrideCss).not.toContain('background');
    expect(result.overrideCss.split(':').filter((p) => p.startsWith('--')).length).toBeLessThanOrEqual(1);
  });

  it('is deterministic — the same template and cover always give the same accent', () => {
    const a = adaptTheme({ theme: theme(), coverAccent: NAVY });
    const b = adaptTheme({ theme: theme(), coverAccent: NAVY });
    expect(a.accentHex).toBe(b.accentHex);
  });
});

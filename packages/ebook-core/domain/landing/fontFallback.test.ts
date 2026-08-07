import { describe, it, expect } from 'vitest';
import { repairFontStacks, lostFamiliesOf } from './fontFallback';
import type { TypographyTokens } from './TemplateManifest';

const NO_TYPOGRAPHY: TypographyTokens = { heading: null, body: null, familiesUsed: [] };

function typography(overrides: Partial<TypographyTokens>): TypographyTokens {
  return { ...NO_TYPOGRAPHY, ...overrides };
}

describe('repairFontStacks', () => {
  // The defect this exists for: the template's @font-face is stripped as
  // unlicensed, the declaration naming it survives, and the browser falls
  // through to its own default — so the clone matched everywhere but the type.
  it('appends a renderable stack to a family nothing provides', () => {
    const result = repairFontStacks({
      css: 'h1 { font-family: Canela; }',
      embeddedFamilies: [],
      typography: NO_TYPOGRAPHY,
    });
    expect(result.css).toContain('Canela');
    expect(result.css).toMatch(/serif\s*;?\s*}/);
    expect(result.lostFamilies).toEqual(['Canela']);
  });

  // Appending rather than replacing is what makes the pass safe to run
  // unconditionally: the embedded face still wins because a stack is already a
  // preference list, so this needs no coordination with the embedder.
  it('leaves a family an embedded face provides untouched', () => {
    const css = "h1 { font-family: 'Playfair Display', serif; }";
    const result = repairFontStacks({
      css,
      embeddedFamilies: ['Playfair Display'],
      typography: NO_TYPOGRAPHY,
    });
    expect(result.css).toBe(css);
    expect(result.lostFamilies).toEqual([]);
  });

  it('does not touch a declaration that already falls through to a generic', () => {
    const css = 'p { font-family: Canela, Georgia, serif; }';
    expect(repairFontStacks({ css, embeddedFamilies: [], typography: NO_TYPOGRAPHY }).css).toBe(css);
  });

  it('keeps the template’s own secondary choices ahead of ours', () => {
    const result = repairFontStacks({
      css: 'p { font-family: Canela, "Georgia Pro"; }',
      embeddedFamilies: [],
      typography: NO_TYPOGRAPHY,
    });
    // Georgia Pro was named for a reason; our stack is the last resort.
    expect(result.css.indexOf('Georgia Pro')).toBeLessThan(result.css.indexOf('serif'));
  });

  // A var() resolves at render time to a family this pass cannot see, so
  // rewriting it would replace a working indirection with a guess.
  it('leaves a var() reference alone', () => {
    const css = 'h1 { font-family: var(--font-display); }';
    expect(repairFontStacks({ css, embeddedFamilies: [], typography: NO_TYPOGRAPHY }).css).toBe(css);
  });

  it('leaves a bare generic alone', () => {
    const css = 'body { font-family: sans-serif; }';
    expect(repairFontStacks({ css, embeddedFamilies: [], typography: NO_TYPOGRAPHY }).css).toBe(css);
  });

  // The measurement is what makes the substitute plausible: a sans face whose
  // name gives no clue would otherwise fall into a book-serif stack.
  it('uses the measured serif flag to pick the right bucket', () => {
    const sans = repairFontStacks({
      css: 'h1 { font-family: Whitney; }',
      embeddedFamilies: [],
      typography: typography({
        heading: { family: 'Whitney', stack: 'Whitney', weight: '700', serif: false },
      }),
    });
    expect(sans.css).toContain('sans-serif');
    expect(sans.css).not.toMatch(/,\s*serif\s*;/);
  });

  it('reports each lost family once across many declarations', () => {
    const result = repairFontStacks({
      css: 'h1 { font-family: Canela; } h2 { font-family: Canela; } p { font-family: Söhne; }',
      embeddedFamilies: [],
      typography: NO_TYPOGRAPHY,
    });
    expect(result.lostFamilies).toEqual(['Canela', 'Söhne']);
  });
});

describe('lostFamiliesOf', () => {
  it('matches families case- and quote-insensitively', () => {
    expect(lostFamiliesOf(['Playfair Display', 'Canela'], ['"playfair display"'])).toEqual(['Canela']);
  });

  it('is empty when every measured family embedded', () => {
    expect(lostFamiliesOf(['Inter'], ['Inter'])).toEqual([]);
  });
});

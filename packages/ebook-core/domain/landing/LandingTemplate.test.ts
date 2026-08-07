import { describe, expect, it } from 'vitest';
import { LANDING_TEMPLATE_DEFAULTS, referenceUrlFor } from './LandingTemplate';

describe('referenceUrlFor', () => {
  // The client's requirement: choosing 3 ebooks uses the 3-ebook template.
  it('gives a three-book page the three-book template by default', () => {
    expect(referenceUrlFor('triple')).toBe(LANDING_TEMPLATE_DEFAULTS.triple);
    expect(referenceUrlFor('triple')).toContain('themechanicbible.com');
  });

  // Single-book projects have always supplied their own reference; defaulting
  // them to the three-book site would restyle every existing project.
  it('leaves a single-book page with no reference unless one was given', () => {
    expect(referenceUrlFor('single')).toBeNull();
    expect(referenceUrlFor('single', 'https://eliasyoder.com')).toBe('https://eliasyoder.com');
  });

  it('lets a seller point either mode at their own reference', () => {
    expect(referenceUrlFor('triple', 'https://example.com/three')).toBe('https://example.com/three');
  });

  it('treats a blank override as unset rather than as a URL', () => {
    expect(referenceUrlFor('triple', '   ')).toBe(LANDING_TEMPLATE_DEFAULTS.triple);
    expect(referenceUrlFor('single', '')).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { placeAuthorPortrait } from './GenerateClonedLandingPageUseCase';

/**
 * The seller uploads one portrait. A template with no portrait region of its
 * own would otherwise discard it — while still showing the template owner's
 * photograph beside the introduction it was meant to replace.
 */
describe('placeAuthorPortrait', () => {
  // The shape vintagelifestyleusa.com uses: introduction in one column, an
  // image in the other.
  const twoColumn =
    '<section class="about"><div class="about-grid">' +
    '<div class="about-copy"><p>{{AUTHOR_BIO}}</p></div>' +
    '<div class="about-figure"><div class="frame">' +
    '<img src="assets/red-beans-rice.webp" alt="Red beans and rice, church potluck style" loading="lazy">' +
    '</div></div></div></section>';

  it('takes over the image the introduction is set against', () => {
    const out = placeAuthorPortrait(twoColumn, 'Mabel Hart');

    expect(out.placed).toBe('replaced');
    expect(out.html).toContain('src="assets/author.webp"');
    expect(out.html).toContain('alt="Mabel Hart"');
    // The template owner's photograph is gone, not joined by a second image.
    expect(out.html).not.toContain('red-beans-rice');
    expect(out.html.match(/<img/g)).toHaveLength(1);
    // Everything the template wrapped it in survives, so its CSS still applies.
    expect(out.html).toContain('<div class="about-figure"><div class="frame">');
    expect(out.html).toContain('loading="lazy"');
  });

  it('does not reach into a neighbouring section', () => {
    const html = `${twoColumn}<section class="order"><img src="assets/seal.svg" alt="Guarantee"></section>`;
    const out = placeAuthorPortrait(html, 'Mabel Hart');

    expect(out.html).toContain('src="assets/seal.svg"');
    expect(out.html).toContain('alt="Guarantee"');
  });

  it('adds a portrait when the introduction has no image of its own', () => {
    const prose = '<section><div><p>{{AUTHOR_BIO}}</p></div></section>';
    const out = placeAuthorPortrait(prose, 'Mabel Hart');

    expect(out.placed).toBe('added');
    expect(out.html).toContain('class="lp-author-portrait"');
    // Ahead of the text, so the float wraps the paragraph rather than trailing it.
    expect(out.html.indexOf('lp-author-portrait')).toBeLessThan(out.html.indexOf('{{AUTHOR_BIO}}'));
  });

  it('leaves a template with no introduction alone', () => {
    const html = '<section><h2>{{HERO_TITLE}}</h2><img src="assets/x.webp" alt="x"></section>';
    const out = placeAuthorPortrait(html, 'Mabel Hart');

    expect(out.placed).toBe('none');
    expect(out.html).toBe(html);
  });

  it('falls back to a generic alt when no author name is known', () => {
    expect(placeAuthorPortrait('<section><p>{{AUTHOR_BIO}}</p></section>', '   ').html).toContain('alt="The author"');
  });

  it('never lets a name break out of the alt attribute', () => {
    const out = placeAuthorPortrait(twoColumn, 'Mabel" onerror="alert(1)');
    expect(out.html).not.toContain('onerror="');
    expect(out.html).toContain('alt="Mabel onerror=alert(1)"');
  });

  it('adds rather than substitutes when the image has no src to replace', () => {
    // Nothing to size or frame it with, so a blind substitution would produce an
    // <img> the template's own CSS never styled.
    const odd = '<section><p>{{AUTHOR_BIO}}</p><img data-lazy="x"></section>';
    expect(placeAuthorPortrait(odd, 'Mabel Hart').placed).toBe('added');
  });
});

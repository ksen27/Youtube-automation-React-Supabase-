import { describe, it, expect } from 'vitest';
import { injectAuthorPortrait } from './GenerateClonedLandingPageUseCase';

/**
 * The seller uploads one portrait. A template with no portrait region of its own
 * — vintagelifestyleusa.com is one — would otherwise discard it silently.
 */
describe('injectAuthorPortrait', () => {
  it('puts the portrait at the front of the author paragraph', () => {
    const out = injectAuthorPortrait('<section><p>{{AUTHOR_BIO}}</p></section>', 'Mabel Hart');
    expect(out.injected).toBe(true);
    expect(out.html).toContain('class="lp-author-portrait"');
    expect(out.html).toContain('src="assets/author.webp"');
    expect(out.html).toContain('alt="Mabel Hart"');
    // Ahead of the text, so the float wraps the paragraph rather than trailing it.
    expect(out.html.indexOf('lp-author-portrait')).toBeLessThan(out.html.indexOf('{{AUTHOR_BIO}}'));
    expect(out.html).toContain('{{AUTHOR_BIO}}');
  });

  it('leaves a template with no author paragraph alone', () => {
    // No introduction to sit beside — a guessed position is worse than omitting.
    const html = '<section><h2>{{HERO_TITLE}}</h2></section>';
    const out = injectAuthorPortrait(html, 'Mabel Hart');
    expect(out.injected).toBe(false);
    expect(out.html).toBe(html);
  });

  it('falls back to a generic alt when no author name is known', () => {
    expect(injectAuthorPortrait('<p>{{AUTHOR_BIO}}</p>', '   ').html).toContain('alt="The author"');
  });

  it('never lets a name break out of the alt attribute', () => {
    const out = injectAuthorPortrait('<p>{{AUTHOR_BIO}}</p>', 'Mabel" onerror="alert(1)');
    expect(out.html).not.toContain('onerror="');
    expect(out.html).toContain('alt="Mabel onerror=alert(1)"');
  });

  it('injects once even if the token somehow repeats', () => {
    const out = injectAuthorPortrait('<p>{{AUTHOR_BIO}}</p><p>{{AUTHOR_BIO}}</p>', 'Mabel Hart');
    expect(out.html.match(/lp-author-portrait/g)).toHaveLength(1);
  });
});

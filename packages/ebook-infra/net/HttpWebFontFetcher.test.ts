import { describe, it, expect } from 'vitest';
import { HttpWebFontFetcher, parseFontFaces } from './HttpWebFontFetcher';

const FONT_BYTES = new Uint8Array([1, 2, 3, 4]);

/** A fetch that records what it was asked for and always succeeds. */
function recordingFetch() {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(String(url));
    return { ok: true, arrayBuffer: async () => FONT_BYTES.buffer } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, asked };
}

const googleCss = `
  @font-face { font-family: 'Playfair Display'; font-style: normal; font-weight: 700;
    src: url(https://fonts.gstatic.com/s/playfair/v30/abc.woff2) format('woff2'); }
`;

describe('parseFontFaces', () => {
  it('reads family, weight and sources out of a stylesheet', () => {
    const faces = parseFontFaces(googleCss);
    expect(faces).toHaveLength(1);
    expect(faces[0]?.family).toBe('Playfair Display');
    expect(faces[0]?.weight).toBe('700');
    expect(faces[0]?.sources[0]?.format).toBe('woff2');
  });

  // Italics were previously dropped to save page weight. That cost more than it
  // saved: emphasised body copy fell back to a different typeface mid-paragraph,
  // which reads as a broken page. Weight is now bounded by the byte budget.
  it('keeps italics, so emphasised copy stays in the same typeface', () => {
    const italic = googleCss.replace('font-style: normal', 'font-style: italic');
    const faces = parseFontFaces(italic);
    expect(faces).toHaveLength(1);
    expect(faces[0]?.style).toBe('italic');
  });

  it('reads a face nested inside an at-rule without eating its closing brace', () => {
    // The `[^}]*` body match this replaced consumed the face's own `}`, leaving
    // the @supports block unbalanced and corrupting every rule after it.
    const nested = `@supports (font-variation-settings: normal) {
      @font-face { font-family: 'Inter'; font-style: normal; font-weight: 400;
        src: url(https://fonts.gstatic.com/s/inter/v13/x.woff2) format('woff2'); }
    }
    body { color: red; }`;
    const faces = parseFontFaces(nested);
    expect(faces).toHaveLength(1);
    expect(faces[0]?.family).toBe('Inter');
  });

  it('reads a quoted family name whole rather than stopping at the quote', () => {
    const css = `@font-face { font-family: "Playfair Display", serif; font-weight: 400;
      src: url(https://fonts.gstatic.com/s/p/v1/a.woff2) format('woff2'); }`;
    expect(parseFontFaces(css)[0]?.family).toBe('Playfair Display');
  });

  it('ignores faces already inlined as data URIs', () => {
    const inlined = "@font-face { font-family: 'X'; src: url(data:font/woff2;base64,AAA) format('woff2'); }";
    expect(parseFontFaces(inlined)).toHaveLength(0);
  });
});

describe('HttpWebFontFetcher — licence gate', () => {
  it('embeds a font from an open-licence origin', async () => {
    const { impl, asked } = recordingFetch();
    const result = await new HttpWebFontFetcher(impl).embedFrom(googleCss, 'https://example.com/');

    expect(result.isOk()).toBe(true);
    if (result.isFail()) throw new Error(result.error);
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.family).toBe('Playfair Display');
    expect(result.value[0]?.fontFaceCss).toContain('data:font/woff2;base64,');
    expect(asked).toHaveLength(1);
  });

  // A font served from the reference's own domain is almost certainly licensed
  // to that site alone. Copying it into someone else's sales page infringes.
  it('refuses a self-hosted font, and never even downloads it', async () => {
    const { impl, asked } = recordingFetch();
    const selfHosted = googleCss.replace(
      'https://fonts.gstatic.com/s/playfair/v30/abc.woff2',
      'https://theirsite.com/fonts/CommercialSans.woff2',
    );

    const result = await new HttpWebFontFetcher(impl).embedFrom(selfHosted, 'https://theirsite.com/');

    if (result.isFail()) throw new Error(result.error);
    expect(result.value).toEqual([]);
    // The gate sits BEFORE the request, so the bytes are never fetched.
    expect(asked).toEqual([]);
  });

  it('resolves relative sources against the page, then still gates them', async () => {
    const { impl, asked } = recordingFetch();
    const relative = googleCss.replace('https://fonts.gstatic.com/s/playfair/v30/abc.woff2', '/fonts/x.woff2');

    const result = await new HttpWebFontFetcher(impl).embedFrom(relative, 'https://theirsite.com/');

    if (result.isFail()) throw new Error(result.error);
    expect(result.value).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('returns nothing rather than failing when a stylesheet has no faces', async () => {
    const { impl } = recordingFetch();
    const result = await new HttpWebFontFetcher(impl).embedFrom('body { color: red }', 'https://example.com/');
    if (result.isFail()) throw new Error(result.error);
    expect(result.value).toEqual([]);
  });
});

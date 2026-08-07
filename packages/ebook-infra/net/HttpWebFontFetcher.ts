import { Result, type EmbeddedFont, type WebFontFetcher } from '@ebook/core';
import { assertPublicUrl } from './HttpReferencePageFetcher';

/**
 * Origins that serve ONLY openly-licensed fonts (OFL / Apache / UFL), whose
 * terms permit redistribution — which is what inlining a font into a published
 * page does.
 *
 * This allowlist is the licence decision, made once and in code. A font served
 * from the reference site's own domain is refused no matter how good it looks:
 * it is very likely commercially licensed to that site alone, and copying it
 * into someone else's sales page is the kind of infringement nobody notices
 * until it matters.
 */
const OPEN_FONT_HOSTS = new Set([
  'fonts.gstatic.com',
  'fonts.googleapis.com',
  'cdn.jsdelivr.net', // serves @fontsource, which is OFL/Apache by policy
]);

/** A woff2 face is 20-120KB; anything larger is not a subsetted web font. */
const MAX_FONT_BYTES = 400_000;

/**
 * Enough for a real type system: two families at regular/medium/semibold/bold
 * plus the italics that body copy actually uses.
 *
 * Was 3, which silently truncated every template with more than one weight per
 * family — the page kept its display face and lost its bold, so headings and
 * emphasis rendered in different typefaces. Page weight is bounded by
 * MAX_FONT_BYTES per face and by MAX_TOTAL_FONT_BYTES across all of them, which
 * is the constraint that actually matters.
 */
const MAX_FONTS = 10;

/**
 * The real budget. A cap on face COUNT is a poor proxy for page weight when
 * faces vary from 20KB to 400KB, so the total is bounded directly.
 */
const MAX_TOTAL_FONT_BYTES = 900_000;

/**
 * Inlines a reference's real typefaces when their licence allows it.
 *
 * Everything here is best-effort. A page that falls back to the closest system
 * stack is a working page; a page that fails to build because a font server was
 * slow is not.
 */
export class HttpWebFontFetcher implements WebFontFetcher {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async embedFrom(css: string, baseUrl: string): Promise<Result<EmbeddedFont[]>> {
    const faces = parseFontFaces(css);
    const embedded: EmbeddedFont[] = [];
    let totalBytes = 0;

    // Upright weights before italics, so a tight byte budget spends itself on
    // the cuts a page uses most rather than on whichever face parsed first.
    const ordered = [...faces].sort((a, b) => Number(a.style !== 'normal') - Number(b.style !== 'normal'));

    for (const face of ordered) {
      if (embedded.length >= MAX_FONTS || totalBytes >= MAX_TOTAL_FONT_BYTES) break;
      // Prefer woff2: smallest, and universally supported by anything that can
      // render a modern landing page.
      const source = face.sources.find((s) => s.format === 'woff2') ?? face.sources[0];
      if (!source) continue;

      let absolute: URL;
      try {
        absolute = new URL(source.url, baseUrl);
      } catch {
        continue;
      }
      // The licence gate. Deliberately before the fetch, so a commercial font
      // is never even downloaded.
      if (!OPEN_FONT_HOSTS.has(absolute.hostname.toLowerCase())) continue;

      const safe = await assertPublicUrl(absolute.toString());
      if (safe.isFail()) continue;

      const bytes = await this.read(absolute.toString());
      if (!bytes) continue;
      if (totalBytes + bytes.byteLength > MAX_TOTAL_FONT_BYTES) continue;
      totalBytes += bytes.byteLength;

      const mime = source.format === 'woff2' ? 'font/woff2' : source.format === 'woff' ? 'font/woff' : 'font/ttf';
      const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
      embedded.push({
        family: face.family,
        fontFaceCss:
          `@font-face{font-family:'${face.family.replace(/'/g, '')}';` +
          `font-style:${face.style};font-weight:${face.weight};font-display:swap;` +
          `src:url(${dataUri}) format('${source.format}');}`,
      });
    }

    return Result.ok(embedded);
  }

  private async read(url: string): Promise<Uint8Array | null> {
    try {
      const res = await this.fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'EbookGenerator/1.0 (+landing-page font embed)' },
      });
      if (!res.ok) return null;
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_FONT_BYTES) return null;
      return new Uint8Array(buffer);
    } catch {
      return null;
    }
  }
}

interface ParsedFace {
  family: string;
  weight: string;
  style: string;
  sources: Array<{ url: string; format: string }>;
}

/**
 * Pulls `@font-face` blocks out of a stylesheet.
 *
 * Regex rather than a CSS parse for the same reason the page digest is: we need
 * a handful of fields, not a syntax tree, and a parser is a dependency plus a
 * new class of failure on malformed third-party CSS.
 */
/**
 * The body of every `@font-face` block, matched by balancing braces.
 *
 * A `[^}]*` body cannot span a nested `}`, which `src: local("X"), url(...)`
 * does not contain but a minified sheet placing `@font-face` inside `@media`
 * does — there the naive match consumed the face's own closing brace and left
 * the enclosing at-rule unbalanced.
 */
function fontFaceBodies(css: string): string[] {
  const bodies: string[] = [];
  const re = /@font-face\s*\{/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    // An unterminated block means truncated CSS; the partial body is still
    // worth reading, since the src usually precedes the truncation.
    bodies.push(css.slice(start, depth === 0 ? i - 1 : css.length));
    re.lastIndex = i;
  }
  return bodies;
}

export function parseFontFaces(css: string): ParsedFace[] {
  const faces: ParsedFace[] = [];
  for (const body of fontFaceBodies(css)) {
    // Quoted first, so `font-family: "Playfair Display", serif` yields the
    // whole name. The unquoted branch stops at a comma for the same reason —
    // the previous single pattern captured through the quote and kept trailing
    // punctuation, which then failed to match the family named in font-family
    // declarations and made the face look absent.
    const family = (
      /font-family:\s*["']([^"']+)["']/i.exec(body)?.[1] ?? /font-family:\s*([^;,}]+)/i.exec(body)?.[1]
    )?.trim();
    if (!family) continue;

    const weight = /font-weight:\s*([^;]+)/i.exec(body)?.[1]?.trim() ?? '400';
    // Italics are kept: dropping them meant emphasised body copy fell back to a
    // different typeface mid-paragraph, which is more visible than the page
    // weight it saved. The byte budget is enforced by the caller.
    const style = /font-style:\s*([^;]+)/i.exec(body)?.[1]?.trim() ?? 'normal';

    const sources: Array<{ url: string; format: string }> = [];
    for (const src of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/gi)) {
      const url = src[1]?.trim();
      if (!url || url.startsWith('data:')) continue;
      const format = (src[2] ?? url.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      sources.push({ url, format });
    }
    if (sources.length > 0) faces.push({ family, weight, style, sources });
  }
  return faces;
}

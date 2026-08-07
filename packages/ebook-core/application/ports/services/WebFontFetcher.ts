import type { Result } from '../../../domain/shared/Result';

/**
 * A reference site's actual typeface, inlined so our page can use it.
 *
 * Landing pages deploy as one self-contained file with no network access, so a
 * webfont can only be used if its bytes travel inside the document. That is
 * what this produces: `@font-face` rules whose `src` is a `data:` URI.
 *
 * LICENSING IS THE CONSTRAINT, not the mechanism. Inlining a font file
 * redistributes it, which open licences (OFL, Apache) permit and commercial
 * desktop/web licences generally do not. Implementations MUST therefore embed
 * only from origins that exclusively serve openly-licensed fonts, and refuse
 * everything else — a self-hosted font on the reference's own domain is
 * exactly the case we cannot safely copy.
 */
export interface EmbeddedFont {
  /** The family name as the stylesheet declares it, e.g. "Playfair Display". */
  family: string;
  /** A complete `@font-face` rule with the payload inlined as a data: URI. */
  fontFaceCss: string;
}

export interface WebFontFetcher {
  /**
   * Reads `@font-face` rules out of a reference stylesheet and inlines the ones
   * that are safe to redistribute. Returns an empty list rather than failing:
   * a page with the nearest system stack is a working page.
   */
  embedFrom(css: string, baseUrl: string): Promise<Result<EmbeddedFont[]>>;
}

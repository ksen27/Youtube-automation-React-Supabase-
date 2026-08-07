import type { Result } from '../../../domain/shared/Result';

/** A readable digest of a reference sales page, for the model to learn from. */
export interface ReferencePage {
  url: string;
  title: string;
  /** Section headings in document order — the page's skeleton. */
  headings: Array<{ level: number; text: string }>;
  /** Visible text, collapsed and truncated; enough to read the structure. */
  text: string;
  /**
   * The page's actual body markup, pruned (no scripts, styles, svg innards or
   * embedded data) and size-capped. This is what lets generation COPY the
   * template rather than reinvent something in its spirit — the client's ask
   * is "same template, our branding and colours".
   */
  markup: string;
  /**
   * The page's own CSS, size-capped. Kept so a font embedder can read the
   * `@font-face` rules — the only place the reference's real typefaces are
   * named with a downloadable source.
   */
  styleCss: string;
  /** Observed visual treatment, read off the page's own stylesheet/markup. */
  style: {
    /** Whether headings use a serif face. */
    serifHeadings: boolean;
    /**
     * Whether BODY text uses a serif face — asked separately from headings
     * because the pairing is the design. These templates run a serif display
     * face over sans-serif body copy, and treating the page as "serif" set the
     * small text in Georgia where the reference uses sans.
     */
    serifBody: boolean;
    /** The named display/heading typeface, e.g. "Playfair Display", when found. */
    headingFont: string | null;
    /** The named BODY typeface, when the stylesheet sets one separately. */
    bodyFont: string | null;
    /** Distinct background colours used as section grounds, most-used first. */
    grounds: string[];
    /** The most prominent non-neutral colour — usually the CTA. */
    accent: string | null;
    /** True when sections carry numbering (I. / 01 / Step 1). */
    numberedSections: boolean;
    /** Roughly how image-led the page is: images per thousand words. */
    imageDensity: number;
    /** Content column width in px, when it can be determined. */
    measurePx: number | null;
  };
}

/**
 * Fetches the reference page the client nominated for a given book.
 *
 * SECURITY: the URL comes from a user, and this runs server-side inside the
 * worker's network. That is a textbook SSRF sink — a URL pointing at
 * 127.0.0.1, a private range, or a cloud metadata endpoint would make this
 * service fetch internal resources on the caller's behalf. Implementations MUST
 * resolve the host and refuse anything that is not a public address, on every
 * redirect hop as well as the initial request.
 */
export interface ReferencePageFetcher {
  fetch(url: string): Promise<Result<ReferencePage>>;
}

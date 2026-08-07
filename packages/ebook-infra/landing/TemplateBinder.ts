import { bindTemplate, Result, type BindValues } from '@ebook/core';
import { esc } from './shared';
import { DISCLOSURE_CSS } from './restoreDisclosure';

/**
 * Fits a bound image inside the slot the template sized for its own artwork.
 *
 * The only styling this system imposes on a cloned page, and it earns its place:
 * the template's product shots and a generated book cover are different shapes,
 * and the template's CSS crops to fill. That cut the book's title off at both
 * edges. Contain letterboxes slightly instead, which is the lesser cost — a
 * cover a buyer cannot read is not doing its job.
 *
 * Scoped to nodes the parameteriser marked, so nothing the template ships is
 * touched.
 */
const BOUND_IMAGE_CSS = `
img[data-fit="contain"] { object-fit: contain; object-position: center; }
`;

/**
 * Assembles a parameterised template into the finished, self-contained page.
 *
 * The document shell is deliberately NOT rebuilt — that is the entire
 * difference from `GeneratedPageAssembler`, which constructed a `<head>`, a
 * palette, a component stylesheet and a reveal script around markup a model had
 * written. Here the document already exists. This replaces its stylesheet links
 * with the bundled copy, restores the identity that cleaning stripped, and
 * fills the tokens.
 */
export interface AssembleInput {
  /** The stored template: a full document carrying `{{TOKEN}}`s. */
  templateHtml: string;
  /** The bundled stylesheet, with every url() already pointing at `assets/…`. */
  css: string;
  /** A `:root` override from the controlled theme adaptation. May be empty. */
  themeOverrideCss: string;
  /**
   * Set when the template writes its accent as a literal rather than through a
   * custom property. Exactly one colour is substituted — never a family, never
   * a range.
   */
  accentLiteral: { from: string; to: string } | null;
  values: BindValues;
  required: readonly string[];
  documentTitle: string;
  metaDescription: string;
}

export class TemplateBinder {
  assemble(input: AssembleInput): Result<{ html: string; unresolved: string[]; removedOptional: string[] }, string[]> {
    const bound = bindTemplate(input.templateHtml, input.values, { required: input.required });
    if (bound.isFail()) return bound;

    let html = bound.value.html;

    // Remote stylesheets and the page's original inline styles both go: the CSS
    // bundle captured during extraction already contains everything they said,
    // with its url() references rewritten to local copies. Left in place they
    // would make the published page fetch CSS from the template owner's server.
    html = html
      .replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

    const accentCss = input.accentLiteral ? literalAccentOverride(input.accentLiteral) : '';
    const head =
      `<meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${esc(input.documentTitle)}</title>` +
      `<meta name="description" content="${esc(input.metaDescription)}">` +
      `<meta property="og:title" content="${esc(input.documentTitle)}">` +
      `<meta property="og:description" content="${esc(input.metaDescription)}">` +
      `<meta property="og:type" content="website">` +
      `<style>\n${input.css}\n${input.themeOverrideCss}${accentCss}${DISCLOSURE_CSS}${BOUND_IMAGE_CSS}</style>`;

    // The identity cleaning removed, rebuilt for the new product. Injected at
    // the END of <head> so the bundled stylesheet still wins over anything the
    // template left inline further up.
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${head}</head>`);
    } else if (/<body\b/i.test(html)) {
      html = html.replace(/<body\b/i, `<head>${head}</head><body`);
    } else {
      html = `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
    }

    return Result.ok({
      html,
      unresolved: bound.value.unresolved,
      removedOptional: bound.value.removedOptional,
    });
  }
}

/**
 * Repoints the template's own accent when it writes a literal colour instead of
 * a custom property.
 *
 * Emitted as an override rather than substituted through the bundle, because a
 * blind find-and-replace over the stylesheet would also catch the same hex used
 * as a border on an unrelated component. Attribute selectors on `style` and a
 * small set of conventional class names cover the buy button, which is the only
 * element the adaptation is meant to move.
 */
function literalAccentOverride(accent: { from: string; to: string }): string {
  const from = accent.from.toLowerCase();
  const to = accent.to;
  return (
    `\n/* controlled accent adaptation: ${from} → ${to} */\n` +
    `[style*="${from}"] { background-color: ${to} !important; }\n` +
    `a[href]:where(.btn, .button, .cta, [class*="btn"], [class*="button"], [class*="cta"]) ` +
    `{ background-color: ${to}; }\n`
  );
}

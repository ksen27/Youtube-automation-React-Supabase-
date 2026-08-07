/**
 * Turns the captured stylesheets into one self-contained bundle.
 *
 * Deliberately lexical rather than a full CSS parse. Every semantic question
 * about this stylesheet — what colour is that token, what font does this
 * heading resolve to, how wide is the content column — was already answered by
 * the browser during capture. What is left is rewriting the URLs so nothing
 * loads from the template owner's server, which is a string operation.
 *
 * That distinction is worth stating, because v1 tried to answer the semantic
 * questions with regexes and got them measurably wrong on the client's own
 * template: `var(--font-display)` contains no `serif` token, so the detector
 * called a DM Serif Display page sans-serif, and every generated page inherited
 * the mistake.
 */

import { repairFontStacks, type TypographyTokens } from '@ebook/core';

/** Matches a `url(...)` reference, capturing the quote style and the target. */
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

/**
 * Every remote asset the stylesheet references, absolutised.
 *
 * `data:` URIs are already self-contained and fragment-only references
 * (`url(#gradient)`) point inside the document, so neither is a download.
 */
export function extractCssUrls(css: string, baseUrl: string): string[] {
  const out = new Set<string>();
  for (const match of css.matchAll(URL_RE)) {
    const raw = (match[2] ?? '').trim();
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue;
    try {
      out.add(new URL(raw, baseUrl).href);
    } catch {
      // A malformed url() is the stylesheet's problem, not ours — it did not
      // load on the original page either.
    }
  }
  return [...out];
}

/**
 * Rewrites every remote reference to the local copy, and removes what cannot
 * be made local.
 *
 * A `url()` left pointing at the template's origin is the quiet version of the
 * worst defect this system can ship: the published page keeps loading images
 * from the site it was copied from, so the template owner sees the traffic and
 * can break the page — or swap the image — at will.
 */
export function rewriteCssUrls(css: string, map: Map<string, string>, baseUrl: string): string {
  return css.replace(URL_RE, (whole, _quote: string, raw = '') => {
    const target = String(raw).trim();
    if (!target || target.startsWith('data:') || target.startsWith('#')) return whole;
    let absolute: string;
    try {
      absolute = new URL(target, baseUrl).href;
    } catch {
      return 'none';
    }
    const local = map.get(absolute);
    // Unmapped means it could not be re-hosted. `none` is the honest result:
    // the decoration is missing, which is visible, rather than the page quietly
    // depending on someone else's server.
    return local ? `url("${local}")` : 'none';
  });
}

/**
 * Removes rules that would reach the network or import more CSS.
 *
 * `@font-face` blocks are dropped wholesale and re-added by the licence-gated
 * embedder: the captured ones point at the template's own font server, and a
 * face that cannot be legally redistributed must not be fetched at all — not
 * merely not deployed.
 */
export function stripRemoteRules(css: string): string {
  return stripFontFaces(css)
    .replace(/@import\s+[^;]+;/gi, '')
    .replace(/@charset\s+[^;]+;/gi, '');
}

/**
 * Removes `@font-face` blocks by balancing braces rather than by `[^}]*`.
 *
 * The naive pattern cannot span a nested `}`, so a face inside `@media` or
 * `@supports` had its own closing brace consumed and the enclosing at-rule left
 * orphaned — which silently corrupted every rule after it in the bundle.
 */
function stripFontFaces(css: string): string {
  let out = '';
  let last = 0;
  const re = /@font-face\s*\{/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    out += css.slice(last, match.index);
    last = i;
    re.lastIndex = i;
  }
  return out + css.slice(last);
}

/**
 * The widths the stylesheet actually branches on.
 *
 * Recorded rather than acted on. Nothing here changes the template's responsive
 * behaviour — that is the point — but knowing where it breaks tells the
 * verifier which widths are worth diffing beyond the standard three.
 */
export function breakpointsOf(css: string): number[] {
  const widths = new Set<number>();
  for (const match of css.matchAll(/@media[^{]*\(\s*(?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)\s*\)/gi)) {
    const value = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(value)) continue;
    // rem/em in a media query resolve against the ROOT font size, which is
    // 16px unless the user changed it — never against a component's font size.
    const px = unit === 'px' ? value : value * 16;
    if (px >= 240 && px <= 2560) widths.add(Math.round(px));
  }
  return [...widths].sort((a, b) => a - b);
}

export interface BundleResult {
  css: string;
  breakpoints: number[];
  /** URLs the stylesheet wanted that had no local copy. */
  unresolved: string[];
  /** Families the page asks for that no embedded face provides. */
  lostFamilies: string[];
}

/**
 * The whole bundling step: strip what must not survive, point every reference
 * at a local copy, prepend the legally embeddable fonts.
 */
export function bundleCss(input: {
  css: string;
  baseUrl: string;
  /** Absolute source URL → deployed site path, e.g. `assets/a1b2c3.png`. */
  assetMap: Map<string, string>;
  /** `@font-face` rules with their payload already inlined as data: URIs. */
  fontFaceCss: string;
  /** Families those rules provide. Declarations naming anything else fall back. */
  embeddedFamilies?: string[] | undefined;
  /** The measured typography, for choosing serif vs sans fallbacks. */
  typography?: TypographyTokens | undefined;
}): BundleResult {
  const stripped = stripRemoteRules(input.css);
  const wanted = extractCssUrls(stripped, input.baseUrl);
  const unresolved = wanted.filter((url) => !input.assetMap.has(url));
  const rewritten = rewriteCssUrls(stripped, input.assetMap, input.baseUrl);

  // Repaired AFTER stripping, so the declarations judged are the ones that
  // actually ship: a face whose @font-face was just removed must now fall back,
  // and one that embedded must not be touched.
  const repaired = repairFontStacks({
    css: rewritten,
    embeddedFamilies: input.embeddedFamilies ?? [],
    typography: input.typography ?? EMPTY_TYPOGRAPHY,
  });

  return {
    css: input.fontFaceCss ? `${input.fontFaceCss}\n${repaired.css}` : repaired.css,
    breakpoints: breakpointsOf(input.css),
    unresolved,
    lostFamilies: repaired.lostFamilies,
  };
}

const EMPTY_TYPOGRAPHY: TypographyTokens = { heading: null, body: null, familiesUsed: [] };

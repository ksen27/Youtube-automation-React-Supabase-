import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Result, type ReferencePage, type ReferencePageFetcher } from '@ebook/core';

/** Refuse anything larger — a reference page is text, not a download. */
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/**
 * Fetches and digests the reference sales page a book is meant to follow.
 *
 * The URL is user-supplied and this runs inside the worker's network, so every
 * hop is validated against the private address ranges before a request is made.
 * Without that, pasting `http://169.254.169.254/latest/meta-data/` into the
 * template field would have the worker read its own cloud credentials and hand
 * them to a model prompt.
 */
export class HttpReferencePageFetcher implements ReferencePageFetcher {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async fetch(url: string): Promise<Result<ReferencePage>> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const safe = await assertPublicUrl(current);
      if (safe.isFail()) return Result.fail(safe.error);

      let res: Response;
      try {
        res = await this.fetchImpl(current, {
          redirect: 'manual', // each hop is re-validated rather than followed blindly
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            // Identify honestly rather than impersonating a browser.
            'User-Agent': 'EbookGenerator/1.0 (+landing-page reference reader)',
            Accept: 'text/html,application/xhtml+xml',
          },
        });
      } catch (e) {
        return Result.fail(`Could not reach ${current}: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return Result.fail(`Redirect from ${current} had no destination`);
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) return Result.fail(`${current} returned ${res.status}`);

      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('html')) return Result.fail(`${current} is ${type || 'not HTML'}, not a web page`);

      const html = await readCapped(res);
      if (html.isFail()) return Result.fail(html.error);
      // Modern site builders (Lovable, Next, Vite) ship their entire palette in
      // linked stylesheets — the first real fetch of a reference read a page
      // whose <style> tags held nothing and misdetected every colour. Pull the
      // linked CSS in too, best-effort, so accent detection sees the real brand.
      const externalCss = await this.fetchLinkedStylesheets(current, html.value);
      return Result.ok(digest(current, html.value, externalCss));
    }
    return Result.fail(`Too many redirects from ${url}`);
  }

  /** Up to three linked stylesheets, size-capped, each SSRF-checked like the page. */
  private async fetchLinkedStylesheets(pageUrl: string, html: string): Promise<string> {
    const hrefs = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]
      .map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1])
      .filter((h): h is string => Boolean(h))
      .slice(0, 3);

    const sheets: string[] = [];
    for (const href of hrefs) {
      try {
        const absolute = new URL(href, pageUrl).toString();
        const safe = await assertPublicUrl(absolute);
        if (safe.isFail()) continue;
        const res = await this.fetchImpl(absolute, {
          redirect: 'follow',
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'EbookGenerator/1.0 (+landing-page reference reader)', Accept: 'text/css' },
        });
        if (!res.ok) continue;
        const body = await readCapped(res);
        if (body.isOk()) sheets.push(body.value);
      } catch {
        // Best-effort: a missing stylesheet degrades style detection, nothing else.
      }
    }
    return sheets.join('\n');
  }
}

// ── safety ───────────────────────────────────────────────────────────────────

/** Blocks loopback, link-local, private and CGNAT ranges in v4 and v6. */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique local
    if (v6.startsWith('fe80')) return true; // link local
    // IPv4-mapped (::ffff:127.0.0.1) must be judged on the embedded v4 address.
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  const p = ip.split('.').map(Number);
  const [a, b] = [p[0] ?? 0, p[1] ?? 0];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export async function assertPublicUrl(raw: string): Promise<Result<void>> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return Result.fail(`"${raw}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Result.fail('Only http and https reference pages are supported');
  }
  const host = parsed.hostname;
  // A literal IP needs no lookup; a name does, and we judge every address it
  // resolves to, since one public and one private answer is a known bypass.
  const addresses = isIP(host) ? [host] : await resolveAll(host);
  if (addresses.length === 0) return Result.fail(`Could not resolve ${host}`);
  if (addresses.some(isPrivateAddress)) {
    return Result.fail(`${host} resolves to a private address and will not be fetched`);
  }
  return Result.ok();
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    const records = await lookup(host, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

/** Reads the body but stops at the cap, so a huge page can't exhaust memory. */
async function readCapped(res: Response): Promise<Result<string>> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return Result.fail('Reference page is too large to read');
  const reader = res.body?.getReader();
  if (!reader) return Result.fail('Reference page had no body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return Result.fail('Reference page is too large to read');
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return Result.ok(new TextDecoder('utf-8').decode(merged));
}

// ── digest ───────────────────────────────────────────────────────────────────

/**
 * Reduces a page to the parts that describe its template: the heading skeleton,
 * the visible prose, and a handful of measurable style signals. Deliberately
 * regex-based rather than a DOM parse — this only needs the shape, and adding a
 * full HTML parser to read someone else's marketing page isn't worth the
 * dependency.
 */
export function digest(url: string, html: string, externalCss = ''): ReferencePage {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const headings: Array<{ level: number; text: string }> = [];
  for (const m of stripped.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = textOf(m[2] ?? '');
    if (text) headings.push({ level: Number(m[1]), text });
  }

  const css =
    [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? '').join('\n') + '\n' + externalCss;
  // Every style signal below is read from the DECLARATIONS, so a site that
  // routes its design through custom properties — `font-family: var(--serif)`,
  // `background: var(--paper)` — reads as a page that specifies nothing, and the
  // digest hands the layout call a blank where its design should be. That is
  // not an exotic shape: it is how most modern marketing pages are built.
  // Resolving once here means every heuristic downstream sees the real values
  // without having to know custom properties exist. `styleCss` below stays RAW:
  // it exists to carry @font-face rules, which have no variables in them.
  const resolvedCss = resolveCustomProperties(css);
  const text = textOf(stripped).slice(0, 12_000);
  const words = text.split(/\s+/).length || 1;
  const images = (stripped.match(/<img\b/gi) ?? []).length;

  return {
    url,
    title: textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || url,
    headings: headings.slice(0, 60),
    text,
    markup: pruneMarkup(html),
    // Capped: only the @font-face rules are wanted, and they sit near the top
    // of a stylesheet in practice.
    styleCss: css.slice(0, 200_000),
    style: {
      serifHeadings: serifHeadingsOf(resolvedCss),
      serifBody: serifBodyOf(resolvedCss),
      headingFont: fontNameFor(resolvedCss, /(^|[\s,>+~])h[1-3]\b/) ?? pickHeadingFont(resolvedCss),
      bodyFont: fontNameFor(resolvedCss, /(^|[\s,>+~])(body|html|:root)\b/),
      grounds: uniqueColors(resolvedCss).slice(0, 5),
      accent: pickAccent(resolvedCss),
      // "I." / "01" / "Step 1" leading a heading is the numbering signal.
      numberedSections: headings.filter((h) => /^([IVXLC]+[.·—]|\d{1,2}[.·—]|step\s+\d)/i.test(h.text)).length >= 2,
      imageDensity: Number(((images * 1000) / words).toFixed(2)),
      measurePx: readMeasure(resolvedCss),
    },
  };
}

/** The template markup budget: ~9k tokens — enough for a full landing page DOM. */
const MAX_MARKUP_CHARS = 36_000;

/**
 * The reference's body markup with everything that isn't TEMPLATE removed:
 * scripts, styles, svg path data, embedded data-URIs, framework attributes.
 * What survives — the element tree, class names (on utility-CSS sites the
 * classes ARE the design), structural attributes — is what "copy the template"
 * actually needs.
 */
export function pruneMarkup(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let m = bodyMatch?.[1] ?? html;
  m = m
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|iframe)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    // Icon innards are noise at template scale; keep the slot, drop the paths.
    .replace(/(<svg\b[^>]*>)[\s\S]*?(<\/svg>)/gi, '$1$2')
    // Embedded images can be megabytes of base64.
    .replace(/(src|href|srcset)="data:[^"]*"/gi, '$1="#"')
    .replace(/(<img\b[^>]*?)\bsrc="[^"]*"/gi, '$1src="#"')
    .replace(/\s(?:data-[\w-]+|aria-hidden|xmlns|viewBox|fill|stroke[\w-]*|d)="[^"]*"/gi, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (m.length > MAX_MARKUP_CHARS) {
    m = `${m.slice(0, MAX_MARKUP_CHARS)}\n<!-- TRUNCATED: the tail of the page was cut for size -->`;
  }
  return m;
}

function textOf(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Substitutes CSS custom properties into the declarations that use them.
 *
 * Every style heuristic in this file reads literal values out of declarations —
 * a font name, a background colour, a measure. A page written as
 * `font-family: var(--serif)` over `:root { --serif: Fraunces, … }` therefore
 * looks, to all of them, like a page that specifies nothing: `serifBody` falls
 * back to false, `bodyFont` to null, `grounds` to empty. The layout call is then
 * TOLD the reference has sans-serif body text and no grounds, in the imperative
 * ("USE EXACTLY THIS"), which overrides what the reference screenshots plainly
 * show. One page-wide pass here is what stops that.
 *
 * First definition of a name wins: the base `:root` block precedes the
 * dark-mode or media-query overrides that redefine it, and the base values are
 * the ones that describe the page as it is normally seen.
 */
export function resolveCustomProperties(css: string): string {
  if (!css.includes("var(")) return css;

  const values = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    const name = m[1] ?? "";
    if (!values.has(name)) values.set(name, (m[2] ?? "").trim());
  }

  // Custom properties routinely reference other custom properties. Each pass
  // resolves one level; the cap is what keeps a circular definition
  // (`--a: var(--b)` / `--b: var(--a)`) from spinning here forever.
  let out = css;
  for (let pass = 0; pass < 5 && out.includes("var("); pass += 1) {
    const next = out.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*([^(),]*))?\)/g,
      (whole, name: string, fallback?: string) => values.get(name) ?? fallback?.trim() ?? whole,
    );
    if (next === out) break;
    out = next;
  }
  return out;
}


/**
 * "sans-serif" contains "serif", so a naive substring test reads every
 * sans-serif page as serif — and then every generated page comes out in
 * Georgia. Drop the sans- declarations before looking for a serif family.
 */
function isSerifDeclaration(decl: string): boolean {
  // "sans-serif" contains "serif", so it has to be removed before the test.
  const cleaned = decl.toLowerCase().replace(/sans-serif/g, '');
  return /\bserif\b|georgia|times|garamond|playfair|iowan|baskerville|caslon/.test(cleaned);
}

function hasSerifFont(css: string): boolean {
  return (css.match(/font-family:[^;}]*/gi) ?? []).some(isSerifDeclaration);
}

/**
 * Whether rules matching a kind of selector set a serif face, or null when the
 * stylesheet says nothing about them.
 *
 * Headings and body text are asked separately because the PAIRING is the
 * design: these templates run a serif display face over sans-serif body copy.
 * A page-wide "is there any serif here" test answers yes and sets the small
 * text in Georgia too, which is the mismatch that shipped.
 */
function serifFor(css: string, selector: RegExp): boolean | null {
  const rules = css.match(/[^{}]+\{[^}]*\}/g) ?? [];
  const decls = rules
    .filter((rule) => selector.test((rule.split('{')[0] ?? '').toLowerCase()))
    .flatMap((rule) => rule.match(/font-family:[^;}]*/gi) ?? []);
  if (decls.length === 0) return null;
  return decls.some(isSerifDeclaration);
}

/** Headings specifically; falls back to the page-wide signal. */
function serifHeadingsOf(css: string): boolean {
  return serifFor(css, /(^|[\s,>+~])h[1-3]\b/) ?? hasSerifFont(css);
}

/**
 * Body text specifically. Falls back to NOT serif rather than to the page-wide
 * signal: a template with a serif display face and no explicit body rule is
 * far more likely to be running a sans default than to be serif throughout.
 */
function fontNameFor(css: string, selector: RegExp): string | null {
  const rules = css.match(/[^{}]+\{[^}]*\}/g) ?? [];
  for (const rule of rules) {
    if (!selector.test((rule.split('{')[0] ?? '').toLowerCase())) continue;
    const decl = /font-family:\s*([^;}]+)/i.exec(rule);
    const first = decl?.[1]?.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
    if (first && !GENERIC_FONTS.has(first.toLowerCase()) && !first.startsWith('var(')) return first;
  }
  return null;
}

function serifBodyOf(css: string): boolean {
  return serifFor(css, /(^|[\s,>+~])(body|html|:root)\b/) ?? false;
}

const GENERIC_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
  'ui-sans-serif', 'ui-monospace', 'inherit', 'initial', 'unset', '-apple-system',
  'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica', 'helvetica neue', 'arial',
]);

/**
 * The most-used NAMED typeface — the reference's actual display face, which is
 * most of what makes its typography recognisable. Generic stacks and the
 * ubiquitous system faces are skipped: "Playfair Display" is a signal,
 * "Helvetica" is noise.
 */
function pickHeadingFont(css: string): string | null {
  const counts = new Map<string, number>();
  for (const decl of css.matchAll(/font-family:\s*([^;}]+)/gi)) {
    for (const raw of (decl[1] ?? '').split(',')) {
      const name = raw.trim().replace(/^["']|["']$/g, '');
      if (!name || name.startsWith('var(')) continue;
      if (GENERIC_FONTS.has(name.toLowerCase())) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function uniqueColors(css: string): string[] {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/background(?:-color)?:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\))/gi)) {
    const key = (m[1] ?? '').toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/** The most-repeated saturated colour — on a sales page that is the CTA. */
function pickAccent(css: string): string | null {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const hex = `#${(m[1] ?? '').toLowerCase()}`;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread < 40) continue; // neutral — a ground or a text colour, not an accent
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? null;
}

/** A qualifying content width: wide enough to be a column, narrow enough to be one. */
const inMeasureRange = (n: number) => n >= 480 && n <= 1400;

/**
 * The width of the reference's page container.
 *
 * Identified by what a centred container DOES — a max-width plus an auto
 * inline margin — rather than by how often its value repeats. Counting was the
 * previous rule and it loses on any page with a real type system: the container
 * is declared once, while the narrow measures on the prose INSIDE it are
 * declared on every text block. vintagelifestyleusa.com resolves to
 * 760×3, 780×3, 560×2, 640×2 … and 1180×1 — so the mode returned 760 and the
 * page was built at 64% of the reference's true 1180px column, every section
 * short by 420px.
 *
 * Falls back to the old mode when no rule centres itself, which is the case on
 * pages that centre with flex or grid instead.
 */
function readMeasure(css: string): number | null {
  // `margin: 0 auto`, `margin-inline: auto`, `margin: 0 auto 40px` — the pair
  // has to be read from the SAME rule, so match each rule and inspect its body.
  const centred = (css.match(/[^{}]+\{[^}]*\}/g) ?? [])
    .filter((rule) => /margin(-inline)?\s*:[^;}]*\bauto\b/i.test(rule))
    .map((rule) => Number(/max-width:\s*(\d{3,4})px/i.exec(rule)?.[1] ?? 0))
    .filter(inMeasureRange);
  // Widest wins: a page that centres both a container and an inner prose column
  // matches twice, and the container is the outer of the two.
  if (centred.length > 0) return Math.max(...centred);

  const widths = [...css.matchAll(/max-width:\s*(\d{3,4})px/gi)]
    .map((m) => Number(m[1]))
    .filter(inMeasureRange);
  if (widths.length === 0) return null;
  const counts = new Map<number, number>();
  for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

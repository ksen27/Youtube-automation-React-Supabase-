import { Result } from '../../domain/shared/Result';
import {
  CORE_PLACEHOLDERS,
  TOKEN_RE,
  kindFor,
  splitRepeaterField,
  type PlaceholderKind,
} from '../../domain/landing/PlaceholderVocabulary';

/**
 * Substitutes one book's content into a parameterised template.
 *
 * Escaping is a property of the token's KIND, not of the call site. That is the
 * whole point of this module: the previous pipeline made escaping a call-site
 * decision and grew the hole you would expect — `fillCopySlots` wrote model
 * prose into markup raw while every other string in the codebase went through
 * `esc()`, so an `&` or a `<` in a headline corrupted the page.
 *
 * Nothing here parses HTML. It does not need to: the tokens were placed by a
 * DOM operation that already knows each one's context, so the kind carries the
 * context with it.
 */

/**
 * One item in a repeating region.
 *
 * A field is normally a string. It may instead be a NESTED list, for a region
 * whose items each contain their own repeating region — three book cards, each
 * with its own bullet list, which is how the reference template presents a set.
 * The nested list is keyed by the inner region's own name, e.g.
 * `{ title: 'Book One', BENEFITS: [{ title: '…' }] }`.
 */
export type RepeatItem = Record<string, string | Array<Record<string, string>>>;

export interface BindValues {
  /** Single-value tokens, by key. */
  scalars: Record<string, string>;
  /** Repeating regions: one record per item, keyed by field name. */
  repeats: Record<string, RepeatItem[]>;
  /**
   * Values for `html`-kind tokens.
   *
   * Separate from `scalars` on purpose. An `html` token writes unescaped markup,
   * so it must be impossible to route model output into one by accident —
   * putting them in their own map means doing so takes a deliberate act rather
   * than a typo in a key name.
   */
  trustedHtml?: Record<string, string> | undefined;
}

export interface BindOptions {
  /**
   * Tokens whose absence is fatal rather than merely empty. Normally the
   * required core vocabulary; passed in so a preview can bind without a
   * checkout URL.
   */
  required?: readonly string[] | undefined;
}

export interface BindOutcome {
  html: string;
  /** Keys the template asked for that had no value. */
  unresolved: string[];
  /** Optional image nodes removed because no value was supplied. */
  removedOptional: string[];
}

/** Escapes for a text node. Quotes are harmless here and left readable. */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes for a quoted attribute value. */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A `src` must resolve to something the deploy actually ships. A remote URL
 * would make the published page depend on someone else's server — and on the
 * template owner's server in particular, which is how a cloned page ends up
 * hotlinking the site it was copied from.
 */
function safeSrc(value: string): string | null {
  const v = value.trim();
  if (v.startsWith('assets/') || v.startsWith('./assets/')) return v;
  if (v.startsWith('data:image/')) return v;
  return null;
}

/**
 * An `href` must be https. The checkout URL is the one link on the page that
 * moves money, and it is written in verbatim — never composed, never rewritten.
 */
function safeHref(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!/^https:\/\//i.test(v)) return null;
  return v;
}

function renderScalar(key: string, kind: PlaceholderKind, raw: string): Result<string, string> {
  switch (kind) {
    case 'text':
      return Result.ok(escapeText(raw));
    case 'alt':
      return Result.ok(escapeAttr(raw));
    case 'src': {
      const safe = safeSrc(raw);
      return safe
        ? Result.ok(escapeAttr(safe))
        : Result.fail(`{{${key}}} must be a local asset path or a data: image, not "${raw.slice(0, 60)}".`);
    }
    case 'href': {
      const safe = safeHref(raw);
      return safe
        ? Result.ok(escapeAttr(safe))
        : Result.fail(`{{${key}}} must be an https URL, not "${raw.slice(0, 60)}".`);
    }
    case 'html':
      // Reached only for a key resolved from `trustedHtml`; see bind().
      return Result.ok(raw);
  }
}

/** Opens a repeating region. */
const REPEAT_OPEN = /<template\s+data-repeat="([^"]+)"\s*>/;
/** Either side of a template tag, for depth counting. */
const TEMPLATE_TAG = /<template[\s>][^>]*>|<\/template\s*>/g;

/**
 * Finds the OUTERMOST repeating region, with its matching close tag.
 *
 * Outermost, not innermost — and that distinction is the whole bug this
 * replaced. The previous matcher deliberately refused to span a nested
 * `<template>`, so an inner region was expanded FIRST, against the page-level
 * list, and every card of the outer region then received the same inner list.
 * On the reference template that is three book cards showing book one's bullets
 * three times: the exact "one book's content shown three times" defect the rest
 * of the system is built to prevent.
 *
 * Expanding outermost-first is what lets each item carry its own nested list.
 */
function findOutermostRepeat(html: string): { key: string; inner: string; start: number; end: number } | null {
  const first = REPEAT_OPEN.exec(html);
  if (!first) return null;

  const key = first[1] ?? '';
  const innerStart = first.index + first[0].length;

  // Walk forward counting nested templates, so the close we stop at is OURS.
  TEMPLATE_TAG.lastIndex = innerStart;
  let depth = 1;
  for (let m = TEMPLATE_TAG.exec(html); m; m = TEMPLATE_TAG.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      return { key, inner: html.slice(innerStart, m.index), start: first.index, end: m.index + m[0].length };
    }
  }
  // Unbalanced markup: take the rest of the document rather than looping.
  return { key, inner: html.slice(innerStart), start: first.index, end: html.length };
}

/** The nested list an item carries for an inner region, if it carries one. */
function nestedListOf(item: RepeatItem, key: string): RepeatItem[] | null {
  const value = item[key];
  return Array.isArray(value) ? value : null;
}

function expandRepeaters(
  html: string,
  repeats: Record<string, RepeatItem[]>,
  errors: string[],
  unresolved: string[],
  /**
   * Set while expanding ONE item of an outer region. An inner region then reads
   * that item's own list; falling back to the page-level list is only safe when
   * the outer region has a single item, because with more than one that is
   * exactly how the same content ends up under every card.
   */
  parent?: { item: RepeatItem; siblings: number } | undefined,
): string {
  let out = html;
  // Bounded: each pass consumes one region, and unbalanced markup that somehow
  // survived would otherwise spin here forever.
  for (let guard = 0; guard < 500; guard++) {
    const region = findOutermostRepeat(out);
    if (!region) break;

    const fromParent = parent ? nestedListOf(parent.item, region.key) : null;
    const items =
      fromParent ?? (parent && parent.siblings > 1 ? null : (repeats[region.key] ?? null));

    if (!items || items.length === 0) {
      // The region disappears rather than rendering an empty card. Recorded so
      // the fidelity report can say a section came back thinner than the
      // template's, instead of it being found on the published page.
      unresolved.push(region.key);
      out = out.slice(0, region.start) + out.slice(region.end);
      continue;
    }

    const rendered = items
      .map((item) => {
        // Nested regions first, against THIS item, before its own fields are
        // substituted — an inner token must not be taken for an outer one.
        const withNested = region.inner.includes('<template')
          ? expandRepeaters(region.inner, repeats, errors, unresolved, { item, siblings: items.length })
          : region.inner;

        return withNested.replace(TOKEN_RE, (token: string, tokenKey = '') => {
          const field = splitRepeaterField(tokenKey);
          // A token from a different region inside this one is a mapping bug,
          // not something to paper over — leave it for the residual-token check.
          if (!field || field.key !== region.key) return token;
          const kind = kindFor(tokenKey) ?? 'text';
          const raw = item[field.field];
          if (typeof raw !== 'string' || raw === '') {
            unresolved.push(tokenKey);
            // Same treatment a scalar gets: an unresolved href must be inert
            // rather than empty. An empty href reloads the page when clicked,
            // which on an offer card reads as a buy button that does nothing.
            return kind === 'href' ? '#' : '';
          }
          const value = renderScalar(tokenKey, kind, raw);
          if (value.isFail()) {
            errors.push(value.error);
            return '';
          }
          return value.value;
        });
      })
      .join('');

    out = out.slice(0, region.start) + rendered + out.slice(region.end);
  }
  return out;
}

/**
 * Drops void elements marked optional when no value was supplied.
 *
 * Only void elements (`<img>`, `<source>`) are handled, and that is all the
 * real cases need: the optional slots are the author portrait and the brand
 * mark, both `<img>`. A non-void optional node blanks its text instead — noted
 * here because it is a real limitation rather than an oversight.
 */
function dropOptional(html: string, key: string): { html: string; removed: boolean } {
  const re = new RegExp(`<(img|source)\\b[^>]*\\bdata-optional="${key}"[^>]*>`, 'gi');
  const next = html.replace(re, '');
  return { html: next, removed: next !== html };
}

export function bindTemplate(html: string, values: BindValues, options: BindOptions = {}): Result<BindOutcome, string[]> {
  const errors: string[] = [];
  const unresolved: string[] = [];
  const removedOptional: string[] = [];
  const required = new Set(options.required ?? []);

  let out = expandRepeaters(html, values.repeats, errors, unresolved);

  // Optional images with no value are removed BEFORE substitution, so their
  // src token never has to resolve to a placeholder image.
  for (const [key, spec] of Object.entries(CORE_PLACEHOLDERS)) {
    if (spec.kind !== 'src' || spec.required) continue;
    if (values.scalars[key]) continue;
    const dropped = dropOptional(out, key);
    if (dropped.removed) removedOptional.push(key);
    out = dropped.html;
  }

  out = out.replace(TOKEN_RE, (token: string, key = '') => {
    const kind = kindFor(key);
    if (!kind) {
      errors.push(`Unknown token ${token} in the template.`);
      return '';
    }

    // An `html` token reads ONLY from the trusted map. A key that appears in
    // `scalars` instead is ignored rather than promoted — that asymmetry is
    // what makes routing model prose into unescaped markup impossible.
    if (kind === 'html') {
      const trusted = values.trustedHtml?.[key];
      if (trusted === undefined) {
        if (required.has(key)) errors.push(`{{${key}}} is required and is system-rendered, but no value was supplied.`);
        unresolved.push(key);
        return '';
      }
      return trusted;
    }

    const raw = values.scalars[key];
    if (raw === undefined || raw === '') {
      if (required.has(key)) errors.push(`{{${key}}} is required but no value was supplied.`);
      unresolved.push(key);
      // An unresolved href would otherwise leave `href=""`, which reloads the
      // page when clicked. `#` is inert.
      return kind === 'href' ? '#' : '';
    }

    const rendered = renderScalar(key, kind, raw);
    if (rendered.isFail()) {
      errors.push(rendered.error);
      return '';
    }
    return rendered.value;
  });

  // Extraction-time scaffolding never reaches a buyer.
  out = out.replace(/\s+data-tpl="[^"]*"/g, '').replace(/\s+data-optional="[^"]*"/g, '');

  const residual = out.match(/\{\{[^}]{0,60}\}\}/);
  if (residual) errors.push(`A token survived binding and would ship to a buyer: ${residual[0]}`);

  if (errors.length > 0) return Result.fail(errors);
  return Result.ok({ html: out, unresolved: [...new Set(unresolved)], removedOptional });
}

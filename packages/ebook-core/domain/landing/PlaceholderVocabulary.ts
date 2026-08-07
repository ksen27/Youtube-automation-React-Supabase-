/**
 * The tokens a cloned template may carry, and what each one is allowed to do.
 *
 * This is the whole vocabulary the annotation model gets to work with. It never
 * writes markup — it labels existing nodes with one of these names — so this
 * file is the complete surface across which model output can affect a published
 * page.
 *
 * `kind` is the important column. Escaping, and whether a value may come from a
 * model at all, are properties of the KIND rather than of the call site. The
 * previous pipeline made that a call-site decision and grew exactly the hole you
 * would expect: `fillCopySlots` in pageContract.ts substituted model prose into
 * markup with no escaping while every other string in the codebase went through
 * `esc()`.
 */

/**
 * How a token's value is written into the document.
 *
 * - `text` — replaces the element's text content. HTML-escaped.
 * - `html` — replaces the element's inner markup. NEVER model output; only
 *   system-rendered blocks (the legal footer) use this.
 * - `src`  — an image URL attribute. Must resolve to a local `assets/…` path or
 *   a `data:` URI; a remote URL is refused.
 * - `href` — a link attribute. `https:` only, and the anchor is forced to
 *   `rel="noopener nofollow"`.
 * - `alt`  — an image's alternative text attribute.
 */
export type PlaceholderKind = 'text' | 'html' | 'src' | 'href' | 'alt';

/** Who supplies a token's value. */
export type PlaceholderSource =
  /** Written by the copy model, within the slot's measured character budget. */
  | 'copy'
  /** Read from project settings or book data. Never model output. */
  | 'system';

export interface PlaceholderSpec {
  kind: PlaceholderKind;
  source: PlaceholderSource;
  /** A page without this is not a sales page; extraction fails without it. */
  required: boolean;
  /** What belongs here — shown to the annotation model and in the review UI. */
  purpose: string;
}

/**
 * The core vocabulary. Fixed, validated, and small on purpose: every entry here
 * is something every sales page has, so a template missing a required one is
 * almost certainly a failed extraction rather than an unusual template.
 */
export const CORE_PLACEHOLDERS: Record<string, PlaceholderSpec> = {
  HERO_TITLE: { kind: 'text', source: 'copy', required: true, purpose: 'The main headline, above the fold.' },
  HERO_SUBTITLE: {
    kind: 'text',
    source: 'copy',
    // Not every template has one. A page whose hero is a single line is a
    // design choice, not a broken extraction.
    required: false,
    purpose: 'The supporting line under the headline.',
  },
  BOOK_COVER: { kind: 'src', source: 'system', required: true, purpose: "The book's cover artwork." },
  BOOK_COVER_ALT: { kind: 'alt', source: 'system', required: false, purpose: 'Alt text for the cover image.' },
  // Unlabelled, the button keeps the template's own wording ("Get instant
  // access"), which is generic enough to be harmless. Not worth failing over.
  CTA_TEXT: { kind: 'text', source: 'copy', required: false, purpose: 'The buy button label.' },
  CHECKOUT_URL: {
    kind: 'href',
    source: 'system',
    required: true,
    purpose: "The seller's payment link. Never composed or rewritten — written in verbatim.",
  },
  /**
   * Not structurally required — a template may not show a price at all — but its
   * absence is checked separately and much more carefully than a missing label.
   * If the template DOES show a price and no node was labelled, the page ships
   * the template owner's price, which is a commercial defect rather than a
   * cosmetic one. See the residual-price check in templateContract.
   */
  PRICE: { kind: 'text', source: 'system', required: false, purpose: 'The price, formatted with its currency.' },
  COMPARE_AT_PRICE: {
    kind: 'text',
    source: 'system',
    required: false,
    purpose: 'The struck-through "was" price, when one is set.',
  },
  BRAND_NAME: {
    kind: 'text',
    source: 'system',
    required: true,
    purpose: 'The site/brand name in the masthead and footer.',
  },
  BRAND_LOGO: { kind: 'src', source: 'system', required: false, purpose: "The channel's avatar as a brand mark." },
  AUTHOR_NAME: { kind: 'text', source: 'system', required: false, purpose: "The author's name." },
  AUTHOR_IMAGE: { kind: 'src', source: 'system', required: false, purpose: "The seller's uploaded portrait." },
  AUTHOR_BIO: { kind: 'text', source: 'copy', required: false, purpose: 'A short paragraph about the author.' },
  GUARANTEE_DAYS: { kind: 'text', source: 'system', required: false, purpose: 'The refund window, in days.' },
  FOOTER_LEGAL: {
    kind: 'html',
    source: 'system',
    required: true,
    purpose:
      "The disclaimer block. System-rendered: cloning the template owner's refund policy would publish a " +
      'contractual claim the seller never made.',
  },
  PAGE_TITLE: { kind: 'text', source: 'copy', required: false, purpose: 'The document <title>.' },
  META_DESCRIPTION: { kind: 'text', source: 'copy', required: false, purpose: 'The meta description.' },
};

/**
 * Repeating regions. The value is a list, and the template carries one item's
 * markup which is cloned per entry.
 *
 * Each declares the fields an item may contain; a repeater item's tokens are
 * `{{KEY.field}}`, e.g. `{{BENEFITS.title}}`.
 */
export const REPEATER_PLACEHOLDERS: Record<string, { fields: string[]; source: PlaceholderSource; purpose: string }> = {
  BENEFITS: {
    fields: ['title', 'body'],
    source: 'copy',
    purpose: 'One card per benefit of owning the book.',
  },
  FAQ_ITEMS: {
    fields: ['question', 'answer'],
    source: 'copy',
    purpose: 'One entry per frequently asked question.',
  },
  CONTENTS_ITEMS: {
    fields: ['title', 'body'],
    source: 'copy',
    purpose: "One entry per chapter or section in the book's table of contents.",
  },
  TESTIMONIALS: {
    fields: ['quote', 'author'],
    source: 'system',
    purpose:
      'Real quotes supplied by the seller. Never model-written — an invented endorsement is a fabricated ' +
      'claim about a real person, so this renders nothing until the seller provides one.',
  },
  OFFER_ITEMS: {
    fields: ['title', 'subtitle', 'price', 'checkoutUrl', 'coverSrc'],
    source: 'system',
    purpose:
      "One card per product. Every field is read from ONE product record in a single pass, so a checkout " +
      'link cannot land under the wrong cover on a multi-book page.',
  },
};

/**
 * A token for a section the core vocabulary does not anticipate — "Where the
 * money goes", "Choose your level", "The method".
 *
 * The core list alone cannot describe an arbitrary template, and a template
 * whose extra sections have nowhere to put content is exactly the gap the old
 * `LandingCopy.templateSections` field was invented for and never closed
 * (its `referenceSections` input was never supplied by any caller). Extended
 * slots are minted mechanically from the annotation map, so supporting a new
 * template shape needs no schema change.
 *
 * Shape: `SECTION:<tplId>.<field>` → `{{SECTION:n47.heading}}`.
 */
export const EXTENDED_PREFIX = 'SECTION:';

/** Matches any token in a parameterised template and captures its key. */
export const TOKEN_RE = /\{\{([A-Za-z0-9_.:-]+)\}\}/g;

export function token(key: string): string {
  return `{{${key}}}`;
}

export function isExtendedKey(key: string): boolean {
  return key.startsWith(EXTENDED_PREFIX);
}

/** `BENEFITS.title` → `{ key: 'BENEFITS', field: 'title' }`; otherwise null. */
export function splitRepeaterField(key: string): { key: string; field: string } | null {
  if (isExtendedKey(key)) return null;
  const dot = key.indexOf('.');
  if (dot <= 0) return null;
  const head = key.slice(0, dot);
  const field = key.slice(dot + 1);
  if (!REPEATER_PLACEHOLDERS[head] || !field) return null;
  return { key: head, field };
}

/**
 * The kind for any key, whether core, repeater field or extended.
 *
 * Extended slots are always `text`: they hold prose for a section our schema
 * never anticipated, and letting an unanticipated slot write an `href` or a
 * `src` would hand the model exactly the authority this design removes.
 */
export function kindFor(key: string): PlaceholderKind | null {
  const core = CORE_PLACEHOLDERS[key];
  if (core) return core.kind;
  if (isExtendedKey(key)) return 'text';

  const repeated = splitRepeaterField(key);
  if (!repeated) return null;
  if (!REPEATER_PLACEHOLDERS[repeated.key]?.fields.includes(repeated.field)) return null;
  // The offer grid is the one repeater carrying links and images, and both are
  // system-supplied per product record.
  if (repeated.field === 'checkoutUrl') return 'href';
  if (repeated.field === 'coverSrc') return 'src';
  return 'text';
}

export function sourceFor(key: string): PlaceholderSource | null {
  const core = CORE_PLACEHOLDERS[key];
  if (core) return core.source;
  if (isExtendedKey(key)) return 'copy';
  const repeated = splitRepeaterField(key);
  if (!repeated) return null;
  return REPEATER_PLACEHOLDERS[repeated.key]?.source ?? null;
}

/** Every core token that a template must carry to be usable. */
export const REQUIRED_PLACEHOLDERS: readonly string[] = Object.entries(CORE_PLACEHOLDERS)
  .filter(([, spec]) => spec.required)
  .map(([key]) => key);

/** Keys the copy model is asked to write. Everything else is system-supplied. */
export function isCopyKey(key: string): boolean {
  return sourceFor(key) === 'copy';
}

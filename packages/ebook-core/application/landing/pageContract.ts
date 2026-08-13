import { Result } from '../../domain/shared/Result';

/**
 * The contract a model-generated landing page must satisfy before it is allowed
 * to become a draft.
 *
 * The model writes the LAYOUT — markup and CSS shaped after the reference page
 * the client nominated. It does not write anything that carries risk:
 *
 *   - money and links arrive as placeholders we substitute afterwards, so a
 *     mangled checkout URL is impossible rather than merely unlikely;
 *   - colours must come from the cover-derived palette variables, so contrast
 *     is guaranteed by construction instead of validated after the fact;
 *   - scripts, embeds, forms and external resources are refused outright.
 *
 * Everything here is mechanical and reported as specific, fixable errors — they
 * are fed straight back to the model for one repair attempt.
 */

/** Substituted with real markup after generation. The model only positions them. */
export const PLACEHOLDERS = {
  cta: '{{CTA_BUTTON}}',
  price: '{{PRICE}}',
  cover: '{{COVER}}',
  guarantee: '{{GUARANTEE}}',
  paymentMarks: '{{PAYMENT_MARKS}}',
  testimonials: '{{TESTIMONIALS}}',
  contents: '{{CONTENTS}}',
  /**
   * The same chapters as a COMPACT LIST — one line each, no cards, no key
   * points.
   *
   * `{{CONTENTS}}` always expands to a three-column card grid, so a reference
   * that presents "what you get" as a short priced stack still came back with a
   * wall of chapter cards: the section existed on our page in a shape the
   * reference never had, and it pushed the offer below two screens of index.
   * The layout can now match what it is looking at instead of being handed one
   * fixed treatment.
   */
  contentsList: '{{CONTENTS_LIST}}',
  legal: '{{FOOTER_LEGAL}}',
  /** The channel avatar as a small round brand mark. Optional. */
  logo: '{{LOGO}}',
  /**
   * A photograph of the author, uploaded by the seller. The reference pages put
   * a real portrait in the hero and again beside the author bio; without this
   * placeholder a generated layout has no image to place there but the cover,
   * which is why those pages came back showing the book twice.
   *
   * Renders to nothing when no photo was uploaded, so a layout must never put a
   * heading or frame around it that would be left empty.
   */
  authorPhoto: '{{AUTHOR_PHOTO}}',
  /**
   * The complete offer section — one card per book plus the bundle, each with
   * its OWN price and checkout link. System-rendered: with up to four different
   * buy links on one page, the model never decides which link goes where.
   */
  offerGrid: '{{OFFER_GRID}}',
  /**
   * Every book's cover together, as the reference's hero shows the set.
   *
   * {{COVER}} renders the FEATURED book and nothing else — its later
   * occurrences are deliberately lightweight copies of the first image — so
   * repeating it to suggest a collection produces the same book three times,
   * which is exactly what shipped. This is the only way to show three books.
   */
  coverStack: '{{COVER_STACK}}',
  /**
   * The "what's inside" breakdown, one block per book: its OWN cover, its own
   * title, its own contents.
   *
   * System-rendered for the same reason as the offer grid. Asked to build this
   * from the copy, the model wrote one book's chapters as three ranges —
   * "chapters 1-5", "6-10", "11-14" — and showed the same cover beside each,
   * because pairing a cover with the book it belongs to is bookkeeping, not
   * layout. Here each block reads one product record, so it cannot mismatch.
   */
  bookBreakdown: '{{BOOK_BREAKDOWN}}',
} as const;

/** A page without these is not a sales page. */
const REQUIRED_PLACEHOLDERS = [PLACEHOLDERS.cta, PLACEHOLDERS.price, PLACEHOLDERS.cover, PLACEHOLDERS.legal];

/**
 * Marked with `data-section` so the structure can be checked mechanically.
 *
 * Only two, and deliberately: a page needs somewhere to open and somewhere to
 * ask for the sale, and both are structural rather than editorial. `inside` and
 * `faq` used to be here too, which meant a layout following a reference that
 * has neither was FORCED to invent them — a chapter grid and a questions block
 * appeared on pages whose reference had no such thing, and the page stopped
 * reading as a copy of that site. What a section contains is still checked
 * (a buy button, a price, a cover, the legal line are all required tokens);
 * how many sections there are is the reference's business.
 */
const REQUIRED_SECTIONS = ['hero', 'order'] as const;

/** Palette variables the page may reference. Anything else is a raw colour. */
export const PALETTE_VARS = [
  '--bg', '--surface', '--border', '--text', '--muted', '--heading',
  '--accent', '--accent-contrast', '--deep', '--on-deep', '--on-deep-muted',
  '--deep-border', '--accent-on-deep', '--tint',
] as const;

const MAX_CSS_BYTES = 120_000;
const MAX_HTML_BYTES = 160_000;

/**
 * A slot in a stored layout where one book's copy goes.
 *
 * Layouts are captured once per reference and reused by every book that follows
 * that template, so the markup cannot contain any book's words — it contains
 * these instead, and the copy call fills them per book.
 */
export interface CopySlot {
  /** Token key, e.g. "hero.headline" → {{COPY:hero.headline}}. */
  key: string;
  /** What belongs here, written for the copywriter. */
  purpose: string;
  /** Soft ceiling so long prose cannot break the layout it was written for. */
  maxChars: number;
}

/** Matches a copy slot token and captures its key. */
export const COPY_SLOT_RE = /\{\{COPY:([a-z0-9][a-z0-9._-]*)\}\}/g;

export function copySlotToken(key: string): string {
  return `{{COPY:${key}}}`;
}

export interface GeneratedPage {
  css: string;
  bodyHtml: string;
  /**
   * Present when the page is a REUSABLE layout rather than a finished one.
   * Its markup then carries {{COPY:…}} tokens in place of prose.
   */
  slots?: CopySlot[];
}

/**
 * Validates a generated page. Returns every problem at once rather than the
 * first — the whole list goes back to the model, so one repair round can fix
 * everything instead of uncovering the next fault each time.
 */
export interface ValidateOptions {
  /**
   * Copy that must appear verbatim. The layout call is given already-approved
   * prose and told to place it, not rewrite it — this is what stops a layout
   * retry from quietly re-authoring claims that were validated in an earlier
   * step.
   */
  requiredText?: string[];
  /**
   * How many products the page sells. More than one → the offer grid becomes
   * mandatory: it is the only element that carries each book's own buy link.
   */
  productCount?: number;
  /**
   * Validate this as a REUSABLE layout: prose must be replaced by {{COPY:…}}
   * slots, and the declared manifest must match the tokens actually used. A
   * layout with a book's words baked in cannot be reused by the next book, and
   * that is the whole point of storing it.
   */
  expectSlots?: boolean;
  /** Minimum slots a layout must declare, so a near-empty one is rejected. */
  minSlots?: number;
}

/**
 * Slots every layout must declare. The system reads these directly — the CTA's
 * label, the document title and the meta description are built from them — so a
 * layout without them produces a page with an empty <title>.
 */
export const REQUIRED_SLOT_KEYS = ['hero.headline', 'hero.subheadline', 'cta.label'] as const;

/**
 * Required slots whose text the SYSTEM renders, so they are declared but must
 * NOT be placed in the markup.
 *
 * `cta.label` is the whole list: it is written into the buy button by
 * {{CTA_BUTTON}}. Requiring it to be declared AND placed — as the general rule
 * does — left no passing answer: omit it and the required check fails, declare
 * it and the placement check fails, place it and the label prints twice as
 * loose text beside the button.
 */
export const SYSTEM_SLOT_KEYS: readonly string[] = ['cta.label'];

export function validateGeneratedPage(page: GeneratedPage, options: ValidateOptions = {}): Result<void, string[]> {
  const errors: string[] = [];
  const { css, bodyHtml } = page;
  const all = `${css}\n${bodyHtml}`;

  for (const text of options.requiredText ?? []) {
    // Compare on collapsed whitespace: wrapping the markup is fine, editing the
    // words is not.
    if (!collapse(bodyHtml).includes(collapse(text))) {
      errors.push(`Copy was altered. This must appear verbatim: "${truncateForError(text)}"`);
    }
  }

  if (options.expectSlots) errors.push(...slotErrors(page, options.minSlots ?? 8));

  if (css.length > MAX_CSS_BYTES) errors.push(`CSS is ${css.length} bytes; the limit is ${MAX_CSS_BYTES}.`);
  if (bodyHtml.length > MAX_HTML_BYTES) {
    errors.push(`HTML is ${bodyHtml.length} bytes; the limit is ${MAX_HTML_BYTES}.`);
  }

  // ── placeholders ──
  const productCount = options.productCount ?? 1;
  for (const token of REQUIRED_PLACEHOLDERS) {
    if (bodyHtml.includes(token)) continue;
    // {{COVER}} is required because a sales page must show the product. On a
    // MULTI-BOOK page it is not the only way to do that, and not the best one:
    // {{COVER}} always renders the featured book, so the prompt tells the model
    // to use {{COVER_STACK}} for the set and {{BOOK_BREAKDOWN}} for the
    // per-book section, and describes {{COVER}} as being for "where the
    // template shows a single book" — which on a three-book page is nowhere.
    //
    // A layout that followed those instructions exactly was then rejected for
    // omitting {{COVER}}, and the repair round could only repeat the demand
    // that contradicted them. All three attempts failed the same way and every
    // three-book page fell back to the built-in template, which is how a page
    // with no relationship to the client's template reached them.
    //
    // The requirement is that a buyer SEES THE BOOKS. Either of these does that
    // for a set, and the rule below already forces at least one of them to be
    // present when productCount > 1.
    const coveredByASet =
      token === PLACEHOLDERS.cover &&
      productCount > 1 &&
      (bodyHtml.includes(PLACEHOLDERS.coverStack) || bodyHtml.includes(PLACEHOLDERS.bookBreakdown));
    if (coveredByASet) continue;
    errors.push(`Missing required placeholder ${token}.`);
  }
  if (occurrences(bodyHtml, PLACEHOLDERS.legal) > 1) {
    errors.push(`${PLACEHOLDERS.legal} must appear exactly once, in the footer.`);
  }
  if (productCount > 1 && !bodyHtml.includes(PLACEHOLDERS.offerGrid)) {
    errors.push(
      `This page sells ${options.productCount} books; ${PLACEHOLDERS.offerGrid} is required — it is the only ` +
        "element carrying each book's own buy link.",
    );
  }
  if (occurrences(bodyHtml, PLACEHOLDERS.offerGrid) > 1) {
    errors.push(`${PLACEHOLDERS.offerGrid} may appear at most once.`);
  }
  if (occurrences(bodyHtml, PLACEHOLDERS.logo) > 3) {
    errors.push(`${PLACEHOLDERS.logo} may appear at most 3 times.`);
  }
  // The hero portrait and the author-bio portrait; more than that and the same
  // face is repeating down the page.
  if (occurrences(bodyHtml, PLACEHOLDERS.authorPhoto) > 2) {
    errors.push(`${PLACEHOLDERS.authorPhoto} may appear at most 2 times.`);
  }
  // Caps sized for template copying — a reference page legitimately repeats its
  // cover and buy button many times. The caps only stop true runaway repetition.
  if (occurrences(bodyHtml, PLACEHOLDERS.cover) > 6) {
    errors.push(`${PLACEHOLDERS.cover} may appear at most 6 times.`);
  }
  if (occurrences(bodyHtml, PLACEHOLDERS.coverStack) > 2) {
    errors.push(`${PLACEHOLDERS.coverStack} may appear at most 2 times.`);
  }
  if (occurrences(bodyHtml, PLACEHOLDERS.bookBreakdown) > 1) {
    errors.push(`${PLACEHOLDERS.bookBreakdown} may appear at most once.`);
  }
  // The offer grid already carries a price and a button per card. A loose
  // {{PRICE}} or {{CTA_BUTTON}} beside it shows the FEATURED book's price
  // under a row of differently-priced products, which reads as a fourth,
  // nameless offer.
  if (bodyHtml.includes(PLACEHOLDERS.offerGrid)) {
    for (const section of sectionBodies(bodyHtml)) {
      if (!section.includes(PLACEHOLDERS.offerGrid)) continue;
      for (const token of [PLACEHOLDERS.price, PLACEHOLDERS.cta] as string[]) {
        if (section.includes(token)) {
          errors.push(
            `${token} sits in the same section as ${PLACEHOLDERS.offerGrid}. The grid already gives every ` +
              `product its own price and button; put ${token} in the hero or the closing section instead.`,
          );
        }
      }
    }
  }
  // A multi-book page must show each book with its own cover somewhere. Both
  // placeholders do that; without either, every book on the page is
  // represented by the featured book's cover.
  if (
    productCount > 1 &&
    !bodyHtml.includes(PLACEHOLDERS.bookBreakdown) &&
    !bodyHtml.includes(PLACEHOLDERS.coverStack)
  ) {
    errors.push(
      `This page sells ${options.productCount} books but shows no per-book covers. Place ` +
        `${PLACEHOLDERS.bookBreakdown} where the reference describes each book, and/or ` +
        `${PLACEHOLDERS.coverStack} where it shows them as a set.`,
    );
  }
  // On a multi-book page, repeated {{COVER}} is how the same book ends up
  // displayed as if it were three different ones.
  if (productCount > 1 && occurrences(bodyHtml, PLACEHOLDERS.cover) > 2) {
    errors.push(
      `${PLACEHOLDERS.cover} always renders the SAME (featured) book, so repeating it cannot show a set. ` +
        `On a page selling ${options.productCount} books use ${PLACEHOLDERS.coverStack} where the reference ` +
        `shows the books together, and keep ${PLACEHOLDERS.cover} to at most 2 uses.`,
    );
  }
  if (occurrences(bodyHtml, PLACEHOLDERS.cta) > 6) {
    errors.push(`${PLACEHOLDERS.cta} may appear at most 6 times.`);
  }
  if (occurrences(bodyHtml, PLACEHOLDERS.price) > 3) {
    errors.push(`${PLACEHOLDERS.price} may appear at most 3 times; the button's label already ends with the price.`);
  }
  // An unknown {{TOKEN}} would ship to a buyer as literal braces.
  const known = new Set<string>(Object.values(PLACEHOLDERS));
  for (const m of bodyHtml.matchAll(/\{\{[A-Z_]+\}\}/g)) {
    if (!known.has(m[0])) errors.push(`Unknown placeholder ${m[0]}. Use only: ${[...known].join(', ')}.`);
  }

  // ── page-sized elements must live in the page ──
  // The sticky bar sits before the first <section>. A cover or a portrait put
  // up there renders at page scale inside a fixed element and covers
  // everything behind it — which is exactly how a generated page shipped with
  // a 460x575 photograph over its own header.
  const firstSection = bodyHtml.search(/<section\b/i);
  if (firstSection > 0) {
    const beforeSections = bodyHtml.slice(0, firstSection);
    for (const token of [PLACEHOLDERS.cover, PLACEHOLDERS.authorPhoto] as string[]) {
      if (beforeSections.includes(token)) {
        errors.push(
          `${token} appears in the top bar, before the first <section>. It renders at page scale and ` +
            `would cover the header. Only ${PLACEHOLDERS.logo} and ${PLACEHOLDERS.cta} belong there.`,
        );
      }
    }
  }

  // ── structure ──
  for (const section of REQUIRED_SECTIONS) {
    if (!new RegExp(`data-section=["']${section}["']`).test(bodyHtml)) {
      errors.push(`Missing <section data-section="${section}">.`);
    }
  }

  // ── executable content ──
  if (/<script\b/i.test(all)) errors.push('Scripts are not allowed; remove every <script> tag.');
  if (/<(iframe|object|embed|form|input|button)\b/i.test(bodyHtml)) {
    errors.push('Embeds, forms and form controls are not allowed. Use the placeholders for actions.');
  }
  if (/\son[a-z]+\s*=/i.test(bodyHtml)) errors.push('Inline event handlers (onclick, onload…) are not allowed.');
  if (/javascript:/i.test(all)) errors.push('javascript: URLs are not allowed.');

  // ── external resources ──
  // The page is deployed as a single file and must render with no network.
  if (/(?:src|href)\s*=\s*["']https?:/i.test(bodyHtml)) {
    errors.push('No external URLs. The only link is the CTA placeholder; images come from {{COVER}}.');
  }
  if (/@import|url\(\s*["']?https?:/i.test(css)) {
    errors.push('No @import and no remote url() in CSS. Fonts must be system stacks.');
  }

  // ── colour discipline ──
  // Raw colours would bypass the cover-derived palette, whose contrast is
  // already proven. Translucent black and white are allowed for shadows and
  // scrims, since neither can make text unreadable on its own.
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/g)) {
    errors.push(`Raw colour "${m[0]}" in CSS. Use the palette variables only: ${PALETTE_VARS.join(', ')}.`);
    break; // one example is enough to make the point
  }
  for (const m of css.matchAll(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const neutral = (r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255);
    if (!neutral) {
      errors.push(`Raw colour "${m[0]})" in CSS. rgba() is allowed only for black or white overlays.`);
      break;
    }
  }
  for (const m of css.matchAll(/var\(\s*(--[a-z-]+)/g)) {
    const name = m[1] ?? '';
    if (!(PALETTE_VARS as readonly string[]).includes(name) && !name.startsWith('--x-')) {
      errors.push(`Unknown CSS variable ${name}. Use the palette variables, or your own prefixed --x-.`);
      break;
    }
  }

  // Single-axis `overflow-x: hidden` forces overflow-y to auto, turning the
  // element into its own scroll container — on body that is a second vertical
  // scrollbar beside the viewport's. Two-axis `overflow: hidden` is fine (it
  // has no auto side-effect and is the normal way to clip rounded corners).
  if (/overflow-[xy]\s*:\s*hidden/i.test(css)) {
    errors.push('Do not use single-axis "overflow-x/y: hidden" — it creates a nested scrollbar; use "clip" instead.');
  }

  // ── well-formedness ──
  // A truncated completion is the common failure, and it shows up as unbalanced
  // block tags long before it shows up as anything visible.
  for (const tag of ['section', 'div', 'ul', 'li', 'p', 'h1', 'h2', 'h3']) {
    const open = occurrences(bodyHtml, `<${tag}`) - occurrences(bodyHtml, `</${tag}`);
    if (open !== 0) {
      errors.push(`Unbalanced <${tag}> tags (${open > 0 ? `${open} unclosed` : `${-open} stray closing`}).`);
    }
  }

  return errors.length === 0 ? Result.ok<void, string[]>(undefined) : Result.fail<void, string[]>(errors);
}

/**
 * Checks a reusable layout's slots against the manifest it declared.
 *
 * The failure this exists to catch is subtle and expensive: a layout that looks
 * fine but has one book's headline written into the markup. It renders
 * perfectly for that book and then puts that book's words on every other book
 * that reuses the template.
 */
function slotErrors(page: GeneratedPage, minSlots: number): string[] {
  const errors: string[] = [];
  const declared = page.slots ?? [];
  const used = [...page.bodyHtml.matchAll(COPY_SLOT_RE)].map((m) => m[1] as string);

  if (declared.length === 0) {
    return ['This layout must be reusable: declare a "slots" array and put {{COPY:key}} tokens in the markup.'];
  }
  if (declared.length < minSlots) {
    errors.push(
      `Only ${declared.length} copy slots were declared; a page of this size needs at least ${minSlots}. ` +
        'Any text that is about THIS book must be a slot, not written into the markup.',
    );
  }

  const declaredKeys = new Set(declared.map((s) => s.key));
  const usedKeys = new Set(used);

  for (const key of REQUIRED_SLOT_KEYS) {
    if (!declaredKeys.has(key)) {
      errors.push(`Slot "${key}" is required — the system builds the page title and CTA label from it.`);
    }
  }

  for (const key of usedKeys) {
    if (!declaredKeys.has(key)) errors.push(`{{COPY:${key}}} is used in the markup but missing from "slots".`);
  }
  for (const slot of declared) {
    const systemRendered = SYSTEM_SLOT_KEYS.includes(slot.key);
    if (systemRendered) {
      if (usedKeys.has(slot.key)) {
        errors.push(
          `Slot "${slot.key}" must NOT appear in the markup — the system renders it. Declare it only.`,
        );
      }
    } else if (!usedKeys.has(slot.key)) {
      errors.push(`Slot "${slot.key}" is declared but never placed in the markup.`);
    }
    if (!slot.purpose?.trim()) errors.push(`Slot "${slot.key}" needs a "purpose" — the copywriter only sees that.`);
    if (!Number.isFinite(slot.maxChars) || slot.maxChars <= 0) {
      errors.push(`Slot "${slot.key}" needs a positive "maxChars".`);
    }
  }
  // A slot rendered twice would print the same sentence in two places.
  for (const key of usedKeys) {
    if (used.filter((k) => k === key).length > 1) errors.push(`{{COPY:${key}}} appears more than once.`);
  }

  return errors;
}

/**
 * Substitutes one book's copy into a stored layout. A slot with no value
 * collapses to nothing rather than leaving `{{COPY:…}}` visible to a buyer.
 */
export function fillCopySlots(bodyHtml: string, values: Record<string, string>): string {
  return bodyHtml.replace(COPY_SLOT_RE, (_match, key: string) => values[key] ?? '');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The contents of each `<section>`, bounded by its OWN closing tag.
 *
 * Splitting on the opening tag alone runs every chunk to the start of the NEXT
 * section, which silently annexes whatever follows the last one — a closing
 * call to action wrapped in a `<div>`, and the whole `<footer>`. On a page
 * whose offer grid IS the final section — which is how the three-book
 * reference is built — that read a perfectly placed closing CTA as a loose
 * price sitting beside the grid. All three layout attempts were rejected for
 * it, the repair round kept telling the model to move a placeholder that was
 * already where it belonged, and the page fell back to the built-in template.
 *
 * A nested section ends its parent's chunk early, so a placeholder after the
 * inner one closes is missed. That direction is deliberate: this rule rejects
 * an entire layout, so failing to flag costs a loose price on one page, while
 * flagging wrongly costs every page its template.
 */
function sectionBodies(bodyHtml: string): string[] {
  return bodyHtml
    .split(/<section\b/i)
    // Anything before the first <section> belongs to no section at all.
    .slice(1)
    .map((chunk) => {
      const end = chunk.search(/<\/section\s*>/i);
      return end === -1 ? chunk : chunk.slice(0, end);
    });
}

/**
 * Comparison that sees only the WORDS: tags are stripped and basic entities
 * decoded before comparing. Copying a template's inline styling — an accent
 * span around a phrase inside the headline — is legitimate; changing the words
 * is not, and this is what tells those apart.
 */
function collapse(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;|[‘’]/g, "'")
    .replace(/&quot;|[“”]/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateForError(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 57)}…`;
}

/** Substitutes the real markup for each placeholder. */
export function fillPlaceholders(bodyHtml: string, values: Record<keyof typeof PLACEHOLDERS, string>): string {
  let out = bodyHtml;
  for (const [key, token] of Object.entries(PLACEHOLDERS) as Array<[keyof typeof PLACEHOLDERS, string]>) {
    out = out.split(token).join(values[key] ?? '');
  }
  return out;
}

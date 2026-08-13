import { ValueObject } from '../shared/ValueObject';

export type Tone = 'educational' | 'conversational' | 'professional';

/**
 * The kind of book to generate.
 * - `normal`: the default YouTube-channel-to-ebook (prose chapters).
 * - `cooking`: a cookbook of AI-suggested recipes (structured recipe cards +
 *   one food photo per recipe), built from the channel's top videos.
 */
export type BookType = 'normal' | 'cooking';

/** Default number of recipes generated for a cooking book. */
export const COOKING_RECIPE_COUNT = 60;
/** For cooking books we only analyze the channel's top videos. */
export const COOKING_MAX_VIDEOS = 10;
/** Recipe counts are clamped to this range (matches the SubmitChannel DTO). */
export const RECIPE_COUNT_MIN = 10;
export const RECIPE_COUNT_MAX = 120;

/**
 * If the book title names a recipe count (e.g. "101 Recipes", "50 Easy Dinners"),
 * that number wins — the book should match its title. Returns undefined when the
 * title has no leading count, so the caller can fall back to the default.
 * The number must PRECEDE the "recipe(s)"-style word, so "Recipes for the 4th of July"
 * isn't misread as 4 recipes. Up to three descriptive words may sit between them
 * ("101 Easy Weeknight Recipes"), which is how these titles are usually written.
 */
export function recipeCountFromTitle(title: string | undefined): number | undefined {
  if (!title) return undefined;
  const m = title.match(
    /(\d{1,3})\s*(?:\+\s*)?(?:[a-z'-]+\s+){0,3}(?:recipe|dish|meal|dinner|plate)s?\b/i,
  );
  if (!m?.[1]) return undefined;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(RECIPE_COUNT_MIN, Math.min(RECIPE_COUNT_MAX, n));
}

/**
 * Titles are frequently pasted in filename form ("THE_DIY_REPAIR_BIBLE_101_REPAIRS").
 * Normalize once, here, so the clean title is what gets stored, hashed, sent to every
 * prompt and printed on the cover. Doing it at the edge (rather than asking the model
 * to tidy it) keeps the "return the title EXACTLY" prompt rule intact — the model
 * receives an already-clean string.
 *
 * Separators become spaces; an ALL-CAPS or all-lowercase title is title-cased, with
 * short joining words kept lowercase unless they lead. A title that already has mixed
 * case is left alone, since the author's own capitalization is deliberate.
 */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'nor', 'of', 'on',
  'or', 'the', 'to', 'v', 'via', 'vs', 'with', 'without',
]);

/**
 * Acronyms that must stay upper-case when title-casing an ALL-CAPS input — otherwise
 * "THE_DIY_REPAIR_BIBLE" becomes "The Diy Repair Bible" on the cover. Only genuinely
 * unambiguous ones; a word that is also a common noun (e.g. "GAS") is left to normal
 * casing rather than risk shouting a real word.
 */
const ACRONYMS = new Set([
  'diy', 'suv', 'rv', 'atv', 'ev', 'hvac', 'abs', 'obd', 'obd2', 'tv', 'pc', 'usa',
  'us', 'uk', 'ai', 'seo', 'ceo', 'diyer', 'mpg', 'psi', 'gps', 'led', 'ac', 'dc',
]);

export function normalizeBookTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Underscores are the common filename separator; collapse runs of them and of
  // whitespace alike. Hyphens are left alone — they are meaningful in real titles.
  const spaced = raw.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) return undefined;

  const letters = spaced.replace(/[^A-Za-z]/g, '');
  const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();
  const isAllLower = letters.length > 0 && letters === letters.toLowerCase();
  if (!isAllCaps && !isAllLower) return spaced; // deliberate mixed case — preserve it

  const words = spaced.split(' ');
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      // Strip punctuation when testing for an acronym so "DIY," / "(DIY)" still match.
      const bare = lower.replace(/[^a-z0-9]/g, '');
      if (ACRONYMS.has(bare)) return word.toUpperCase();
      // Keep tokens that aren't plain words (numbers, "101", hyphenates) as-is apart
      // from casing their first letter.
      if (MINOR_WORDS.has(lower) && i > 0 && i < words.length - 1) return lower;
      return lower.replace(/^([a-z])/, (c) => c.toUpperCase());
    })
    .join(' ');
}

/** Default currency for the landing page price, when the user doesn't pick one. */
export const DEFAULT_LANDING_CURRENCY = 'USD';

/**
 * Which landing page template a project uses. The client maintains a separate
 * reference site per mode, and the two are not interchangeable: a `triple` page
 * sells three books from one offer grid, a `single` page sells one.
 */
export type LandingMode = 'single' | 'triple';

/** How many sibling books a `triple` page requires beyond the project's own. */
export const TRIPLE_SIBLING_COUNT = 2;

interface GenerationOptionsProps {
  /** User-provided book title. When set, it overrides the AI-generated title. */
  bookTitle?: string | undefined;
  bookType: BookType;
  targetPages: number;
  maxVideos: number;
  /** Number of recipes to generate for a cooking book. Ignored for normal books. */
  recipeCount: number;
  tone: Tone;
  includeComments: boolean;
  /** Generate full-color in-chapter illustrations (69labs). Off by default. */
  includeIllustrations: boolean;
  /** Roughly one illustration per this many finished pages. */
  illustrationEveryPages: number;

  // ── Sales landing page ─────────────────────────────────────────────────────
  // Generate a standalone sales page for the finished book and host it on
  // Netlify. Everything below is inert while `landingPage` is false.
  /** Set when the user asks for a sales page on a finished book. */
  landingPage: boolean;
  /**
   * Which sales page this is: one book, or the client's three-book set.
   *
   * Stored explicitly rather than inferred from `landingSiblings.length`,
   * because the client's requirement is absolute — selecting the 3-ebook option
   * must produce the 3-ebook template and nothing else. An inferred mode would
   * silently degrade to the single-book layout the moment a sibling failed to
   * load, which is the exact failure the requirement exists to prevent.
   */
  landingMode: LandingMode;
  /**
   * The user's own checkout link (Payhip, Gumroad, Kajabi, Stripe — any URL).
   * Deliberately provider-agnostic: it is written into every CTA verbatim and
   * never composed or rewritten. Optional at submit time, because the product
   * can't exist on the store until the book itself has been generated and
   * uploaded — but a page cannot be PUBLISHED without it.
   */
  landingCheckoutUrl?: string | undefined;
  /** Sale price in minor units (cents). The user sets this per book. */
  landingPriceCents?: number | undefined;
  /** Optional "was" price, rendered struck-through beside the sale price. */
  landingCompareAtCents?: number | undefined;
  landingCurrency: string;
  /** Money-back guarantee window advertised on the page; 0 hides the section. */
  landingGuaranteeDays: number;
  /**
   * Other finished books sold on the SAME page (the client's 3-ebook template).
   * Each entry names a sibling project plus that book's own price and checkout
   * link — every card on the page buys a different product, so the links live
   * with the books they sell.
   */
  landingSiblings: Array<{
    projectId: string;
    priceCents?: number | undefined;
    /** This book's own "was" price, so every card can carry its own discount. */
    compareAtCents?: number | undefined;
    checkoutUrl?: string | undefined;
  }>;
  /** The all-books bundle: its own store product, price and link. */
  landingBundlePriceCents?: number | undefined;
  landingBundleCheckoutUrl?: string | undefined;
  /**
   * Storage path of a photograph of the author, uploaded by the seller.
   *
   * Optional, and deliberately not derived from the YouTube avatar: a channel
   * avatar is usually a logo or a low-resolution crop, and blowing it up into
   * the hero portrait the reference pages use looks worse than showing the
   * cover. The avatar becomes the small round brand mark instead.
   */
  landingAuthorPhotoPath?: string | undefined;
  /**
   * A reference sales page for this book's landing page to follow — the client
   * supplies a different one per book. Its structure and visual treatment are
   * read at generation time and used to steer the layout. Unset falls back to
   * the built-in structure.
   */
  landingTemplateUrl?: string | undefined;
  /**
   * The CLONED template this page is built from — a `landing_templates` row.
   *
   * Distinct from `landingTemplateUrl`, which named a page for a model to
   * imitate. This names a template that has already been captured, cleaned and
   * parameterised, so the page is that template with the content swapped rather
   * than a fresh interpretation of it. Set → the clone engine runs; unset →
   * the built-in renderer, as before.
   */
  landingTemplateId?: string | undefined;
}

export class GenerationOptions extends ValueObject<GenerationOptionsProps> {
  static create(props: Partial<GenerationOptionsProps>): GenerationOptions {
    const bookTitle = normalizeBookTitle(props.bookTitle);
    const bookType: BookType = props.bookType ?? 'normal';
    const isCooking = bookType === 'cooking';
    // The recipe count should follow the title: "101 Recipes" → 101. A count named
    // in the title wins over both an explicit option and the default, so the book
    // matches what its cover promises. Falls back to the option, then the default.
    const recipeCount = recipeCountFromTitle(bookTitle) ?? props.recipeCount ?? COOKING_RECIPE_COUNT;
    return new GenerationOptions({
      ...(bookTitle ? { bookTitle } : {}),
      bookType,
      targetPages: props.targetPages ?? 100,
      // Cooking books analyze only the channel's top videos.
      maxVideos: isCooking ? (props.maxVideos ?? COOKING_MAX_VIDEOS) : (props.maxVideos ?? 30),
      recipeCount,
      tone: props.tone ?? 'professional',
      includeComments: props.includeComments ?? true,
      includeIllustrations: props.includeIllustrations ?? true,
      illustrationEveryPages: props.illustrationEveryPages ?? 5,
      landingPage: props.landingPage ?? false,
      landingMode: props.landingMode === 'triple' ? 'triple' : 'single',
      // Blank strings arrive from empty form fields; treat them as "not set" so
      // `hasCheckoutUrl` stays a single honest check everywhere downstream.
      ...(props.landingCheckoutUrl?.trim() ? { landingCheckoutUrl: props.landingCheckoutUrl.trim() } : {}),
      ...(typeof props.landingPriceCents === 'number' && Number.isFinite(props.landingPriceCents)
        ? { landingPriceCents: Math.max(0, Math.round(props.landingPriceCents)) }
        : {}),
      ...(typeof props.landingCompareAtCents === 'number' && Number.isFinite(props.landingCompareAtCents)
        ? { landingCompareAtCents: Math.max(0, Math.round(props.landingCompareAtCents)) }
        : {}),
      landingCurrency: (props.landingCurrency ?? DEFAULT_LANDING_CURRENCY).toUpperCase(),
      landingGuaranteeDays: props.landingGuaranteeDays ?? 30,
      landingSiblings: (props.landingSiblings ?? [])
        .filter((sib) => Boolean(sib?.projectId))
        .slice(0, 2)
        .map((sib) => ({
          projectId: sib.projectId,
          ...(typeof sib.priceCents === 'number' && Number.isFinite(sib.priceCents)
            ? { priceCents: Math.max(0, Math.round(sib.priceCents)) }
            : {}),
          ...(typeof sib.compareAtCents === 'number' && Number.isFinite(sib.compareAtCents)
            ? { compareAtCents: Math.max(0, Math.round(sib.compareAtCents)) }
            : {}),
          ...(sib.checkoutUrl?.trim() ? { checkoutUrl: sib.checkoutUrl.trim() } : {}),
        })),
      ...(typeof props.landingBundlePriceCents === 'number' && Number.isFinite(props.landingBundlePriceCents)
        ? { landingBundlePriceCents: Math.max(0, Math.round(props.landingBundlePriceCents)) }
        : {}),
      ...(props.landingBundleCheckoutUrl?.trim()
        ? { landingBundleCheckoutUrl: props.landingBundleCheckoutUrl.trim() }
        : {}),
      ...(props.landingAuthorPhotoPath?.trim()
        ? { landingAuthorPhotoPath: props.landingAuthorPhotoPath.trim() }
        : {}),
      ...(props.landingTemplateUrl?.trim() ? { landingTemplateUrl: props.landingTemplateUrl.trim() } : {}),
      ...(props.landingTemplateId?.trim() ? { landingTemplateId: props.landingTemplateId.trim() } : {}),
    });
  }

  /** Plain props, for rebuilding a modified copy (the object itself is frozen). */
  toJSON(): GenerationOptionsProps {
    return { ...this.props };
  }

  get bookTitle() {
    return this.props.bookTitle;
  }
  get bookType() {
    return this.props.bookType;
  }
  get isCooking() {
    return this.props.bookType === 'cooking';
  }
  get recipeCount() {
    return this.props.recipeCount;
  }
  get targetPages() {
    return this.props.targetPages;
  }
  get maxVideos() {
    return this.props.maxVideos;
  }
  get tone() {
    return this.props.tone;
  }
  get includeComments() {
    return this.props.includeComments;
  }
  get includeIllustrations() {
    return this.props.includeIllustrations;
  }
  get illustrationEveryPages() {
    return this.props.illustrationEveryPages;
  }
  get landingPage() {
    return this.props.landingPage;
  }
  get landingCheckoutUrl() {
    return this.props.landingCheckoutUrl;
  }
  get landingPriceCents() {
    return this.props.landingPriceCents;
  }
  get landingCompareAtCents() {
    return this.props.landingCompareAtCents;
  }
  get landingCurrency() {
    return this.props.landingCurrency;
  }
  get landingGuaranteeDays() {
    return this.props.landingGuaranteeDays;
  }
  get landingTemplateUrl() {
    return this.props.landingTemplateUrl;
  }
  get landingTemplateId() {
    return this.props.landingTemplateId;
  }
  /** Which renderer this project's page uses. */
  get landingEngine(): 'clone' | 'builtin' {
    return this.props.landingTemplateId ? 'clone' : 'builtin';
  }
  get landingSiblings() {
    return this.props.landingSiblings;
  }
  get landingBundlePriceCents() {
    return this.props.landingBundlePriceCents;
  }
  get landingBundleCheckoutUrl() {
    return this.props.landingBundleCheckoutUrl;
  }
  get landingAuthorPhotoPath() {
    return this.props.landingAuthorPhotoPath;
  }
  get landingMode(): LandingMode {
    return this.props.landingMode;
  }
  /** True when this page sells the three-book set rather than one book. */
  get isTripleLanding(): boolean {
    return this.props.landingMode === 'triple';
  }
  /** Publishing needs SOMEWHERE for a buyer to go — any product's link will do. */
  get hasAnyCheckoutUrl(): boolean {
    return (
      this.hasCheckoutUrl ||
      Boolean(this.props.landingBundleCheckoutUrl) ||
      this.props.landingSiblings.some((s) => Boolean(s.checkoutUrl))
    );
  }
  /** A page can be generated without a checkout link, but never published without one. */
  get hasCheckoutUrl(): boolean {
    return Boolean(this.props.landingCheckoutUrl);
  }

  /**
   * Which books on this page have no buy link yet, as 1-based positions.
   *
   * Publishing is blocked while any is missing. `hasAnyCheckoutUrl` is not a
   * sufficient gate for a three-book page: it passes with one link set, which
   * would ship a live page with two dead buttons taking no money. The bundle is
   * excluded on purpose — no bundle link simply means no bundle card renders.
   */
  missingCheckoutPositions(): number[] {
    if (!this.isTripleLanding) return this.hasCheckoutUrl ? [] : [1];
    const positions = this.hasCheckoutUrl ? [] : [1];
    this.props.landingSiblings.forEach((sib, i) => {
      if (!sib.checkoutUrl) positions.push(i + 2);
    });
    return positions;
  }

  /**
   * Why this project can't generate the page it asked for, or null when it can.
   * A `triple` page with the wrong number of siblings is a configuration error,
   * not something to quietly render as a single-book page.
   */
  landingConfigError(): string | null {
    if (!this.props.landingPage) return null;
    if (this.isTripleLanding && this.props.landingSiblings.length !== TRIPLE_SIBLING_COUNT) {
      return `A 3-ebook landing page needs exactly ${TRIPLE_SIBLING_COUNT} other finished books; ${this.props.landingSiblings.length} selected.`;
    }
    return null;
  }
}

import type { LandingCopy } from '../../../domain/landing/LandingPage';
import type { Palette } from '../../../domain/landing/Palette';

/** One purchasable item on the page. */
export interface LandingProduct {
  title: string;
  subtitle: string;
  /** Cover art as a `data:` URI, or null to fall back to a typographic tile. */
  coverDataUri: string | null;
  pageCount: number | null;
  /** Chapter titles, listed under the cover. */
  contents: string[];
  /**
   * The "what's inside" breakdown: one entry per chapter, with its key points
   * as the items beneath. The reference page lists 13 categories with a method
   * count against each, which is exactly the shape of the book's own outline.
   */
  sections: Array<{ title: string; items: string[] }>;
  /** Eyebrow above the card title, e.g. "Buying guide" / "Best value". */
  categoryLabel: string | null;
  /** Terse selling points listed on the card itself. */
  features: string[];
  priceCents: number | null;
  compareAtCents: number | null;
  /**
   * The user's checkout link, written into the CTA verbatim. Null renders the
   * buttons as disabled placeholders — which is why a page can be previewed
   * before the product exists on the store, but never published.
   */
  checkoutUrl: string | null;
  /** Marks the emphasised card when several products are offered. */
  featured?: boolean;
  /**
   * A bundle is a product like any other — its own price, its own checkout link
   * — but it sells the whole set rather than one book, so it renders with every
   * book's cover instead of one and never appears as "book 4".
   */
  kind?: 'book' | 'bundle';
  /**
   * Bundle only: the covers of the books it contains, for the stacked card.
   * Derived from the other products, never supplied independently.
   */
  bundleCoverDataUris?: string[];
}

export interface LandingPageModel {
  copy: LandingCopy;
  palette: Palette;
  currency: string;
  guaranteeDays: number;
  /** Author byline, from the book strategy. */
  author: string | null;
  channelTitle: string | null;
  subscriberCount: number | null;
  /**
   * Real reader quotes supplied by the user. Empty by default: the section is
   * omitted rather than invented, because fabricated endorsements are a legal
   * exposure, not a stylistic choice.
   */
  testimonials: Array<{ quote: string; author: string }>;
  products: LandingProduct[];
  /** Shown in the footer next to the copyright line. */
  siteName: string;
  /**
   * The brand mark — the YouTube channel's own avatar, or an upload that
   * overrides it. Null renders the logo slots as nothing rather than as a gap.
   */
  logoDataUri: string | null;

  /**
   * The stat row under the hero. Every entry must be a fact the system already
   * holds — page count, guarantee window, the channel's real subscriber count.
   * Nothing here is written by the model, because a made-up "4,200 readers" is
   * a false claim about real people.
   */
  stats: Array<{ value: string; label: string }>;
  /** Optional photographic hero, behind the deep band. Supplied by the user. */
  heroImageDataUri: string | null;
  /** Optional author headshot. Supplied by the user; omitted when absent. */
  authorPhotoDataUri: string | null;
  /** Author credential line, e.g. "Founder · Car Care Garage". */
  authorCredential: string | null;

  // ── user-supplied commercial furniture ────────────────────────────────────
  // Every field below renders only when its data exists. They are grouped here
  // because they share one property: NONE of them can be model-generated. A
  // countdown, a star rating, an itemised value stack and a savings table are
  // all factual claims — about a deadline, about real reviewers, about products
  // that exist, about money a reader will actually save. Inventing any of them
  // would put a false statement on a page that takes payment.

  /** Real deadline for the launch price. Omitted → no countdown at all. */
  promoEndsAt: string | null;
  /** Aggregate rating, only if the seller genuinely has one. */
  rating: { score: number; count: number | null } | null;
  /** Itemised components adding to a "total value", struck through vs the price. */
  valueStack: Array<{ label: string; valueCents: number }>;
  /** The before/after cost table. `source` is required — an unsourced savings
   * claim is the single riskiest thing that can appear on this page. */
  costComparison: {
    beforeLabel: string;
    afterLabel: string;
    rows: Array<{ label: string; beforeCents: number; afterCents: number }>;
    source: string;
  } | null;
  /** Payment marks shown by the order button. */
  paymentMethods: string[];
  /** Edition line for the footer, e.g. "MMXXVI · No. I". */
  edition: string | null;
}

/** Renders the model into one self-contained HTML document (no external requests). */
export interface LandingPageRenderer {
  render(model: LandingPageModel): string;
}

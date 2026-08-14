/**
 * What a book on a multi-book sales page costs, and where it is bought.
 *
 * A three-book page references two OTHER books, and both of them are ordinary
 * projects with their own price, their own "was" price and their own store
 * product. This resolves which of the two possible sources wins.
 *
 * THE BOOK WINS. One book has one Payhip product, and that product charges one
 * price; a page that references the book has to advertise what the buyer will
 * actually be charged. The alternative — each page storing its own price for a
 * book it merely references — lets two pages sell the same product at two
 * different advertised prices, and the only person who discovers the
 * discrepancy is the customer at checkout.
 *
 * THE PAGE'S OWN ENTRY IS THE FALLBACK. It was the sole source of truth back
 * when every link was pasted in by hand, so pages built under that rule still
 * carry prices and links for books that never got their own. Dropping straight
 * to the book would blank those pages out. Falling back keeps them rendering
 * exactly as before while every newly-generated product follows the book.
 *
 * Fields fall back INDEPENDENTLY: a book with its own price but no link of its
 * own still takes the page's stored link, rather than the presence of one field
 * deciding the other two.
 */

/** The book's own commerce settings — a `GenerationOptions`-shaped subset. */
export interface OwnCommerce {
  landingPriceCents?: number | undefined;
  landingCompareAtCents?: number | undefined;
  landingCheckoutUrl?: string | undefined;
}

/** What the referencing page recorded for this book, before the book had its own. */
export interface StoredCommerce {
  priceCents?: number | undefined;
  compareAtCents?: number | undefined;
  checkoutUrl?: string | undefined;
}

export interface ResolvedCommerce {
  priceCents: number | null;
  compareAtCents: number | null;
  checkoutUrl: string | null;
}

export function siblingCommerce(own: OwnCommerce, stored: StoredCommerce): ResolvedCommerce {
  return {
    priceCents: own.landingPriceCents ?? stored.priceCents ?? null,
    compareAtCents: own.landingCompareAtCents ?? stored.compareAtCents ?? null,
    checkoutUrl: own.landingCheckoutUrl ?? stored.checkoutUrl ?? null,
  };
}

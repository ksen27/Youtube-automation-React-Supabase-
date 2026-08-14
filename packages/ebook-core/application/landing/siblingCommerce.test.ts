import { describe, it, expect } from 'vitest';
import { siblingCommerce } from './siblingCommerce';

/**
 * Which price a three-book page advertises for the OTHER two books.
 *
 * This reverses an earlier rule — pages used to store their own price for a
 * book they merely referenced — so these cases are the record of what changed
 * and, just as importantly, of what did not break when it changed.
 */

describe('resolving a referenced book\'s price and link', () => {
  it('takes the book\'s own price and link over the page\'s stored copy', () => {
    const resolved = siblingCommerce(
      { landingPriceCents: 1000, landingCompareAtCents: 2700, landingCheckoutUrl: 'https://payhip.com/b/NEW' },
      { priceCents: 1500, compareAtCents: 3000, checkoutUrl: 'https://payhip.com/b/OLD' },
    );

    // One book has ONE Payhip product charging ONE price. A page advertising a
    // different number than the product charges is a discrepancy only the
    // customer discovers, at checkout.
    expect(resolved).toEqual({
      priceCents: 1000,
      compareAtCents: 2700,
      checkoutUrl: 'https://payhip.com/b/NEW',
    });
  });

  /**
   * The compatibility case, and the reason this is a fallback rather than a
   * straight swap: pages built under the old rule carry prices for books that
   * never got their own, and reading only the book would blank them out.
   */
  it('falls back to the page\'s stored values for a book with none of its own', () => {
    const resolved = siblingCommerce(
      {},
      { priceCents: 1500, compareAtCents: 3000, checkoutUrl: 'https://payhip.com/b/OLD' },
    );

    expect(resolved).toEqual({
      priceCents: 1500,
      compareAtCents: 3000,
      checkoutUrl: 'https://payhip.com/b/OLD',
    });
  });

  /**
   * Fields fall back one at a time. A book that has been priced but not yet
   * listed still needs the page's link, and letting one populated field claim
   * all three would drop it.
   */
  it('falls back field by field, not all-or-nothing', () => {
    const resolved = siblingCommerce(
      { landingPriceCents: 1000 },
      { priceCents: 1500, compareAtCents: 3000, checkoutUrl: 'https://payhip.com/b/OLD' },
    );

    expect(resolved.priceCents).toBe(1000);
    expect(resolved.compareAtCents).toBe(3000);
    expect(resolved.checkoutUrl).toBe('https://payhip.com/b/OLD');
  });

  it('reports nulls when neither side has anything', () => {
    // Not zero: a free book and an unpriced one are different things, and the
    // renderers use null to mean "no price to show".
    expect(siblingCommerce({}, {})).toEqual({
      priceCents: null,
      compareAtCents: null,
      checkoutUrl: null,
    });
  });

  it('keeps a genuinely free book at zero rather than treating it as unset', () => {
    // `??` and not `||` — the difference between "this book costs nothing" and
    // "nobody has said what this book costs".
    expect(siblingCommerce({ landingPriceCents: 0 }, { priceCents: 1500 }).priceCents).toBe(0);
  });
});

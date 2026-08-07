import { describe, expect, it } from 'vitest';
import { COOKING_RECIPE_COUNT, GenerationOptions, normalizeBookTitle } from './GenerationOptions';

describe('normalizeBookTitle', () => {
  it('turns a pasted filename-style title into a readable one', () => {
    expect(normalizeBookTitle('THE_DIY_REPAIR_BIBLE_101_REPAIRS_YOU_CAN_DO_YOURSELF_AND_SAVE_THOUSANDS')).toBe(
      'The DIY Repair Bible 101 Repairs You Can Do Yourself and Save Thousands',
    );
  });

  it('keeps acronyms upper-case when title-casing', () => {
    expect(normalizeBookTitle('THE_DIY_SUV_OWNERS_GUIDE')).toBe('The DIY SUV Owners Guide');
  });

  it('keeps minor words lowercase inside the title but not at the edges', () => {
    expect(normalizeBookTitle('stop paying for ignorance')).toBe('Stop Paying for Ignorance');
    // A minor word must still be capitalized when it leads.
    expect(normalizeBookTitle('THE_ART_OF_REPAIR')).toBe('The Art of Repair');
  });

  it('preserves deliberate mixed case', () => {
    const title = 'iPhone Repair for the DIY Owner';
    expect(normalizeBookTitle(title)).toBe(title);
  });

  it('collapses underscore and whitespace runs', () => {
    expect(normalizeBookTitle('  MESSY___SPACING  ')).toBe('Messy Spacing');
  });

  it('leaves numbers and apostrophes intact', () => {
    expect(normalizeBookTitle("THE_SMART_DRIVER'S_BUYING_BIBLE_101_PRODUCTS")).toBe(
      "The Smart Driver's Buying Bible 101 Products",
    );
  });

  it('returns undefined for empty or missing input', () => {
    expect(normalizeBookTitle(undefined)).toBeUndefined();
    expect(normalizeBookTitle('   ')).toBeUndefined();
    expect(normalizeBookTitle('___')).toBeUndefined();
  });
});

describe('GenerationOptions', () => {
  it('stores the normalized title so every stage sees the clean string', () => {
    const options = GenerationOptions.create({ bookTitle: 'THE_DIY_REPAIR_BIBLE' });
    expect(options.bookTitle).toBe('The DIY Repair Bible');
  });

  it('still reads a recipe count from a filename-style title', () => {
    const options = GenerationOptions.create({ bookType: 'cooking', bookTitle: '101_EASY_WEEKNIGHT_RECIPES' });
    expect(options.recipeCount).toBe(101);
  });

  it('does not mistake a date for a recipe count', () => {
    const options = GenerationOptions.create({ bookType: 'cooking', bookTitle: 'Recipes for the 4th of July' });
    expect(options.recipeCount).toBe(COOKING_RECIPE_COUNT);
  });
});

describe('landing page options', () => {
  // Empty form fields arrive as blank strings, not undefined.
  it('treats a blank checkout link or template URL as unset', () => {
    const opts = GenerationOptions.create({ landingCheckoutUrl: '   ', landingTemplateUrl: '' });
    expect(opts.hasCheckoutUrl).toBe(false);
    expect(opts.landingTemplateUrl).toBeUndefined();
  });

  it('keeps the landing settings through a round trip', () => {
    const original = GenerationOptions.create({
      landingPage: true,
      landingTemplateUrl: 'https://eliasyoder.com',
      landingPriceCents: 2700,
    });
    const restored = GenerationOptions.create(original.toJSON());
    expect(restored.landingTemplateUrl).toBe('https://eliasyoder.com');
    expect(restored.landingPriceCents).toBe(2700);
  });
});

describe('three-book landing options', () => {
  const triple = (over: Parameters<typeof GenerationOptions.create>[0] = {}) =>
    GenerationOptions.create({
      landingPage: true,
      landingMode: 'triple',
      landingCheckoutUrl: 'https://payhip.com/b/ONE',
      landingSiblings: [
        { projectId: 'a', checkoutUrl: 'https://payhip.com/b/TWO' },
        { projectId: 'b', checkoutUrl: 'https://payhip.com/b/THREE' },
      ],
      ...over,
    });

  it('defaults to a single-book page', () => {
    expect(GenerationOptions.create({}).landingMode).toBe('single');
    expect(GenerationOptions.create({}).isTripleLanding).toBe(false);
  });

  it('keeps the mode, siblings and bundle through a round trip', () => {
    const restored = GenerationOptions.create(
      triple({ landingBundlePriceCents: 4700, landingBundleCheckoutUrl: 'https://payhip.com/b/SET' }).toJSON(),
    );
    expect(restored.landingMode).toBe('triple');
    expect(restored.landingSiblings).toHaveLength(2);
    expect(restored.landingBundlePriceCents).toBe(4700);
    expect(restored.landingBundleCheckoutUrl).toBe('https://payhip.com/b/SET');
  });

  it('rejects a three-book page that does not have three books', () => {
    expect(triple({ landingSiblings: [{ projectId: 'a' }] }).landingConfigError()).toContain('exactly 2');
    expect(triple().landingConfigError()).toBeNull();
  });

  // A live page with dead buy buttons is the failure this gate exists for.
  it('names every book still missing a checkout link', () => {
    expect(triple().missingCheckoutPositions()).toEqual([]);
    expect(triple({ landingCheckoutUrl: '' }).missingCheckoutPositions()).toEqual([1]);
    expect(
      triple({
        landingSiblings: [{ projectId: 'a' }, { projectId: 'b', checkoutUrl: 'https://payhip.com/b/THREE' }],
      }).missingCheckoutPositions(),
    ).toEqual([2]);
  });

  it('does not let one link stand in for all three', () => {
    const partial = triple({ landingSiblings: [{ projectId: 'a' }, { projectId: 'b' }] });
    // The older "any link will do" check passes here — which is exactly why
    // publishing uses missingCheckoutPositions instead.
    expect(partial.hasAnyCheckoutUrl).toBe(true);
    expect(partial.missingCheckoutPositions()).toEqual([2, 3]);
  });

  it('leaves a single-book page reporting only its own missing link', () => {
    expect(GenerationOptions.create({ landingPage: true }).missingCheckoutPositions()).toEqual([1]);
  });
});

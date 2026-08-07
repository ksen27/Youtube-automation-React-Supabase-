import { describe, expect, it } from 'vitest';
import { LandingLayoutPrompt } from './LandingLayoutPrompt';
import { PLACEHOLDERS } from '../landing/pageContract';
import type { LandingCopy } from '../../domain/landing/LandingPage';

const copy = {
  eyebrow: 'For weekend mechanics',
  headline: 'Stop paying for repairs you could do yourself',
  subheadline: 'The workshop manual for people who own a car, not a garage.',
  ctaLabel: 'Get the manual',
  painPoints: [],
  whatsInsideHeading: "What's inside",
  bullets: [{ title: 'Read the dashboard', body: 'Know which warnings mean stop now.' }],
  whoIsItForHeading: 'Who this is for',
  whoIsItFor: [],
  authorHeading: 'About the author',
  authorBio: 'Adrian has spent nineteen years under cars.',
  faqs: [],
  categoryLabel: '',
  productFeatures: [],
  comparisonWithout: [],
  comparisonWith: [],
  closingHeading: 'Fix it yourself',
  closingBody: 'One repair pays for the book.',
  fontFamily: 'sans',
  templateSections: [],
} as LandingCopy;

const base = { reference: null, copy, bookTitle: 'The Mechanic Bible', pageCount: 120 };

describe('LandingLayoutPrompt', () => {
  it('tells a one-book page there is exactly one product', () => {
    const { system } = LandingLayoutPrompt.build({ ...base, productCount: 1 });
    expect(system).toContain('THERE IS EXACTLY ONE PRODUCT');
    expect(system).not.toContain(PLACEHOLDERS.offerGrid);
  });

  // The model must never write the buy links on a multi-book page: with four
  // different checkout URLs, pairing them with books is the system's job.
  it('hands a multi-book page the offer grid instead', () => {
    const { system } = LandingLayoutPrompt.build({ ...base, productCount: 3 });
    expect(system).toContain('THIS PAGE SELLS 3 PRODUCTS');
    expect(system).toContain(PLACEHOLDERS.offerGrid);
    expect(system).not.toContain('THERE IS EXACTLY ONE PRODUCT');
  });

  it('sends plain text when there are no screenshots', () => {
    const { user } = LandingLayoutPrompt.build({ ...base, productCount: 1 });
    expect(typeof user).toBe('string');
  });

  it('puts the screenshots ahead of the brief when they exist', () => {
    const { user } = LandingLayoutPrompt.build({
      ...base,
      productCount: 1,
      referenceShots: [
        { mediaType: 'image/png', dataBase64: 'AAA' },
        { mediaType: 'image/png', dataBase64: 'BBB' },
      ],
    });

    expect(Array.isArray(user)).toBe(true);
    const blocks = user as Array<{ type: string }>;
    // A framing line, then both images, then the brief — the model should see
    // what the page looks like before reading what it is made of.
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'image', 'text']);
  });

  // Section order was previously free here AND "mirror this sequence" in the
  // reference block — the contradiction that opened generated pages on the
  // problem section where the template opens on the offer.
  it('does not let the model reorder sections when it has a reference', () => {
    const reference = {
      url: 'https://eliasyoder.com',
      title: 'An Almanac',
      headings: [{ level: 1, text: 'The old methods' }],
      text: 'body text',
      markup: '<main><h1>The old methods</h1></main>',
      styleCss: '',
      style: {
        serifHeadings: true, serifBody: false,
        headingFont: null, bodyFont: null,
        grounds: [],
        accent: null,
        numberedSections: true,
        imageDensity: 2,
        measurePx: 1080,
      },
    };
    const { system } = LandingLayoutPrompt.build({ ...base, reference, productCount: 1 });

    expect(system).toContain('SECTION ORDER IS NOT YOURS TO CHOOSE');
    expect(system).not.toContain('You may choose the order of sections');
  });

  it('keeps the freedom when there is no reference to follow', () => {
    const { system } = LandingLayoutPrompt.build({ ...base, productCount: 1 });
    expect(system).toContain('You may choose the order of sections');
    expect(system).not.toContain('SECTION ORDER IS NOT YOURS TO CHOOSE');
  });

  // Placing the portrait placeholder with no photo uploaded leaves a hole
  // exactly where the reference has a face.
  it('offers the author photo only when one was actually uploaded', () => {
    const withPhoto = LandingLayoutPrompt.build({ ...base, productCount: 1, hasAuthorPhoto: true }).system;
    expect(withPhoto).toContain('a real photograph of the author');
    // Scoped to the photo's own line: the logo carries the same wording on its
    // line, so a bare match would pass no matter which placeholder was withheld.
    expect(withPhoto).not.toContain('{{AUTHOR_PHOTO}}   NOT AVAILABLE');

    const without = LandingLayoutPrompt.build({ ...base, productCount: 1, hasAuthorPhoto: false }).system;
    expect(without).toContain('{{AUTHOR_PHOTO}}   NOT AVAILABLE');
    expect(without).toContain('Do not place it');
  });

  // Same failure as the portrait, one row up: a header designed around a brand
  // mark that resolves to nothing is a bar with a hole in it.
  it('offers the logo only when the channel avatar actually resolved', () => {
    const withLogo = LandingLayoutPrompt.build({ ...base, productCount: 1, hasLogo: true }).system;
    expect(withLogo).toContain("the channel's avatar as a small round brand mark");
    expect(withLogo).not.toContain('{{LOGO}}           NOT AVAILABLE');
    expect(withLogo).toContain('{{LOGO}}, the brand text and');

    const without = LandingLayoutPrompt.build({ ...base, productCount: 1, hasLogo: false }).system;
    expect(without).toContain('{{LOGO}}           NOT AVAILABLE');
    // The top-bar rule must stop naming a placeholder the page cannot fill.
    expect(without).not.toContain('{{LOGO}}, the brand text and');
    expect(without).toContain('there is no logo for this page');
  });

  // The edition line changes with the year, and the layout is stored and
  // reused — so it is offered as a slot rather than written into the markup,
  // which would freeze one year's line into every future page.
  it('offers the edition as a slot rather than embedding its value', () => {
    const { user } = LandingLayoutPrompt.build({ ...base, productCount: 1, edition: 'MMXXVI · No. I' });
    const text = user as string;
    expect(text).toContain('masthead edition line is available');
    expect(text).not.toContain('MMXXVI · No. I');
  });

  it('names no book — the layout is reused by all of them', () => {
    const { user } = LandingLayoutPrompt.build({ ...base, productCount: 3 });
    const text = user as string;
    expect(text).toContain('Do not name a book');
    expect(text).not.toContain('The Mechanic Bible');
  });

  // The offer grid was the only system-rendered block whose classes the model
  // was given. It styled that one correctly and the book breakdown blind, which
  // is how one book rendered as a wide card and the next as a squeezed column.
  it('shows the markup the book breakdown expands into', () => {
    const { system } = LandingLayoutPrompt.build({ ...base, productCount: 3 });
    for (const cls of ['.books', '.book', '.book-cover', '.book-body', '.book-index']) {
      expect(system, `${cls} not disclosed`).toContain(cls);
    }
  });

  it('forbids positional selectors on the repeated book blocks', () => {
    const { system } = LandingLayoutPrompt.build({ ...base, productCount: 3 });
    expect(system).toContain(':nth-child');
  });

  it('shows the markup the cover stack expands into', () => {
    const { system } = LandingLayoutPrompt.build({ ...base, productCount: 3 });
    expect(system).toContain('cover-stack-item');
  });

  // A layout with one book's words baked in would print that book's headline
  // on every other book that reuses the template.
  it('demands copy slots rather than prose', () => {
    const { system } = LandingLayoutPrompt.build({ ...base, productCount: 1 });
    expect(system).toContain('COPY SLOTS');
    expect(system).toContain('REUSABLE TEMPLATE');
    expect(system).toContain('{{COPY:key}}');
    expect(system).toContain('hero.headline, hero.subheadline, cta.label');
  });

});

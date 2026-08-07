import { describe, it, expect } from 'vitest';
import { Palette, type LandingCopy, type LandingPageModel, type LandingProduct } from '@ebook/core';
import { LandingPageHtmlRenderer } from './LandingPageHtmlRenderer';

const copy: LandingCopy = {
  eyebrow: 'For weekend mechanics',
  headline: 'Stop paying for repairs you could do yourself',
  subheadline: 'The workshop manual for people who own a car, not a garage.',
  ctaLabel: 'Get the manual',
  painPoints: ['Shops charge for diagnosis you can do in ten minutes.'],
  whatsInsideHeading: 'The manual',
  bullets: [{ title: 'Read the dashboard', body: 'Know which warnings mean stop now.' }],
  whoIsItForHeading: 'Who this is for',
  whoIsItFor: ['You keep a car past its warranty.'],
  authorHeading: 'About the author',
  authorBio: 'Nineteen years under other cars.',
  faqs: [{ question: 'What format?', answer: 'PDF and DOCX.' }],
  categoryLabel: 'Repair manual',
  productFeatures: ['101 fixes, step by step'],
  comparisonWithout: ['You pay the shop rate.'],
  comparisonWith: ['You do it yourself.'],
  closingHeading: 'Fix it yourself',
  closingBody: 'One repair pays for the book.',
  fontFamily: 'serif',
  templateSections: [],
};

function product(overrides: Partial<LandingProduct> = {}): LandingProduct {
  return {
    title: 'The Mechanic Bible',
    subtitle: 'Fix it yourself',
    coverDataUri: null,
    pageCount: 120,
    categoryLabel: 'Repair manual',
    features: ['101 fixes, step by step'],
    contents: ['Reading the dashboard'],
    sections: [
      { title: 'Reading the dashboard', items: ['Amber vs red', 'When to stop now'] },
      { title: 'Pricing a job', items: ['Parts vs labour'] },
    ],
    priceCents: 4700,
    compareAtCents: 7700,
    checkoutUrl: 'https://payhip.com/b/AbC9',
    ...overrides,
  };
}

function model(overrides: Partial<LandingPageModel> = {}): LandingPageModel {
  return {
    copy,
    palette: Palette.fromSeed({ r: 30, g: 60, b: 120 }),
    currency: 'USD',
    guaranteeDays: 30,
    author: 'Adrian',
    channelTitle: 'Car Care Garage',
    subscriberCount: 280_000,
    testimonials: [],
    products: [product()],
    siteName: 'The Mechanic Bible',
    logoDataUri: null,
    stats: [],
    heroImageDataUri: null,
    authorPhotoDataUri: null,
    authorCredential: 'Adrian · Car Care Garage',
    promoEndsAt: null,
    rating: null,
    valueStack: [],
    costComparison: null,
    paymentMethods: ['Visa', 'Mastercard'],
    edition: 'MMXXVI · No. I',
    ...overrides,
  };
}

const render = (m: LandingPageModel) => new LandingPageHtmlRenderer().render(m);

describe('LandingPageHtmlRenderer', () => {
  it('renders a complete standalone document', () => {
    const html = render(model());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Stop paying for repairs you could do yourself');
    expect(html).toContain('The workshop manual for people who own a car');
    expect(html).toContain('MMXXVI · No. I');
  });

  // The fallback page used to drop the channel avatar entirely, even when it
  // had loaded — the generated-layout path was the only one that showed it.
  it('shows the channel avatar in the masthead, and nothing when there is none', () => {
    const withLogo = render(model({ logoDataUri: 'data:image/png;base64,AQID' }));
    expect(withLogo).toContain('class="masthead-logo"');
    expect(withLogo).toContain('data:image/png;base64,AQID');

    expect(render(model())).not.toContain('masthead-logo"');
  });

  // The page must render from a static host with no network at all.
  it('fetches nothing from the network', () => {
    const html = render(model({ products: [product({ coverDataUri: 'data:image/png;base64,AQID' })] }));
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.every((h) => h === 'https://payhip.com/b/AbC9')).toBe(true);
  });

  it('puts the checkout URL on every CTA, byte for byte', () => {
    const url = 'https://payhip.com/b/AbC9?ref=a&b=1';
    const html = render(model({ products: [product({ checkoutUrl: url })] }));
    // &amp; in the attribute is the correct HTML encoding of the same URL.
    const occurrences = html.split('href="https://payhip.com/b/AbC9?ref=a&amp;b=1"').length - 1;
    expect(occurrences).toBe(2); // the order section and the last call
    expect(html).not.toContain('<span class="cta" aria-disabled');
  });

  it('renders inert buttons when no checkout link is set yet', () => {
    const html = render(model({ products: [product({ checkoutUrl: null })] }));
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('Checkout link not set yet');
    expect(html).not.toContain('href="https://payhip.com');
  });

  // Copy comes from a model and prices/links from a user; neither may become markup.
  it('escapes hostile content instead of executing it', () => {
    const html = render(
      model({
        copy: { ...copy, headline: '<script>alert(1)</script>', authorBio: '" onload="alert(2)' },
        products: [product({ checkoutUrl: 'https://x.test/"><script>alert(3)</script>' })],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('onload="alert(2)"');
    expect(html).not.toContain('"><script>alert(3)');
  });

  it('formats prices, showing the anchor price only when it is higher', () => {
    expect(render(model())).toContain('$47');
    expect(render(model())).toContain('class="price-was">$77');
    expect(render(model({ products: [product({ compareAtCents: 2000 })] }))).not.toContain(
      '<span class="price-was">',
    );
    expect(render(model({ products: [product({ priceCents: 4750, compareAtCents: null })] }))).toContain('$47.50');
    expect(render(model({ currency: 'EUR' }))).toContain('€47');
  });

  describe('section numbering', () => {
    it('numbers the sections in roman numerals', () => {
      const html = render(model());
      expect(html).toContain('<p class="mark">I</p>');
      expect(html).toContain('<p class="mark">II</p>');
    });

    // Skipping a numeral looks like a rendering bug to a reader, and every
    // optional section here is routinely absent.
    it('closes the numbering up when sections are omitted', () => {
      const bare = render(model({ costComparison: null, testimonials: [] }));
      const marks = [...bare.matchAll(/<p class="mark">([IVX]+)<\/p>/g)].map((m) => m[1]);
      expect(marks).toEqual(['I', 'II', 'III', 'IV']);

      const full = render(
        model({
          testimonials: [{ quote: 'Saved me a fortune.', author: 'Dana, TX' }],
          costComparison: {
            beforeLabel: 'Before',
            afterLabel: 'After',
            rows: [{ label: 'Servicing', beforeCents: 120000, afterCents: 40000 }],
            source: 'Figures supplied by the publisher.',
          },
        }),
      );
      const fullMarks = [...full.matchAll(/<p class="mark">([IVX]+)<\/p>/g)].map((m) => m[1]);
      expect(fullMarks).toEqual(['I', 'II', 'III', 'IV', 'V', 'VI']);
    });
  });

  // The reference's own sections, written from the book. The fallback renderer
  // must carry them too, or a rejected layout silently loses most of the page.
  describe('template-driven sections', () => {
    const withSections = (sections: LandingCopy['templateSections']) =>
      render(model({ copy: { ...copy, templateSections: sections } }));

    it('renders each section in the order the reference had them', () => {
      const html = withSections([
        { heading: 'Where the money goes', eyebrow: 'THE MATH', intro: 'Your bills.', kind: 'prose', items: [], table: null },
        { heading: 'Choose your level', eyebrow: '', intro: '', kind: 'cards', items: [], table: null },
      ]);
      expect(html.indexOf('Where the money goes')).toBeLessThan(html.indexOf('Choose your level'));
      expect(html).toContain('THE MATH');
    });

    it('renders a figure table with its source line', () => {
      const html = withSections([
        {
          heading: 'What a shop charges',
          eyebrow: '',
          intro: '',
          kind: 'table',
          items: [],
          table: {
            leftHeading: 'At the shop',
            rightHeading: 'Doing it yourself',
            rows: [{ label: 'Diagnostic scan', left: '$150', right: '$22' }],
            leftTotal: '$150',
            rightTotal: '$22',
            source: 'Costs quoted in Chapter 3 of the book.',
          },
        },
      ]);
      expect(html).toContain('Diagnostic scan');
      expect(html).toContain('At the shop');
      // An unsourced savings table is the riskiest thing on a page taking money.
      expect(html).toContain('Costs quoted in Chapter 3 of the book.');
    });

    it('gives each kind its own shape', () => {
      const items = [{ title: 'One', body: 'Body.' }];
      expect(withSections([{ heading: 'A', eyebrow: '', intro: '', kind: 'steps', items, table: null }])).toContain(
        'tmpl-steps',
      );
      expect(
        withSections([{ heading: 'B', eyebrow: '', intro: '', kind: 'comparison', items, table: null }]),
      ).toContain('tmpl-compare');
      expect(withSections([{ heading: 'C', eyebrow: '', intro: '', kind: 'cards', items, table: null }])).toContain(
        'tmpl-card',
      );
    });

    it('keeps the numbering continuous across them', () => {
      const html = withSections([
        { heading: 'Extra one', eyebrow: '', intro: '', kind: 'prose', items: [], table: null },
      ]);
      const marks = [...html.matchAll(/<p class="mark">([IVX]+)<\/p>/g)].map((m) => m[1]);
      expect(marks).toEqual(['I', 'II', 'III', 'IV', 'V']);
    });

    it('escapes section content like everything else', () => {
      const html = withSections([
        { heading: '<script>alert(1)</script>', eyebrow: '', intro: '', kind: 'prose', items: [], table: null },
      ]);
      expect(html).not.toContain('<script>alert(1)</script>');
    });
  });

  describe('claims that cannot be generated', () => {
    // Each of these is a factual assertion — about a deadline, real reviewers,
    // products that exist, or money a reader will save. The page must stay
    // silent rather than invent one.
    it('shows no countdown without a real end date', () => {
      expect(render(model())).not.toContain('Launch price ends in');
      const withDate = render(model({ promoEndsAt: '2026-09-01T00:00:00Z' }));
      expect(withDate).toContain('Launch price ends in');
      expect(withDate).toContain('data-ends="2026-09-01T00:00:00Z"');
    });

    it('hides the countdown once the deadline passes rather than resetting it', () => {
      // A timer that restarts each visit is a false urgency claim.
      const html = render(model({ promoEndsAt: '2026-09-01T00:00:00Z' }));
      expect(html).toContain('if (left <= 0)');
      expect(html).toContain("promo.style.display = 'none'");
      expect(html).not.toMatch(/Date\.now\(\)\s*\+/); // never "now + 24h"
    });

    it('shows no star rating unless one was supplied', () => {
      expect(render(model())).not.toContain('★ from');
      expect(render(model({ rating: { score: 4.9, count: 312 } }))).toContain('4.9★ from 312 readers');
    });

    it('shows the value stack only when its line items exist', () => {
      expect(render(model())).not.toContain('Total value');
      const stacked = render(
        model({ valueStack: [{ label: 'The manual', valueCents: 4700 }, { label: 'Lifetime updates', valueCents: 2100 }] }),
      );
      expect(stacked).toContain('Total value');
      expect(stacked).toContain('$68'); // 47 + 21
      expect(stacked).toContain('You pay today');
    });

    it('omits the arithmetic table entirely without supplied figures', () => {
      expect(render(model())).not.toContain('The arithmetic');
    });

    it('always prints a source beside the arithmetic', () => {
      const html = render(
        model({
          costComparison: {
            beforeLabel: 'Now',
            afterLabel: 'After',
            rows: [
              { label: 'Servicing', beforeCents: 120000, afterCents: 40000 },
              { label: 'Parts', beforeCents: 60000, afterCents: 30000 },
            ],
            source: 'Figures from the publisher’s 2026 survey.',
          },
        }),
      );
      expect(html).toContain('The arithmetic');
      expect(html).toContain('$1800'); // totals row: 1200 + 600
      expect(html).toContain('$700'); // 400 + 300
      expect(html).toContain('class="source"');
      expect(html).toContain('2026 survey');
    });

    it('renders reader results only from real quotes', () => {
      expect(render(model())).not.toContain('Reader results');
      const withQuotes = render(model({ testimonials: [{ quote: 'It paid for itself.', author: 'Dana, TX' }] }));
      expect(withQuotes).toContain('Reader results');
      expect(withQuotes).toContain('It paid for itself.');
    });
  });

  it('builds the contents from the book’s own outline, with counts', () => {
    const html = render(model());
    expect(html).toContain('Reading the dashboard');
    expect(html).toContain('2 methods');
    expect(html).toContain('1 method'); // singular, not "1 methods"
  });

  // The key points are the book's substance — "Buy the $22 Topdon ArtiLink
  // 200", "Disconnect the negative terminal 45 minutes with the brake pedal
  // held". A fourteen-chapter book put roughly seventy of them on a free public
  // page, which is the product being given away by the page selling it.
  it('lists the chapters without printing what is in them', () => {
    const html = render(model());
    expect(html).not.toContain('Amber vs red');
    expect(html).not.toContain('When to stop now');
    expect(html).not.toContain('Parts vs labour');
  });

  it('falls back to the model’s bullets when the outline is empty', () => {
    const html = render(model({ products: [product({ sections: [] })] }));
    expect(html).toContain('Know which warnings mean stop now.');
  });

  it('shows the payment marks it was given', () => {
    expect(render(model())).toContain('>Visa</span>');
    expect(render(model({ paymentMethods: [] }))).not.toContain('class="pay"');
  });

  it('omits sections it has no content for', () => {
    const html = render(model({ copy: { ...copy, painPoints: [], faqs: [], whoIsItFor: [] }, guaranteeDays: 0 }));
    expect(html).not.toContain('<details>');
    expect(html).not.toContain('money-back guarantee');
    expect(html).not.toContain('class="pains');
  });

  it('drives its colours from the palette', () => {
    const palette = Palette.fromSeed({ r: 200, g: 20, b: 24 });
    const html = render(model({ palette }));
    expect(html).toContain(`--accent: ${palette.toJSON().accent}`);
    expect(html).toContain(`--bg: ${palette.toJSON().background}`);
  });

  it('switches typeface on the copy’s own judgement', () => {
    expect(render(model())).toContain('Georgia');
    expect(render(model({ copy: { ...copy, fontFamily: 'sans' } }))).toContain('Helvetica Neue');
  });

  describe('scroll animation', () => {
    it('marks the blocks that reveal on scroll', () => {
      const html = render(model());
      expect(html).toContain('class="reveal"');
      expect(html).toContain('class="pains stagger"');
      expect(html).toContain('IntersectionObserver');
    });

    it('reveals each block once and stops watching it', () => {
      expect(render(model())).toContain('io.unobserve');
    });

    // The one that actually matters. If the hidden start state applied without
    // JavaScript, a blocked or broken script would leave the page blank — a dead
    // sales page nobody notices until a customer reports it.
    it('only ever hides content under the JS-set .anim class', () => {
      const css = render(model())
        .replace(/@keyframes[\s\S]*?\{[\s\S]*?\}\s*\}/g, '')
        .slice(0);
      const style = css.slice(css.indexOf('<style>'), css.indexOf('</style>'));
      for (const rule of style.split('}')) {
        if (!/opacity:\s*0[;\s]|visibility:\s*hidden/.test(rule)) continue;
        const selector = rule.split('{')[0] ?? '';
        if (selector.includes('aria-disabled')) continue; // the inert button
        expect(selector).toContain('.anim');
      }
    });

    it('un-hides the page if the observer never starts', () => {
      const html = render(model());
      expect(html).toContain('data-anim');
      expect(html).toContain("replace(' anim', '')");
    });

    it('skips reveals entirely for readers who prefer reduced motion', () => {
      const html = render(model());
      expect(html).toContain("matchMedia('(prefers-reduced-motion: reduce)').matches");
      expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    });

    it('carries no inline event handlers', () => {
      expect(render(model())).not.toMatch(/\s\bon(click|load|error|mouse\w+)\s*=/i);
    });
  });

  // The built-in template is the guaranteed fallback when a generated layout
  // fails its contract. On a three-book page that makes these cases the last
  // thing standing between the client and a page that sells the wrong book.
  // Reference templates pair a serif display face with sans-serif body copy.
  // Tying both to one choice set the eyebrows, bullets and fine print in
  // Georgia on any page whose headings were serif.
  describe('type pairing', () => {
    const bodyRule = (html: string) => /body \{[\s\S]*?font-family: ([^;]+);/.exec(html)?.[1] ?? '';
    const headingRule = (html: string) => /h1, h2, h3 \{ font-family: ([^;]+);/.exec(html)?.[1] ?? '';

    it('sets serif headings over sans body when the reference pairs them', () => {
      const html = render(model({ copy: { ...copy, fontFamily: 'serif', bodyFontFamily: 'sans' } }));
      expect(headingRule(html)).toContain('Georgia');
      expect(bodyRule(html)).toContain('Inter');
      expect(bodyRule(html)).not.toContain('Georgia');
    });

    it('follows the headings when no body face was observed', () => {
      const html = render(model({ copy: { ...copy, fontFamily: 'serif' } }));
      expect(bodyRule(html)).toContain('Georgia');
    });

    it('keeps an all-sans page all sans', () => {
      const html = render(model({ copy: { ...copy, fontFamily: 'sans', bodyFontFamily: 'sans' } }));
      expect(headingRule(html)).not.toContain('Georgia');
      expect(bodyRule(html)).toContain('Inter');
    });
  });

  describe('multi-product pages', () => {
    const three = () =>
      model({
        products: [
          product({ title: 'Book One', checkoutUrl: 'https://payhip.com/b/ONE', priceCents: 4700, featured: true }),
          product({ title: 'Book Two', checkoutUrl: 'https://payhip.com/b/TWO', priceCents: 3900 }),
          product({ title: 'Book Three', checkoutUrl: 'https://payhip.com/b/THREE', priceCents: 2900 }),
        ],
      });

    it('renders one card per book, not just the featured one', () => {
      const html = render(three());
      expect(html).toContain('Book One');
      expect(html).toContain('Book Two');
      expect(html).toContain('Book Three');
    });

    it('pairs every book with its OWN checkout link', () => {
      const html = render(three());
      // Each card is one `<div class="offer…">`; the link inside a card must be
      // the link belonging to the title inside that same card. This is the
      // whole reason the offer grid is system-rendered.
      // Split on a card's opening tag only — `class="offer"` or
      // `class="offer offer-featured"` — not on `offer-art`/`offer-flag`.
      const cards = html.split(/<div class="offer[" ]/).slice(1);
      expect(cards.length).toBeGreaterThanOrEqual(3);
      const expected: Array<[string, string]> = [
        ['Book One', 'ONE'],
        ['Book Two', 'TWO'],
        ['Book Three', 'THREE'],
      ];
      for (const [title, slug] of expected) {
        const card = cards.find((c) => c.includes(title));
        expect(card, `no card rendered for ${title}`).toBeDefined();
        expect(card).toContain(`https://payhip.com/b/${slug}`);
      }
    });

    it('still sells one book the plain way when there is only one', () => {
      const html = render(model());
      expect(html).toContain('Order the book');
      expect(html).not.toContain('class="offers"');
    });

    it('computes the bundle saving from the real book prices', () => {
      const html = render(
        model({
          products: [
            product({ title: 'Book One', priceCents: 4700, featured: true }),
            product({ title: 'Book Two', priceCents: 3900 }),
            product({ title: 'The complete set', kind: 'bundle', priceCents: 6900 }),
          ],
        }),
      );
      expect(html).toContain('Save $17 vs buying separately'); // 4700 + 3900 - 6900
    });

    it('claims no saving when a book has no price to compare against', () => {
      const html = render(
        model({
          products: [
            product({ title: 'Book One', priceCents: null, featured: true }),
            product({ title: 'The complete set', kind: 'bundle', priceCents: 6900 }),
          ],
        }),
      );
      expect(html).not.toContain('vs buying separately');
    });

    it('closes on the bundle rather than on one third of what it just sold', () => {
      const html = render(
        model({
          products: [
            product({ title: 'Book One', priceCents: 4700, checkoutUrl: 'https://payhip.com/b/ONE', featured: true }),
            product({
              title: 'The complete set',
              kind: 'bundle',
              priceCents: 6900,
              checkoutUrl: 'https://payhip.com/b/SET',
            }),
          ],
        }),
      );
      const lastLink = html.lastIndexOf('payhip.com/b/');
      expect(html.slice(lastLink, lastLink + 20)).toContain('SET');
    });
  });
});

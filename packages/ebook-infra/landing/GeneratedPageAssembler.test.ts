import { describe, it, expect } from 'vitest';
import { Palette, type LandingCopy, type LandingPageModel, type LandingProduct } from '@ebook/core';
import { GeneratedPageAssembler } from './GeneratedPageAssembler';

const copy: LandingCopy = {
  eyebrow: '',
  headline: 'A headline',
  subheadline: 'A subheadline',
  ctaLabel: 'Get the book',
  painPoints: [],
  whatsInsideHeading: '',
  bullets: [],
  whoIsItForHeading: '',
  whoIsItFor: [],
  authorHeading: '',
  authorBio: '',
  faqs: [],
  categoryLabel: '',
  productFeatures: [],
  comparisonWithout: [],
  comparisonWith: [],
  closingHeading: '',
  closingBody: '',
  fontFamily: 'sans',
  templateSections: [],
};

function product(over: Partial<LandingProduct> = {}): LandingProduct {
  return {
    title: 'A Book',
    subtitle: '',
    coverDataUri: null,
    pageCount: 100,
    categoryLabel: null,
    features: [],
    contents: [],
    sections: [],
    priceCents: 2700,
    compareAtCents: null,
    checkoutUrl: 'https://example.com/a',
    kind: 'book',
    ...over,
  };
}

function model(products: LandingProduct[]): LandingPageModel {
  return {
    copy,
    palette: Palette.neutral(),
    currency: 'USD',
    guaranteeDays: 30,
    author: null,
    channelTitle: null,
    subscriberCount: null,
    testimonials: [],
    products,
    siteName: 'Site',
    logoDataUri: null,
    stats: [],
    heroImageDataUri: null,
    authorPhotoDataUri: null,
    authorCredential: null,
    promoEndsAt: null,
    rating: null,
    valueStack: [],
    costComparison: null,
    paymentMethods: [],
    edition: null,
  };
}

const assemble = (bodyHtml: string, products: LandingProduct[]) =>
  new GeneratedPageAssembler().assemble({ page: { css: '', bodyHtml }, model: model(products) });

const THREE = [
  product({ title: 'Book One', coverDataUri: 'data:image/png;base64,ONE', featured: true, contents: ['Alpha'] }),
  product({ title: 'Book Two', coverDataUri: 'data:image/png;base64,TWO', contents: ['Beta'] }),
  product({ title: 'Book Three', coverDataUri: 'data:image/png;base64,THREE', contents: ['Gamma'] }),
];

describe('GeneratedPageAssembler — per-book elements', () => {
  // {{COVER}} renders the featured book however often it appears, so a
  // three-book page built from repeats showed one book three times.
  it('gives every book its own cover in the breakdown', () => {
    const html = assemble('<section>{{BOOK_BREAKDOWN}}</section>', THREE);

    for (const slug of ['ONE', 'TWO', 'THREE']) {
      expect(html).toContain(`data:image/png;base64,${slug}`);
    }
    // Each block must pair a title with the cover that belongs to it.
    const blocks = html.split('<div class="book">').slice(1);
    expect(blocks).toHaveLength(3);
    for (const [title, slug] of [
      ['Book One', 'ONE'],
      ['Book Two', 'TWO'],
      ['Book Three', 'THREE'],
    ] as Array<[string, string]>) {
      const block = blocks.find((b) => b.includes(title));
      expect(block, `no block for ${title}`).toBeDefined();
      expect(block).toContain(`base64,${slug}`);
    }
  });

  it('lists each book with its own contents, not the featured book’s', () => {
    const html = assemble('<section>{{BOOK_BREAKDOWN}}</section>', THREE);
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(html).toContain('Gamma');
  });

  it('shows every cover in the stack too', () => {
    const html = assemble('<section>{{COVER_STACK}}</section>', THREE);
    for (const slug of ['ONE', 'TWO', 'THREE']) {
      expect(html).toContain(`data:image/png;base64,${slug}`);
    }
  });

  // The bundle has no cover of its own; it must not become a fourth book.
  it('leaves the bundle out of both', () => {
    const withBundle = [...THREE, product({ title: 'The complete set', kind: 'bundle', coverDataUri: null })];
    const html = assemble('<section>{{BOOK_BREAKDOWN}}{{COVER_STACK}}</section>', withBundle);
    expect(html.split('<div class="book">').length - 1).toBe(3);
    expect(html).not.toContain('The complete set');
  });

  // The copy's ctaLabel names the FEATURED book, so reusing it across the offer
  // grid put "Get The DIY Repair Bible" on every card, bundle included. Nor
  // does a card's button repeat the price printed directly above it.
  it('labels each offer button without the price or the featured title', () => {
    const withBundle = [
      ...THREE,
      product({ title: 'The complete set', kind: 'bundle', priceCents: 8000, coverDataUri: null }),
    ];
    const html = assemble('<section>{{OFFER_GRID}}</section>', withBundle);

    expect(html).toContain('Get this book');
    expect(html).toContain('Get the complete set');
    expect(html).not.toContain('Get it for $27');
    // Each card still SHOWS its own price, once, above the button.
    expect(html).toContain('$27');
    expect(html).toContain('$80');
    // The global label belongs to the hero, not to a card.
    const cards = html.split(/<div class="offer[" ]/).slice(1);
    for (const card of cards) expect(card).not.toContain('Get the book —');
  });

  it('keeps each offer button pointing at its own checkout link', () => {
    const html = assemble(
      '<section>{{OFFER_GRID}}</section>',
      THREE.map((p, i) => ({ ...p, checkoutUrl: `https://example.com/book-${i + 1}` })),
    );
    for (let i = 1; i <= 3; i++) expect(html).toContain(`https://example.com/book-${i}`);
  });

  // The order block shipped a large "$10" stacked directly on a button already
  // labelled "… — $10".
  // {{CONTENTS}} is the table of contents, not the contents. A fourteen-chapter
  // book rendered roughly seventy key points — "Buy the $22 Topdon ArtiLink
  // 200", "Only PEA chemistry dissolves intake deposits" — on a free public
  // page. Those are the book's substance, so the page selling it was giving it
  // away, and the wall of text buried the CTA the reference template never had.
  describe('the contents block', () => {
    const withOutline = () =>
      new GeneratedPageAssembler().assemble({
        page: { css: '', bodyHtml: '<section data-section="hero">{{CONTENTS}}{{FOOTER_LEGAL}}</section>' },
        model: model([
          product({
            featured: true,
            sections: [
              { title: 'The $22 Tool That Beats Dealerships', items: ['Buy the $22 Topdon ArtiLink 200', 'Read P0420 codes'] },
              { title: 'ECU Resets You Do Free', items: ['Disconnect negative terminal 45 minutes'] },
            ],
          }),
        ]),
      });

    it('lists every chapter, numbered, with its key points', () => {
      const html = withOutline();
      expect(html).toContain('The $22 Tool That Beats Dealerships');
      expect(html).toContain('ECU Resets You Do Free');
      expect(html).toContain('Chapter 01');
      expect(html).toContain('Chapter 02');
      // Specifics are what make the section persuasive rather than a table of
      // contents (client feedback 2026-08-06).
      expect(html).toContain('Buy the $22 Topdon ArtiLink 200');
      expect(html).toContain('Disconnect negative terminal 45 minutes');
    });

    it('caps the points shown and counts the rest, so the book is not given away', () => {
      const html = assemble('<section>{{CONTENTS}}</section>', [
        product({
          sections: [
            {
              title: 'Long Chapter',
              items: ['point one', 'point two', 'point three', 'point four', 'point five', 'point six'],
            },
          ],
        }),
      ]);
      expect(html).toContain('point four'); // the 4th is shown...
      expect(html).not.toContain('point five'); // ...the 5th is not
      expect(html).not.toContain('point six');
      expect(html).toContain('+2 more');
    });

    // The section felt enormous because the grid ran the full width of the
    // screen; the count was never the problem, and a buyer should see the whole
    // list of what the book covers. The measure is held in CSS instead.
    it('lists every chapter, however many there are', () => {
      const html = assemble('<section>{{CONTENTS}}</section>', [
        product({
          sections: Array.from({ length: 14 }, (_, i) => ({ title: `Chapter Title ${i + 1}`, items: [] })),
        }),
      ]);
      expect(html).toContain('Chapter Title 9');
      expect(html).toContain('Chapter Title 14');
      expect(html).not.toContain('more chapters inside the book');
    });
  });

  it('drops a price that sits directly on top of a buy button', () => {
    const html = assemble('<section>{{PRICE}}{{CTA_BUTTON}}</section>', [product({ priceCents: 1000 })]);
    expect(html).not.toContain('class="price-row"');
    expect(html).toContain('$10');
  });

  it('still drops it through the markup a layout wraps them in', () => {
    const html = assemble('<section><p>{{PRICE}}</p>\n  <div>{{CTA_BUTTON}}</div></section>', [product({ priceCents: 1000 })]);
    expect(html).not.toContain('class="price-row"');
  });

  // Only the adjacent pair is redundant; a price elsewhere is the page working.
  it('keeps a price that stands on its own', () => {
    const html = assemble('<section>{{PRICE}}<p>Some copy</p>{{CTA_BUTTON}}</section>', [product({ priceCents: 1000 })]);
    expect(html).toContain('class="price-row"');
  });

  it('renders no payment marks when none are supplied', () => {
    const html = assemble('<section>{{PAYMENT_MARKS}}</section>', [product()]);
    expect(html).not.toContain('class="pay"');
  });

  // The model styles blocks it never sees the markup of, so a selector that
  // happens to catch some .book elements and not others reflowed one book into a
  // wide card and the next into a squeezed column beside a floating cover.
  describe('structural guard', () => {
    const withCss = (css: string) =>
      new GeneratedPageAssembler().assemble({
        page: { css, bodyHtml: '<section>{{BOOK_BREAKDOWN}}</section>' },
        model: model(THREE),
      });

    const guardIndex = (html: string) => html.indexOf('structural guard');

    it('re-asserts book geometry after the layout stylesheet', () => {
      const html = withCss('.book { grid-template-columns: 1fr 1fr; }');
      const modelRule = html.indexOf('grid-template-columns: 1fr 1fr');
      expect(modelRule).toBeGreaterThan(-1); // the model keeps its say on everything else
      // Later in the cascade wins, so ours must come after theirs.
      expect(guardIndex(html)).toBeGreaterThan(modelRule);
      expect(html.slice(guardIndex(html))).toContain('minmax(120px, 180px) minmax(22ch, 1fr)');
    });

    it('undoes a rule that reorders one block but not the others', () => {
      const guard = withCss('.book:nth-child(even) > * { order: 2; }').slice(guardIndex(withCss('')));
      expect(guard).toContain('order: 0');
      expect(guard).toContain('grid-column: auto');
    });

    it('caps page-sized images the top-bar check cannot see', () => {
      const guard = withCss('.author-photo { max-height: none; }').slice(guardIndex(withCss('')));
      expect(guard).toContain('.author-photo');
      expect(guard).toContain('min(60vh, 520px)');
      expect(guard).toContain('.logo');
    });

    // Colour and type are what make the page look like its template.
    it('leaves everything but geometry to the model', () => {
      const guard = withCss('').slice(guardIndex(withCss('')));
      for (const prop of ['color:', 'background:', 'font-family', 'font-size']) {
        expect(guard, `guard should not pin ${prop}`).not.toContain(prop);
      }
    });
  });

  it('falls back to a typographic tile when a book has no cover', () => {
    const html = assemble('<section>{{BOOK_BREAKDOWN}}</section>', [product({ title: 'Coverless', coverDataUri: null })]);
    expect(html).toContain('cover-fallback');
    expect(html).toContain('Coverless');
  });
});

import { describe, it, expect } from 'vitest';
import { bindTemplate, type BindOutcome } from './bindTemplate';
import type { Result } from '../../domain/shared/Result';

/** Narrows a rejection so the error list can be inspected. */
function rejected(result: Result<BindOutcome, string[]>): string[] {
  if (result.isOk()) throw new Error('expected binding to fail, but it succeeded');
  return result.error;
}

const empty = { scalars: {}, repeats: {} };

describe('bindTemplate', () => {
  it('substitutes a text token', () => {
    const out = bindTemplate('<h1>{{HERO_TITLE}}</h1>', { ...empty, scalars: { HERO_TITLE: 'Fix It Yourself' } });
    expect(out.isOk()).toBe(true);
    expect(out.value.html).toBe('<h1>Fix It Yourself</h1>');
  });

  // The hole v1 had: fillCopySlots wrote model prose into markup unescaped
  // while every other string in the codebase went through esc().
  it('escapes copy so a headline containing markup cannot become markup', () => {
    const out = bindTemplate('<h1>{{HERO_TITLE}}</h1>', {
      ...empty,
      scalars: { HERO_TITLE: 'Brakes & Rotors <script>alert(1)</script>' },
    });
    expect(out.isOk()).toBe(true);
    expect(out.value.html).toBe('<h1>Brakes &amp; Rotors &lt;script&gt;alert(1)&lt;/script&gt;</h1>');
    expect(out.value.html).not.toContain('<script>');
  });

  it('escapes quotes in an attribute context but not in text', () => {
    const attr = bindTemplate('<img src="assets/a.webp" alt="{{BOOK_COVER_ALT}}">', {
      ...empty,
      scalars: { BOOK_COVER_ALT: 'The "Complete" Guide' },
    });
    expect(attr.value.html).toContain('alt="The &quot;Complete&quot; Guide"');

    const text = bindTemplate('<p>{{HERO_SUBTITLE}}</p>', {
      ...empty,
      scalars: { HERO_SUBTITLE: `Don't guess` },
    });
    // An apostrophe is harmless in text and stays readable.
    expect(text.value.html).toBe(`<p>Don't guess</p>`);
  });

  describe('links', () => {
    it('writes the checkout URL verbatim', () => {
      const out = bindTemplate('<a href="{{CHECKOUT_URL}}">Buy</a>', {
        ...empty,
        scalars: { CHECKOUT_URL: 'https://store.example.com/p/abc?ref=x' },
      });
      expect(out.value.html).toBe('<a href="https://store.example.com/p/abc?ref=x">Buy</a>');
    });

    it('refuses a non-https checkout URL', () => {
      const out = bindTemplate('<a href="{{CHECKOUT_URL}}">Buy</a>', {
        ...empty,
        scalars: { CHECKOUT_URL: 'javascript:alert(1)' },
      });
      expect(rejected(out).join(' ')).toContain('must be an https URL');
    });

    // An unresolved href would otherwise render href="", which reloads the page.
    it('renders an unfilled link inert rather than empty', () => {
      const out = bindTemplate('<a href="{{CHECKOUT_URL}}">Buy</a>', empty);
      expect(out.value.html).toBe('<a href="#">Buy</a>');
      expect(out.value.unresolved).toContain('CHECKOUT_URL');
    });
  });

  describe('images', () => {
    it('refuses a remote src so a published page cannot hotlink the template', () => {
      const out = bindTemplate('<img src="{{BOOK_COVER}}">', {
        ...empty,
        scalars: { BOOK_COVER: 'https://themechanicbible.com/cover.png' },
      });
      expect(rejected(out).join(' ')).toContain('local asset path');
    });

    it('accepts a local asset path', () => {
      const out = bindTemplate('<img src="{{BOOK_COVER}}">', {
        ...empty,
        scalars: { BOOK_COVER: 'assets/cover.webp' },
      });
      expect(out.value.html).toBe('<img src="assets/cover.webp">');
    });

    it('removes an optional image that has no value', () => {
      const out = bindTemplate('<div><img src="{{AUTHOR_IMAGE}}" data-optional="AUTHOR_IMAGE"></div>', empty);
      expect(out.value.html).toBe('<div></div>');
      expect(out.value.removedOptional).toContain('AUTHOR_IMAGE');
    });
  });

  describe("the template owner's branding", () => {
    // vintagelifestyleusa.com carries its logo twice — masthead and footer. Only
    // one could be labelled while BRAND_LOGO was single-use, so the other kept
    // that site's own mark and it published under the new seller's name.
    it('removes every logo node when no brand mark was supplied', () => {
      const html =
        '<header><img src="{{BRAND_LOGO}}" data-optional="BRAND_LOGO"></header>' +
        '<footer><img src="{{BRAND_LOGO}}" data-optional="BRAND_LOGO"></footer>';
      const out = bindTemplate(html, empty) as Result<BindOutcome, string[]>;
      expect(out.isOk()).toBe(true);
      expect(out.value.removedOptional).toContain('BRAND_LOGO');
      expect(out.value.html).not.toContain('<img');
      expect(out.value.html).not.toContain('{{BRAND_LOGO}}');
    });

    it("uses the seller's mark when there is one", () => {
      const html = '<header><img src="{{BRAND_LOGO}}" data-optional="BRAND_LOGO"></header>';
      const out = bindTemplate(html, { scalars: { BRAND_LOGO: 'assets/logo.webp' }, repeats: {} });
      expect(out.isOk()).toBe(true);
      expect((out as Result<BindOutcome, string[]>).value.html).toContain('assets/logo.webp');
    });
  });

  describe('html slots', () => {
    // An `html` token writes unescaped markup, so routing model prose into one
    // must take a deliberate act rather than a typo in a key name.
    it('reads only from trustedHtml, never from scalars', () => {
      const out = bindTemplate('<footer>{{FOOTER_LEGAL}}</footer>', {
        ...empty,
        scalars: { FOOTER_LEGAL: '<script>alert(1)</script>' },
      });
      expect(out.value.html).toBe('<footer></footer>');
    });

    it('writes trusted markup unescaped', () => {
      const out = bindTemplate('<footer>{{FOOTER_LEGAL}}</footer>', {
        ...empty,
        trustedHtml: { FOOTER_LEGAL: '<p>© 2026</p>' },
      });
      expect(out.value.html).toBe('<footer><p>© 2026</p></footer>');
    });
  });

  describe('repeaters', () => {
    const template =
      '<div class="cards"><template data-repeat="BENEFITS">' +
      '<div class="card"><h3>{{BENEFITS.title}}</h3><p>{{BENEFITS.body}}</p></div>' +
      '</template></div>';

    it('clones the item once per entry, keeping the item markup identical', () => {
      const out = bindTemplate(template, {
        ...empty,
        repeats: {
          BENEFITS: [
            { title: 'Save money', body: 'Do it yourself' },
            { title: 'Save time', body: 'No booking' },
          ],
        },
      });
      expect(out.value.html).toBe(
        '<div class="cards">' +
          '<div class="card"><h3>Save money</h3><p>Do it yourself</p></div>' +
          '<div class="card"><h3>Save time</h3><p>No booking</p></div>' +
          '</div>',
      );
    });

    it('escapes each field by its own kind', () => {
      const out = bindTemplate(template, {
        ...empty,
        repeats: { BENEFITS: [{ title: 'A & B', body: '<em>x</em>' }] },
      });
      expect(out.value.html).toContain('<h3>A &amp; B</h3>');
      expect(out.value.html).toContain('<p>&lt;em&gt;x&lt;/em&gt;</p>');
    });

    it('removes the region entirely when there is no content for it', () => {
      const out = bindTemplate(template, empty);
      expect(out.value.html).toBe('<div class="cards"></div>');
      expect(out.value.unresolved).toContain('BENEFITS');
    });
  });

  // A three-book page carries up to four different buy links. Every field of a
  // card comes from ONE product record in a single pass, which is what makes a
  // link landing under the wrong cover structurally impossible rather than
  // merely unlikely.
  describe('the offer grid on a multi-book page', () => {
    const grid =
      '<div class="offers"><template data-repeat="OFFER_ITEMS">' +
      '<div class="offer"><img src="{{OFFER_ITEMS.coverSrc}}"><h3>{{OFFER_ITEMS.title}}</h3>' +
      '<span>{{OFFER_ITEMS.price}}</span><a href="{{OFFER_ITEMS.checkoutUrl}}">Buy</a></div>' +
      '</template></div>';

    const three = {
      ...empty,
      repeats: {
        OFFER_ITEMS: [
          { title: 'Book One', price: '$27', checkoutUrl: 'https://store.example.com/one', coverSrc: 'assets/cover.webp' },
          { title: 'Book Two', price: '$27', checkoutUrl: 'https://store.example.com/two', coverSrc: 'assets/cover-1.webp' },
          { title: 'Book Three', price: '$27', checkoutUrl: 'https://store.example.com/three', coverSrc: 'assets/cover-2.webp' },
        ],
      },
    };

    it('gives every book its own cover, price and buy link', () => {
      const html = bindTemplate(grid, three).value.html;
      expect(html).toContain('<a href="https://store.example.com/one">');
      expect(html).toContain('<a href="https://store.example.com/two">');
      expect(html).toContain('<a href="https://store.example.com/three">');
      expect(html).toContain('src="assets/cover.webp"');
      expect(html).toContain('src="assets/cover-1.webp"');
      expect(html).toContain('src="assets/cover-2.webp"');
    });

    // Repeating one cover is how a page selling three books came back showing
    // the first book three times.
    it('never repeats one book’s cover across the cards', () => {
      const html = bindTemplate(grid, three).value.html;
      const covers = [...html.matchAll(/src="(assets\/[^"]+)"/g)].map((m) => m[1]);
      expect(new Set(covers).size).toBe(3);
    });

    it('pairs each link with its own card rather than crossing them', () => {
      const html = bindTemplate(grid, three).value.html;
      const cards = html.split('<div class="offer">').slice(1);
      expect(cards[0]).toContain('Book One');
      expect(cards[0]).toContain('store.example.com/one');
      expect(cards[2]).toContain('Book Three');
      expect(cards[2]).toContain('store.example.com/three');
    });

    it('renders a card inert when its link is not set yet, without failing', () => {
      const out = bindTemplate(grid, {
        ...empty,
        repeats: { OFFER_ITEMS: [{ title: 'Book One', price: '$27', coverSrc: 'assets/cover.webp' }] },
      });
      expect(out.isOk()).toBe(true);
      expect(out.value.html).toContain('<a href="#">');
    });

    it('carries the bundle card alongside the books', () => {
      const html = bindTemplate(grid, {
        ...empty,
        repeats: {
          OFFER_ITEMS: [
            ...three.repeats.OFFER_ITEMS,
            { title: 'The complete set — all 3 books', price: '$47', checkoutUrl: 'https://store.example.com/bundle' },
          ],
        },
      }).value.html;
      expect(html).toContain('The complete set');
      expect(html).toContain('store.example.com/bundle');
      expect(html.split('<div class="offer">').length - 1).toBe(4);
    });
  });

  /**
   * The shape the reference template actually uses: three book cards, each with
   * its own bullet list. The expander used to resolve the INNER region first,
   * against the page-level list, so all three cards showed book one's bullets —
   * the same "one book's content three times" defect the rest of the system
   * exists to prevent, reproduced inside the binder.
   */
  describe('nested repeating regions', () => {
    const cards =
      '<div class="books"><template data-repeat="OFFER_ITEMS">' +
      '<div class="book"><h3>{{OFFER_ITEMS.title}}</h3>' +
      '<ul><template data-repeat="BENEFITS"><li>{{BENEFITS.title}}</li></template></ul>' +
      '</div></template></div>';

    it('gives each card its own nested list', () => {
      const html = bindTemplate(cards, {
        ...empty,
        repeats: {
          OFFER_ITEMS: [
            { title: 'Book One', BENEFITS: [{ title: 'one-a' }, { title: 'one-b' }] },
            { title: 'Book Two', BENEFITS: [{ title: 'two-a' }] },
            { title: 'Book Three', BENEFITS: [{ title: 'three-a' }, { title: 'three-b' }] },
          ],
        },
      }).value.html;

      const books = html.split('<div class="book">').slice(1);
      expect(books).toHaveLength(3);
      expect(books[0]).toContain('one-a');
      expect(books[0]).toContain('one-b');
      expect(books[0]).not.toContain('two-a');
      expect(books[1]).toContain('two-a');
      expect(books[1]).not.toContain('one-a');
      expect(books[2]).toContain('three-b');
      expect(books[2]).not.toContain('one-a');
    });

    it('never repeats one card’s bullets under the others', () => {
      const html = bindTemplate(cards, {
        ...empty,
        repeats: {
          OFFER_ITEMS: [
            { title: 'Book One', BENEFITS: [{ title: 'only-book-one' }] },
            { title: 'Book Two', BENEFITS: [{ title: 'only-book-two' }] },
          ],
        },
      }).value.html;
      expect(html.split('only-book-one').length - 1).toBe(1);
      expect(html.split('only-book-two').length - 1).toBe(1);
    });

    // Silence beats a lie: a card with no list of its own renders none, rather
    // than borrowing the page-level one and showing another book's content.
    it('leaves a card empty rather than borrowing a shared list', () => {
      const html = bindTemplate(cards, {
        ...empty,
        repeats: {
          OFFER_ITEMS: [{ title: 'Book One' }, { title: 'Book Two' }],
          BENEFITS: [{ title: 'page-level' }],
        },
      }).value.html;
      expect(html).not.toContain('page-level');
    });

    // With ONE card there is no ambiguity about whose content it is.
    it('uses the page-level list when the outer region has a single item', () => {
      const html = bindTemplate(cards, {
        ...empty,
        repeats: { OFFER_ITEMS: [{ title: 'The Book' }], BENEFITS: [{ title: 'page-level' }] },
      }).value.html;
      expect(html).toContain('page-level');
    });

    it('escapes nested values by their own kind', () => {
      const html = bindTemplate(cards, {
        ...empty,
        repeats: { OFFER_ITEMS: [{ title: 'A & B', BENEFITS: [{ title: '<em>x</em>' }] }] },
      }).value.html;
      expect(html).toContain('<h3>A &amp; B</h3>');
      expect(html).toContain('<li>&lt;em&gt;x&lt;/em&gt;</li>');
    });

    it('does not hang on an unbalanced template tag', () => {
      const out = bindTemplate('<div><template data-repeat="FAQ_ITEMS"><li>{{FAQ_ITEMS.question}}</li></div>', {
        ...empty,
        repeats: { FAQ_ITEMS: [{ question: 'A?' }] },
      });
      expect(out.isOk()).toBe(true);
    });
  });

  it('strips extraction scaffolding so it never reaches a buyer', () => {
    const out = bindTemplate('<h1 data-tpl="n4" class="x">{{HERO_TITLE}}</h1>', {
      ...empty,
      scalars: { HERO_TITLE: 'Hi' },
    });
    expect(out.value.html).toBe('<h1 class="x">Hi</h1>');
  });

  it('fails on an unknown token rather than shipping literal braces', () => {
    const out = bindTemplate('<p>{{NOT_A_REAL_TOKEN}}</p>', empty);
    expect(rejected(out).join(' ')).toContain('Unknown token');
  });

  it('reports a required token that was not supplied', () => {
    const out = bindTemplate('<h1>{{HERO_TITLE}}</h1>', empty, { required: ['HERO_TITLE'] });
    expect(rejected(out).join(' ')).toContain('{{HERO_TITLE}} is required');
  });
});

import { describe, it, expect } from 'vitest';
import {
  PLACEHOLDERS,
  fillPlaceholders,
  fillCopySlots,
  validateGeneratedPage,
  type GeneratedPage,
} from './pageContract';

/** A page that satisfies the contract; each test breaks one thing. */
function page(overrides: Partial<GeneratedPage> = {}): GeneratedPage {
  return {
    css: `
      body { background: var(--bg); color: var(--text); font-family: Georgia, serif; }
      .cta { background: var(--accent); color: var(--accent-contrast); }
      .card { box-shadow: 0 10px 30px rgba(0,0,0,.3); }
    `,
    bodyHtml: `
      <section data-section="hero"><h1>A headline</h1>{{COVER}}{{PRICE}}{{CTA_BUTTON}}</section>
      <section data-section="inside"><h2>Inside</h2>{{CONTENTS}}</section>
      <section data-section="order"><h2>Order</h2>{{PRICE}}{{CTA_BUTTON}}{{GUARANTEE}}{{PAYMENT_MARKS}}</section>
      <section data-section="faq"><h2>Questions</h2><p>Answers.</p></section>
      <footer>{{FOOTER_LEGAL}}</footer>
    `,
    ...overrides,
  };
}

const errorsOf = (p: GeneratedPage) => (validateGeneratedPage(p) as { error?: string[] }).error ?? [];

describe('validateGeneratedPage', () => {
  it('accepts a page that meets the contract', () => {
    expect(validateGeneratedPage(page()).isOk()).toBe(true);
  });

  // A three-book layout that followed the prompt exactly was rejected for
  // omitting {{COVER}}. The prompt tells the model to use {{COVER_STACK}} for
  // the set and {{BOOK_BREAKDOWN}} for the per-book section, and describes
  // {{COVER}} as being for "where the template shows a single book" — which on
  // a three-book page is nowhere. The repair round could only repeat the demand
  // that contradicted those instructions, so all three attempts failed the same
  // way and every three-book page fell back to the built-in template.
  describe('cover art on a multi-book page', () => {
    const multiBook = (covers: string) =>
      page({
        bodyHtml: `
          <section data-section="hero"><h1>A headline</h1>${covers}{{CTA_BUTTON}}</section>
          <section data-section="inside"><h2>Inside</h2>{{BOOK_BREAKDOWN}}</section>
          <section data-section="order"><h2>Order</h2>{{OFFER_GRID}}</section>
          <section data-section="faq"><h2>Questions</h2><p>Answers.</p></section>
          <footer>{{PRICE}}{{FOOTER_LEGAL}}</footer>
        `,
      });

    it('accepts {{COVER_STACK}} in place of {{COVER}}', () => {
      const result = validateGeneratedPage(multiBook('{{COVER_STACK}}'), { productCount: 3 });
      expect(result.isOk()).toBe(true);
    });

    it('accepts {{BOOK_BREAKDOWN}} alone as the way the books are shown', () => {
      const result = validateGeneratedPage(
        page({
          bodyHtml: `
            <section data-section="hero"><h1>A headline</h1>{{CTA_BUTTON}}</section>
            <section data-section="inside"><h2>Inside</h2>{{BOOK_BREAKDOWN}}</section>
            <section data-section="order"><h2>Order</h2>{{OFFER_GRID}}</section>
            <section data-section="faq"><h2>Questions</h2><p>Answers.</p></section>
            <footer>{{PRICE}}{{FOOTER_LEGAL}}</footer>
          `,
        }),
        { productCount: 3 },
      );
      expect(result.isOk()).toBe(true);
    });

    it('still requires SOME cover art on a multi-book page', () => {
      const errors = (
        validateGeneratedPage(
          page({
            bodyHtml: `
              <section data-section="hero"><h1>A headline</h1>{{CTA_BUTTON}}</section>
              <section data-section="inside"><h2>Inside</h2></section>
              <section data-section="order"><h2>Order</h2>{{OFFER_GRID}}</section>
              <section data-section="faq"><h2>Questions</h2><p>Answers.</p></section>
              <footer>{{PRICE}}{{FOOTER_LEGAL}}</footer>
            `,
          }),
          { productCount: 3 },
        ) as { error?: string[] }
      ).error ?? [];
      expect(errors.join(' ')).toContain('shows no per-book covers');
    });

    // The relaxation is scoped to multi-book pages. A single-book page has no
    // other placeholder that shows the product, so {{COVER}} stays mandatory.
    it('still requires {{COVER}} on a single-book page', () => {
      const errors = errorsOf(page({ bodyHtml: page().bodyHtml.replace('{{COVER}}', '') }));
      expect(errors.join(' ')).toContain('Missing required placeholder {{COVER}}');
    });
  });

  // Every error goes back to the model in one repair round, so it must report
  // all of them rather than stopping at the first.
  it('reports every problem at once', () => {
    const errors = errorsOf({
      css: 'body { color: #ff0000; }',
      bodyHtml: '<section data-section="hero"><script>x()</script></section>',
    });
    expect(errors.length).toBeGreaterThan(4);
    expect(errors.some((e) => e.includes('Scripts'))).toBe(true);
    expect(errors.some((e) => e.includes('Raw colour'))).toBe(true);
    expect(errors.some((e) => e.includes('{{CTA_BUTTON}}'))).toBe(true);
  });

  describe('placeholders', () => {
    it.each([PLACEHOLDERS.cta, PLACEHOLDERS.price, PLACEHOLDERS.cover, PLACEHOLDERS.legal])(
      'requires %s',
      (token) => {
        const p = page({ bodyHtml: page().bodyHtml.split(token).join('') });
        expect(errorsOf(p).some((e) => e.includes(token))).toBe(true);
      },
    );

    it('allows the CTA and price to repeat', () => {
      expect(validateGeneratedPage(page()).isOk()).toBe(true);
    });

    it('rejects a second legal block', () => {
      const p = page({ bodyHtml: `${page().bodyHtml}<footer>{{FOOTER_LEGAL}}</footer>` });
      expect(errorsOf(p).some((e) => e.includes('exactly once'))).toBe(true);
    });

    // How the model fakes a three-tier offer grid out of one book: repeat the
    // buy button and price into invented "editions".
    it('caps runaway repetition while allowing template-faithful repeats', () => {
      // A template legitimately repeats its buy button and cover several times —
      // production run 1489a338 was rejected for exactly that. Only true spam trips.
      const faithful = page({
        bodyHtml: page().bodyHtml + '{{CTA_BUTTON}}{{CTA_BUTTON}}{{CTA_BUTTON}}{{COVER}}{{COVER}}{{PRICE}}',
      });
      expect(validateGeneratedPage(faithful).isOk()).toBe(true);

      const spam = page({
        bodyHtml: page().bodyHtml + '{{CTA_BUTTON}}'.repeat(5) + '{{COVER}}'.repeat(6) + '{{PRICE}}'.repeat(2),
      });
      const errors = errorsOf(spam);
      expect(errors.some((e) => e.includes('{{CTA_BUTTON}} may appear at most 6'))).toBe(true);
      expect(errors.some((e) => e.includes('{{COVER}} may appear at most 6'))).toBe(true);
      expect(errors.some((e) => e.includes('{{PRICE}} may appear at most 3'))).toBe(true);
    });

    // Copying a template's accent-highlight inside a headline wraps approved
    // words in a span. Production run 1489a338 was rejected for this; the check
    // must see words, not markup.
    it('accepts approved copy wrapped in styling tags', () => {
      const p = page({
        bodyHtml: page().bodyHtml.replace(
          '<h1>A headline</h1>',
          '<h1>A <span class="hl">headline</span></h1>',
        ),
      });
      expect(validateGeneratedPage(p, { requiredText: ['A headline'] }).isOk()).toBe(true);
    });

    it('still rejects changed words', () => {
      const p = page();
      const result = validateGeneratedPage(p, { requiredText: ['A better headline'] });
      expect(result.isFail()).toBe(true);
    });

    // An unrecognised token would reach a buyer as literal braces on the page.
    it('rejects invented placeholders', () => {
      const p = page({ bodyHtml: page().bodyHtml.replace('{{CONTENTS}}', '{{BONUS_STACK}}') });
      expect(errorsOf(p).some((e) => e.includes('{{BONUS_STACK}}'))).toBe(true);
    });
  });

  // A generated page shipped with a 460x575 portrait sitting over its own
  // sticky header, hiding the brand and the hero behind it.
  describe('top bar', () => {
    it.each([PLACEHOLDERS.cover, PLACEHOLDERS.authorPhoto])('rejects %s above the first section', (token) => {
      const p = page({ bodyHtml: `<header>${token}</header>${page().bodyHtml}` });
      expect(errorsOf(p).some((e) => e.includes('appears in the top bar'))).toBe(true);
    });

    it('allows the logo and the buy button up there', () => {
      const p = page({
        bodyHtml: `<header>{{LOGO}}{{CTA_BUTTON}}</header>${page().bodyHtml}`,
      });
      expect(errorsOf(p).some((e) => e.includes('top bar'))).toBe(false);
    });
  });

  // {{COVER}} renders the featured book however often it appears, so a
  // three-book hero built from repeats showed the same book three times.
  describe('multi-book covers', () => {
    it('rejects repeated {{COVER}} on a page selling several books', () => {
      const p = page({ bodyHtml: page().bodyHtml + '{{COVER}}{{COVER}}' });
      const errors = (validateGeneratedPage(p, { productCount: 3 }) as { error?: string[] }).error ?? [];
      expect(errors.some((e) => e.includes('cannot show a set'))).toBe(true);
    });

    it('leaves single-book pages free to repeat it', () => {
      const p = page({ bodyHtml: page().bodyHtml + '{{COVER}}{{COVER}}' });
      expect(errorsOf(p).some((e) => e.includes('cannot show a set'))).toBe(false);
    });

    // Without one of these, every book on the page is represented by the
    // featured book's cover.
    it('requires per-book covers somewhere on a multi-book page', () => {
      const errors = (validateGeneratedPage(page(), { productCount: 3 }) as { error?: string[] }).error ?? [];
      expect(errors.some((e) => e.includes('shows no per-book covers'))).toBe(true);
    });

    it.each([PLACEHOLDERS.bookBreakdown, PLACEHOLDERS.coverStack])('accepts %s as that proof', (token) => {
      const p = page({ bodyHtml: `${page().bodyHtml}<section>${token}{{OFFER_GRID}}</section>` });
      const errors = (validateGeneratedPage(p, { productCount: 3 }) as { error?: string[] }).error ?? [];
      expect(errors.some((e) => e.includes('shows no per-book covers'))).toBe(false);
    });

    // A loose price beside the grid reads as a fourth, nameless offer.
    it('rejects a loose price or button in the offer grid section', () => {
      const p = page({
        bodyHtml: page().bodyHtml + '<section>{{OFFER_GRID}}{{PRICE}}{{CTA_BUTTON}}</section>',
      });
      const errors = errorsOf(p);
      expect(errors.some((e) => e.includes('same section as {{OFFER_GRID}}'))).toBe(true);
    });

    // The three-book reference ends on its offer grid, so the closing call to
    // action and the footer follow the last </section>. Bounded on the opening
    // tag alone they were read as sitting INSIDE the grid's section, and every
    // layout attempt was rejected for a placeholder that was already where the
    // repair round kept telling the model to put it.
    it('allows a closing price and button after the offer grid section closes', () => {
      const p = page({
        bodyHtml:
          '<section data-section="hero"><h1>A headline</h1>{{COVER}}</section>' +
          '<section data-section="inside"><h2>Inside</h2>{{BOOK_BREAKDOWN}}</section>' +
          '<section data-section="faq"><h2>Questions</h2></section>' +
          '<section data-section="order"><h2>Order</h2>{{OFFER_GRID}}</section>' +
          '<div class="last-call"><h2>Last call</h2>{{PRICE}}{{CTA_BUTTON}}</div>' +
          '<footer>{{FOOTER_LEGAL}}</footer>',
      });
      const errors = (validateGeneratedPage(p, { productCount: 3 }) as { error?: string[] }).error ?? [];
      expect(errors.some((e) => e.includes('same section as {{OFFER_GRID}}'))).toBe(false);
    });

    it('caps the book breakdown at one placement', () => {
      const p = page({ bodyHtml: page().bodyHtml + '{{BOOK_BREAKDOWN}}'.repeat(2) });
      expect(errorsOf(p).some((e) => e.includes('{{BOOK_BREAKDOWN}} may appear at most once'))).toBe(true);
    });

    it('caps the cover stack at two placements', () => {
      const p = page({ bodyHtml: page().bodyHtml + '{{COVER_STACK}}'.repeat(3) });
      expect(errorsOf(p).some((e) => e.includes('{{COVER_STACK}} may appear at most 2'))).toBe(true);
    });
  });

  describe('structure', () => {
    it.each(['hero', 'order'])('requires the %s section', (name) => {
      const p = page({ bodyHtml: page().bodyHtml.replace(`data-section="${name}"`, 'data-x="y"') });
      expect(errorsOf(p).some((e) => e.includes(name))).toBe(true);
    });

    // Requiring these forced a layout to invent them: a reference with no FAQ
    // and no chapter grid still produced both, and the page stopped reading as
    // a copy of that site. Only hero and order are structural.
    it.each(['inside', 'faq'])('does NOT require the %s section — the reference decides', (name) => {
      const p = page({ bodyHtml: page().bodyHtml.replace(`data-section="${name}"`, 'data-x="y"') });
      expect(errorsOf(p).some((e) => e.includes(`data-section="${name}"`))).toBe(false);
    });

    // Truncated completions are the common failure and show up here first.
    it('catches unbalanced tags from a truncated completion', () => {
      const p = page({ bodyHtml: `${page().bodyHtml}<section data-section="extra"><div><p>cut off` });
      const errors = errorsOf(p);
      expect(errors.some((e) => e.includes('Unbalanced <div>'))).toBe(true);
      expect(errors.some((e) => e.includes('Unbalanced <p>'))).toBe(true);
    });
  });

  describe('executable and external content', () => {
    it.each([
      ['<script>alert(1)</script>', 'Scripts'],
      ['<iframe src="x"></iframe>', 'Embeds'],
      ['<form><input></form>', 'Embeds'],
      ['<div onclick="go()"></div>', 'event handlers'],
      ['<a href="javascript:go()">x</a>', 'javascript:'],
      ['<img src="https://cdn.example.com/a.png">', 'external URLs'],
    ])('rejects %s', (snippet, expected) => {
      const p = page({ bodyHtml: page().bodyHtml + snippet });
      expect(errorsOf(p).some((e) => e.includes(expected))).toBe(true);
    });

    it('rejects remote CSS', () => {
      expect(errorsOf(page({ css: "@import url('https://fonts.example/x.css');" })).length).toBeGreaterThan(0);
      expect(
        errorsOf(page({ css: "body { background: url('https://x.test/bg.png'); }" })).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('imagery', () => {
    // The reference sites these pages copy are image-led — dish photos, product
    // shots, payment marks. We have the cover, maybe an author photo, and
    // nothing else, so a figure the model writes itself is a hole on the page.
    it.each([
      ['<img src="">', 'empty src'],
      ['<img src="dishes/stew.webp">', 'a relative path'],
      ['<img alt="a photo of the author">', 'no src at all'],
      ['<figure><img src="./hero.jpg"><figcaption>Sunday dinner</figcaption></figure>', 'a captioned figure'],
    ])('rejects an <img> the model wrote itself — %s (%s)', (snippet) => {
      const bad = page({ bodyHtml: page().bodyHtml + snippet });
      expect(errorsOf(bad).some((e) => e.includes('No <img> tags'))).toBe(true);
    });

    it('accepts a page whose only pictures are placeholders', () => {
      // {{COVER}} and {{AUTHOR_PHOTO}} become <img> tags at ASSEMBLY time, which
      // is after this check — so the clean page has no <img> in it at all.
      const good = page({
        bodyHtml: page().bodyHtml + '<section data-section="author">{{AUTHOR_PHOTO}}<p>Who wrote it.</p></section>',
      });
      expect(errorsOf(good).some((e) => e.includes('No <img> tags'))).toBe(false);
    });
  });

  describe('colour discipline', () => {
    // The palette is derived from the cover and its contrast is already proven.
    // A raw colour would bypass that guarantee entirely.
    it.each(['#ff0000', 'rgb(255,0,0)', 'hsl(200, 50%, 50%)'])('rejects the raw colour %s', (colour) => {
      const p = page({ css: `${page().css}\n.x { color: ${colour}; }` });
      expect(errorsOf(p).some((e) => e.includes('Raw colour'))).toBe(true);
    });

    it('allows translucent black and white for shadows and scrims', () => {
      const p = page({ css: `${page().css}\n.a{background:rgba(255,255,255,.06)}\n.b{color:rgba(0,0,0,.5)}` });
      expect(validateGeneratedPage(p).isOk()).toBe(true);
    });

    it('rejects a tinted rgba that could wash out text', () => {
      const p = page({ css: `${page().css}\n.a { color: rgba(200, 30, 30, .9); }` });
      expect(errorsOf(p).some((e) => e.includes('Raw colour'))).toBe(true);
    });

    it('rejects unknown variables but allows the model’s own --x- prefix', () => {
      expect(errorsOf(page({ css: '.a { color: var(--brand-blue); }' })).some((e) => e.includes('--brand-blue'))).toBe(
        true,
      );
      const ok = page({ css: `${page().css}\n:root{--x-gap:20px}\n.a{gap:var(--x-gap)}` });
      expect(validateGeneratedPage(ok).isOk()).toBe(true);
    });
  });

  it('rejects a page too large to be one', () => {
    expect(errorsOf(page({ css: 'a{}'.repeat(60_000) })).some((e) => e.includes('CSS is'))).toBe(true);
  });
});

describe('reusable layout slots', () => {
  /** A layout that satisfies the slot contract. */
  function layout(over: Partial<GeneratedPage> = {}): GeneratedPage {
    const keys = ['hero.headline', 'hero.subheadline', 'inside.heading', 's1.a', 's1.b', 's2.a', 'faq.q1', 'faq.a1'];
    return {
      css: 'body { background: var(--bg); }',
      slots: [
        ...keys.map((key) => ({ key, purpose: `Text for ${key}`, maxChars: 120 })),
        // Declared but never placed — the system writes it into the button.
        { key: 'cta.label', purpose: 'Button label', maxChars: 28 },
      ],
      bodyHtml:
        `<section data-section="hero">${keys
          .slice(0, 2)
          .map((k) => `<p>{{COPY:${k}}}</p>`)
          .join('')}{{COVER}}{{PRICE}}{{CTA_BUTTON}}</section>` +
        `<section data-section="inside">${keys
          .slice(2)
          .map((k) => `<p>{{COPY:${k}}}</p>`)
          .join('')}{{CONTENTS}}</section>` +
        '<section data-section="order"></section><section data-section="faq"></section>' +
        '<footer>{{FOOTER_LEGAL}}</footer>',
      ...over,
    };
  }

  const slotErrors = (p: GeneratedPage) =>
    (validateGeneratedPage(p, { expectSlots: true }) as { error?: string[] }).error ?? [];

  it('accepts a layout whose prose is entirely slots', () => {
    expect(validateGeneratedPage(layout(), { expectSlots: true }).isOk()).toBe(true);
  });

  // This exact combination made every layout unpassable: cta.label was required
  // to be declared, every declared slot had to be placed, and placing it would
  // print the button's label twice. Nothing could satisfy all three.
  it('requires cta.label to be declared but NOT placed', () => {
    const placed = layout({
      bodyHtml: layout().bodyHtml.replace('{{CTA_BUTTON}}', '{{CTA_BUTTON}}{{COPY:cta.label}}'),
    });
    expect(slotErrors(placed).some((e) => e.includes('must NOT appear in the markup'))).toBe(true);

    const undeclared = layout({ slots: layout().slots!.filter((s) => s.key !== 'cta.label') });
    expect(slotErrors(undeclared).some((e) => e.includes('"cta.label" is required'))).toBe(true);
  });

  it('rejects a layout with no slots at all', () => {
    expect(slotErrors(layout({ slots: [] })).some((e) => e.includes('must be reusable'))).toBe(true);
  });

  it('catches tokens and declarations that disagree', () => {
    const undeclaredToken = layout({
      bodyHtml: layout().bodyHtml.replace('{{COPY:hero.headline}}', '{{COPY:hero.mystery}}'),
    });
    const errors = slotErrors(undeclaredToken);
    expect(errors.some((e) => e.includes('{{COPY:hero.mystery}} is used'))).toBe(true);
    expect(errors.some((e) => e.includes('"hero.headline" is declared but never placed'))).toBe(true);
  });

  it('rejects the same slot placed twice', () => {
    const twice = layout({ bodyHtml: `${layout().bodyHtml}<p>{{COPY:faq.q1}}</p>` });
    expect(slotErrors(twice).some((e) => e.includes('appears more than once'))).toBe(true);
  });

  it('fills slots and drops any the copy call left out', () => {
    const filled = fillCopySlots('<h1>{{COPY:a}}</h1><p>{{COPY:b}}</p>', { a: 'Hello' });
    expect(filled).toBe('<h1>Hello</h1><p></p>');
  });
});

describe('fillPlaceholders', () => {
  it('substitutes every placeholder, including repeats', () => {
    const out = fillPlaceholders(page().bodyHtml, {
      cta: '<a href="https://payhip.com/b/X">Buy</a>',
      price: '<span>$27</span>',
      cover: '<img src="data:image/png;base64,AA">',
      guarantee: '<p>30 days</p>',
      paymentMarks: '<p>Visa</p>',
      testimonials: '',
      contents: '<ul><li>One</li></ul>',
      contentsList: '<ul class="contents-list"><li>One</li></ul>',
      legal: '<p>Disclaimer</p>',
      logo: '<img src="data:image/png;base64,BB">',
      offerGrid: '<div class="offers"></div>',
      authorPhoto: '<img src="data:image/png;base64,CC">',
      coverStack: '<div class="cover-stack"></div>',
      bookBreakdown: '<div class="books"></div>',
    });

    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/); // nothing left unsubstituted
    expect(out.split('https://payhip.com/b/X').length - 1).toBe(2); // both CTAs
    expect(out).toContain('$27');
  });

  it('drops a placeholder whose content is empty', () => {
    const out = fillPlaceholders('<div>{{TESTIMONIALS}}</div>', {
      cta: '', price: '', cover: '', guarantee: '', paymentMarks: '', testimonials: '', contents: '',
      contentsList: '', legal: '', logo: '', offerGrid: '', authorPhoto: '', coverStack: '', bookBreakdown: '',
    });
    expect(out).toBe('<div></div>');
  });
});

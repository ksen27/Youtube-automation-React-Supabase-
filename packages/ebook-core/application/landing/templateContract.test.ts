import { describe, it, expect } from 'vitest';
import { validateTemplate, validateBoundPage } from './templateContract';
import type { Finding, PlaceholderEntry, RepeaterEntry } from '../../domain/landing/TemplateManifest';
import type { Result } from '../../domain/shared/Result';

/** Narrows a rejection so the findings can be inspected. */
function rejected(result: Result<void, Finding[]>): Finding[] {
  if (result.isOk()) throw new Error('expected the template to be rejected, but it passed');
  return result.error;
}

function placeholder(placeholderName: string, overrides: Partial<PlaceholderEntry> = {}): PlaceholderEntry {
  return {
    tplId: 'n1',
    placeholder: placeholderName,
    kind: 'text',
    maxChars: 60,
    originalText: 'original',
    hadInlineMarkup: false,
    ...overrides,
  };
}

/** A template carrying every required token, so a test can remove just one. */
const COMPLETE_HTML =
  '<h1>{{HERO_TITLE}}</h1><p>{{HERO_SUBTITLE}}</p><img src="{{BOOK_COVER}}">' +
  '<a href="{{CHECKOUT_URL}}">{{CTA_TEXT}}</a><span>{{PRICE}}</span>' +
  '<span>{{BRAND_NAME}}</span><footer>{{FOOTER_LEGAL}}</footer>';

function baseInput(overrides: Partial<Parameters<typeof validateTemplate>[0]> = {}) {
  return {
    html: COMPLETE_HTML,
    placeholders: [placeholder('HERO_TITLE')],
    repeaters: [] as RepeaterEntry[],
    sourceHost: 'themechanicbible.com',
    originalCtaCount: 1,
    sectionCount: 6,
    ...overrides,
  };
}

describe('validateTemplate', () => {
  it('passes a template carrying every required token', () => {
    expect(validateTemplate(baseInput()).isOk()).toBe(true);
  });

  it('blocks when a genuinely required token was never assigned to a node', () => {
    const result = validateTemplate(baseInput({ html: COMPLETE_HTML.replace('{{BRAND_NAME}}', 'The Mechanic Bible') }));
    expect(rejected(result).map((f: Finding) => f.code)).toContain('MISSING_REQUIRED_PLACEHOLDER');
  });

  /**
   * Requirements describe what the SELLER needs, not what one template happens
   * to contain. Demanding a {{PRICE}} label outright meant a lead-magnet page
   * with no price element could never be extracted, however cleanly it cloned —
   * a real template failed exactly that way with 31 placeholders labelled.
   */
  describe('a template that simply does not have one of the optional parts', () => {
    it('extracts fine when it shows no price at all', () => {
      const result = validateTemplate(baseInput({ html: COMPLETE_HTML.replace('<span>{{PRICE}}</span>', '') }));
      expect(result.isOk()).toBe(true);
    });

    it('extracts fine with no hero subtitle', () => {
      const result = validateTemplate(baseInput({ html: COMPLETE_HTML.replace('<p>{{HERO_SUBTITLE}}</p>', '') }));
      expect(result.isOk()).toBe(true);
    });

    // A leftover price is recorded, not refused. On a page about saving money
    // on airfare, "$1,400" is the subject of the copy — refusing the template
    // rejected one that cloned perfectly. Which figure matters can only be
    // decided once the seller's own price is known, so the decision moves to
    // bind time.
    it("only warns when the template's own price survived unlabelled", () => {
      const result = validateTemplate(baseInput({ html: COMPLETE_HTML.replace('{{PRICE}}', '$47') }));
      expect(result.isOk()).toBe(true);
    });
  });

  /**
   * The first real extraction failed on all three of these. Two were the same
   * mistake the v1 contract made with {{COVER}}: demanding one specific
   * placeholder when a multi-product template legitimately uses another, so
   * there was no answer the model could give that would pass.
   */
  describe('requirements a multi-product template cannot meet literally', () => {
    it('accepts covers living in the product repeater instead of a single BOOK_COVER', () => {
      const html =
        COMPLETE_HTML.replace('<img src="{{BOOK_COVER}}">', '') +
        '<div><template data-repeat="OFFER_ITEMS"><img src="{{OFFER_ITEMS.coverSrc}}"></template></div>';
      const result = validateTemplate(
        baseInput({
          html,
          repeaters: [
            { key: 'OFFER_ITEMS', containerTplId: 'n9', itemTplId: 'n10', originalCount: 3, flexibleCount: false, fields: ['coverSrc'] },
          ],
        }),
      );
      expect(result.isOk()).toBe(true);
    });

    it('still requires cover art when there is no product repeater either', () => {
      const result = validateTemplate(baseInput({ html: COMPLETE_HTML.replace('<img src="{{BOOK_COVER}}">', '') }));
      expect(rejected(result).map((f: Finding) => f.code)).toContain('MISSING_REQUIRED_PLACEHOLDER');
    });

    // Missing one is a live link to the owner's store. An extra one points at
    // the seller's own checkout and costs nothing, so it must not be fatal.
    it('warns rather than blocks when MORE buy buttons were labelled than detected', () => {
      const html = `${COMPLETE_HTML}<a href="{{CHECKOUT_URL}}">Buy again</a>`;
      const result = validateTemplate(baseInput({ html, originalCtaCount: 1 }));
      expect(result.isOk()).toBe(true);
    });

    it('still blocks when FEWER were labelled than the template had', () => {
      const result = validateTemplate(baseInput({ originalCtaCount: 4 }));
      const finding = rejected(result).find((f: Finding) => f.code === 'CTA_COUNT_CHANGED');
      expect(finding?.message).toContain('only 1');
    });
  });

  it('blocks a link still pointing at the template owner', () => {
    const result = validateTemplate(
      baseInput({ html: `${COMPLETE_HTML}<a href="https://themechanicbible.com/buy">Buy</a>` }),
    );
    expect(rejected(result).map((f: Finding) => f.code)).toContain('SOURCE_LINK_SURVIVED');
  });

  it('ignores the www prefix when matching the source host', () => {
    const result = validateTemplate(
      baseInput({ html: `${COMPLETE_HTML}<img src="https://www.themechanicbible.com/hero.png">` }),
    );
    expect(rejected(result).map((f: Finding) => f.code)).toContain('SOURCE_LINK_SURVIVED');
  });

  it.each([
    ['<script>x()</script>', 'SCRIPT_SURVIVED'],
    ['<iframe src="x"></iframe>', 'EMBED_SURVIVED'],
    ['<form action="/x"></form>', 'FORM_SURVIVED'],
    ['<div onclick="x()"></div>', 'INLINE_HANDLER'],
  ])('blocks executable content that survived cleaning: %s', (fragment, code) => {
    const result = validateTemplate(baseInput({ html: COMPLETE_HTML + fragment }));
    expect(rejected(result).map((f: Finding) => f.code)).toContain(code);
  });

  it('blocks an app shell that never rendered', () => {
    const result = validateTemplate(baseInput({ sectionCount: 1 }));
    expect(rejected(result).map((f: Finding) => f.code)).toContain('TOO_FEW_SECTIONS');
  });

  it('blocks a token the system has no way to fill', () => {
    const result = validateTemplate(baseInput({ html: `${COMPLETE_HTML}<p>{{MADE_UP}}</p>` }));
    expect(rejected(result).map((f: Finding) => f.code)).toContain('UNKNOWN_TOKEN');
  });

  describe('repeaters', () => {
    const withRepeater = `${COMPLETE_HTML}<div><template data-repeat="BENEFITS"><p>{{BENEFITS.title}}</p></template></div>`;
    const declared: RepeaterEntry = {
      key: 'BENEFITS',
      containerTplId: 'n9',
      itemTplId: 'n10',
      originalCount: 3,
      flexibleCount: false,
      fields: ['title'],
    };

    it('accepts a declared repeater placed in the markup', () => {
      expect(validateTemplate(baseInput({ html: withRepeater, repeaters: [declared] })).isOk()).toBe(true);
    });

    it('blocks a repeater in the markup that is not in the map', () => {
      const result = validateTemplate(baseInput({ html: withRepeater, repeaters: [] }));
      expect(rejected(result).map((f: Finding) => f.code)).toContain('UNDECLARED_REPEATER');
    });

    it('blocks a declared repeater with no <template> in the markup', () => {
      const result = validateTemplate(baseInput({ repeaters: [declared] }));
      expect(rejected(result).map((f: Finding) => f.code)).toContain('REPEATER_NOT_PLACED');
    });
  });
});

describe('validateBoundPage', () => {
  const bound =
    '<h1>Fix It Yourself</h1><img src="assets/cover.webp" alt="cover">' +
    '<a href="https://store.example.com/p/1">Get it</a>';

  it('passes a clean bound page', () => {
    const findings = validateBoundPage({
      html: bound,
      checkoutUrls: ['https://store.example.com/p/1'],
      sourceHost: 'themechanicbible.com',
      expectedCtaCount: 1,
    });
    expect(findings.filter((f) => f.severity === 'BLOCKER')).toEqual([]);
  });

  // Every v1 check ran BEFORE substitution, so a page could ship with leaked
  // slot tokens and nothing would catch it.
  it('blocks a token that survived binding', () => {
    const findings = validateBoundPage({
      html: '<h1>{{HERO_TITLE}}</h1>',
      checkoutUrls: [],
      sourceHost: 'x.com',
      expectedCtaCount: 0,
    });
    expect(findings.map((f) => f.code)).toContain('RESIDUAL_TOKEN');
  });

  it('blocks a page whose buttons never got the checkout URL', () => {
    const findings = validateBoundPage({
      html: '<a href="#">Get it</a>',
      checkoutUrls: ['https://store.example.com/p/1'],
      sourceHost: 'x.com',
      expectedCtaCount: 1,
    });
    expect(findings.map((f) => f.code)).toContain('CHECKOUT_MISSING');
  });

  it('warns when the checkout link count drifted from the template', () => {
    const findings = validateBoundPage({
      html: bound,
      checkoutUrls: ['https://store.example.com/p/1'],
      sourceHost: 'themechanicbible.com',
      expectedCtaCount: 3,
    });
    const drift = findings.find((f) => f.code === 'CHECKOUT_COUNT_DRIFT');
    expect(drift?.severity).toBe('WARN');
  });

  // A three-book page carries several different links. A check that only looked
  // at the featured book's would pass a page whose other two buttons go nowhere.
  describe('multi-book pages', () => {
    const urls = [
      'https://store.example.com/one',
      'https://store.example.com/two',
      'https://store.example.com/three',
    ];
    const page = (present: string[]) =>
      `<h1>x</h1>${present.map((u) => `<a href="${u}">Buy</a>`).join('')}`;

    it('passes when every product has its own link', () => {
      const findings = validateBoundPage({
        html: page(urls),
        checkoutUrls: urls,
        sourceHost: 'themechanicbible.com',
        expectedCtaCount: 3,
      });
      expect(findings.filter((f) => f.severity === 'BLOCKER')).toEqual([]);
    });

    it('blocks when one book’s buy link never got bound', () => {
      const findings = validateBoundPage({
        html: page(urls.slice(0, 2)),
        checkoutUrls: urls,
        sourceHost: 'themechanicbible.com',
        expectedCtaCount: 3,
      });
      const finding = findings.find((f) => f.code === 'CHECKOUT_INCOMPLETE');
      expect(finding?.severity).toBe('BLOCKER');
      expect(finding?.message).toContain('1 of 3 products');
    });

    it('does not report count drift when the links legitimately differ', () => {
      const findings = validateBoundPage({
        html: page(urls),
        checkoutUrls: urls,
        sourceHost: 'themechanicbible.com',
        expectedCtaCount: 1,
      });
      expect(findings.map((f) => f.code)).not.toContain('CHECKOUT_COUNT_DRIFT');
    });
  });

  describe("the template owner's price on the finished page", () => {
    const checkout = 'https://store.example.com/p/1';

    it('blocks a template price sitting beside a buy button', () => {
      const findings = validateBoundPage({
        html: `<div><span>$47</span><a href="${checkout}">Buy</a></div>`,
        checkoutUrls: [checkout],
        sourceHost: 'x.com',
        expectedCtaCount: 1,
        templatePrices: ['$47'],
      });
      const finding = findings.find((f) => f.code === 'TEMPLATE_PRICE_BESIDE_CTA');
      expect(finding?.severity).toBe('BLOCKER');
    });

    // The airfare case: a figure the copy is ABOUT, far from any buy button.
    it('leaves a figure alone when it is the copy talking, not a price tag', () => {
      const findings = validateBoundPage({
        html: `<p>Readers save $1,400 a year on airfare.</p>${'<p>x</p>'.repeat(80)}<a href="${checkout}">Buy</a>`,
        checkoutUrls: [checkout],
        sourceHost: 'x.com',
        expectedCtaCount: 1,
        templatePrices: ['$1,400'],
      });
      expect(findings.map((f) => f.code)).not.toContain('TEMPLATE_PRICE_BESIDE_CTA');
    });

    it('ignores a recorded price the bound page no longer contains', () => {
      const findings = validateBoundPage({
        html: `<span>$27</span><a href="${checkout}">Buy</a>`,
        checkoutUrls: [checkout],
        sourceHost: 'x.com',
        expectedCtaCount: 1,
        templatePrices: ['$47'],
      });
      expect(findings.filter((f) => f.severity === 'BLOCKER')).toEqual([]);
    });
  });

  it('blocks an empty href, which reloads the page when clicked', () => {
    const findings = validateBoundPage({
      html: '<a href="">Buy</a>',
      checkoutUrls: [],
      sourceHost: 'x.com',
      expectedCtaCount: 0,
    });
    expect(findings.map((f) => f.code)).toContain('EMPTY_HREF');
  });

  it('warns on accessibility problems without blocking', () => {
    const findings = validateBoundPage({
      html: '<h1>a</h1><h1>b</h1><img src="assets/x.webp">',
      checkoutUrls: [],
      sourceHost: 'x.com',
      expectedCtaCount: 0,
    });
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('MULTIPLE_H1');
    expect(codes).toContain('IMG_NO_ALT');
    expect(findings.filter((f) => f.severity === 'BLOCKER')).toEqual([]);
  });
});

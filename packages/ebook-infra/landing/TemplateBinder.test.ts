import { describe, it, expect } from 'vitest';
import { TemplateBinder, type AssembleInput } from './TemplateBinder';

const binder = new TemplateBinder();

/** A parameterised template as extraction stores it: a full document. */
const TEMPLATE =
  '<!doctype html><html><head>' +
  '<link rel="stylesheet" href="https://themechanicbible.com/bundle.css">' +
  '<style>.leftover{color:red}</style>' +
  '</head><body><h1 data-tpl="n3">{{HERO_TITLE}}</h1>' +
  '<a href="{{CHECKOUT_URL}}">{{CTA_TEXT}}</a>' +
  '<footer>{{FOOTER_LEGAL}}</footer></body></html>';

function input(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    templateHtml: TEMPLATE,
    css: '.hero{padding:90px 0}',
    themeOverrideCss: '',
    accentLiteral: null,
    values: {
      scalars: { HERO_TITLE: 'Fix It Yourself', CTA_TEXT: 'Get the book', CHECKOUT_URL: 'https://store.example.com/p/1' },
      repeats: {},
      trustedHtml: { FOOTER_LEGAL: '<p>© 2026 Garage</p>' },
    },
    required: ['HERO_TITLE'],
    documentTitle: 'Fix It Yourself',
    metaDescription: 'Stop paying for jobs you can do yourself',
    ...overrides,
  };
}

function assembled(overrides: Partial<AssembleInput> = {}): string {
  const result = binder.assemble(input(overrides));
  if (result.isFail()) throw new Error(`assemble failed: ${result.error.join('; ')}`);
  return result.value.html;
}

describe('TemplateBinder', () => {
  it('keeps the template body and fills its tokens', () => {
    const html = assembled();
    expect(html).toContain('<h1>Fix It Yourself</h1>');
    expect(html).toContain('<a href="https://store.example.com/p/1">Get the book</a>');
    expect(html).toContain('<p>© 2026 Garage</p>');
  });

  // A stylesheet link left in place makes the published page fetch its CSS from
  // the site it was copied from — the owner sees the traffic and can break the
  // page at will.
  it('removes the template’s remote stylesheet link', () => {
    const html = assembled();
    expect(html).not.toContain('themechanicbible.com/bundle.css');
    expect(html).not.toContain('rel="stylesheet"');
  });

  it('removes the template’s inline styles, which the bundle already contains', () => {
    expect(assembled()).not.toContain('.leftover');
  });

  it('injects the bundled stylesheet', () => {
    expect(assembled()).toContain('.hero{padding:90px 0}');
  });

  it('appends the theme override after the bundle so it wins', () => {
    const html = assembled({ themeOverrideCss: ':root { --brand-primary: #1a2a5c; }\n' });
    expect(html.indexOf('--brand-primary')).toBeGreaterThan(html.indexOf('.hero{padding'));
  });

  it('emits a scoped override when the template writes a literal accent', () => {
    const html = assembled({ accentLiteral: { from: '#da5e25', to: '#1a2a5c' } });
    expect(html).toContain('controlled accent adaptation: #da5e25 → #1a2a5c');
    expect(html).toContain('#1a2a5c');
  });

  // Cleaning strips the owner's title, canonical and og: tags precisely so the
  // clone does not tell search engines it is the original product.
  it('rebuilds the document identity for the new product', () => {
    const html = assembled();
    expect(html).toContain('<title>Fix It Yourself</title>');
    expect(html).toContain('<meta name="description" content="Stop paying for jobs you can do yourself">');
    expect(html).toContain('og:title');
    expect(html).toContain('<meta name="viewport"');
  });

  it('escapes the title and description it injects', () => {
    const html = assembled({ documentTitle: 'A "Quoted" & <Tagged> Title' });
    expect(html).toContain('<title>A &quot;Quoted&quot; &amp; &lt;Tagged&gt; Title</title>');
  });

  it('strips the extraction scaffolding', () => {
    expect(assembled()).not.toContain('data-tpl');
  });

  it('reports a required token that had no value instead of shipping the page', () => {
    const result = binder.assemble(
      input({ values: { scalars: {}, repeats: {}, trustedHtml: { FOOTER_LEGAL: '<p>x</p>' } } }),
    );
    expect(result.isFail()).toBe(true);
    if (result.isFail()) expect(result.error.join(' ')).toContain('{{HERO_TITLE}} is required');
  });

  it('builds a head when the template fragment has none', () => {
    const html = assembled({ templateHtml: '<h1>{{HERO_TITLE}}</h1>' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Fix It Yourself</title>');
    expect(html).toContain('<h1>Fix It Yourself</h1>');
  });
});

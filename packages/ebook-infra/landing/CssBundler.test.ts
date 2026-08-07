import { describe, it, expect } from 'vitest';
import { breakpointsOf, bundleCss, extractCssUrls, rewriteCssUrls, stripRemoteRules } from './CssBundler';

const BASE = 'https://themechanicbible.com/';

describe('extractCssUrls', () => {
  it('absolutises every remote reference', () => {
    const css = `.a{background:url(/img/hero.png)}.b{background:url("../t/x.webp")}`;
    expect(extractCssUrls(css, `${BASE}page/`)).toEqual([
      'https://themechanicbible.com/img/hero.png',
      'https://themechanicbible.com/t/x.webp',
    ]);
  });

  it('ignores data URIs and in-document fragments, which are not downloads', () => {
    const css = `.a{background:url(data:image/png;base64,AAA)}.b{fill:url(#grad)}`;
    expect(extractCssUrls(css, BASE)).toEqual([]);
  });
});

describe('rewriteCssUrls', () => {
  const map = new Map([['https://themechanicbible.com/img/hero.png', 'assets/abc123.png']]);

  it('repoints a mapped reference at the local copy', () => {
    const out = rewriteCssUrls('.a{background:url(/img/hero.png)}', map, BASE);
    expect(out).toBe('.a{background:url("assets/abc123.png")}');
  });

  // A url() left pointing at the origin means the published page keeps loading
  // from the site it was copied from — the owner sees the traffic and can swap
  // or break the image at will.
  it('drops an unmapped reference rather than leaving it pointing at the origin', () => {
    const out = rewriteCssUrls('.a{background:url(/img/missing.png)}', map, BASE);
    expect(out).toBe('.a{background:none}');
    expect(out).not.toContain('themechanicbible.com');
  });

  it('leaves data URIs alone', () => {
    const css = '.a{background:url(data:image/png;base64,AAA)}';
    expect(rewriteCssUrls(css, map, BASE)).toBe(css);
  });
});

describe('stripRemoteRules', () => {
  it('removes @import, which would pull in more CSS at render time', () => {
    expect(stripRemoteRules('@import url("x.css");.a{color:red}')).toBe('.a{color:red}');
  });

  // The captured @font-face rules point at the template's own font server. A
  // face that may not be redistributed must not be fetched at all, so they are
  // dropped wholesale and re-added only by the licence-gated embedder.
  it('removes @font-face so only licence-checked faces can come back', () => {
    const css = '@font-face{font-family:"X";src:url(/f/x.woff2)}.a{color:red}';
    expect(stripRemoteRules(css)).toBe('.a{color:red}');
  });
});

describe('breakpointsOf', () => {
  it('reads px breakpoints in ascending order', () => {
    const css = '@media (min-width:1024px){.a{}}@media (max-width:640px){.b{}}';
    expect(breakpointsOf(css)).toEqual([640, 1024]);
  });

  it('converts rem against the root font size, not a component font size', () => {
    expect(breakpointsOf('@media (min-width:48rem){.a{}}')).toEqual([768]);
  });

  it('ignores values outside any plausible viewport', () => {
    expect(breakpointsOf('@media (min-width:1px){.a{}}@media (min-width:9000px){.b{}}')).toEqual([]);
  });
});

describe('bundleCss', () => {
  it('prepends embedded fonts, rewrites urls, and reports what could not be resolved', () => {
    const result = bundleCss({
      css: '@font-face{font-family:"X";src:url(/f/x.woff2)}.a{background:url(/img/a.png)}.b{background:url(/img/b.png)}@media (min-width:768px){.c{}}',
      baseUrl: BASE,
      assetMap: new Map([['https://themechanicbible.com/img/a.png', 'assets/aaa.png']]),
      fontFaceCss: '@font-face{font-family:"X";src:url(data:font/woff2;base64,AAA)}',
    });

    expect(result.css).toContain('data:font/woff2');
    expect(result.css).toContain('url("assets/aaa.png")');
    expect(result.css).toContain('.b{background:none}');
    expect(result.unresolved).toEqual(['https://themechanicbible.com/img/b.png']);
    expect(result.breakpoints).toEqual([768]);
  });
});

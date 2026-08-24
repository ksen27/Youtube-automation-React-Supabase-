import { describe, it, expect } from 'vitest';
import { HttpReferencePageFetcher, digest, resolveCustomProperties } from './HttpReferencePageFetcher';

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8', ...headers }),
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(body) };
          },
          async cancel() {},
        };
      },
    },
  } as unknown as Response;
}

describe('HttpReferencePageFetcher — SSRF guard', () => {
  // The template URL is typed by a user and fetched from inside the worker's
  // network. Without these checks it is a request-forgery sink.
  const blocked = [
    'http://127.0.0.1/admin',
    'http://localhost:3000/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.4.4/',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://100.64.0.1/', // CGNAT
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', // v4-mapped loopback
  ];

  it.each(blocked)('refuses %s', async (url) => {
    let called = false;
    const fetcher = new HttpReferencePageFetcher(
      (async () => {
        called = true;
        return htmlResponse('<html></html>');
      }) as unknown as typeof fetch,
    );

    const result = await fetcher.fetch(url);

    expect(result.isFail()).toBe(true);
    expect(called).toBe(false); // refused before any request left the process
  });

  it.each(['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com'])(
    'refuses the %s scheme',
    async (url) => {
      const result = await new HttpReferencePageFetcher((async () => htmlResponse('')) as unknown as typeof fetch).fetch(url);
      expect(result.isFail()).toBe(true);
    },
  );

  it('re-checks the destination of every redirect', async () => {
    // A public URL that redirects inward is the classic bypass.
    const impl = (async (url: string) => {
      if (String(url).includes('start')) {
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
        } as unknown as Response;
      }
      return htmlResponse('<html><body>secrets</body></html>');
    }) as unknown as typeof fetch;

    const result = await new HttpReferencePageFetcher(impl).fetch('https://example.com/start');

    expect(result.isFail()).toBe(true);
    expect((result as { error: string }).error).toContain('private address');
  });

  it('refuses a body that is too large to be a web page', async () => {
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html', 'content-length': '99000000' }),
        body: null,
      }) as unknown as Response) as unknown as typeof fetch;

    const result = await new HttpReferencePageFetcher(impl).fetch('https://example.com/');
    expect(result.isFail()).toBe(true);
    expect((result as { error: string }).error).toContain('too large');
  });

  it('refuses a response that is not HTML', async () => {
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/pdf' }),
        body: null,
      }) as unknown as Response) as unknown as typeof fetch;

    const result = await new HttpReferencePageFetcher(impl).fetch('https://example.com/');
    expect(result.isFail()).toBe(true);
  });
});

describe('digest', () => {
  const page = `<!doctype html><html><head><title>The Amish Home Savings Manual</title>
    <style>
      body { font-family: Georgia, serif; background: #faf7f0; max-width: 720px; }
      .band { background: #1a1a1a; }
      .cta { background: #b8860b; color: #fff; }
      .btn { background: #b8860b; }
    </style></head>
    <body>
      <h1>Cut your household bills</h1>
      <h2>I. The Manual</h2>
      <h2>II. The Math</h2>
      <h2>III. What's Inside</h2>
      <p>Ninety-three methods, tested over generations.</p>
      <img src="a.jpg"><script>tracking()</script>
    </body></html>`;

  it('reads the heading skeleton in document order', () => {
    const d = digest('https://example.com/', page);
    expect(d.title).toBe('The Amish Home Savings Manual');
    expect(d.headings.map((h) => h.text)).toEqual([
      'Cut your household bills',
      'I. The Manual',
      'II. The Math',
      "III. What's Inside",
    ]);
  });

  it('detects the reference page’s visual treatment', () => {
    const d = digest('https://example.com/', page);
    expect(d.style.serifHeadings).toBe(true);
    expect(d.style.numberedSections).toBe(true); // roman numerals lead the headings
    expect(d.style.accent).toBe('#b8860b'); // the repeated saturated colour
    expect(d.style.grounds).toContain('#faf7f0');
    expect(d.style.measurePx).toBe(720);
  });

  it('keeps script and style content out of the readable text', () => {
    const d = digest('https://example.com/', page);
    expect(d.text).toContain('Ninety-three methods');
    expect(d.text).not.toContain('tracking()');
    expect(d.text).not.toContain('font-family');
  });

  // Site builders ship the palette in linked CSS; the inline <style> scan alone
  // misread mechanicbible.com's orange as an unrelated indigo.
  it('reads style signals from linked stylesheets too', async () => {
    const pageHtml = `<html><head>
        <link rel="stylesheet" href="/assets/site.css">
      </head><body><h1>Hello</h1><p>world</p></body></html>`;
    const impl = (async (url: string) => {
      if (String(url).endsWith('site.css')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/css' }),
          body: {
            getReader() {
              let sent = false;
              return {
                async read() {
                  if (sent) return { done: true, value: undefined };
                  sent = true;
                  return {
                    done: false,
                    value: new TextEncoder().encode(
                      'h1{font-family:Georgia,serif}.btn{background:#f97316}.b2{color:#f97316}',
                    ),
                  };
                },
                async cancel() {},
              };
            },
          },
        } as unknown as Response;
      }
      return htmlResponse(pageHtml);
    }) as unknown as typeof fetch;

    const result = await new HttpReferencePageFetcher(impl).fetch('https://example.com/');
    expect(result.isOk()).toBe(true);
    const style = (result as { value: { style: { accent: string | null; serifHeadings: boolean } } }).value.style;
    expect(style.accent).toBe('#f97316'); // the real brand orange, from the linked file
    expect(style.serifHeadings).toBe(true);
  });

  it('reports an unnumbered, sans-serif page as such', () => {
    const d = digest(
      'https://example.com/',
      `<html><head><style>body{font-family:Inter,sans-serif}</style></head>
       <body><h2>Why it works</h2><h2>Pricing</h2><p>hello</p></body></html>`,
    );
    expect(d.style.serifHeadings).toBe(false);
    expect(d.style.numberedSections).toBe(false);
    expect(d.style.accent).toBeNull();
  });
});

describe('pruneMarkup', () => {
  const page = `<html><head><script src="a.js"></script></head><body>
    <!-- built with X -->
    <div class="hero bg-dark px-6" data-framework-id="abc123">
      <svg viewBox="0 0 24 24" fill="none"><path d="M3 3l18 18"/><circle cx="4" cy="4" r="2"/></svg>
      <h1 class="font-serif text-5xl">Big claim</h1>
      <img src="data:image/png;base64,AAAA" class="cover">
      <a href="https://checkout.example/x" class="btn">Buy</a>
    </div>
    <style>.junk{color:red}</style>
    <script>track()</script>
  </body></html>`;

  it('keeps the template skeleton — elements and class names', async () => {
    const { pruneMarkup } = await import('./HttpReferencePageFetcher');
    const m = pruneMarkup(page);
    expect(m).toContain('class="hero bg-dark px-6"'); // utility classes ARE the design
    expect(m).toContain('class="font-serif text-5xl"');
    expect(m).toContain('Big claim');
    expect(m).toContain('class="btn"');
  });

  it('strips everything that is not template', async () => {
    const { pruneMarkup } = await import('./HttpReferencePageFetcher');
    const m = pruneMarkup(page);
    expect(m).not.toContain('track()');
    expect(m).not.toContain('.junk');
    expect(m).not.toContain('built with');
    expect(m).not.toContain('base64');
    expect(m).not.toContain('data-framework-id');
    expect(m).not.toContain('<path'); // icon innards dropped, slot kept
    expect(m).toContain('<svg');
  });

  it('caps runaway pages instead of blowing the prompt budget', async () => {
    const { pruneMarkup } = await import('./HttpReferencePageFetcher');
    const huge = `<body>${'<div class="x">block</div>'.repeat(5000)}</body>`;
    const m = pruneMarkup(huge);
    expect(m.length).toBeLessThan(37_000);
    expect(m).toContain('TRUNCATED');
  });
});

describe('digest — custom properties', () => {
  // The shape that shipped a sans-serif clone of a serif page: every colour and
  // font on the reference is written as a var(), so the digest read the page as
  // specifying nothing and the layout call was told "body: sans-serif".
  const page = `<html><head><title>Vintage</title><style>
    :root {
      --paper: #f2ecdb;
      --ink: #241b0f;
      --serif: 'Fraunces', 'EB Garamond', Georgia, serif;
      --body: var(--serif);
      --brick: #9c3b26;
    }
    @media (prefers-color-scheme: dark) { :root { --paper: #101010; } }
    body { font-family: var(--body); background: var(--paper); color: var(--ink); }
    h1, h2 { font-family: var(--serif); }
    .card { background: var(--brick); }
  </style></head><body><h1>Your mother never wrote them down.</h1><p>We did.</p></body></html>`;

  it('reads the body face through the variable', () => {
    const d = digest('https://example.com/', page);
    expect(d.style.serifBody).toBe(true);
    expect(d.style.bodyFont).toBe('Fraunces');
  });

  it('follows a variable that points at another variable', () => {
    // --body: var(--serif) — one level of indirection, which is how these
    // stylesheets keep a display face and a body face in step.
    expect(resolveCustomProperties(':root{--a:red;--b:var(--a)}p{color:var(--b)}')).toContain(
      'color:red',
    );
  });

  it('takes the base definition, not the dark-mode override', () => {
    const d = digest('https://example.com/', page);
    expect(d.style.grounds).toContain('#f2ecdb');
    expect(d.style.grounds).not.toContain('#101010');
  });

  it('leaves a stylesheet with no variables untouched', () => {
    const css = 'body{font-family:Georgia,serif;background:#fff}';
    expect(resolveCustomProperties(css)).toBe(css);
  });

  it('uses the fallback when the variable was never defined', () => {
    expect(resolveCustomProperties('p{color:var(--nope, #333)}')).toContain('color:#333');
  });

  it('terminates on a circular definition', () => {
    // Left as-is rather than hanging: an unresolvable var is the same to every
    // heuristic downstream as the var() it started as.
    const out = resolveCustomProperties(':root{--a:var(--b);--b:var(--a)}p{color:var(--a)}');
    expect(out).toContain('var(');
  });
});

describe('digest — content column', () => {
  const wrap = (extra: string) =>
    `<html><head><title>T</title><style>
      :root { --max: 1180px; }
      .wrap { max-width: var(--max); margin: 0 auto; padding: 0 28px; }
      ${extra}
    </style></head><body><h1>H</h1></body></html>`;

  it('takes the centred container, not the most repeated width', () => {
    // The shape that built every page at 64% of the reference: the container is
    // declared once, the prose measures inside it are declared on every block.
    const d = digest('https://example.com/', wrap(`
      .lede { max-width: 760px; } .body p { max-width: 760px; } .note { max-width: 760px; }
      .card { max-width: 780px; } .card p { max-width: 780px; } .quote { max-width: 780px; }
    `));
    expect(d.style.measurePx).toBe(1180);
  });

  it('prefers the outer container when prose is centred too', () => {
    const d = digest('https://example.com/', wrap('.lede { max-width: 640px; margin-inline: auto; }'));
    expect(d.style.measurePx).toBe(1180);
  });

  it('falls back to the most common width when nothing centres itself', () => {
    // Flex- and grid-centred pages never write `margin: auto`.
    const html = `<html><head><title>T</title><style>
      .a { max-width: 900px; } .b { max-width: 900px; } .c { max-width: 1200px; }
    </style></head><body><h1>H</h1></body></html>`;
    expect(digest('https://example.com/', html).style.measurePx).toBe(900);
  });

  it('ignores widths outside the plausible column range', () => {
    const d = digest('https://example.com/', wrap('.full { max-width: 2400px; margin: 0 auto; }'));
    expect(d.style.measurePx).toBe(1180);
  });

  it('reports nothing when the page sets no width at all', () => {
    const html = '<html><head><title>T</title><style>body{color:#111}</style></head><body><h1>H</h1></body></html>';
    expect(digest('https://example.com/', html).style.measurePx).toBeNull();
  });
});

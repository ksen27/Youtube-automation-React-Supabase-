import type {
  LandingPageModel,
  LandingPageRenderer,
  LandingProduct,
  LandingTemplateSection,
} from '@ebook/core';

/**
 * Renders the sales page. The LAYOUT is fixed and hand-written here — the model
 * only supplies prose, prices and colours. That is deliberate:
 *
 *   - every book gets the same proven structure instead of a layout the model
 *     re-invents (and degrades) on each run;
 *   - no model-authored markup or script can reach the published page, so there
 *     is nothing to sanitise and nothing to inject;
 *   - restyling every page ever generated is an edit to this one file.
 *
 * The structure follows the client's reference page: a masthead carrying the
 * offer, then numbered sections in roman numerals — the book, the arithmetic,
 * what's inside, reader results, the authors, the order, the questions — and a
 * last call. Single column and text-led rather than image-led; the cover appears
 * once, and the page argues in prose.
 *
 * Sections whose data is absent are skipped, and the numbering closes up behind
 * them, so a page with no testimonials still reads I, II, III, IV rather than
 * skipping a numeral and looking broken.
 *
 * The output is fully self-contained: inline CSS, inlined `data:` images, no
 * fonts, scripts or images fetched from anywhere. It renders offline.
 */
export class LandingPageHtmlRenderer implements LandingPageRenderer {
  render(model: LandingPageModel): string {
    const { copy, palette } = model;
    const products = model.products;
    const primary = products.find((p) => p.featured) ?? products[0];
    // Display and body are chosen INDEPENDENTLY. Tying them together set the
    // eyebrows, bullets and fine print in Georgia on any page whose headings
    // were serif — where the reference pairs a serif display face with
    // sans-serif body copy.
    const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
    // Display sans is tighter and more assertive than the body sans; they were
    // always two different stacks and must stay so.
    const DISPLAY_SANS = '"Helvetica Neue", Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
    const SANS = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const fonts = {
      // A stack resolved from the reference's ACTUAL typeface wins over the
      // serif/sans flag: "Playfair Display" and "Merriweather" are both serif
      // and read nothing alike, and mapping both to Georgia lost most of what
      // makes a template recognisable.
      display: copy.displayFontStack ?? (copy.fontFamily === 'sans' ? DISPLAY_SANS : SERIF),
      // Unset follows the headings, which is what it always did.
      body: copy.bodyFontStack ?? ((copy.bodyFontFamily ?? copy.fontFamily) === 'sans' ? SANS : SERIF),
    };

    // Numbering is assigned as sections are emitted, so omitting one never
    // leaves a gap in the sequence.
    const numeral = counter();

    const body = [
      // ORDER IS THE ARGUMENT. A direct-response page sells the problem before
      // the product: the reader has to feel what their situation costs, and see
      // that what they have already tried cannot fix it, BEFORE the book is
      // introduced. So failedAlternatives and the discovery story run ahead of
      // the product blocks, not after them. Each is omitted when its copy is
      // absent, which is also how a page generated before these existed still
      // renders unchanged.
      sectionFailedAlternatives(model, numeral),
      sectionDiscovery(model, numeral),
      sectionTheBook(model, primary, numeral),
      sectionTheMath(model, numeral),
      // The reference's own sections, written from this book. They sit after
      // the book intro and before the fixed blocks so a fallback page still
      // carries the template's material rather than dropping it silently.
      ...(model.copy.templateSections ?? []).map((s) => templateSection(s, numeral)),
      sectionWhatsInside(model, primary, numeral),
      // The curiosity block sits directly after the contents: the reader has
      // just seen WHAT is in the book, and these say why each part matters
      // without giving any of it away. Immediately before the order block, so
      // the page peaks at the moment it asks for the sale.
      sectionFascinations(model, numeral),
      sectionReaderResults(model, numeral),
      sectionAuthors(model),
      sectionOrder(model, primary, numeral),
      sectionFaq(model, numeral),
      sectionLastCall(model, primary),
      sectionPostscripts(model),
    ]
      .filter(Boolean)
      .join('\n\n');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(primary?.title ?? model.siteName)}</title>
<meta name="description" content="${esc(truncate(copy.subheadline, 300))}">
<meta property="og:title" content="${esc(primary?.title ?? model.siteName)}">
<meta property="og:description" content="${esc(truncate(copy.subheadline, 300))}">
<meta property="og:type" content="website">
<!-- No og:image. Every scraper that reads these tags requires an absolute URL
     and ignores a data: URI, so embedding the cover here bought nothing and
     cost a full second copy of it in the stored HTML. -->
<style>
  :root {
    ${palette.toCssVariables()};
    --measure: 44rem;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: ${fonts.body};
    font-size: 18px;
    line-height: 1.7;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3 { font-family: ${fonts.display}; color: var(--heading); line-height: 1.15; margin: 0 0 .5em; }
  h1 { font-size: clamp(2rem, 5vw, 3rem); letter-spacing: -0.02em; text-wrap: balance; }
  h2 { font-size: clamp(1.5rem, 3.2vw, 2.05rem); letter-spacing: -0.015em; text-wrap: balance; }
  h3 { font-size: 1.08rem; }
  p { margin: 0 0 1.1em; }
  a { color: var(--accent); }
  strong { color: var(--heading); }
  .wrap { max-width: var(--measure); margin: 0 auto; padding: 0 22px; }
  .center { text-align: center; }
  .muted { color: var(--muted); }
  .lede { font-size: 1.12rem; }

  section { padding: 60px 0; border-top: 1px solid var(--border); }

  /* Roman-numeral section marks — the reference page's signature device. */
  .mark {
    font-family: ${fonts.display}; font-size: .78rem; letter-spacing: .3em;
    text-transform: uppercase; color: var(--accent); margin: 0 0 10px;
  }
  .rule { border: 0; border-top: 1px solid var(--border); margin: 34px 0; }

  /* ── masthead ─────────────────────────────────────────────────────────── */
  .masthead { background: var(--deep); color: var(--on-deep); padding: 18px 0; text-align: center; }
  .masthead .wrap { display: flex; flex-direction: column; gap: 6px; }
  /* The channel avatar as a brand mark. Sized as a mark, not as an image: the
     source is a 800px YouTube thumbnail and unconstrained it would fill the bar. */
  .masthead-logo {
    width: 34px; height: 34px; border-radius: 50%; object-fit: cover;
    align-self: center; display: block;
  }
  .masthead-line {
    font-family: ${fonts.display}; font-size: .76rem; letter-spacing: .22em;
    text-transform: uppercase; color: var(--on-deep-muted);
  }
  .promo { font-size: .82rem; color: var(--accent-on-deep); font-variant-numeric: tabular-nums; }
  .proof { font-size: .82rem; color: var(--on-deep-muted); }

  .hero { padding: 62px 0 54px; text-align: center; border-top: 0; }
  .byline { font-size: .82rem; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin-bottom: 20px; }
  .cover {
    display: block; width: min(230px, 56vw); margin: 34px auto 0; border-radius: 4px;
    box-shadow: 0 20px 46px -16px rgba(0,0,0,.42), 0 0 0 1px var(--border);
  }
  .cover-fallback {
    display: grid; place-items: center; width: min(230px, 56vw); aspect-ratio: 2/3;
    margin: 34px auto 0; border-radius: 4px; background: var(--surface);
    border: 1px solid var(--border); padding: 24px; text-align: center;
  }
  .cover-fallback span { font-family: ${fonts.display}; font-size: 1.25rem; color: var(--heading); }

  /* ── price ────────────────────────────────────────────────────────────── */
  .price-row { display: flex; align-items: baseline; justify-content: center; gap: 10px; margin: 0 0 6px; }
  .price { font-family: ${fonts.display}; font-size: 2.6rem; color: var(--heading); line-height: 1; }
  .price-was { font-size: 1.2rem; color: var(--muted); text-decoration: line-through; }
  .price-note { font-size: .84rem; color: var(--muted); margin-bottom: 22px; }

  /* Itemised value stack — every line is a real component of the offer. */
  .stack { list-style: none; padding: 0; margin: 0 0 6px; }
  .stack li { display: flex; justify-content: space-between; gap: 18px; padding: 9px 0;
              border-bottom: 1px solid var(--border); font-size: .95rem; }
  .stack li span:last-child { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .stack-total { display: flex; justify-content: space-between; gap: 18px; padding: 12px 0 0;
                 font-family: ${fonts.display}; }
  .stack-total .was { text-decoration: line-through; color: var(--muted); font-weight: 400; }
  .stack-pay { display: flex; justify-content: space-between; gap: 18px; padding: 6px 0 0;
               font-family: ${fonts.display}; font-size: 1.15rem; color: var(--heading); }

  /* ── the math ─────────────────────────────────────────────────────────── */
  .table-scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .95rem; }
  th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid var(--border); }
  th { font-family: ${fonts.display}; font-weight: 700; color: var(--heading); font-size: .8rem;
       letter-spacing: .08em; text-transform: uppercase; }
  td + td, th + th { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-family: ${fonts.display}; color: var(--heading); border-bottom: 0; border-top: 2px solid var(--border); }
  .source { font-size: .78rem; color: var(--muted); margin-top: 12px; }

  /* ── lists ────────────────────────────────────────────────────────────── */
  /* Chapter cards. A three-column grid rather than one long stacked list:
     fourteen full-width rows pushed the CTA off the page and read as a table of
     contents instead of as a reason to buy (client feedback 2026-08-06). */
  .cats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  @media (max-width: 900px) { .cats { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 620px) { .cats { grid-template-columns: 1fr; } }
  .cat {
    border: 1px solid var(--rule);
    border-radius: 10px;
    padding: 20px 20px 18px;
    background: var(--card, transparent);
  }
  .cat h3 { margin-bottom: .45em; font-size: 1.02rem; line-height: 1.35; }
  .cat-num { font-size: .7rem; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); margin-bottom: .5em; }
  /* The teaser points. Capped in the renderer, not here — see contentsPoints. */
  .cat-points { list-style: none; margin: 0; padding: 0; }
  .cat-points li {
    position: relative;
    padding-left: 14px;
    margin-bottom: .5em;
    font-size: .86rem;
    line-height: 1.5;
    color: var(--muted);
  }
  .cat-points li::before {
    content: ""; position: absolute; left: 0; top: .55em;
    width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: .7;
  }
  .cat-more { font-size: .76rem; color: var(--accent); margin-top: .2em; }
  .items { list-style: none; padding: 0; margin: 8px 0 0; }
  .items li { padding: 5px 0 5px 20px; position: relative; font-size: .95rem; color: var(--muted); }
  .items li::before { content: "·"; position: absolute; left: 6px; color: var(--accent); }

  .checks { list-style: none; padding: 0; margin: 0; }
  .checks li { padding: 10px 0 10px 26px; position: relative; border-bottom: 1px solid var(--border); }
  .checks li:last-child { border-bottom: 0; }
  .checks li::before { content: "✓"; position: absolute; left: 0; color: var(--accent); }
  /* The mirror of .checks, for what does NOT work — failed alternatives and the
     "not for" list. Muted rather than alarming: these are things the reader has
     honestly tried, not mistakes to shame them for. */
  .crosses { list-style: none; padding: 0; margin: 0; }
  .crosses li { padding: 10px 0 10px 26px; position: relative; border-bottom: 1px solid var(--border); color: var(--muted); }
  .crosses li:last-child { border-bottom: 0; }
  .crosses li::before { content: "✕"; position: absolute; left: 0; opacity: .55; }
  /* A measure of ~62 characters. Long prose at the page's full width is the
     fastest way to make a reader stop reading. */
  .narrow { max-width: 34rem; }
  .story { margin: 0 0 1em; line-height: 1.75; }
  .fascinations { list-style: none; padding: 0; margin: 0; }
  .fascinations li {
    padding: 11px 0 11px 26px; position: relative;
    border-bottom: 1px solid var(--border); line-height: 1.55;
  }
  .fascinations li:last-child { border-bottom: 0; }
  .fascinations li::before {
    content: ""; position: absolute; left: 2px; top: 1.15em;
    width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
  }
  .fasc-ch {
    white-space: nowrap; font-size: .72rem; letter-spacing: .08em;
    text-transform: uppercase; color: var(--accent); opacity: .85;
  }
  .ps { margin: 0 0 1em; line-height: 1.7; }
  .ps strong { color: var(--heading, inherit); }

  .pains { list-style: none; padding: 0; margin: 0; }
  .pains li { padding: 13px 0 13px 26px; position: relative; border-bottom: 1px solid var(--border); }
  .pains li:last-child { border-bottom: 0; }
  .pains li::before { content: "—"; position: absolute; left: 0; color: var(--accent); }

  /* ── testimonials ─────────────────────────────────────────────────────── */
  blockquote { margin: 0 0 22px; padding: 0 0 0 20px; border-left: 2px solid var(--accent); }
  blockquote p { font-style: italic; margin-bottom: .5em; }
  blockquote cite { font-style: normal; font-size: .84rem; color: var(--muted); }
  .stars { color: var(--accent); letter-spacing: .1em; font-size: .82rem; }

  /* ── order ────────────────────────────────────────────────────────────── */
  .cta {
    display: inline-block; background: var(--accent); color: var(--accent-contrast);
    font-family: ${fonts.body}; font-weight: 700; font-size: 1.02rem; text-decoration: none;
    padding: 15px 36px; border-radius: 4px; border: 0; cursor: pointer; max-width: 100%;
    transition: filter .12s ease;
  }
  .cta:hover { filter: brightness(1.08); }
  .cta:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  .cta[aria-disabled="true"] { opacity: .45; cursor: not-allowed; pointer-events: none; }
  .cta-note { margin-top: 12px; font-size: .82rem; }
  .pay { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 16px; }
  .pay span {
    font-size: .72rem; letter-spacing: .04em; color: var(--muted);
    border: 1px solid var(--border); border-radius: 4px; padding: 4px 9px;
  }

  /* One card per book when the page sells more than one. Each carries its own
     price and buy link, so the row is the only place a purchase is made. */
  .offers { display: grid; gap: 20px; margin-top: 30px; text-align: left;
            grid-template-columns: repeat(auto-fit, minmax(min(250px, 100%), 1fr)); }
  .offer { display: flex; flex-direction: column; gap: 12px; padding: 22px;
           background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
  .offer-featured { border-color: var(--accent); border-width: 2px; }
  .offer-flag { align-self: flex-start; background: var(--accent); color: var(--accent-contrast);
                font-size: .66rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
                padding: 4px 10px; border-radius: 999px; }
  .offer-art { display: flex; justify-content: center; }
  .offer-art img, .offer-art span { width: min(140px, 45%); aspect-ratio: 2/3; object-fit: cover;
    border-radius: 4px; box-shadow: 0 10px 26px -10px rgba(0,0,0,.4); }
  .offer-art-stack img { width: min(104px, 32%); }
  .offer-art-stack > * + * { margin-left: -32px; }
  .offer h3 { margin: 0; font-size: 1.1rem; }
  .offer-sub { margin: 0; font-size: .88rem; color: var(--muted); }
  .offer-buy { margin-top: auto; text-align: center; }
  .offer-buy .cta { width: 100%; padding: 13px 18px; font-size: .95rem; }
  .offer-save { font-size: .78rem; font-weight: 700; color: var(--accent); margin: 0 0 10px; }

  /* ── sections copied from the reference's structure ───────────────────── */
  .tmpl-cards { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); }
  .tmpl-card { padding: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
  .tmpl-card h3, .tmpl-compare h3, .tmpl-steps h3 { margin: 0 0 .35em; font-size: 1.02rem; color: var(--heading); }
  .tmpl-card p, .tmpl-compare p, .tmpl-steps p { margin: 0; font-size: .93rem; color: var(--muted); }
  .tmpl-compare { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); }
  .tmpl-compare > div { padding: 18px 20px; border-left: 2px solid var(--accent); background: var(--surface); }
  .tmpl-steps { list-style: decimal; padding-left: 1.3em; display: grid; gap: 16px; }
  /* Wide tables scroll inside their own container rather than the page. */
  .tmpl-table-wrap { overflow-x: auto; }
  .tmpl-table { border-collapse: collapse; width: 100%; font-size: .94rem; }
  .tmpl-table th, .tmpl-table td { text-align: left; padding: 11px 12px; border-bottom: 1px solid var(--border); }
  .tmpl-table th { font-size: .72rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
  .tmpl-table td:not(:first-child), .tmpl-table th:not(:first-child) { text-align: right; }
  .tmpl-table tfoot td { font-family: ${fonts.display}; color: var(--heading); border-bottom: 0;
                         border-top: 2px solid var(--border); }
  .tmpl-source { margin-top: 10px; font-size: .74rem; color: var(--muted); }

  details { border-bottom: 1px solid var(--border); }
  summary { cursor: pointer; padding: 17px 0; font-weight: 700; color: var(--heading);
            font-family: ${fonts.display}; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::after { content: "+"; float: right; color: var(--accent); font-weight: 400; }
  details[open] summary::after { content: "–"; }
  details p { color: var(--muted); margin: 0 0 17px; font-size: .95rem; }

  footer { background: var(--deep); color: var(--on-deep-muted); padding: 36px 0 52px;
           text-align: center; }
  footer p { font-size: .76rem; margin: 0 0 .7em; }
  .edition { font-family: ${fonts.display}; letter-spacing: .2em; text-transform: uppercase;
             color: var(--on-deep); font-size: .74rem; margin-bottom: 14px; }

  /* ── motion ───────────────────────────────────────────────────────────── */
  @keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: no-preference) {
    .hero .byline { animation: rise .55s ease .05s both; }
    .hero h1      { animation: rise .65s ease .12s both; }
    .hero .lede   { animation: rise .65s ease .20s both; }
    .hero .cover, .hero .cover-fallback { animation: rise .8s ease .28s both; }
  }
  /* The hidden start state is scoped to .anim, a class only JavaScript adds — so
     with scripts blocked, disabled or broken the page renders plain and complete
     instead of blank. */
  .anim .reveal, .anim .stagger > * {
    opacity: 0; transform: translateY(18px);
    transition: opacity .55s ease, transform .55s cubic-bezier(.22,.61,.36,1);
  }
  .anim .reveal.in, .anim .stagger > *.in { opacity: 1; transform: none; }
  .anim .stagger > *:nth-child(2) { transition-delay: .06s; }
  .anim .stagger > *:nth-child(3) { transition-delay: .12s; }
  .anim .stagger > *:nth-child(4) { transition-delay: .18s; }
  .anim .stagger > *:nth-child(5) { transition-delay: .24s; }
  .anim .stagger > *:nth-child(6) { transition-delay: .30s; }

  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    .cta { transition: none; }
  }
</style>
<script>
/* Arms the scroll reveals before first paint, so nothing flashes in and then
   hides. Two safety nets, because a hidden page that never un-hides is the worst
   outcome here: reveals are skipped for readers who prefer reduced motion, and a
   timer strips the class if the observer below never reports ready. */
(function () {
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var root = document.documentElement;
    root.className += ' anim';
    setTimeout(function () {
      if (root.getAttribute('data-anim') !== 'ready') root.className = root.className.replace(' anim', '');
    }, 2500);
  } catch (e) { /* leave the page in its plain, fully visible state */ }
})();
</script>
</head>
<body>

<div class="masthead">
  <div class="wrap">
    ${model.logoDataUri ? `<img class="masthead-logo" src="${esc(model.logoDataUri)}" alt="${esc(model.siteName)}">` : ''}
    <div class="masthead-line">${esc(primary?.title ?? model.siteName)}</div>
    ${model.promoEndsAt ? `<div class="promo" data-ends="${esc(model.promoEndsAt)}">Launch price ends in <span data-countdown>&mdash;</span></div>` : ''}
    ${proofLine(model)}
  </div>
</div>

<main>

  <section class="hero">
    <div class="wrap">
      ${model.authorCredential ? `<p class="byline">${esc(model.authorCredential)}</p>` : ''}
      <h1>${esc(copy.headline)}</h1>
      <p class="lede muted">${esc(copy.subheadline)}</p>
      ${cover(primary)}
    </div>
  </section>

${body}

</main>

<footer>
  <div class="wrap">
    ${model.edition ? `<p class="edition">${esc(model.edition)}</p>` : ''}
    <p>© ${new Date().getFullYear()} ${esc(model.siteName)}. All rights reserved.</p>
    <p>
      This is a digital product delivered as a downloadable file; nothing is shipped.
      Any figures shown are illustrative and not a guarantee — individual results vary.
    </p>
  </div>
</footer>

<script>
/* Reveals each marked block the first time it enters the viewport, and drives
   the launch countdown when a real end date was supplied. IntersectionObserver
   rather than a scroll-timeline: this has to work in every browser a buyer might
   arrive in, and scroll-driven CSS still does not. */
(function () {
  var root = document.documentElement;
  if (root.className.indexOf('anim') > -1) {
    var els = document.querySelectorAll('.reveal, .stagger > *');
    root.setAttribute('data-anim', 'ready');
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            entries[i].target.classList.add('in');
            io.unobserve(entries[i].target); // reveal once; don't replay on scroll back
          }
        }
      }, { threshold: 0.08, rootMargin: '0px 0px -8% 0px' });
      for (var j = 0; j < els.length; j++) io.observe(els[j]);
    } else {
      for (var k = 0; k < els.length; k++) els[k].classList.add('in');
    }
  }

  /* The deadline is a real stored date, never "now + 24h" — a timer that resets
     on every visit is a false urgency claim, and an actionable one. */
  var promo = document.querySelector('[data-ends]');
  var out = promo && promo.querySelector('[data-countdown]');
  if (!promo || !out) return;
  var ends = Date.parse(promo.getAttribute('data-ends'));
  if (isNaN(ends)) { promo.style.display = 'none'; return; }
  function tick() {
    var left = ends - Date.now();
    if (left <= 0) { promo.style.display = 'none'; return; }
    var d = Math.floor(left / 86400000);
    var h = Math.floor(left / 3600000) % 24;
    var m = Math.floor(left / 60000) % 60;
    var s = Math.floor(left / 1000) % 60;
    out.textContent = (d > 0 ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
    setTimeout(tick, 1000);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  tick();
})();
</script>
</body>
</html>`;
  }
}

// ── sections ─────────────────────────────────────────────────────────────────

function sectionTheBook(model: LandingPageModel, p: LandingProduct | undefined, n: () => string): string {
  const { copy } = model;
  return `  <section class="reveal">
    <div class="wrap">
      <p class="mark">${n()}</p>
      <h2>${esc(copy.whatsInsideHeading)}</h2>
      ${copy.closingBody ? `<p class="lede">${esc(copy.closingBody)}</p>` : ''}
      ${p?.pageCount ? `<p class="muted">${p.pageCount} pages · PDF and DOCX · read on any device</p>` : ''}
      ${copy.painPoints.length > 0 ? `<hr class="rule">
      <ul class="pains stagger">
        ${copy.painPoints.map((x) => `<li>${esc(x)}</li>`).join('\n        ')}
      </ul>` : ''}
      ${valueStack(model, p)}
    </div>
  </section>`;
}

/**
 * The before/after arithmetic. Rendered only from figures the seller supplied
 * WITH a source — the model is never asked to produce them, because a savings
 * table is a quantified financial claim and an invented one is a lie told on a
 * page that takes money.
 */
function sectionTheMath(model: LandingPageModel, n: () => string): string {
  const c = model.costComparison;
  if (!c || c.rows.length === 0) return '';
  const before = c.rows.reduce((t, r) => t + r.beforeCents, 0);
  const after = c.rows.reduce((t, r) => t + r.afterCents, 0);
  return `  <section class="reveal">
    <div class="wrap">
      <p class="mark">${n()}</p>
      <h2>The arithmetic</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th scope="col">Per year</th><th scope="col">${esc(c.beforeLabel)}</th><th scope="col">${esc(c.afterLabel)}</th></tr></thead>
          <tbody>
            ${c.rows
              .map(
                (r) =>
                  `<tr><td>${esc(r.label)}</td><td>${money(r.beforeCents, model.currency)}</td><td>${money(r.afterCents, model.currency)}</td></tr>`,
              )
              .join('\n            ')}
          </tbody>
          <tfoot><tr><td>Total</td><td>${money(before, model.currency)}</td><td>${money(after, model.currency)}</td></tr></tfoot>
        </table>
      </div>
      <p class="source">${esc(c.source)}</p>
    </div>
  </section>`;
}

/**
 * How many of a chapter's key points a card shows.
 *
 * The previous behaviour printed NONE of them — only "5 methods" — on the
 * reasoning that a fourteen-chapter book would put ~70 specifics on the free
 * page selling it. The client's reference page shows them, and specifics are
 * what make a contents section persuasive rather than a table of contents.
 *
 * Four is the compromise the cap encodes: enough that a buyer sees the book
 * deals in concrete claims, few enough that the chapter still has to be bought
 * to be useful. The remainder is COUNTED rather than listed ("+3 more"), which
 * keeps the old "there is more in here" signal without giving it away.
 */
const MAX_POINTS_PER_CARD = 4;

function contentsPoints(items: readonly string[]): string {
  if (items.length === 0) return '';
  const shown = items.slice(0, MAX_POINTS_PER_CARD);
  const rest = items.length - shown.length;
  return `<ul class="cat-points">
            ${shown.map((it) => `<li>${esc(it)}</li>`).join('\n            ')}
          </ul>${rest > 0 ? `\n          <p class="cat-more">+${rest} more</p>` : ''}`;
}

function sectionWhatsInside(model: LandingPageModel, p: LandingProduct | undefined, n: () => string): string {
  const { copy } = model;
  const cats = p?.sections ?? [];
  return `  <section class="reveal">
    <div class="wrap">
      <p class="mark">${n()}</p>
      <h2>What is inside</h2>
      ${
        cats.length > 0
          ? `<div class="cats stagger">
        ${cats
          .map(
            (c, i) => `<div class="cat">
          <p class="cat-num">Chapter ${String(i + 1).padStart(2, '0')}</p>
          <h3>${esc(c.title)}</h3>
          ${contentsPoints(c.items)}
        </div>`,
          )
          .join('\n        ')}
      </div>`
          : `<div class="stagger">
        ${copy.bullets.map((b) => `<div class="cat"><h3>${esc(b.title)}</h3><p class="muted">${esc(b.body)}</p></div>`).join('\n        ')}
      </div>`
      }
      ${
        copy.whoIsItFor.length > 0
          ? `<hr class="rule">
      <h3>${esc(copy.whoIsItForHeading)}</h3>
      <ul class="checks">
        ${copy.whoIsItFor.map((w) => `<li>${esc(w)}</li>`).join('\n        ')}
      </ul>`
          : ''
      }
      ${
        // The disqualifying list. It sells harder than the one above it: a
        // reader who sees themselves excluded from the wrong group reads that
        // as confirmation they belong in the right one.
        (copy.notFor ?? []).length > 0
          ? `<h3>${esc(copy.notForHeading?.trim() || 'Who this is not for')}</h3>
      <ul class="crosses">
        ${(copy.notFor ?? []).map((w) => `<li>${esc(w)}</li>`).join('\n        ')}
      </ul>`
          : ''
      }
    </div>
  </section>`;
}

/**
 * What the reader has already tried, and why it failed them.
 *
 * Runs BEFORE the product is introduced. Its job is to close the exits: a reader
 * who believes a forum thread or a phone call would solve this has no reason to
 * buy anything.
 */
function sectionFailedAlternatives(model: LandingPageModel, n: () => string): string {
  const items = model.copy.failedAlternatives ?? [];
  if (items.length === 0) return '';
  return `  <section class="reveal">
    <div class="wrap">
      <p class="mark">${n()}</p>
      <h2>You have probably tried this already</h2>
      <ul class="crosses stagger">
        ${items.map((it) => `<li>${esc(it)}</li>`).join('\n        ')}
      </ul>
    </div>
  </section>`;
}

/**
 * The origin story. First person, and the only place on the page where the
 * author speaks as "I" rather than being described in the third person.
 */
function sectionDiscovery(model: LandingPageModel, n: () => string): string {
  const story = (model.copy.discoveryStory ?? '').trim();
  if (!story) return '';
  const heading = model.copy.discoveryHeading?.trim() || 'How I found this out';
  // Blank-line-separated paragraphs; the model is asked for prose, not markup.
  const paras = story.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return `  <section class="reveal">
    <div class="wrap narrow">
      <p class="mark">${n()}</p>
      <h2>${esc(heading)}</h2>
      ${paras.map((p) => `<p class="story">${esc(p)}</p>`).join('\n      ')}
    </div>
  </section>`;
}

/**
 * The curiosity block — the hardest-selling section on the page.
 *
 * Each line teases a mechanism without revealing it. The chapter reference is
 * what makes the book feel dense and real; it is a REAL chapter number, never a
 * page number, because nothing in this system knows what page a fact lands on
 * and an invented one would be a false claim repeated down the whole list.
 */
function sectionFascinations(model: LandingPageModel, n: () => string): string {
  const items = model.copy.fascinations ?? [];
  if (items.length === 0) return '';
  const heading = model.copy.fascinationsHeading?.trim() || 'What you will know by the end';
  return `  <section class="reveal">
    <div class="wrap">
      <p class="mark">${n()}</p>
      <h2>${esc(heading)}</h2>
      <ul class="fascinations stagger">
        ${items
          .map(
            (f) =>
              `<li>${esc(f.text)}${
                typeof f.chapter === 'number'
                  ? ` <span class="fasc-ch">Chapter ${f.chapter}</span>`
                  : ''
              }</li>`,
          )
          .join('\n        ')}
      </ul>
    </div>
  </section>`;
}

/**
 * The P.S. blocks. Deliberately outside the numbered sections and after the
 * final CTA — a sales letter's postscript is read by people who scrolled past
 * everything else, so #1 restates the whole offer on its own.
 */
function sectionPostscripts(model: LandingPageModel): string {
  const items = (model.copy.postscripts ?? []).map((p) => p.trim()).filter(Boolean);
  if (items.length === 0) return '';
  return `  <section class="reveal">
    <div class="wrap narrow">
      ${items
        .map(
          // P.S. → P.P.S. → P.P.P.S., the usual convention for successive
          // postscripts.
          (p, i) => `<p class="ps"><strong>${'P.'.repeat(i + 1)}S.</strong> ${esc(p)}</p>`,
        )
        .join('\n      ')}
    </div>
  </section>`;
}

/** Only ever real quotes the seller supplied. Never generated. */
function sectionReaderResults(model: LandingPageModel, n: () => string): string {
  if (model.testimonials.length === 0) return '';
  return `  <section class="reveal">
    <div class="wrap">
      <p class="mark">${n()}</p>
      <h2>Reader results</h2>
      <div class="stagger">
        ${model.testimonials
          .map(
            (t) => `<blockquote>
          <p class="stars">★★★★★</p>
          <p>&ldquo;${esc(t.quote)}&rdquo;</p>
          <cite>&mdash; ${esc(t.author)}</cite>
        </blockquote>`,
          )
          .join('\n        ')}
      </div>
    </div>
  </section>`;
}

function sectionAuthors(model: LandingPageModel): string {
  const { copy } = model;
  return `  <section class="reveal">
    <div class="wrap">
      <h2>${esc(copy.authorHeading)}</h2>
      ${model.authorPhotoDataUri ? `<img class="cover" style="width:min(150px,40vw);margin-top:0;border-radius:8px" src="${esc(model.authorPhotoDataUri)}" alt="${esc(model.author ?? 'The author')}">` : ''}
      ${model.authorCredential ? `<p class="byline" style="margin-top:18px">${esc(model.authorCredential)}</p>` : ''}
      <p>${esc(copy.authorBio)}</p>
    </div>
  </section>`;
}

/**
 * The order section. With one product this is a price and a button; with
 * several it becomes the offer grid, because each book is bought separately and
 * a single button could only ever buy one of them.
 *
 * This branch is not cosmetic. The built-in template is the guaranteed fallback
 * when generated layout fails its contract, so a version that rendered only the
 * primary product would quietly ship a three-book page selling one book.
 */
function sectionOrder(model: LandingPageModel, p: LandingProduct | undefined, n: () => string): string {
  const multi = model.products.length > 1;
  return `  <section class="reveal center">
    <div class="wrap">
      <p class="mark">${n()}</p>
      <h2>${multi ? 'Choose your set' : 'Order the book'}</h2>
      ${multi ? offerGrid(model) : `${priceBlock(p, model)}\n      ${ctaButton(p, model.copy.ctaLabel, model)}`}
      ${paymentMarks(model)}
      ${model.guaranteeDays > 0 ? `<p class="cta-note muted">${model.guaranteeDays}-day money-back guarantee — email and it is refunded in full.</p>` : ''}
    </div>
  </section>`;
}

/** One card per product; every field on a card comes from that same record. */
function offerGrid(model: LandingPageModel): string {
  return `<div class="offers">${model.products.map((p) => offerCard(p, model)).join('')}</div>`;
}

function offerCard(p: LandingProduct, model: LandingPageModel): string {
  // See the assembler's twin: the bundle carries "Best value", never the hero
  // book, whose `featured` flag exists to pick the page's cover image.
  const flag = p.kind === 'bundle' ? 'Best value' : p.categoryLabel;
  const points = p.features.length > 0 ? p.features : p.contents.slice(0, 4);
  return (
    `<div class="offer${p.kind === 'bundle' ? ' offer-featured' : ''}">` +
    (flag ? `<span class="offer-flag">${esc(flag)}</span>` : '') +
    offerArt(p) +
    `<h3>${esc(p.title)}</h3>` +
    (p.subtitle ? `<p class="offer-sub">${esc(p.subtitle)}</p>` : '') +
    (points.length > 0 ? `<ul class="checks">${points.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '') +
    '<div class="offer-buy">' +
    priceBlock(p, model) +
    bundleSavings(p, model) +
    ctaButton(p, model.copy.ctaLabel, model) +
    '</div></div>'
  );
}

function offerArt(p: LandingProduct): string {
  if (p.kind === 'bundle') {
    const covers = p.bundleCoverDataUris ?? [];
    if (covers.length === 0) return '';
    return `<div class="offer-art offer-art-stack">${covers
      .map((src) => `<img src="${esc(src)}" alt="">`)
      .join('')}</div>`;
  }
  if (!p.coverDataUri) return `<div class="offer-art"><span class="cover-fallback">${esc(p.title)}</span></div>`;
  return `<div class="offer-art"><img src="${esc(p.coverDataUri)}" alt="${esc(p.title)} cover"></div>`;
}

/** Computed from the real per-book prices on this page — never model-written. */
function bundleSavings(p: LandingProduct, model: LandingPageModel): string {
  if (p.kind !== 'bundle' || p.priceCents === null) return '';
  const books = model.products.filter((o) => o.kind !== 'bundle');
  if (books.length === 0 || books.some((o) => o.priceCents === null)) return '';
  const saved = books.reduce((t, o) => t + (o.priceCents ?? 0), 0) - p.priceCents;
  if (saved <= 0) return '';
  return `<p class="offer-save">Save ${money(saved, model.currency)} vs buying separately</p>`;
}

/**
 * One section copied from the reference's structure. Shape follows `kind`, so
 * the same payload renders a card grid, a numbered method list or a two-column
 * figure table without the renderer knowing which template it came from.
 */
function templateSection(s: LandingTemplateSection, n: () => string): string {
  if (!s.heading) return '';
  const body =
    s.table && s.table.rows.length > 0
      ? templateTable(s.table)
      : s.items.length === 0
        ? ''
        : s.kind === 'comparison'
          ? `<div class="tmpl-compare">${s.items
              .map((i) => `<div><h3>${esc(i.title)}</h3><p>${esc(i.body)}</p></div>`)
              .join('')}</div>`
          : s.kind === 'steps'
            ? `<ol class="tmpl-steps">${s.items
                .map((i) => `<li><h3>${esc(i.title)}</h3><p>${esc(i.body)}</p></li>`)
                .join('')}</ol>`
            : s.kind === 'list'
              ? `<ul class="checks">${s.items
                  .map((i) => `<li><strong>${esc(i.title)}</strong> — ${esc(i.body)}</li>`)
                  .join('')}</ul>`
              : `<div class="tmpl-cards stagger">${s.items
                  .map((i) => `<div class="tmpl-card"><h3>${esc(i.title)}</h3><p>${esc(i.body)}</p></div>`)
                  .join('')}</div>`;

  return `  <section class="reveal">
    <div class="wrap">
      <p class="mark">${n()}</p>
      ${s.eyebrow ? `<p class="eyebrow">${esc(s.eyebrow)}</p>` : ''}
      <h2>${esc(s.heading)}</h2>
      ${s.intro ? `<p class="lede">${esc(s.intro)}</p>` : ''}
      ${body}
    </div>
  </section>`;
}

/** The two-column figure table. The source line is never omitted. */
function templateTable(t: NonNullable<LandingTemplateSection['table']>): string {
  return `<div class="tmpl-table-wrap"><table class="tmpl-table">
        <thead><tr><th></th><th>${esc(t.leftHeading)}</th><th>${esc(t.rightHeading)}</th></tr></thead>
        <tbody>${t.rows
          .map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.left)}</td><td>${esc(r.right)}</td></tr>`)
          .join('')}</tbody>
        ${
          t.leftTotal || t.rightTotal
            ? `<tfoot><tr><td>Total</td><td>${esc(t.leftTotal)}</td><td>${esc(t.rightTotal)}</td></tr></tfoot>`
            : ''
        }
      </table></div>
      <p class="tmpl-source">${esc(t.source)}</p>`;
}

function sectionFaq(model: LandingPageModel, n: () => string): string {
  if (model.copy.faqs.length === 0) return '';
  return `  <section class="reveal">
    <div class="wrap">
      <p class="mark">${n()}</p>
      <h2>Questions</h2>
      ${model.copy.faqs
        .map((f) => `<details><summary>${esc(f.question)}</summary><p>${esc(f.answer)}</p></details>`)
        .join('\n      ')}
    </div>
  </section>`;
}

function sectionLastCall(model: LandingPageModel, p: LandingProduct | undefined): string {
  // On a multi-book page the closing button should buy the whole set — that is
  // what the bundle is. Falling back to the primary book would make the last
  // thing a reader sees an offer for one third of what the page just sold.
  const target = model.products.find((o) => o.kind === 'bundle') ?? p;
  // An empty <h2> above the final buy button is worse than no heading: it
  // opens a heading-sized gap and reads as a rendering fault. The price and
  // the button are what this section is for; the line above them is a bonus.
  return `  <section class="reveal center">
    <div class="wrap">
      ${model.copy.closingHeading ? `<h2>${esc(model.copy.closingHeading)}</h2>` : ''}
      ${priceBlock(target, model)}
      ${ctaButton(target, model.copy.ctaLabel, model)}
    </div>
  </section>`;
}

// ── fragments ────────────────────────────────────────────────────────────────

function proofLine(model: LandingPageModel): string {
  const bits: string[] = [];
  if (model.subscriberCount && model.subscriberCount >= 1000) {
    bits.push(`${formatCount(model.subscriberCount)}+ subscribers`);
  }
  // A rating is a claim about real reviewers, so it appears only when supplied.
  if (model.rating) {
    bits.push(
      `${model.rating.score.toFixed(1)}★${model.rating.count ? ` from ${model.rating.count} readers` : ''}`,
    );
  }
  if (model.guaranteeDays > 0) bits.push(`${model.guaranteeDays}-day guarantee`);
  return bits.length > 0 ? `<div class="proof">${esc(bits.join('  ·  '))}</div>` : '';
}

function valueStack(model: LandingPageModel, p: LandingProduct | undefined): string {
  if (model.valueStack.length === 0 || !p || p.priceCents === null) return '';
  const total = model.valueStack.reduce((t, i) => t + i.valueCents, 0);
  return `<hr class="rule">
      <ul class="stack">
        ${model.valueStack
          .map((i) => `<li><span>${esc(i.label)}</span><span>${money(i.valueCents, model.currency)}</span></li>`)
          .join('\n        ')}
      </ul>
      <div class="stack-total"><span>Total value</span><span class="was">${money(total, model.currency)}</span></div>
      <div class="stack-pay"><span>You pay today</span><span>${money(p.priceCents, model.currency)}</span></div>`;
}

function cover(p: LandingProduct | undefined): string {
  if (!p) return '';
  if (p.coverDataUri) return `<img class="cover" src="${esc(p.coverDataUri)}" alt="${esc(p.title)} cover">`;
  return `<div class="cover-fallback"><span>${esc(p.title)}</span></div>`;
}

function priceBlock(p: LandingProduct | undefined, model: LandingPageModel): string {
  if (!p || p.priceCents === null) return '';
  const discounted = p.compareAtCents !== null && p.compareAtCents > p.priceCents;
  const was = discounted ? `<span class="price-was">${money(p.compareAtCents!, model.currency)}</span>` : '';
  const note = discounted
    ? `<p class="price-note">Launch price${model.promoEndsAt ? ' — ends soon' : ''}</p>`
    : '<p class="price-note">One-time payment</p>';
  return `<div class="price-row"><span class="price">${money(p.priceCents, model.currency)}</span>${was}</div>${note}`;
}

function paymentMarks(model: LandingPageModel): string {
  if (model.paymentMethods.length === 0) return '';
  return `<div class="pay">${model.paymentMethods.map((m) => `<span>${esc(m)}</span>`).join('')}</div>`;
}

/**
 * The checkout URL is written in verbatim and never composed, rewritten or
 * generated — a mangled link is the one defect on this page that costs real
 * money. With no link the button renders inert, which is what makes a preview
 * possible before the product exists on the store.
 */
function ctaButton(p: LandingProduct | undefined, label: string, model: LandingPageModel): string {
  const price = p && p.priceCents !== null ? ` — ${money(p.priceCents, model.currency)}` : '';
  const text = esc(label) + price;
  if (!p?.checkoutUrl) {
    return `<span class="cta" aria-disabled="true">${text}</span>
      <p class="cta-note muted">Checkout link not set yet.</p>`;
  }
  return `<a class="cta" href="${esc(p.checkoutUrl)}" rel="noopener nofollow">${text}</a>`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** Hands out roman numerals in order, so omitted sections leave no gap. */
function counter(): () => string {
  let i = 0;
  return () => NUMERALS[i++] ?? String(i);
}

/**
 * Escapes into HTML text/attribute context. Every model-supplied string passes
 * through here, so prose from Claude and a checkout URL from the user are both
 * inert data — they can never become markup.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function money(cents: number, currency: string): string {
  const amount = cents / 100;
  // Whole prices ($47) read better than padded ones ($47.00) in a headline.
  const text = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const symbol = SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${text}` : `${text} ${currency.toUpperCase()}`;
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$' };

/** Compact subscriber-style counts: 280000 → "280K". */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Roman numeral for the edition line, e.g. 2026 → "MMXXVI". */
export function romanYear(year: number): string {
  const table: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let n = year;
  let out = '';
  for (const [value, sym] of table) {
    while (n >= value) {
      out += sym;
      n -= value;
    }
  }
  return out;
}

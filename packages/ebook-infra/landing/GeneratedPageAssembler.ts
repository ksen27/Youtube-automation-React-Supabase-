import {
  PLACEHOLDERS,
  fillPlaceholders,
  type GeneratedPage,
  type LandingPageAssembler,
  type LandingPageModel,
  type LandingProduct,
} from '@ebook/core';
import { ARMING_SCRIPT, OBSERVER_SCRIPT, REVEAL_CSS, esc, money, truncate } from './shared';

/**
 * Turns a validated, model-generated layout into the finished page.
 *
 * The model supplied only `css` and `bodyHtml`. Everything with consequences is
 * added here: the document shell, the cover-derived palette variables, the
 * reveal and countdown scripts, and the real markup behind each placeholder —
 * so the checkout link, the price, the cover and the legal footer are ours no
 * matter what the model wrote.
 */
export class GeneratedPageAssembler implements LandingPageAssembler {
  assemble({ page, model }: { page: GeneratedPage; model: LandingPageModel }): string {
    const primary = model.products.find((p) => p.featured) ?? model.products[0];
    const title = primary?.title ?? model.siteName;

    // The cover is a base64 data URI; embedding it once per {{COVER}} would
    // multiply page weight by the occurrence count. The first slot carries the
    // real image; later slots are lightweight copies the page's own script
    // fills from the first (see OBSERVER_SCRIPT).
    const bodyWithCovers = page.bodyHtml
      .split(PLACEHOLDERS.cover)
      .map((part, i) => (i === 0 ? part : `${i === 1 ? coverMarkup(primary) : coverCopyMarkup(primary)}${part}`))
      .join('');

    const body = fillPlaceholders(dropPriceBesideCta(bodyWithCovers), {
      cta: ctaMarkup(primary, model),
      price: priceMarkup(primary, model),
      cover: '',
      contents: contentsMarkup(primary),
      contentsList: contentsListMarkup(primary),
      guarantee: guaranteeMarkup(model),
      paymentMarks: paymentMarkup(model),
      testimonials: testimonialsMarkup(model),
      legal: legalMarkup(model),
      logo: logoMarkup(model),
      offerGrid: offerGridMarkup(model),
      authorPhoto: authorPhotoMarkup(model),
      coverStack: coverStackMarkup(model),
      bookBreakdown: bookBreakdownMarkup(model),
    });

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(truncate(model.copy.subheadline, 300))}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(truncate(model.copy.subheadline, 300))}">
<meta property="og:type" content="website">
<!-- No og:image — see the note in LandingPageHtmlRenderer: a data: URI is
     ignored by every scraper, so this tag was pure page weight. -->
<style>
  /* Palette derived from this book's cover; the generated CSS may only
     reference these, which is what makes its contrast provable. */
  :root {
    ${model.palette.toCssVariables()};
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
  body { margin: 0; background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased; }
  img { max-width: 100%; height: auto; }
  /* A generated layout must never scroll the page sideways. This must be
     \`clip\`, not \`hidden\`: an element with overflow-x hidden gets overflow-y
     computed to auto, turning body into its own scroll container — which is a
     second vertical scrollbar next to the viewport's. clip clips the axis
     without creating a scroll container at all. */
  body, main { overflow-x: clip; }
  table { max-width: 100%; }

/* ── system components ────────────────────────────────────────────────────
   Baseline styling for the markup substituted into the placeholders. The
   model's layout CSS comes AFTER this block, so it can restyle any of these
   selectors and win — but a layout that never mentions them still renders
   buttons as buttons rather than as bare inline text. */
${COMPONENT_CSS}
/* ── generated layout ─────────────────────────────────────────────────── */
${page.css}
/* ── structural guard ─────────────────────────────────────────────────── */
${STRUCTURAL_CSS}
/* ── system behaviour ─────────────────────────────────────────────────── */
${REVEAL_CSS}
</style>
<script>${ARMING_SCRIPT}</script>
</head>
<body>
${body}
<script>${OBSERVER_SCRIPT}</script>
</body>
</html>`;
  }
}

/**
 * Default look of every substituted component, on the palette variables. This
 * is what was missing when the first real generation shipped buy buttons as
 * bare inline text: the injected markup carries classes the model has never
 * heard of, so unless WE style them, nobody does.
 */
/**
 * The geometry of system-rendered components, re-asserted AFTER the model's CSS.
 *
 * COMPONENT_CSS deliberately loses to the layout — a generated page should be
 * able to theme these components rather than wear bolted-on defaults. But
 * "restyle" and "reflow into something broken" are not the same freedom, and
 * nothing separated them: the model styles blocks it never sees the markup of,
 * so a selector that happens to match ours reflows a component it cannot
 * picture. That shipped one book's block as a wide two-column card and the
 * next as a column of two-word lines beside a floating cover.
 *
 * Only geometry is pinned here. Colour, type, spacing, borders and radius —
 * everything that makes the page look like its template — stay the model's.
 */
const STRUCTURAL_CSS = `
  /* Every book block is the same shape. These are one render of one loop, so
     any difference between them came from a selector that caught some and not
     others. */
  .book { grid-template-columns: minmax(120px, 180px) minmax(22ch, 1fr); }
  .book > * { order: 0; grid-column: auto; grid-row: auto; }
  .book-body { min-width: 0; }
  @media (max-width: 620px) { .book { grid-template-columns: 1fr; } }

  /* Page-sized images stay page-sized. The contract keeps these out of the top
     bar, but it can only see the markup ABOVE the first <section> — a header
     nested inside one slips past it, and then only a cap stands between a
     portrait and the whole viewport. */
  .logo { max-width: 72px; max-height: 72px; }
  .author-photo { max-width: 100%; max-height: min(60vh, 520px); }
  .cover { max-width: min(280px, 60vw); }
`;

const COMPONENT_CSS = `
  .cta {
    display: inline-block; background: var(--accent); color: var(--accent-contrast);
    font-weight: 700; font-size: 1.02rem; text-decoration: none; text-align: center;
    padding: 15px 34px; border-radius: 8px; cursor: pointer; max-width: 100%;
    white-space: nowrap; transition: filter .12s ease;
  }
  .cta:hover { filter: brightness(1.08); }
  .cta:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  /* Not-yet-active keeps the REAL button's look, slightly dimmed — the preview
     should show the page as it will publish, and a dashed ghost reads as a
     different design rather than a pending link. The note below explains why
     it is inert. */
  .cta[aria-disabled="true"] {
    filter: saturate(.7) brightness(.82); cursor: not-allowed; pointer-events: none;
  }
  /* Keeps the explanatory note UNDER its button wherever the button lands —
     in a sticky bar it otherwise wraps beside it as loose text. */
  .cta-wrap { display: inline-flex; flex-direction: column; align-items: center; gap: 6px; max-width: 100%; }
  .cta-note { display: block; font-size: .74rem; color: var(--muted); margin: 0; }

  .price-row { display: inline-flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 14px 0; }
  .price { font-size: 2.2rem; font-weight: 700; color: var(--heading); line-height: 1; }
  .price-was { font-size: 1.1rem; color: var(--muted); text-decoration: line-through; }
  .save {
    background: var(--accent); color: var(--accent-contrast); font-size: .68rem; font-weight: 700;
    letter-spacing: .07em; text-transform: uppercase; padding: 4px 10px; border-radius: 999px;
  }

  /* A full-width row on its own line — inline-flex let it land BESIDE the
     price in a flex parent, which is the mis-placement run 1489a338 shipped. */
  .pay { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; width: 100%; justify-content: center; }
  .pay span { font-size: .72rem; color: var(--muted); border: 1px solid var(--border);
              border-radius: 4px; padding: 4px 9px; }

  .guarantee { border: 2px solid var(--accent); border-radius: 12px; padding: 22px 24px; margin: 10px 0; }

  /* Three columns, matching the reference template. One long stacked list of
     fourteen chapters read as a table of contents and pushed the CTA down the
     page (client feedback 2026-08-06). */
  /* HELD TO A READABLE COLUMN. A layout that puts the grid in a full-bleed
     section stretched it across the whole viewport — on a wide monitor that is
     three cards of ~600px each, with four-word bullets adrift in them, and the
     section reads as enormous however few chapters it holds. The measure is
     what made it feel like a wall; the count never was. */
  .contents, .contents-list { max-width: 1080px; margin-inline: auto; }
  .contents { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  @media (max-width: 900px) { .contents { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 620px) { .contents { grid-template-columns: 1fr; } }
  .contents-item { border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
  .contents-num { font-size: .68rem; letter-spacing: .12em; text-transform: uppercase;
    color: var(--accent); margin: 0 0 .5em; }
  .contents-more { font-size: .76rem; color: var(--accent); margin: .4em 0 0; }
  /* The count of what the grid did NOT list. Centred under it, quiet — it is a
     note about the book's depth, not another card competing with the offer. */
  .contents-rest { font-size: .82rem; color: var(--muted); text-align: center; margin: 14px 0 0;
                   letter-spacing: .04em; }
  /* The compact variant: a stack of lines, the shape a reference uses when its
     "what you get" sits beside the price rather than filling a section. */
  .contents-list { list-style: none; margin: 0; padding: 0; }
  .contents-list li { display: flex; gap: 12px; align-items: baseline; padding: 10px 0;
                      border-bottom: 1px solid var(--border); color: var(--heading); }
  .contents-list li:last-child { border-bottom: 0; }
  .contents-list-num { font-size: .7rem; letter-spacing: .12em; color: var(--accent); flex: none; }
  .contents-item h3 { margin: 0 0 .2em; color: var(--heading); }
  .contents-count { font-size: .74rem; letter-spacing: .1em; text-transform: uppercase;
                    color: var(--accent); margin: 0 0 6px; }
  .contents-item ul { list-style: none; padding: 0; margin: 0; }
  .contents-item li { padding: 5px 0 5px 18px; position: relative; color: var(--muted); font-size: .94rem; }
  .contents-item li::before { content: "·"; position: absolute; left: 4px; color: var(--accent); }

  .testimonials { display: grid; gap: 16px; }
  .testimonials blockquote { margin: 0; padding: 18px 20px; border-left: 3px solid var(--accent);
                             background: var(--surface); border-radius: 0 10px 10px 0; }
  .testimonials cite { font-style: normal; font-size: .84rem; color: var(--muted); }

  /* The injected cover had NO default rule, so a layout that never styled
     .cover left the image at its intrinsic size — floating in a column at
     whatever width it happened to be, with dead space around it. */
  .cover { display: block; width: 100%; max-width: min(280px, 60vw); height: auto;
           margin-inline: auto; border-radius: 4px; }

  /* One block per book — cover beside contents, as the reference's "what's
     inside" presents each volume. Stacks on a phone. */
  .books { display: grid; gap: 22px; }
  .book { display: grid; grid-template-columns: minmax(120px, 180px) minmax(22ch, 1fr); gap: 24px;
          align-items: start; padding: 22px; background: var(--surface);
          border: 1px solid var(--border); border-radius: 10px; }
  @media (max-width: 620px) { .book { grid-template-columns: 1fr; } }
  .book-cover { display: block; width: 100%; height: auto; border-radius: 4px;
                box-shadow: 0 12px 30px -12px rgba(0,0,0,.55); }
  .book-body { min-width: 0; }
  .book-index { margin: 0 0 4px; font-size: .68rem; letter-spacing: .16em; text-transform: uppercase;
                color: var(--accent); }
  .book-body h3 { margin: 0 0 .3em; color: var(--heading); font-size: 1.16rem; }
  .book-sub { margin: 0 0 12px; font-size: .9rem; color: var(--muted); }
  .book-body ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 7px; }
  .book-body li { padding-left: 18px; position: relative; font-size: .92rem; color: var(--muted); }
  .book-body li::before { content: "·"; position: absolute; left: 5px; color: var(--accent); }

  /* The set of books, as the reference hero shows them: the featured title
     centred and slightly larger, the others flanking it. */
  .cover-stack { display: flex; align-items: center; justify-content: center; gap: 18px; flex-wrap: wrap; }
  .cover-stack-item { display: block; width: min(200px, 26vw); height: auto; border-radius: 4px;
                      box-shadow: 0 18px 40px -14px rgba(0,0,0,.55); }
  .cover-stack-lead { width: min(240px, 32vw); order: -1; }
  /* Centre the lead on wide viewports; stacked order is fine below that. */
  @media (min-width: 700px) { .cover-stack-lead { order: 0; } }

  .cover-fallback { display: grid; place-items: center; aspect-ratio: 2/3; width: min(230px, 60vw);
                    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
                    padding: 22px; text-align: center; font-weight: 700; color: var(--heading); }

  .legal p { font-size: .76rem; color: var(--muted); margin: 0 0 .6em; }
  .legal .edition { letter-spacing: .2em; text-transform: uppercase; font-size: .72rem; }

  /* ── offer grid ──
     One card per product, each carrying its OWN price and buy link. Sized so
     three cards sit in a row on desktop and stack cleanly on a phone. */
  .offers { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); }
  .offer {
    display: flex; flex-direction: column; gap: 12px; padding: 22px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  }
  .offer-featured { border-color: var(--accent); border-width: 2px; }
  /* The bundle takes the full row rather than orphaning onto a second one as a
     lone narrow card, and lays out horizontally where there is room. */
  .offer-bundle { grid-column: 1 / -1; }
  @media (min-width: 760px) {
    .offer-bundle { display: grid; grid-template-columns: minmax(160px, 240px) 1fr minmax(200px, 260px);
                    gap: 26px; align-items: center; }
    .offer-bundle .offer-flag { grid-column: 1 / -1; }
    .offer-bundle .offer-buy { margin-top: 0; }
  }
  .offer-flag {
    align-self: flex-start; background: var(--accent); color: var(--accent-contrast);
    font-size: .66rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    padding: 4px 10px; border-radius: 999px;
  }
  .offer-art { display: flex; justify-content: center; gap: 6px; }
  /* CONTAIN, not cover. A cover forced into a 2:3 box was cropped left and
     right, so each card showed a vertical strip through the middle of the
     artwork with the title sliced in half — the one image whose whole job is to
     be read. The box keeps its shape so the cards still line up; the artwork
     sits inside it whatever its own proportions are. */
  .offer-art img, .offer-art .cover-fallback { width: min(150px, 45%); aspect-ratio: 2/3;
    object-fit: contain; border-radius: 6px; filter: drop-shadow(0 6px 14px rgba(0,0,0,.18)); }
  /* The bundle stacks its books; each cover overlaps the one before it. */
  .offer-art-stack img, .offer-art-stack .cover-fallback { width: min(110px, 32%); }
  .offer-art-stack > * + * { margin-left: -34px; }
  .offer h3 { margin: 0; color: var(--heading); font-size: 1.12rem; }
  .offer-sub { margin: 0; font-size: .88rem; color: var(--muted); }
  .offer ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
  .offer li { padding-left: 18px; position: relative; font-size: .88rem; color: var(--muted); }
  .offer li::before { content: "·"; position: absolute; left: 5px; color: var(--accent); }
  /* Pins price + button to the card's bottom, so cards with different amounts
     of text still line their buy buttons up across the row. */
  .offer-buy { margin-top: auto; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .offer-buy .price-row { margin: 6px 0; }
  .offer-buy .cta { width: 100%; white-space: normal; }
  .offer-save { font-size: .78rem; font-weight: 700; color: var(--accent); margin: 0; }

  .logo { height: 44px; width: 44px; border-radius: 50%; object-fit: cover; }

  /* Sized to the slot it lands in rather than fixed: the reference pages use
     the same portrait large in the hero and small beside the author bio. */
  /* Sized BY ITS CONTAINER, never by a fixed figure. The previous default —
     max-width 460px with a forced 4/5 ratio — rendered a 460x575 portrait
     wherever it landed, which covered the whole sticky bar and the hero behind
     it when a layout placed it up there. The caps below mean a bad placement
     is merely wrong, not page-breaking. */
  .author-photo {
    display: block; width: 100%; max-width: 100%; height: auto;
    max-height: min(60vh, 520px); object-fit: cover; border-radius: 6px;
  }
`;

// ── placeholder markup ───────────────────────────────────────────────────────

/**
 * The checkout URL is written in verbatim and never composed, rewritten or
 * generated — a mangled link is the one defect on this page that costs real
 * money. With no link the button renders inert, which is what makes a preview
 * possible before the product exists on the store.
 */
function ctaMarkup(p: LandingProduct | undefined, model: LandingPageModel, label?: string): string {
  // The copy's ctaLabel names the FEATURED book ("Get the DIY Repair Bible"),
  // which is right in the hero and wrong on every other card of a multi-book
  // offer grid — every button there advertised book one. Cards pass their own
  // label, which already carries the price, so nothing is appended to it.
  if (label) {
    const cardText = esc(label);
    if (!p?.checkoutUrl) {
      return `<span class="cta-wrap"><span class="cta" aria-disabled="true">${cardText}</span><span class="cta-note">Checkout link not set yet</span></span>`;
    }
    return `<a class="cta" href="${esc(p.checkoutUrl)}" rel="noopener nofollow">${cardText}</a>`;
  }
  const price = p && p.priceCents !== null ? ` — ${money(p.priceCents, model.currency)}` : '';
  const text = esc(model.copy.ctaLabel) + price;
  if (!p?.checkoutUrl) {
    return `<span class="cta-wrap"><span class="cta" aria-disabled="true">${text}</span><span class="cta-note">Checkout link not set yet</span></span>`;
  }
  return `<a class="cta" href="${esc(p.checkoutUrl)}" rel="noopener nofollow">${text}</a>`;
}

function priceMarkup(p: LandingProduct | undefined, model: LandingPageModel): string {
  if (!p || p.priceCents === null) return '';
  const discounted = p.compareAtCents !== null && p.compareAtCents > p.priceCents;
  return (
    `<span class="price-row"><span class="price">${money(p.priceCents, model.currency)}</span>` +
    (discounted ? `<span class="price-was">${money(p.compareAtCents!, model.currency)}</span>` : '') +
    (discounted
      ? `<span class="save">Save ${money(p.compareAtCents! - p.priceCents, model.currency)}</span>`
      : '') +
    '</span>'
  );
}

/**
 * Drops a {{PRICE}} that sits directly on top of a {{CTA}}.
 *
 * The button's label already ends with the price, so the two together render the
 * amount twice — which is how the order block shipped a large "$10" stacked on a
 * button reading "Get the Complete 3-Book Set — $10". Only adjacent pairs are
 * touched: a price elsewhere on the page is the page doing its job, and the
 * layout is free to put one wherever a buyer needs to see it.
 */
function dropPriceBesideCta(bodyHtml: string): string {
  // Nothing but whitespace and markup may sit between them — anything else means
  // they belong to different parts of the block and both are wanted.
  const gap = '(?:\\s|<[^>]*>)*';
  const price = PLACEHOLDERS.price.replace(/[{}]/g, '\\$&');
  const cta = PLACEHOLDERS.cta.replace(/[{}]/g, '\\$&');
  return bodyHtml.replace(new RegExp(`${price}(${gap})${cta}`, 'g'), `$1${PLACEHOLDERS.cta}`);
}

/** A later cover slot: no data URI of its own; the page script fills it. */
function coverCopyMarkup(p: LandingProduct | undefined): string {
  if (!p) return '';
  if (p.coverDataUri) return `<img class="cover" data-cover-copy alt="${esc(p.title)} cover">`;
  return `<span class="cover cover-fallback">${esc(p.title)}</span>`;
}

/**
 * Every book's own cover, side by side, with the featured one raised.
 *
 * Each image carries its own data URI — unlike the repeated {{COVER}} slots,
 * which are copies of one image on purpose. That is the whole distinction: a
 * page selling three books must show three covers, and repeating {{COVER}}
 * showed the same book three times.
 */
function coverStackMarkup(model: LandingPageModel): string {
  const books = model.products.filter((p) => p.kind !== 'bundle');
  if (books.length === 0) return '';
  return `<div class="cover-stack">${books
    .map((p) => {
      const classes = `cover-stack-item${p.featured ? ' cover-stack-lead' : ''}`;
      if (!p.coverDataUri) return `<span class="${classes} cover-fallback">${esc(p.title)}</span>`;
      return `<img class="${classes}" src="${esc(p.coverDataUri)}" alt="${esc(p.title)} cover">`;
    })
    .join('')}</div>`;
}

/**
 * One block per book: its own cover beside its own contents.
 *
 * Every field in a block comes from ONE product record in a single pass — the
 * same discipline as the offer grid, and for the same reason. Left to the copy
 * and the layout, this section came back as three chapter ranges of one book,
 * each beside the same cover.
 */
function bookBreakdownMarkup(model: LandingPageModel): string {
  const books = model.products.filter((p) => p.kind !== 'bundle');
  if (books.length === 0) return '';

  return `<div class="books">${books
    .map((p, i) => {
      // Its own outline if we have one, else its chapter titles. Never the
      // featured book's — that is the mismatch this element exists to prevent.
      const points = p.sections.length > 0 ? p.sections.map((s) => s.title) : p.contents;
      const cover = p.coverDataUri
        ? `<img class="book-cover" src="${esc(p.coverDataUri)}" alt="${esc(p.title)} cover">`
        : `<span class="book-cover cover-fallback">${esc(p.title)}</span>`;

      return (
        `<div class="book">${cover}<div class="book-body">` +
        `<p class="book-index">${books.length > 1 ? `Book ${i + 1}` : 'The book'}</p>` +
        `<h3>${esc(p.title)}</h3>` +
        (p.subtitle ? `<p class="book-sub">${esc(p.subtitle)}</p>` : '') +
        (points.length > 0
          ? `<ul>${points.slice(0, 6).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
          : '') +
        '</div></div>'
      );
    })
    .join('')}</div>`;
}

function coverMarkup(p: LandingProduct | undefined): string {
  if (!p) return '';
  if (p.coverDataUri) return `<img class="cover" src="${esc(p.coverDataUri)}" alt="${esc(p.title)} cover">`;
  return `<span class="cover cover-fallback">${esc(p.title)}</span>`;
}

/**
 * How many of a chapter's key points a card shows. Mirrors the constant of the
 * same name in LandingPageHtmlRenderer — the two renderers are independent paths
 * (built-in vs cloned template) that deliberately share no code, so the value is
 * duplicated rather than imported across them. Keep the two in step.
 */
const MAX_POINTS_PER_CARD = 4;

/**
 * The contents section lists EVERY chapter.
 *
 * It was capped at nine while the grid ran the full width of the screen, which
 * made the section feel enormous for the wrong reason: the problem was the
 * measure, not the count. With the grid held to a readable column (see
 * `.contents` below) the whole list reads as a table of contents rather than a
 * wall, and the seller's judgement is that a buyer should see everything the
 * book covers. The per-card points are still capped — those are the book's
 * substance, and printing all of them gives the product away.
 */

/**
 * The contents section: what each chapter is called and what is in it.
 *
 * A FEW of each chapter's key points are printed — capped at
 * MAX_POINTS_PER_CARD, with the remainder counted rather than listed.
 *
 * This reverses an earlier decision to print none of them. The concern behind
 * that was real: the points are the book's substance ("Buy the $22 Topdon
 * ArtiLink 200"), and a fourteen-chapter book has roughly seventy, which on a
 * free page is the product being given away by the page selling it. But showing
 * only "5 methods" left a contents section with nothing concrete in it, which
 * reads as a table of contents rather than a reason to buy — and the client's
 * reference page shows specifics (feedback 2026-08-06).
 *
 * The cap is the compromise: enough specifics to prove the book deals in
 * concrete claims, few enough that the chapter still has to be bought.
 */
function contentsMarkup(p: LandingProduct | undefined): string {
  const sections = p?.sections ?? [];
  if (sections.length === 0) return '';
  return `<div class="contents stagger">${sections
    .map((s, i) => {
      const shown = s.items.slice(0, MAX_POINTS_PER_CARD);
      const rest = s.items.length - shown.length;
      return (
        `<div class="contents-item">` +
        `<p class="contents-num">Chapter ${String(i + 1).padStart(2, '0')}</p>` +
        `<h3>${esc(s.title)}</h3>` +
        (shown.length > 0
          ? `<ul>${shown.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>`
          : '') +
        (rest > 0 ? `<p class="contents-more">+${rest} more</p>` : '') +
        '</div>'
      );
    })
    .join('')}</div>`;
}

/**
 * The chapters as a plain list — one line each, numbered, no cards.
 *
 * For references whose "what you get" is a short stack rather than a grid of
 * cards. Every chapter, like the grid: the difference between the two is
 * presentation, never how much of the book is shown.
 */
function contentsListMarkup(p: LandingProduct | undefined): string {
  const sections = p?.sections ?? [];
  if (sections.length === 0) return '';
  return (
    `<ul class="contents-list stagger">${sections
      .map((s, i) => `<li><span class="contents-list-num">${String(i + 1).padStart(2, '0')}</span>${esc(s.title)}</li>`)
      .join('')}</ul>`
  );
}

function guaranteeMarkup(model: LandingPageModel): string {
  if (model.guaranteeDays <= 0) return '';
  return (
    `<div class="guarantee"><strong>${model.guaranteeDays}-day money-back guarantee.</strong> ` +
    `Read it. If it doesn't deliver, email for a full refund within ${model.guaranteeDays} days — no questions asked.</div>`
  );
}

function paymentMarks(model: LandingPageModel): string[] {
  return model.paymentMethods;
}

function paymentMarkup(model: LandingPageModel): string {
  const marks = paymentMarks(model);
  if (marks.length === 0) return '';
  return `<span class="pay">${marks.map((m) => `<span>${esc(m)}</span>`).join('')}</span>`;
}

/** Only ever real quotes the seller supplied; never generated. */
function testimonialsMarkup(model: LandingPageModel): string {
  if (model.testimonials.length === 0) return '';
  return `<div class="testimonials stagger">${model.testimonials
    .map(
      (t) =>
        `<blockquote><p>&ldquo;${esc(t.quote)}&rdquo;</p><cite>&mdash; ${esc(t.author)}</cite></blockquote>`,
    )
    .join('')}</div>`;
}

/** The channel's own avatar as a brand mark. Absent → nothing, not a gap. */
function logoMarkup(model: LandingPageModel): string {
  if (!model.logoDataUri) return '';
  return `<img class="logo" src="${esc(model.logoDataUri)}" alt="${esc(model.siteName)}">`;
}

/**
 * The author's photograph. Optional, and silently absent when the seller has
 * not uploaded one — which is why the prompt forbids wrapping it in a heading
 * or frame that would otherwise be left standing empty.
 */
function authorPhotoMarkup(model: LandingPageModel): string {
  if (!model.authorPhotoDataUri) return '';
  return `<img class="author-photo" src="${esc(model.authorPhotoDataUri)}" alt="${esc(model.author ?? 'The author')}">`;
}

/**
 * The complete offer section: one card per product, each with its own cover,
 * price and checkout link.
 *
 * This is system-rendered for one reason. A three-book page carries up to four
 * different buy links, and the model has no way to know which link sells which
 * book — so it never gets to decide. Every field on a card is read from the
 * SAME LandingProduct record in a single pass, which makes a link landing under
 * the wrong cover structurally impossible rather than merely unlikely.
 */
function offerGridMarkup(model: LandingPageModel): string {
  if (model.products.length === 0) return '';
  return `<div class="offers stagger">${model.products.map((p) => offerCardMarkup(p, model)).join('')}</div>`;
}

function offerCardMarkup(p: LandingProduct, model: LandingPageModel): string {
  const isBundle = p.kind === 'bundle';
  // "Best value" belongs to the bundle — it is the cheapest way to get
  // everything. A single book gets whatever category the copy gave it.
  const flag = isBundle ? 'Best value' : p.categoryLabel;
  // Features are the card's selling points; chapter titles stand in when the
  // model gave none, since an empty card reads as a broken one.
  const points = p.features.length > 0 ? p.features : p.contents.slice(0, 4);

  return (
    `<div class="offer${isBundle ? ' offer-featured offer-bundle' : ''}">` +
    (flag ? `<span class="offer-flag">${esc(flag)}</span>` : '') +
    offerArtMarkup(p, isBundle) +
    `<h3>${esc(p.title)}</h3>` +
    (p.subtitle ? `<p class="offer-sub">${esc(p.subtitle)}</p>` : '') +
    (points.length > 0 ? `<ul>${points.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '') +
    '<div class="offer-buy">' +
    priceMarkup(p, model) +
    bundleSavingsMarkup(p, model) +
    ctaMarkup(p, model, offerCtaLabel(p, model)) +
    '</div></div>'
  );
}

/**
 * A card's button label. Names no book on purpose: with several cards on one
 * page, "Get the <featured title>" is wrong on all but one of them, and the
 * price is the thing a buyer is choosing between anyway.
 */
function offerCtaLabel(p: LandingProduct, model: LandingPageModel): string {
  // No price in the label. The card prints the price directly ABOVE the button,
  // so "Get it for $50" under a large "$50" said the same number twice in two
  // sizes — which reads as a mistake, and on a three-card row it is the noise
  // that makes the cards hard to compare. The price row is where a buyer
  // compares; the button is where they act.
  //
  // The label names no book on purpose either: with several cards on one page,
  // "Get the <featured title>" is wrong on all but one of them.
  if (p.kind === 'bundle') return 'Get the complete set';
  return model.products.length > 1 ? 'Get this book' : 'Get the book';
}

/** A book shows its cover; a bundle shows the covers of everything in it. */
function offerArtMarkup(p: LandingProduct, isBundle: boolean): string {
  if (isBundle) {
    const covers = p.bundleCoverDataUris ?? [];
    if (covers.length === 0) return '';
    return (
      `<div class="offer-art offer-art-stack">` +
      covers.map((src) => `<img src="${esc(src)}" alt="">`).join('') +
      '</div>'
    );
  }
  if (!p.coverDataUri) return `<div class="offer-art"><span class="cover-fallback">${esc(p.title)}</span></div>`;
  return `<div class="offer-art"><img src="${esc(p.coverDataUri)}" alt="${esc(p.title)} cover"></div>`;
}

/**
 * What the bundle actually saves, computed from the real per-book prices on
 * this very page — never a figure the model wrote. If the books' prices are
 * unknown, or the bundle isn't cheaper, nothing is claimed.
 */
function bundleSavingsMarkup(p: LandingProduct, model: LandingPageModel): string {
  if (p.kind !== 'bundle' || p.priceCents === null) return '';
  const books = model.products.filter((o) => o.kind !== 'bundle');
  if (books.length === 0 || books.some((o) => o.priceCents === null)) return '';
  const sum = books.reduce((total, o) => total + (o.priceCents ?? 0), 0);
  const saved = sum - p.priceCents;
  if (saved <= 0) return '';
  return `<p class="offer-save">Save ${money(saved, model.currency)} vs buying separately</p>`;
}

/**
 * The disclaimer is substituted rather than written by the model, so it is
 * present and correct on every generated page regardless of what layout came
 * back.
 */
function legalMarkup(model: LandingPageModel): string {
  return (
    `<div class="legal">` +
    (model.edition ? `<p class="edition">${esc(model.edition)}</p>` : '') +
    `<p>© ${new Date().getFullYear()} ${esc(model.siteName)}. All rights reserved.</p>` +
    `<p>This is a digital product delivered as a downloadable file; nothing is shipped. ` +
    `Any figures shown are illustrative and not a guarantee — individual results vary.</p>` +
    `</div>`
  );
}

export { PLACEHOLDERS };

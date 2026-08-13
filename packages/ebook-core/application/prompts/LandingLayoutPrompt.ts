import { PALETTE_VARS, PLACEHOLDERS } from '../landing/pageContract';
import { systemStackFor } from '../../domain/landing/fontStacks';
import type { ReferencePage } from '../ports/services/ReferencePageFetcher';
import type { ReferenceShot } from '../ports/services/ReferenceScreenshotter';
import type { AiContentBlock } from '../ports/services/AiTextGenerator';

/**
 * The layout call: capture a reference site's page structure as a REUSABLE
 * template, with {{COPY:…}} slots wherever a book's words belong.
 *
 * Runs once per reference, not once per book. That is both what makes it
 * affordable — it was a 30k-token Opus call on every generation — and what
 * satisfies the requirement it exists for: the client wants every page to
 * follow the same template, and a layout re-derived per book is a different
 * page every time. Captured once, every book pours into identical bones.
 *
 * It never sees a book. Copy is written separately against the slot manifest
 * this returns, so no book's prose can be baked into a template that other
 * books will reuse.
 */
/**
 * What "a good layout" currently means. BUMP THIS whenever this prompt or the
 * page contract changes in a way that should produce a different layout.
 *
 * A derived layout is cached per reference and reused by every book that
 * follows it — that cache is what makes the second book free, and it returns
 * BEFORE this prompt or the contract is reached. So a deployed change to either
 * one silently did nothing to any reference already in the cache: the rules
 * about not inventing sections, and about matching how the reference shows
 * what's inside, landed and the next page came back exactly as before
 * ("layoutRebuilt: false" in the worker log, which was the only clue).
 *
 * Folding this into the layout's input hash makes a deploy invalidate the
 * layouts it actually affects, and nothing else — the same job LANDING_PIPELINE_VERSION
 * does for cloned templates.
 *
 * 2: sections follow the reference (hero/order only are required),
 *    {{CONTENTS_LIST}} added, design-plan and finish rules added.
 */
export const LANDING_LAYOUT_VERSION = 2;

export const LandingLayoutPrompt = {
  build(input: {
    reference: ReferencePage | null;
    /**
     * How many products the page sells. Above one, the offer grid replaces the
     * single-product rules — the reference's own tier section is then a feature
     * to copy rather than something to collapse down to one card.
     */
    productCount: number;
    /**
     * Whether a real author photograph exists. Told explicitly either way: a
     * layout that places {{AUTHOR_PHOTO}} when none was uploaded leaves a hole
     * where the reference has a portrait.
     */
    hasAuthorPhoto?: boolean;
    /**
     * Whether a channel avatar actually resolved. Told explicitly for the same
     * reason as the photo: a header designed around a brand mark that renders
     * to nothing is a lopsided bar with a hole where the reference has a logo.
     */
    hasLogo?: boolean;
    /** e.g. "MMXXVI · No. I", for a masthead slot the reference has. */
    edition?: string | null;
    /** Screenshots of the reference, attached to the user message as images. */
    referenceShots?: ReferenceShot[];
    /** Errors from the previous attempt, when this is the repair round. */
    repairErrors?: string[];
  }) {
    const system = [
      'You build single-page sales sites. You return ONLY JSON with exactly these keys:',
      '  css      — the page stylesheet, no <style> tag',
      '  bodyHtml — the page markup, no <html>, <head>, <body> or <style> tags',
      '  slots    — the copy slots your markup uses (see COPY SLOTS below)',
      '',
      'YOU WRITE LAYOUT, NOT CONTENT AND NOT VALUES.',
      '',
      'COPY SLOTS. You are building a REUSABLE TEMPLATE, not one book\'s page.',
      'Many different books will be poured into this exact markup, so it must not',
      'contain any book\'s words. Everywhere text about the book belongs, write a',
      'token {{COPY:key}} instead, and declare it in "slots":',
      '  { "key": "hero.headline", "purpose": "Problem-led hero headline",',
      '    "maxChars": 120 }',
      'Rules:',
      '  - keys are lowercase dot-separated, e.g. hero.eyebrow, s3.item2.title',
      '  - every token you place must be declared, and every declared slot placed',
      '  - each token appears EXACTLY ONCE',
      '  - "purpose" is the only brief the copywriter gets — say what belongs',
      '    there and in what voice, e.g. "One-sentence benefit, imperative mood"',
      '  - "maxChars" must be what the design can actually hold at that size',
      'These three keys are REQUIRED: hero.headline, hero.subheadline, cta.label.',
      'hero.headline and hero.subheadline are declared AND placed like any other.',
      'cta.label is different: DECLARE it, but do NOT put {{COPY:cta.label}} in the',
      `markup — the system writes that label into ${PLACEHOLDERS.cta} itself, and`,
      'placing it too would print the button text a second time as loose prose.',
      'Fixed UI words that are the same for every book — "FAQ", "Instant download",',
      '"Add to cart" — you may write directly. Anything specific to a book is a slot.',
      'Structural text you can see in the reference (section headings, eyebrows,',
      'card titles, FAQ questions and answers, body paragraphs) is ALL slots.',
      '',
      'PLACEHOLDERS. Position these exactly as written; the system substitutes real',
      'markup for them afterwards. Never write a price, a link or an image yourself.',
      `  ${PLACEHOLDERS.cta}      the buy button (its label already ENDS with the price) — place it`,
      '                        wherever the template has one, up to 6 times',
      `  ${PLACEHOLDERS.price}          a standalone price block with strike-through and savings chip.`,
      '                        NEVER put it right next to the button — the price would show twice.',
      '                        Use it once, in the order section, above the button.',
      `  ${PLACEHOLDERS.cover}          ONE book cover — always the same (featured) book, however`,
      '                        many times you place it. Use it where the template shows a',
      '                        single book.',
      ...(input.productCount > 1
        ? [
            `  ${PLACEHOLDERS.bookBreakdown} one block per book — each book's OWN cover, title and`,
            '                        contents. Put it where the reference describes the books',
            '                        individually ("what\'s inside"). Once only. You do not build',
            '                        these blocks: pairing a cover with its book is ours to get',
            '                        right, not yours. It expands to:',
            '                          <div class="books">          the list of every book',
            '                            <div class="book">         ONE book, repeated per book',
            '                              <img class="book-cover">   its own cover',
            '                              <div class="book-body">',
            '                                <p class="book-index">   "Book 1", "Book 2", …',
            '                                <h3> <p class="book-sub"> <ul><li>',
            '                        Style .books/.book/.book-cover/.book-body/.book-index to',
            '                        match the reference. Every .book is one render of one loop:',
            '                        style them as a set, never with :nth-child, :first-child or',
            '                        any rule that catches some blocks and not others — the page',
            '                        showed one book as a wide card and the next as a squeezed',
            '                        column that way.',
            `  ${PLACEHOLDERS.coverStack}    ALL ${input.productCount} covers together, side by side. Use this`,
            '                        wherever the reference shows the books as a set — the hero,',
            `                        a bundle panel. Repeating ${PLACEHOLDERS.cover} would show the`,
            '                        SAME book that many times, which is not a set. It expands to',
            '                        <div class="cover-stack"> of <img class="cover-stack-item">,',
            '                        the featured one also .cover-stack-lead.',
          ]
        : []),
      `  ${PLACEHOLDERS.contents}       the chapter breakdown as CARDS — a <div class="contents"> of`,
      '                        .contents-item, each with .contents-count, an <h3> and a <ul>.',
      '                        Use where the reference devotes a whole section to a grid of',
      '                        chapter or module cards',
      `  ${PLACEHOLDERS.contentsList}  the same chapters as a COMPACT LIST — one line each, no`,
      '                        cards, no key points. Use where the reference presents what the',
      '                        buyer gets as a short stack beside the price or under a heading',
      '                        like "what you get". PICK ONE of these two, never both: they',
      '                        render the same chapters in different shapes, and a page that',
      '                        shows a card grid the reference never had reads as a different',
      '                        page, not as a copy of it',
      `  ${PLACEHOLDERS.guarantee}      the guarantee panel (omit if not wanted)`,
      `  ${PLACEHOLDERS.paymentMarks}   payment marks — a full-width row on its OWN line,`,
      '                        directly beneath a buy button; never beside a price',
      `  ${PLACEHOLDERS.testimonials}   reader quotes — may render to nothing, so never`,
      '                        put a heading inside a section that has only this',
      ...(input.hasLogo
        ? [
            `  ${PLACEHOLDERS.logo}           the channel's avatar as a small round brand mark —`,
            '                        the header, and the footer if the reference marks it too.',
            '                        At most 3 times.',
          ]
        : [
            `  ${PLACEHOLDERS.logo}           NOT AVAILABLE for this page — this channel has no avatar.`,
            '                        Do not place it. Where the reference shows a logo, the brand',
            '                        text alone carries the header; do not leave a slot, box or',
            '                        circle sitting empty in its place.',
          ]),
      ...(input.hasAuthorPhoto
        ? [
            `  ${PLACEHOLDERS.authorPhoto}   a real photograph of the author — put it where the`,
            '                        reference puts its portrait (typically the hero, and again',
            '                        beside the author bio). At most twice.',
          ]
        : [
            `  ${PLACEHOLDERS.authorPhoto}   NOT AVAILABLE for this page — no photo was supplied.`,
            `                        Do not place it. Where the reference shows a portrait, use`,
            `                        ${PLACEHOLDERS.cover} or let the text hold the space.`,
          ]),
      `  ${PLACEHOLDERS.legal}   the footer disclaimer — exactly once, in the footer`,
      '',
      'The substituted markup arrives PRE-STYLED by a system stylesheet loaded before',
      'yours, under these selectors: .cta, .cta-note, .price-row/.price/.price-was/.save,',
      '.pay, .guarantee, .contents/.contents-item/.contents-count, .testimonials, .legal.',
      'They already look right; restyle them only to match the reference (your CSS wins).',
      '',
      ...(input.productCount > 1
        ? [
            `THIS PAGE SELLS ${input.productCount} PRODUCTS. Place ${PLACEHOLDERS.offerGrid} exactly once,`,
            'where the reference puts its "choose your level" / product-tier section.',
            'That one placeholder expands into EVERY product card — each book\'s own',
            'cover, title, price and buy link, plus the bundle. You do not build the',
            'cards, count them, name the books or write any of their links: with several',
            'different checkout URLs on one page, deciding which link belongs to which',
            'book is the system\'s job, not yours. Give the grid a section to live in and',
            'style .offers/.offer/.offer-flag/.offer-art/.offer-buy/.offer-save to match',
            'the reference\'s card treatment.',
            `Keep using ${PLACEHOLDERS.cta} and ${PLACEHOLDERS.price} for the HERO and`,
            'CLOSING calls to action — those buy the featured product.',
            '',
          ]
        : [
            'THERE IS EXACTLY ONE PRODUCT — this book. Do not invent editions, tiers,',
            'bundles or a "choose your level" grid. If the reference sells several products,',
            'adapt its layout to selling ONE: a single offer card, stated once, repeated as',
            'a closing call to action.',
            '',
          ]),
      'SECTIONS. Two are required, because a sales page has to open and has to ask',
      'for the sale:',
      '  <section data-section="hero">   <section data-section="order">',
      '',
      'EVERY OTHER SECTION COMES FROM THE REFERENCE. Build the sections it has, in',
      'its order, and give each its own descriptive data-section value. Do NOT add a',
      'section it does not have — no chapter grid, no FAQ, no testimonial block, no',
      'bonus stack unless the reference shows one. A page carrying sections the',
      'reference never had does not read as that site with different words; it reads',
      'as a different page, which is the one thing this whole job is trying not to',
      'produce. If the reference is short, the page is short.',
      '',
      'COLOUR. Use ONLY these CSS variables — they are derived from this book\'s own',
      'cover and their contrast is already proven. Any raw colour is rejected:',
      `  ${PALETTE_VARS.join(', ')}`,
      '  --deep / --on-deep are a dark band and its text; --tint is a subtle band.',
      '  For shadows and scrims only, rgba(0,0,0,x) and rgba(255,255,255,x) are allowed.',
      '  Your own non-colour variables are fine if prefixed --x-.',
      '',
      'HARD LIMITS. The page is deployed as one static file and must render offline:',
      '  no <script>, no <iframe>, <object>, <embed>, <form> or form controls',
      '  no on* attributes, no javascript: URLs',
      '  no external URLs anywhere, no @import, no remote url() — system font stacks only',
      '  close every tag; unbalanced markup is rejected',
      '',
      // Small, cheap rules that separate a designed page from a generated one,
      // and one accessibility floor. None of them costs a section or a slot.
      'FINISH. Applies with or without a reference:',
      '  - buttons and small labels in sentence case, not Title Case',
      '  - at most two weights in the page chrome (nav, labels, buttons); weight is',
      '    for the headings, not for everything at once',
      '  - the accent colour belongs to the buy button. Using it for headings,',
      '    borders and icons as well removes the one signal that says where to click',
      '  - every interactive element gets a VISIBLE :focus-visible state — an outline',
      '    or ring in the accent colour. A keyboard buyer who cannot see where they',
      '    are cannot check out',
      '',
      'NO PROSE. You write no sentences about any book — every one of them is a',
      'slot. You MAY wrap a slot in styling tags to match the template, e.g. an',
      'accent-coloured <span> around {{COPY:hero.headline.emphasis}} beside',
      '{{COPY:hero.headline}}; split a headline into two slots when the reference',
      'styles half of it differently.',
      '',
      // Section order used to be free here, which directly contradicted the
      // reference block's "mirror this sequence" and is why generated pages
      // opened on the problem section where the template opens on the offer.
      ...(input.reference
        ? [
            'SECTION ORDER IS NOT YOURS TO CHOOSE. Follow the reference\'s sequence',
            'exactly — its Nth section is your Nth section. Never reorder, and never',
            'promote a later section to the top because it seems stronger.',
            '',
            'BUILD EVERY SECTION THE REFERENCE HAS, in its order, with the same',
            'treatment — its eyebrow, heading, intro and the shape of its contents',
            '(card grid, numbered steps, two facing columns, a figure table). Give each',
            'the slots that section needs: a heading slot, an intro slot, and one pair',
            'of slots per card, step, row or list item the reference shows there.',
            'Match the reference\'s COUNT: if it shows six cards, build six cards.',
            '',
            'A figure table gets a slot per cell plus a slot for the source line beneath',
            'it in small muted type. Never omit the source line — an unsourced savings',
            'figure is the riskiest thing that can appear on a page that takes money.',
            '',
            'Leave out only sections that need customer reviews, a promotional deadline',
            'or bonus products; the system renders those, and only when they are real.',
            '',
          ]
        : ['You may choose the order of sections and which copy goes where.', '']),
      'TOP BAR. If the page has a sticky bar, the ONLY things allowed inside it are',
      input.hasLogo
        ? `${PLACEHOLDERS.logo}, the brand text and ${PLACEHOLDERS.cta}. Never put`
        : `the brand text and ${PLACEHOLDERS.cta} (there is no logo for this page). Never put`,
      `${PLACEHOLDERS.cover}, ${PLACEHOLDERS.authorPhoto}, a price block or a`,
      'section heading in there — those are page-sized elements, and in a fixed bar',
      'they cover the page behind them.',
      'Build it like a professional brand header, not a text row:',
      '  - a single slim row, vertically centered, padding-block 10-12px',
      '  - brand block on the left: the book title set in a SANS-SERIF stack even on',
      '    a serif page, uppercase, ~0.8rem, letter-spacing .12-.18em, one line with',
      '    a CSS ellipsis — never wrapping. Beneath it, optionally, the author as a',
      '    tiny byline (~0.62rem, letter-spacing .2em, uppercase, muted)',
      `  - ${PLACEHOLDERS.cta} on the right, nothing else beside it`,
      '  - optionally a separate 1-line announcement strip ABOVE it with a short',
      '    plain-text offer line such as "Instant download · 30-day money-back',
      '    guarantee" — never a price, the button already carries the price',
      '  - if the reference ends its bar with an edition or issue marker, mirror it',
      '    with the edition line given below, set in the same small letter-spaced caps',
      '',
      'DETAIL WORK. These are the touches that separate a copied template from a',
      'generic page. Apply each ONLY where the reference actually does it:',
      '  - a drop cap on the opening body paragraph: the first letter enlarged to',
      '    ~3 lines, float: left, in the accent or heading colour, with the rest of',
      '    the paragraph flowing around it',
      '  - a secondary action beside the primary button rendered as an OUTLINED box',
      '    — same height and padding as the CTA, transparent ground, 1px border,',
      '    never as bare inline text',
      '  - the headline set at the reference\'s optical weight and measure: on a',
      '    two-column hero it should run close to the full width of its column',
      '    rather than sitting small inside it',
      '',
      'SCROLL ANIMATION. The system animates the page as the reader scrolls: every',
      '<section> fades and rises when it enters the viewport, automatically. Add the',
      'class "stagger" to any grid or list whose CHILDREN should arrive one after',
      'another (feature cards, pain-point cards, comparison columns, FAQ items), and',
      '"reveal" to a standalone block that should animate on its own (the offer',
      'card). Do not write your own animation CSS or keyframes.',
      '',
      'SIZE. This is the failure that actually kills responses: exceeding the output',
      'limit cuts the JSON off mid-stream and the whole attempt is rejected. Budget:',
      'stylesheet under 12,000 characters, page under 60,000. When copying a template,',
      'compress: one shared rule per repeated component (cards, FAQ items, sections),',
      'never a copy per instance; collapse its utility-class styling into terse',
      'semantic classes; skip decorative wrappers that only exist for a framework.',
      '',
      'LAYOUT DISCIPLINE. Every grid or flex column must contain visible content at',
      'every breakpoint — an empty column with a floating divider is a broken page.',
      'Keep an image and its caption/text in normal document flow inside their card;',
      'never absolute-position content out of a column. Text columns need a sane',
      'minimum width (18ch+); if a split cannot hold both sides, stack them.',
      '',
      'NEVER NEST A SPLIT INSIDE A SPLIT. A two-column section whose text side is',
      'itself split into two columns leaves each one around 12 characters wide, and',
      'headings and bullets then wrap after two or three words. If a section shows',
      'an image beside a list, the list stays ONE column. Any column holding prose',
      'must be at least 22 characters wide at every breakpoint; if the split cannot',
      'give both sides that, stack them instead.',
      '',
      'BALANCE THE SPLIT. When a section pairs text with an image, the text takes',
      'the larger share (about 3:2) and the image sits centred in its own column at',
      'its natural size. Do not leave a third of the section empty beside it.',
      '',
      'ONE COLUMN PER SECTION. Every block inside a section — eyebrow, heading,',
      'body, card grid, table, button — shares ONE centred content column and ONE',
      'left edge. A heading indented further than the grid beneath it reads as a',
      'broken page, so set the measure once on a section wrapper and let everything',
      'inherit it rather than giving blocks their own widths or padding.',
      'A decorative section numeral ("I.", "01") hangs in the column\'s left margin',
      'and does NOT get a grid column of its own — a numeral with an empty column',
      'beside it is the single most common way this goes wrong.',
      '',
      'CONSISTENT SETS. Items that form one set are typeset identically: every',
      'figure in a stat row shares one face, size, weight and colour treatment, as',
      'do every card title, every FAQ question and every price. Vary them only where',
      'the reference visibly varies them. One stat in italic serif beside another in',
      'plain sans looks like a mistake, because it is.',
      '',
      'RESPONSIVE. Mobile first; the page must not scroll sideways at 360px. Any',
      'table or wide block gets its own overflow-x: auto container.',
      'Respect @media (prefers-reduced-motion: reduce).',
    ].join('\n');

    const reference = input.reference
      ? [
          '=== REFERENCE PAGE — MATCH THIS ===',
          `Source: ${input.reference.url}`,
          `Title: ${input.reference.title}`,
          '',
          'Observed treatment:',
          `  headings: ${input.reference.style.serifHeadings ? 'serif' : 'sans-serif'}`,
          `  body and small text: ${input.reference.style.serifBody ? 'serif' : 'sans-serif'}` +
            (input.reference.style.serifHeadings !== input.reference.style.serifBody
              ? ' — the two DIFFER, and that pairing is the design. Set them separately:'
                + ' eyebrows, labels, bullets, captions, buttons and fine print all take the'
                + ' BODY face, not the heading face.'
              : ''),
          // The closest renderable stack is COMPUTED, not described. The page
          // loads no fonts, so the reference's real webface is unavailable, and
          // "pick something similar" gave Georgia for every serif regardless of
          // how the original actually read.
          input.reference.style.headingFont
            ? `  display typeface: "${input.reference.style.headingFont}" — unavailable here (no webfonts).`
            : '  display typeface: not detected.',
          `  USE EXACTLY THIS for headings: font-family: ${systemStackFor(input.reference.style.headingFont, input.reference.style.serifHeadings)};`,
          `  USE EXACTLY THIS for body and small text: font-family: ${systemStackFor(input.reference.style.bodyFont, input.reference.style.serifBody)};`,
          '  Echo the original with weight, letter-spacing and case; substitute no other families.',
          `  section numbering: ${input.reference.style.numberedSections ? 'yes — number the sections the same way' : 'no'}`,
          `  content column: ${input.reference.style.measurePx ? `${input.reference.style.measurePx}px` : 'unspecified'}`,
          `  imagery: ${input.reference.style.imageDensity < 1 ? 'text-led, very few images' : input.reference.style.imageDensity < 4 ? 'balanced' : 'image-led'}`,
          `  distinct section grounds: ${input.reference.style.grounds.length}`,
          '',
          'Its section headings, in order — mirror this sequence and this density:',
          input.reference.headings.map((h) => `  ${'  '.repeat(Math.max(0, h.level - 1))}h${h.level}: ${h.text}`).join('\n'),
          '',
          ...(input.reference.markup
            ? [
                '',
                '=== THE TEMPLATE MARKUP (pruned) ===',
                'This is the reference page\'s actual DOM. Your task is to COPY THIS',
                'TEMPLATE, not to design in its spirit: reproduce its element structure,',
                'section order, spacing and component shapes as faithfully as the rules',
                'allow, translating its styling — including what its utility class names',
                'imply — into your own stylesheet on the palette variables.',
                'Change ONLY these things:',
                '  - the words: swap every piece of its text for the approved copy',
                '  - the colours: express everything through the palette variables',
                '  - images, prices, buy links, guarantees: use the placeholders',
                '  - branding: our book\'s title and author, never theirs',
                'Drop entirely: its scripts, cookie/consent chrome, tracking, and any',
                'section whose content we have no equivalent for (e.g. testimonials when',
                'none are supplied). If it sells several products and we have one, keep',
                'the offer section\'s design but as a single card.',
                '',
                input.reference.markup,
              ]
            : [
                'Its page text, for tone of structure (NOT for copying words — the copy for',
                'this book is given separately and is the only prose you may use):',
                input.reference.text.slice(0, 6000),
              ]),
          '',
          'Do not reproduce the reference\'s words, its prices, its claims, its',
          'testimonials or its statistics — only its design.',
          '',
          // With the actual markup in hand, descriptive craft guidance is
          // redundant and can fight the template - it applies only when the
          // model must work from the digest alone.
          ...(!input.reference.markup
            ? [
            'COMPONENT FIDELITY — copy the reference at the component level, not just the',
            'section level. Where its text suggests card grids, give cards the same feel:',
            'radius, borders, an icon at the top. You may draw SMALL inline SVG icons',
            '(viewBox="0 0 24 24", stroke="currentColor", fill="none", 2-4 simple shapes,',
            'sized ~28px, coloured via the accent variable) — receipts, carts, wrenches,',
            'planes, shields. Statistics quoted in the copy belong in a bordered callout',
            'with the key figure emphasised. FAQ entries are individual rounded cards, not',
            'bare rules, when the reference styles them that way. Eyebrow labels, big',
            'display headings, generous card padding — match the reference\'s scale.',
            '',
            'CRAFT BLUEPRINT — the finish professional direct-response pages share. This',
            'is a quality floor, NOT a design: express every item in the reference\'s own',
            'visual language, and wherever the reference clearly does something different',
            '(no icons, no cards, bare rules instead of pills, a plain text hero), THE',
            'REFERENCE WINS — drop the conflicting item rather than import a foreign style:',
            '  hero: an eyebrow in a small bordered pill; the headline\'s single most',
            '    striking phrase wrapped in <em> styled as accent colour (not italic);',
            '    beneath the subheadline, 3 divider-separated benefit lines with a small',
            '    accent ◆ marker and a bold lead-in, built from the card features',
            `  offer card: category eyebrow, ${PLACEHOLDERS.cover}, title, ${PLACEHOLDERS.price},`,
            '    check-marked feature lines, full-width CTA, then the guarantee line small',
            '  guarantee band: its own centred section — a short display heading in the',
            '    pattern "30 days. Zero risk." (use the real number from the guarantee',
            '    placeholder context) over two calm sentences',
            '  last call: display heading, CTA, then a letter-spaced uppercase trust row',
            '    "INSTANT DELIVERY · MONEY BACK · ANY DEVICE" separated by accent dots',
            '  footer: brand line, a one-line tagline in the book\'s voice, then',
            `    ${PLACEHOLDERS.legal}`,
            '  rhythm: ~90px section padding; alternate the ground variables so no two',
            '    adjacent sections share a background; content column 680-1080px',
              ]
            : []),
        ].join('\n')
      : [
          '=== NO REFERENCE PAGE ===',
          'Build a conventional long-form sales page: hero with the cover, the problem,',
          'what is inside, who it is for, the author, the order block, questions, and a',
          'closing call to action.',
          '',
          // With a reference, its own screenshots supply the design decisions.
          // With none, the model is designing from scratch — which is exactly
          // where an unguided call reaches for the same three looks every time.
          'DECIDE THE DESIGN BEFORE YOU WRITE MARKUP. Settle the palette, the display /',
          'body type pairing, and one structural idea for the page — then check that',
          'choice against the list below and change it if it matches.',
          '',
          'REJECT THE DEFAULT LOOKS. These are what an unguided page always becomes,',
          'and a seller can spot them at a glance because every AI page has them:',
          '  - cream background + high-contrast serif + terracotta accent',
          '  - near-black background + one neon accent',
          '  - broadsheet columns with hairline rules and zero border-radius',
          'Pick a treatment that suits THIS book\'s subject rather than landing pages in',
          'general, and ground it in the palette variables, which are derived from the',
          'book\'s own cover.',
          '',
          'ONE SIGNATURE ELEMENT. Choose a single structural device that carries the',
          'page — a recurring rule, a numbered progression, a repeated card shape, a',
          'motif in the section headers — and use it in the hero and at least twice',
          'more. Spend restraint everywhere else. A page of evenly-weighted sections',
          'reads as assembled; one device used three times reads as designed.',
        ].join('\n');

    // No book is named here on purpose. This layout is stored and reused by
    // every book that follows this template, so anything book-specific would be
    // baked into a page that is not about that book.
    const copy = [
      '=== WHAT THIS TEMPLATE IS FOR ===',
      input.productCount > 1
        ? `Non-fiction ebooks sold in sets of ${input.productCount}, via ${PLACEHOLDERS.offerGrid}.`
        : 'Single non-fiction ebooks, sold from one offer section.',
      'Do not name a book, an author, a subject or a price anywhere — those',
      'arrive through the slots and the placeholders.',
      input.edition ? 'A masthead edition line is available; give it a slot if the reference has one.' : '',
    ]
      .filter(Boolean)
      .join('\n');

    const repair =
      input.repairErrors && input.repairErrors.length > 0
        ? [
            '',
            '=== YOUR PREVIOUS ATTEMPT WAS REJECTED ===',
            'Fix every one of these and return the corrected page. Change nothing else:',
            ...input.repairErrors.map((e) => `  - ${e}`),
          ].join('\n')
        : '';

    const text = `${reference}\n\n${copy}${repair}`;

    // With screenshots the user message becomes blocks: the images first, then
    // the brief. The model sees what the page LOOKS like before it reads what
    // the page is made of — which is the order the client described when he
    // said to let the AI look at the reference and learn it.
    const shots = input.referenceShots ?? [];
    const user: string | AiContentBlock[] =
      shots.length === 0
        ? text
        : [
            {
              type: 'text' as const,
              text:
                `These ${shots.length} screenshots are the reference page, captured top to bottom. ` +
                'They are the ground truth for how it LOOKS — spacing, type scale, section rhythm, ' +
                'card treatment, how much air sits around things. Match them. The markup below tells ' +
                'you what the page is MADE OF; the images tell you what it should feel like.',
            },
            ...shots.map((shot) => ({
              type: 'image' as const,
              mediaType: shot.mediaType,
              dataBase64: shot.dataBase64,
            })),
            { type: 'text' as const, text },
          ];

    return { system, user };
  },
};

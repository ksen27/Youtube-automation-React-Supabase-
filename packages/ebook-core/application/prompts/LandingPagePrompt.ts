/**
 * The sales-page copywriting prompt.
 *
 * The model writes PROSE ONLY. It is never asked for HTML, CSS, colours or a
 * layout — those are fixed by the renderer — so there is no model-authored
 * markup to sanitise, and every book gets the same proven page structure.
 */
/**
 * Fills a stored layout's copy slots for one book.
 *
 * The layout is captured once per reference and reused, so this call does not
 * decide what sections exist or how many cards they hold — the template already
 * did. It writes the words for the slots that template declared, each within
 * the length its design can actually hold.
 */
export const LandingSlotCopyPrompt = {
  build(input: {
    bookTitle: string;
    subtitle: string;
    channelTitle: string;
    author: string | undefined;
    strategy: string;
    chapterTitles: string[];
    pageCount: number | null;
    tone: string;
    slots: Array<{ key: string; purpose: string; maxChars: number }>;
    /**
     * The other books on the page, with what each one covers.
     *
     * Their CONTENTS, not just their names: a "what's inside" section on a
     * three-book page has to say what each book contains, and a copywriter
     * given only the featured book's chapters writes about that book three
     * times over.
     */
    otherBooks?: Array<{ title: string; chapterTitles: string[] }>;
  }) {
    const others = input.otherBooks ?? [];
    return {
      system: [
        'You are a direct-response copywriter filling a sales page template for a non-fiction ebook.',
        '',
        'Return ONLY a JSON object mapping every slot key to its text:',
        '  { "hero.headline": "…", "hero.eyebrow": "…", … }',
        'Every key listed below must appear exactly once. No other keys. Plain text',
        'only — no markdown, no HTML, no emoji.',
        '',
        ...(others.length > 0
          ? [
              `THIS PAGE SELLS ${others.length + 1} BOOKS. Where a slot describes what the`,
              'reader gets, cover the SET — one book per group of slots, in order, using',
              "each book's own chapters. Never describe the first book three times over,",
              'and never split one book into chapter ranges as if the ranges were the',
              'separate products. Book 1 leads; the others follow in the order listed.',
              '',
            ]
          : []),
        'LENGTH IS A HARD CONSTRAINT. Each slot states maxChars. That is what the',
        'design physically holds; going over breaks the layout it was written for.',
        'Write to the length, do not pad to it.',
        '',
        'HARD RULES.',
        '1. NEVER invent testimonials, reviews, ratings, sales figures, subscriber',
        '   counts, awards or endorsements. Fabricated social proof is not a stylistic',
        '   choice, it is a false statement about real people. If a slot seems to ask',
        '   for one, write the nearest honest thing instead.',
        '2. NEVER promise a specific income, saving, health or legal outcome, and never',
        '   state a figure the source material does not support.',
        '3. NEVER mention price, discounts, countdowns, scarcity or bonuses — the',
        '   system renders all of those.',
        '4. Every claim must trace to the positioning or the chapter list below.',
        '5. Figures may appear only if the book supports them, and the slot whose',
        '   purpose mentions a source must say where they come from.',
        '',
        `Tone: ${input.tone}. Write for an intelligent reader; concrete beats clever.`,
      ].join('\n'),
      user: [
        `=== BOOK ===\nTitle: ${input.bookTitle}`,
        input.subtitle ? `Subtitle: ${input.subtitle}` : '',
        input.author ? `Author byline: ${input.author}` : '',
        `Creator/channel: ${input.channelTitle}`,
        input.pageCount ? `Length: ${input.pageCount} pages` : '',
        '',
        '=== POSITIONING ===',
        input.strategy,
        '',
        others.length > 0
          ? `=== BOOK 1 CHAPTERS: ${input.bookTitle} ===`
          : '=== CHAPTERS (the only content you may promise) ===',
        input.chapterTitles.map((t, i) => `${i + 1}. ${t}`).join('\n'),
        // Each other book with its OWN contents. A slot asking what is inside
        // the set can only be answered per book if the chapters are here.
        ...others.flatMap((b, i) => [
          '',
          `=== BOOK ${i + 2} CHAPTERS: ${b.title} ===`,
          b.chapterTitles.length > 0
            ? b.chapterTitles.map((t, j) => `${j + 1}. ${t}`).join('\n')
            : '(chapter list unavailable)',
        ]),
        '',
        '=== SLOTS TO FILL ===',
        ...input.slots.map((s) => `${s.key}  (max ${s.maxChars} chars) — ${s.purpose}`),
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
};

export const LandingPagePrompt = {
  build(input: {
    bookTitle: string;
    subtitle: string;
    channelTitle: string;
    author: string | undefined;
    strategy: string;
    chapterTitles: string[];
    pageCount: number | null;
    tone: string;
    hasRealTestimonials: boolean;
    /**
     * The reference page's sections, in its order. Given so the copy call can
     * write one section per template section instead of only the fixed set
     * below — without this the layout call is handed prose for sections the
     * template does not have, and nothing at all for the ones it does.
     */
    referenceSections?: Array<{ heading: string; excerpt: string }>;
    referenceTitle?: string;
  }) {
    const sections = input.referenceSections ?? [];
    return {
      system:
        'You are a direct-response copywriter who writes sales pages for non-fiction ebooks. ' +
        'You write the COPY only — never HTML, CSS, colours or layout. Return ONLY a JSON object ' +
        'with exactly these keys:\n' +
        '  eyebrow (string, ≤6 words, names the reader e.g. "For weekend mechanics")\n' +
        '  headline (string, ≤120 chars, problem-led and specific — the reader\'s pain, not the book\'s features)\n' +
        '  subheadline (string, ≤220 chars, what the book does about it, naming the author\'s credibility)\n' +
        '  ctaLabel (string, ≤28 chars, action-first, e.g. "Get the manual" — do NOT include a price)\n' +
        '  painPoints (string[], 3-4 items, one sentence each, concrete costs of not solving this)\n' +
        '  whatsInsideHeading (string, ≤60 chars)\n' +
        '  bullets (array of 4-6 {title (≤55 chars), body (1-2 sentences)}) — benefits drawn from the ' +
        'actual chapters, phrased as what the reader will be able to DO\n' +
        '  whoIsItForHeading (string, ≤60 chars)\n' +
        '  whoIsItFor (string[], 3-5 items, each a reader situation, ≤90 chars)\n' +
        '  authorHeading (string, ≤60 chars)\n' +
        '  authorBio (string, 2-4 sentences, third person, based ONLY on the channel and strategy given)\n' +
        '  faqs (array of 4-6 {question, answer}) — cover format/delivery, refunds, who it suits, ' +
        'and the strongest objection to buying\n' +
        '  categoryLabel (string, 1-2 words, what KIND of book this is, e.g. "Buying guide")\n' +
        '  productFeatures (string[], 4-5 items, ≤55 chars each) — terse card lines, NOT sentences, ' +
        'e.g. "101 tested picks, by category"\n' +
        '  comparisonWithout (string[], 3-4 items, ≤85 chars) — what the reader keeps doing without ' +
        'this book, written as their current reality, not as a threat\n' +
        '  comparisonWith (string[], 3-4 items, ≤85 chars) — the same situations after reading it; ' +
        'item N must answer item N of comparisonWithout\n' +
        '  closingHeading (string, ≤70 chars)\n' +
        '  closingBody (string, 1-2 sentences)\n' +
        '  fontFamily ("serif" | "sans") — "serif" for narrative, lifestyle, spiritual, cooking or ' +
        'traditional subjects; "sans" for technical, financial, automotive or how-to subjects\n' +
        (sections.length > 0
          ? '  templateSections (array) — ONE ENTRY PER REFERENCE SECTION LISTED BELOW, IN THAT ORDER. ' +
            'This is the most important field: the page must follow the reference\'s full structure, and ' +
            'these are the sections our fixed fields above do not cover. Each entry:\n' +
            '    heading (string, ≤80 chars) — that section\'s heading, rewritten for THIS book\n' +
            '    eyebrow (string, ≤30 chars, "" if the reference has none)\n' +
            '    intro (string, 1-3 sentences, "" if the section needs none)\n' +
            '    kind ("prose"|"cards"|"list"|"steps"|"comparison"|"table") — how the reference ' +
            'presents it, so the layout can match\n' +
            '    items (array of {title (≤60 chars), body (1-2 sentences)}, [] for prose/table)\n' +
            '    table (null, OR {leftHeading, rightHeading, rows:[{label,left,right}], leftTotal, ' +
            'rightTotal, source}) — use ONLY when the reference runs a two-column figure table. ' +
            'Every figure must come from the book\'s own material, and "source" must say where ' +
            '(e.g. "Costs quoted in Chapter 3 of the book"). If the book gives you no real figures, ' +
            'set table to null and use kind "comparison" with items instead.\n'
          : '') +
        '\n' +
        'HARD RULES.\n' +
        '1. NEVER invent testimonials, reviews, ratings, sales figures, subscriber counts, awards or ' +
        'endorsements. You have not been given any' +
        (input.hasRealTestimonials ? ', except the real quotes shown, which are rendered separately.' : '.') +
        ' Fabricated social proof is not a stylistic choice, it is a false statement about real people.\n' +
        '2. NEVER promise a specific income, saving, health or legal outcome, and never state a figure ' +
        '("save $4,000 a year") that the source material does not support. Write about what the reader ' +
        'will learn and be able to do, not what they are guaranteed to earn or avoid.\n' +
        '3. NEVER mention price, discounts, countdown timers, scarcity ("only 12 left") or bonuses — ' +
        'the system renders all of those. (Format and delivery may be described in the FAQ, which is ' +
        'the one place a buyer expects to find them.)\n' +
        '4. Stay inside the book\'s actual subject. Every claim must trace to the strategy or the ' +
        'chapter list below.\n' +
        '5. Plain text only in every field — no markdown, no HTML, no emoji.\n\n' +
        `Tone: ${input.tone}. Write for an intelligent reader; concrete beats clever.`,
      user: [
        `=== BOOK ===\nTitle: ${input.bookTitle}`,
        input.subtitle ? `Subtitle: ${input.subtitle}` : '',
        input.author ? `Author byline: ${input.author}` : '',
        `Creator/channel: ${input.channelTitle}`,
        input.pageCount ? `Length: ${input.pageCount} pages` : '',
        '',
        '=== POSITIONING (the commercial strategy this book was written to) ===',
        input.strategy,
        '',
        '=== CHAPTERS (the only content you may promise) ===',
        input.chapterTitles.map((t, i) => `${i + 1}. ${t}`).join('\n'),
        ...(sections.length > 0
          ? [
              '',
              `=== THE REFERENCE PAGE'S SECTIONS${input.referenceTitle ? ` (${input.referenceTitle})` : ''} ===`,
              'Our page must have the SAME sections, in this order. Write one templateSections entry',
              'for each, covering the same GROUND for our book that the reference covers for its own.',
              '',
              'The excerpts show you what each section is FOR — its job on the page. They are somebody',
              'else\'s writing about somebody else\'s product: never reuse their sentences, their figures,',
              'their claims or their examples. Take the purpose, write it from our book.',
              '',
              'If a section is one we genuinely cannot fill from this book, still write the entry and',
              'cover the nearest equivalent our book does support — an empty section is a hole in the',
              'page. The only exception is a section that would need real customer reviews, a real',
              'promotional deadline or bonus products that do not exist; skip those, the system supplies',
              'them when the seller has them.',
              '',
              ...sections.map(
                (s, i) => `${i + 1}. ${s.heading}\n   what it does there: ${s.excerpt}`,
              ),
            ]
          : []),
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
};

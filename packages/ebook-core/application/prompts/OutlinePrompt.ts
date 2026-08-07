export const OutlinePrompt = {
  build(input: {
    bookStrategy: string;
    knowledgeBase: string;
    chapterCount: number;
    perChapterWords: number;
    tone: string;
    /** User-supplied book title. When present it GOVERNS what the chapters cover. */
    bookTitle?: string | undefined;
  }) {
    // Without this, the outline is derived from the knowledge base's dominant topic and
    // the chapters end up about the channel's usual subject instead of the title's.
    const titleRule = input.bookTitle
      ? 'EVERY CHAPTER IS BOUND BY TWO CONSTRAINTS AT ONCE.\n\n' +
        'CONSTRAINT 1 — SUBJECT DOMAIN: the domain of the channel behind this book, as described by the book ' +
        'strategy and knowledge base (e.g. cars and vehicle ownership, cooking, personal finance). Every ' +
        'chapter, example and recommendation must sit inside that domain. A car channel yields chapters about ' +
        'cars — never about home improvement or any other field.\n\n' +
        `CONSTRAINT 2 — ANGLE, set by the title: "${input.bookTitle}"\n` +
        'Return this EXACT string as "title". Every chapter must deliver a distinct part of what THIS TITLE ' +
        'promises. Read the title literally: if it promises a buying guide to products, every chapter is about ' +
        'choosing and buying products; if it promises repairs to do yourself, every chapter is about doing ' +
        'those repairs. If the title names a number of items (e.g. "101 products"), the chapters must be ' +
        'categories that together cover that many items.\n\n' +
        'RESOLVING THE TWO: read the title INSIDE the channel\'s domain. A title term with both a generic ' +
        'everyday meaning and a domain-specific meaning always takes the domain-specific one — "repairs you ' +
        'can do yourself" on a car channel means repairs to a CAR, not to a house.\n' +
        'Check each chapter title against BOTH constraints before keeping it: it must be recognisably part of ' +
        'the channel\'s domain AND obviously deliver on the book title. Drop any chapter failing either.\n' +
        'Take the creator\'s voice, the audience\'s pain points, goals and vocabulary from the knowledge base ' +
        'too. What you must NOT take from it is the ANGLE — do not drift back to the channel\'s usual format ' +
        'when the title asks for a different one.\n\n'
      : '';

    return {
      system:
        'You are a book editor. Produce a coherent ebook outline. ' +
        'Return ONLY JSON: { "title": string, "entries": [{ "title": string, "purpose": string, ' +
        '"promise": string, "keyPoints": string[], "wordTarget": number }] }.\n\n' +
        titleRule +
        'CHAPTER TITLE RULES: each entry "title" must be a SHORT, benefit-driven chapter title (about 3–7 words). ' +
        'Do NOT prefix it with "Chapter N". Do NOT add a subtitle, tagline, colon clause, or em-dash continuation — ' +
        'give the title only, with the curiosity/benefit baked into those few words. ' +
        'Keep each entry compact to avoid bloated output: "purpose" and "promise" one sentence each (≤25 words); ' +
        '"keyPoints" must be 3–5 short bullet phrases (≤12 words each). ' +
        `Produce exactly ${input.chapterCount} chapters that build on one another, each with ` +
        `wordTarget≈${input.perChapterWords}. Tone: ${input.tone}.`,
      user:
        (input.bookTitle ? `=== BOOK TITLE (governs every chapter) ===\n${input.bookTitle}\n\n` : '') +
        `=== BOOK STRATEGY ===\n${input.bookStrategy}\n\n` +
        '=== CHANNEL KNOWLEDGE BASE ===\n' +
        (input.bookTitle
          ? '(Defines the SUBJECT DOMAIN every chapter must stay inside, plus voice and audience. The title ' +
            'decides the angle within that domain.)\n'
          : '') +
        input.knowledgeBase,
    };
  },
};

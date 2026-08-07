export const BookStrategyPrompt = {
  build(input: {
    knowledgeBase: string;
    targetPages: number;
    tone: string;
    channelTitle: string;
    /** User-supplied book title. When present it GOVERNS the subject of the book. */
    bookTitle?: string | undefined;
  }) {
    // Keep in step with GenerateOutlineUseCase's deterministic count (≈14 at 100 pages).
    const chapterCount = Math.max(2, Math.min(14, Math.round(input.targetPages / 7)));

    // Two independent constraints, and BOTH must hold:
    //   - the CHANNEL fixes the subject domain (a car channel writes car books);
    //   - the TITLE fixes the angle taken within that domain.
    // Book titles are routinely domain-ambiguous ("The DIY Repair Bible" reads as home
    // improvement on its own), so the domain must come from the channel. Telling the
    // model to ignore the channel's topic entirely makes it guess the domain and drift.
    const titleRule = input.bookTitle
      ? 'TWO FIXED CONSTRAINTS GOVERN THIS BOOK. BOTH MUST HOLD AT ONCE.\n\n' +
        `CONSTRAINT 1 — SUBJECT DOMAIN, set by the channel "${input.channelTitle}".\n` +
        'Infer the channel\'s subject domain from the knowledge base (e.g. cars and vehicle ownership, ' +
        'cooking, personal finance) and state it to yourself before writing anything. EVERY chapter, example ' +
        'and recommendation must sit inside that domain. This book is written by this creator for this ' +
        'audience: a car channel produces a book about cars, never about home improvement, gardening or any ' +
        'other field.\n\n' +
        `CONSTRAINT 2 — ANGLE, set by the title: "${input.bookTitle}"\n` +
        'Return this EXACT string as "title" — do not reword, shorten, extend or "improve" it. The title ' +
        'decides WHICH book you write within the domain. Read it literally; every noun constrains the angle. ' +
        'A buying guide to products is a buying guide — not a repair manual, not a maintenance guide. Repairs ' +
        'you can do yourself are those repairs — not a guide to buying products.\n\n' +
        'RESOLVING THE TWO: the title is almost always domain-ambiguous on its own. Interpret it INSIDE the ' +
        'channel\'s domain — never as a book for a different field. "The DIY Repair Bible" on a car channel ' +
        'means repairs to YOUR CAR, not to your house. If a title term has a generic everyday reading and a ' +
        'domain-specific reading, always take the domain-specific one.\n' +
        'corePromise, transformation, targetAudience, uniqueSellingProposition and keyPrinciples must all ' +
        'describe delivering the title\'s promise within the channel\'s domain.\n\n' +
        'ALSO TAKE FROM THE KNOWLEDGE BASE: the creator\'s voice and vocabulary, their expertise level, and ' +
        'the audience\'s pain points, goals and objections. What you must NOT take from it is the ANGLE — do ' +
        'not fall back to the channel\'s most common format when the title asks for a different one.\n' +
        'Write a "subtitle" that expands on the title\'s specific promise.'
      : 'Derive the title, subtitle and positioning from the channel knowledge base.';

    return {
      system:
        'You are a bestselling non-fiction book strategist. Design the commercial strategy for a sellable ' +
        'Kindle-quality ebook. Return ONLY JSON with keys: ' +
        'title, subtitle, targetAudience, corePromise, transformation, authorVoice, tone, ' +
        'chapterCount (number), targetWordCount (number), uniqueSellingProposition, keyPrinciples (string[]), ' +
        'author.\n\n' +
        titleRule +
        '\n\nThe "author" is the cover byline and MUST be based on the real channel — use the channel/creator ' +
        `name "${input.channelTitle}". If that name reads like a person, use it as-is; if it reads like a brand, ` +
        'use a natural byline such as "<Name> from ' + `${input.channelTitle}` + '" or "The ' + `${input.channelTitle}` +
        ' Team". Do not invent an unrelated name and do not use a famous real person. ' +
        'The "authorVoice" must capture how the creator actually speaks, drawn from the knowledge base. ' +
        `Aim for chapterCount=${chapterCount} and targetWordCount=${input.targetPages * 450}. Tone: ${input.tone}.`,
      user:
        (input.bookTitle ? `=== BOOK TITLE (governs the subject of the book) ===\n${input.bookTitle}\n\n` : '') +
        `Channel: ${input.channelTitle}\n\n` +
        '=== CHANNEL KNOWLEDGE BASE ===\n' +
        (input.bookTitle
          ? '(Defines the SUBJECT DOMAIN the book must stay inside, plus the voice, expertise level and ' +
            'audience. The title decides the angle WITHIN this domain — not the domain itself.)\n'
          : '') +
        input.knowledgeBase,
    };
  },
};

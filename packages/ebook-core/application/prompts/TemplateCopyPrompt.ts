/**
 * Writes one book's copy into a cloned template's slots.
 *
 * Two things make this prompt different from the slot-copy call it replaces.
 *
 * First, the brief for each slot is the template's OWN original text, not a
 * one-line "purpose" a model invented. "Write a benefit card title, max 34
 * chars" tells a copywriter almost nothing; "the original said 'Stop paying
 * £400 for a 20-minute job' in 34 characters" tells them the register, the
 * angle and the length at once.
 *
 * Second, the character budgets are measured from that original text rather
 * than guessed. The template's CSS was tuned to those lengths, so they are the
 * only honest ceiling — and copy that overflows its box is the one way a
 * faithful clone still comes out looking wrong.
 */
export const TemplateCopyPrompt = {
  build(input: {
    bookTitle: string;
    subtitle: string;
    channelTitle: string;
    author: string | undefined;
    strategy: string;
    chapterTitles: string[];
    pageCount: number | null;
    tone: string;
    /**
     * What the audience actually complains about, from the comment-analysis
     * phase. The pipeline has produced this for a long time and the landing
     * copy has never seen it — it only ever got the book strategy.
     */
    audiencePains?: string[] | undefined;
    audienceObjections?: string[] | undefined;
    /** Single-value slots: what was there, and how much room there is. */
    slots: Array<{ key: string; maxChars: number; originalText: string }>;
    /** Repeating regions and how many items each must have. */
    repeaters: Array<{
      key: string;
      count: number;
      fields: Array<{ name: string; maxChars: number; originalText: string }>;
    }>;
    /** The other books on a multi-book page, with what each covers. */
    otherBooks?: Array<{ title: string; chapterTitles: string[] }> | undefined;
  }) {
    const others = input.otherBooks ?? [];

    return {
      system: [
        'You are a direct-response copywriter filling an existing sales page for a',
        'non-fiction ebook.',
        '',
        'Return ONLY a JSON object:',
        '  { "slots": { "HERO_TITLE": "…" },',
        '    "repeats": { "BENEFITS": [ { "title": "…", "body": "…" } ] } }',
        '',
        'Plain text only — no markdown, no HTML, no emoji. Every slot key listed',
        'below must appear exactly once, and every repeater must have exactly the',
        'number of items stated.',
        '',
        'THE PAGE ALREADY EXISTS. You are not designing it, choosing its sections or',
        'deciding how many cards it holds — all of that is fixed. You are replacing',
        'the words in slots whose size is already known.',
        '',
        'LENGTH IS A HARD CONSTRAINT, not a target. Each slot states maxChars, which',
        'is what that box physically holds. Going over breaks a layout that has been',
        'reproduced exactly; padding to reach it wastes a reader\'s attention. The',
        "original text's length is given for each slot — write to roughly that.",
        '',
        'MATCH THE ORIGINAL\'S JOB, NOT ITS WORDS. Each slot shows what the template',
        'said for a different product. Use it to understand what belongs there — the',
        'angle, the register, the specificity — then write the equivalent for THIS',
        'book. Never reuse its claims, its numbers or its subject matter.',
        '',
        'CLAIM NOTHING YOU WERE NOT GIVEN. No invented statistics, no testimonials,',
        'no "join 4,000 readers", no results a buyer might measure you against. If',
        "the original slot made a numeric claim and you have no equivalent fact,",
        'write the same kind of sentence without the number.',
        '',
        ...(others.length > 0
          ? [
              `THIS PAGE SELLS ${others.length + 1} BOOKS. Where a slot describes what the`,
              "reader gets, cover the SET — one book per item, in order, using each",
              "book's own chapters. Do not describe the first book repeatedly, and do",
              'not split one book into chapter ranges as though the ranges were the',
              'separate products.',
              '',
            ]
          : []),
      ].join('\n'),

      user: [
        '=== THE BOOK ===',
        `Title: ${input.bookTitle}`,
        ...(input.subtitle ? [`Subtitle: ${input.subtitle}`] : []),
        ...(input.author ? [`Author: ${input.author}`] : []),
        `Channel: ${input.channelTitle}`,
        ...(input.pageCount ? [`Length: ${input.pageCount} pages`] : []),
        `Tone: ${input.tone}`,
        '',
        input.strategy,
        '',
        '=== CHAPTERS ===',
        ...input.chapterTitles.map((t, i) => `${i + 1}. ${t}`),
        '',
        ...(others.length > 0
          ? [
              '=== THE OTHER BOOKS ON THIS PAGE ===',
              ...others.flatMap((b) => [b.title, ...b.chapterTitles.slice(0, 8).map((c) => `  · ${c}`), '']),
            ]
          : []),
        ...(input.audiencePains && input.audiencePains.length > 0
          ? [
              '=== WHAT THIS AUDIENCE ACTUALLY SAYS ===',
              'From their own comments. Write to these, in their words where you can.',
              ...input.audiencePains.map((p) => `  · ${p}`),
              '',
            ]
          : []),
        ...(input.audienceObjections && input.audienceObjections.length > 0
          ? ['=== WHAT STOPS THEM BUYING ===', ...input.audienceObjections.map((o) => `  · ${o}`), '']
          : []),
        '=== SLOTS ===',
        ...input.slots.map(
          (s) => `${s.key}  (max ${s.maxChars} chars)\n    the template said: "${truncate(s.originalText, 180)}"`,
        ),
        '',
        ...(input.repeaters.length > 0
          ? [
              '=== REPEATING REGIONS ===',
              ...input.repeaters.flatMap((r) => [
                `${r.key} — exactly ${r.count} ${r.count === 1 ? 'item' : 'items'}`,
                ...r.fields.map(
                  (f) => `    ${f.name} (max ${f.maxChars}) — template said: "${truncate(f.originalText, 140)}"`,
                ),
                '',
              ]),
            ]
          : []),
      ].join('\n'),
    };
  },
};

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

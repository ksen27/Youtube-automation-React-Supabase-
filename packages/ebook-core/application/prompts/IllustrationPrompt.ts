interface IllustrationInput {
  /** The chapter this illustration sits in. */
  chapterTitle: string;
  /** The passage the illustration sits beside — the art must depict THIS. */
  passage: string;
  /** Whole-book subject, for visual coherence across illustrations. */
  bookSubject: string;
  tone: string;
}

/**
 * Builds a TEXTLESS, full-color editorial illustration prompt for one in-chapter
 * image. The art is driven by the surrounding passage so it matches the content
 * it accompanies, while a shared style keeps every illustration cohesive across
 * the book. No words are requested — illustrations carry no captions baked into
 * the pixels, so nothing can render as garbled text.
 */
/**
 * 69labs' img-flux (Flux Schnell) rejects long prompts with a generic
 * "This job failed to complete" error. Measured cutoff is sharp: ≤1300 chars
 * succeed 100% of the time, ≥1400 fail 100% of the time. The real limit is
 * token-based and tokens-per-char varies by content, so we cap the WHOLE prompt
 * at 1200 for margin. The fixed style/constraint text is preserved; only the
 * variable passage is trimmed to fit the remaining budget.
 */
const MAX_PROMPT_CHARS = 1200;

export const IllustrationPrompt = {
  build(input: IllustrationInput): string {
    const subject = input.bookSubject.replace(/\s+/g, ' ').trim().slice(0, 300);

    // Assemble everything except the passage first, so we know how many chars are
    // left for it within the budget. The passage sits between `head` and `tail`.
    const head =
      'Create a single full-color editorial illustration for a non-fiction book, ' +
      `for the chapter "${input.chapterTitle}". ` +
      'Illustrate the specific idea described in THIS passage so the image matches the surrounding text:\n"""';
    const tail =
      '"""\n' +
      (subject ? `Overall book subject (for visual coherence): "${subject}".\n` : '') +
      'STYLE: modern full-color editorial illustration — clean, confident shapes, a warm and ' +
      'cohesive palette, soft depth and tasteful texture, the polished look of a premium magazine ' +
      'or trade non-fiction book. Conceptual and metaphorical rather than a literal diagram. ' +
      `Match a ${input.tone} mood. ` +
      'HARD CONSTRAINTS: absolutely NO text, NO letters, NO words, NO numbers, NO labels, NO logos, ' +
      'NO captions anywhere in the image. One cohesive illustration, not a collage, not a grid.';

    // Whatever budget remains after the fixed parts goes to the passage (min 120
    // chars so the art still has something concrete to depict).
    const budget = Math.max(120, MAX_PROMPT_CHARS - head.length - tail.length);
    const passage = input.passage.replace(/\s+/g, ' ').trim().slice(0, budget);

    return head + passage + tail;
  },
};

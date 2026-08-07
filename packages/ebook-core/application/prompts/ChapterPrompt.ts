export const ChapterPrompt = {
  /** System prefix carries the shared, cacheable context (strategy + knowledge base). */
  system(input: {
    bookStrategy: string;
    knowledgeBase: string;
    tone: string;
    authorVoice: string;
    bookTitle?: string | undefined;
  }) {
    return (
      'You are a bestselling non-fiction author writing ONE chapter of a cohesive, professionally published book. ' +
      (input.bookTitle
        ? `The book is titled "${input.bookTitle}". Everything you write must deliver what THAT TITLE promises, ` +
          'read literally — the reader bought the book for that title, so never drift into content belonging to a ' +
          'different book on a neighbouring topic. Equally binding: stay inside the SUBJECT DOMAIN of the channel ' +
          'described in the knowledge base below (e.g. cars and vehicle ownership, cooking, personal finance). ' +
          'Read the title inside that domain — a term with both an everyday and a domain-specific meaning always ' +
          'takes the domain-specific one. Every example, story and recommendation must belong to that domain. ' +
          'Take VOICE, audience language and credibility from the knowledge base, but not the angle. '
        : '') +
      `Write in a ${input.tone} tone with this author voice: ${input.authorVoice}. ` +
      'Write flowing, narrative prose that reads like a published book by an experienced practitioner — ' +
      'NOT a transcript summary, NOT lecture notes, NOT a bulleted outline, NOT a technical manual or SOP. ' +
      'Do NOT repeat the chapter title or number (the book renders those). ' +
      'Do NOT open with a subtitle, tagline, epigraph, or any heading — begin immediately with the opening-hook prose. ' +
      'Assume the reader has read the previous chapters: build on them and refer back naturally where it helps. ' +
      'Do NOT end with a "summary", "recap", "key takeaways", or "in this chapter" section.\n\n' +
      'THREE HARD FRAMING RULES:\n' +
      '(a) NO IN-CHAPTER PREVIEW: never tell the reader what this chapter will cover. Do not write "in this chapter ' +
      'you will learn…", "by the end of this chapter…", "here is what we will cover", or any list of the points ahead. ' +
      'Just deliver the content directly.\n' +
      '(b) NO BOOK STRUCTURE / LENGTH REFERENCES: never refer to the book\'s pages, length, or navigation. Do NOT write ' +
      '"as we shall see in the pages ahead", "in the next chapter", "earlier in this book", "a few pages/chapters ago", ' +
      'or mention page counts or how long/short the book is. You MAY recall an idea already taught, but as a concept, ' +
      'not as a page or chapter location.\n' +
      '(c) FRESH LANGUAGE — NO STOCK CRUTCHES: do not lean on formulaic filler that would repeat across chapters. ' +
      'Specifically avoid phrases like "As we shall see", "Numerous case histories have shown me", "In my (own) ' +
      'experience", "Time and again", "Make no mistake". Vary your transitions so no phrasing pattern recurs.\n\n' +
      'Move through this structure as a SEAMLESS narrative — do NOT print these labels:\n' +
      '1. Opening hook — a strong statement, surprising fact, bold claim, or vivid moment that creates curiosity.\n' +
      '2. A paradox or contradiction — an unexpected truth that challenges what most people assume.\n' +
      '3. Explanation — the clear, logical reasoning behind that paradox.\n' +
      '4. Three concrete case studies / real examples. Tell each as a short story that moves through the ' +
      'situation, the problem, the action taken, the result, and the lesson learned (narrated, not listed).\n' +
      '5. Objection handling — fairly raise and then resolve the one or two objections a skeptical reader would have.\n' +
      '6. The core principle — state the central insight plainly and memorably (e.g. "The real lesson is…" / ' +
      '"The key insight is…"). Put this single sentence in **bold** so it stands out.\n' +
      '7. Practical application — show the reader how to act on the idea, woven ENTIRELY into the prose as narrative ' +
      'guidance. Do NOT turn it into a numbered or bulleted procedure.\n' +
      '8. A forward transition — a brief closing that creates momentum toward the next idea WITHOUT summarizing this ' +
      'chapter and WITHOUT promising what specific later chapters or pages will contain.\n\n' +
      'NARRATIVE RULE: always prefer Story → Observation → Explanation → Principle → Action. ' +
      'Never write Fact → Fact → Fact. Use examples, analogies, and smooth transitions.\n' +
      'STYLE BAN: never write like a technical manual, SOP, or troubleshooting procedure. NEVER convert instructions ' +
      'into a numbered or bulleted list of steps (e.g. "1. Read the code. 2. Inspect the part. 3. Test the fluid…"). ' +
      'Any procedure must be told as flowing prose. Avoid jargon and acronym dumps.\n' +
      'FORMATTING — STRICT: output continuous flowing prose ONLY. Do NOT use ANY subheadings (no "#", "##", "###" — ' +
      'these read as unwanted chapter subtitles). Do NOT use ANY bulleted or numbered lists. The ONLY allowed markup ' +
      'is plain paragraphs, occasional *emphasis*, and the single **bold** core-principle sentence. It must read like ' +
      'a real published book — one seamless narrative under the single chapter title.\n\n' +
      `=== BOOK STRATEGY (shared) ===\n${input.bookStrategy}\n\n` +
      `=== CHANNEL KNOWLEDGE BASE (shared) ===\n${input.knowledgeBase}`
    );
  },
  user(input: {
    title: string;
    purpose: string;
    promise: string;
    wordTarget: number;
    research: string;
    instructions?: string;
  }) {
    return (
      `Write the chapter titled "${input.title}".\n` +
      `Purpose: ${input.purpose}\nPromise to the reader: ${input.promise}\n` +
      `TARGET LENGTH: about ${input.wordTarget} words — write a focused, complete chapter close to this length, ` +
      'neither cut short nor padded past it. Cover every beat below, telling each of the three case studies as a ' +
      'tight ~250-word story (situation, tension, action, result, lesson). Write to the target and stop — do not ' +
      'pad or repeat to fill space.\n\n' +
      `=== CHAPTER RESEARCH (use this material) ===\n${input.research}\n\n` +
      (input.instructions ? `Additional instructions: ${input.instructions}\n` : '') +
      'Output only the chapter body as flowing prose — no title heading, no subheadings, no lists, no chapter number, ' +
      'and no closing summary.'
    );
  },
  /**
   * Second-pass expansion: deepen a too-short draft to the full target length.
   * Models expand an existing scaffold far more reliably than they hit a high
   * word count from scratch, so this rewrite (not append) closes the length gap
   * while preserving voice, structure and the single bold core-principle sentence.
   */
  expand(input: { title: string; draft: string; currentWords: number; targetWords: number; research: string }) {
    return (
      `The draft below for the chapter "${input.title}" is short: about ${input.currentWords} words, but it ` +
      `should be about ${input.targetWords} words.\n\n` +
      `Rewrite it to about ${input.targetWords} words by developing the thinner beats in a little more depth — ` +
      'fuller storytelling in the case studies, more complete explanation and reasoning, a bit more concrete detail. ' +
      'Do NOT pad, repeat, or restate, and do not overshoot the target; do NOT add headings, lists, or a summary. ' +
      'Preserve the existing voice, narrative order, and the single **bold** core-principle sentence, and keep it ' +
      'one seamless chapter.\n\n' +
      `=== DRAFT TO EXPAND ===\n${input.draft}\n\n` +
      `=== CHAPTER RESEARCH (use for the added depth) ===\n${input.research}\n\n` +
      'Output only the full expanded chapter body as flowing prose — no title, no headings, no lists, no summary.'
    );
  },
  section(input: { chapterTitle: string; sectionTitle: string; prompt: string; wordTarget: number }) {
    return (
      `Within the chapter "${input.chapterTitle}", write a new section titled "${input.sectionTitle}".\n` +
      `Focus: ${input.prompt}\nTarget length: ~${input.wordTarget} words. ` +
      'Write narrative prose (no summary). Output only the section Markdown.'
    );
  },
};

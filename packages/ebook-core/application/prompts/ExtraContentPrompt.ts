import { ExtraContentKind } from '../../domain/book/BookSection';

interface ExtraContentInput {
  kind: ExtraContentKind;
  bookTitle: string;
  bookStrategy: string;
  knowledgeBase: string;
  tone: string;
  authorVoice: string;
  tableOfContents: string[];
  userPrompt?: string;
}

/** Per-type instructions and word budgets — each extra-content kind has its own shape. */
const SPEC: Record<ExtraContentKind, { instruction: string; words: number }> = {
  [ExtraContentKind.DEDICATION]: {
    instruction:
      'Write a short, heartfelt book Dedication — one to three sentences, centered in spirit (e.g. "For everyone ' +
      'who…"). Warm and sincere. Do NOT invent real named people. Output the dedication line(s) only, with no heading ' +
      'and no commentary.',
    words: 40,
  },
  [ExtraContentKind.INTRODUCTION]: {
    instruction:
      'Write the Introduction as flowing narrative prose that pulls the reader in and hands off naturally into the ' +
      'first chapter. Frame the subject, restate the core promise in the reader\'s language, and make the reader feel ' +
      'the transformation ahead. ' +
      'STRICT RULES: Do NOT preview or summarize the chapters. Do NOT write a "What\'s Coming", "What You\'ll Learn", ' +
      '"In this book" or chapter-by-chapter list ("Chapter One… Chapter Two…"). Do NOT write a "How to Get the Most ' +
      'From This Book" or "how to use this book" section. No bullet lists — narrative prose only.',
    words: 800,
  },
  [ExtraContentKind.FOREWORD]: {
    instruction:
      "Write the book's Preface in the author's own first-person voice as flowing narrative prose. This single " +
      'section serves as BOTH the foreword and the introduction, so it both establishes the author and frames the ' +
      'book. Move through, WITHOUT printing any labels: (1) a real personal story, experience, or moment that ' +
      'motivated the author to write this book, to create emotional connection and authenticity; (2) the author\'s ' +
      'authority and credibility — relevant experience, years in the field, why they are qualified to teach this; ' +
      '(3) the core problem — why most people struggle, the common mistakes and misconceptions; (4) the book\'s ' +
      'promise — what the reader will learn, the problems it solves, the outcomes they can expect; (5) the practical ' +
      'benefits and transformation the reader will gain; (6) a short, motivating transition that encourages the ' +
      'reader to continue into Chapter 1. Do NOT preview the chapters one by one. Warm, authentic, and credible. Do ' +
      'not invent a real named third-party endorser.',
    words: 1000,
  },
  [ExtraContentKind.CONCLUSION]: {
    instruction:
      'Write the Conclusion as flowing narrative prose. Synthesize the transformation the reader has gone through, ' +
      'weave the key principles together into a coherent whole (not a dry list), and end with a motivating call to ' +
      'action and a vivid picture of what is now possible. Do not write a chapter-by-chapter "summary". ' +
      'Do NOT reference the physical book\'s length, size, or page count (never write things like "a few hundred ' +
      'pages ago", "this short book", or "by now you\'ve read N chapters").',
    words: 900,
  },
  [ExtraContentKind.ACKNOWLEDGMENTS]: {
    instruction:
      'Write a brief, gracious Acknowledgments as warm narrative prose — thank, in a general way, the community, ' +
      'mentors, peers, and especially the readers who make the work meaningful. Do NOT invent real named people or ' +
      'organizations. Keep it genuine and concise.',
    words: 180,
  },
  [ExtraContentKind.FAQ]: {
    instruction:
      'Write an FAQ as a series of "**Q:** …\\n**A:** …" pairs answering the audience\'s most common questions. 8–12 questions.',
    words: 1200,
  },
  [ExtraContentKind.BONUS_CHAPTER]: {
    instruction:
      'Write a full Bonus Chapter as flowing narrative prose following the same framework as the main chapters: ' +
      'opening hook → a paradox or contradiction → explanation → three real case studies (situation, problem, ' +
      'action, result, lesson) → objection handling → the core principle (in bold) → practical action steps → a ' +
      'forward transition. Do NOT include a chapter summary or recap.',
    words: 3500,
  },
  [ExtraContentKind.RESOURCES]: {
    instruction:
      'Write a Resources section: a curated, categorized list of tools, references, and next steps with a one-line note on why each matters.',
    words: 700,
  },
  [ExtraContentKind.CHECKLIST]: {
    instruction:
      'Write a Checklist as actionable Markdown checkbox items ("- [ ] …") grouped under short headings the reader can follow step by step.',
    words: 600,
  },
  [ExtraContentKind.GLOSSARY]: {
    instruction:
      'Write a Glossary as "**Term** — definition" entries in alphabetical order, covering the key terms used across the book.',
    words: 800,
  },
};

export const ExtraContentPrompt = {
  build(input: ExtraContentInput) {
    const spec = SPEC[input.kind];
    return {
      system:
        `You are an expert non-fiction author writing the "${input.kind}" element of a cohesive, sellable ebook. ` +
        `The book is titled "${input.bookTitle}" — describe the book THAT TITLE promises, read literally. ` +
        'The book also sits squarely inside the subject domain of the channel described in the knowledge base ' +
        '(e.g. cars and vehicle ownership, cooking, personal finance); read the title inside that domain and ' +
        'keep every example within it. Take voice, audience and credibility from the knowledge base, but do ' +
        'not let the creator\'s usual format override the angle this title promises. ' +
        `Maintain a ${input.tone} tone and this author voice: ${input.authorVoice}. ` +
        `${spec.instruction} Target ~${spec.words} words. Output only well-structured Markdown (no surrounding commentary). ` +
        'Do NOT begin with or include any title/heading that names this section (no "# Foreword", "# Preface", ' +
        '"# Introduction", "# Conclusion", etc.) — the book prints the section heading itself, so start directly with ' +
        'the prose.\n\n' +
        `=== BOOK STRATEGY (shared) ===\n${input.bookStrategy}\n\n` +
        `=== CHANNEL KNOWLEDGE BASE (shared) ===\n${input.knowledgeBase}`,
      user:
        `Book: "${input.bookTitle}"\n` +
        `Table of contents:\n${input.tableOfContents.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n` +
        (input.userPrompt ? `Author's specific request: ${input.userPrompt}\n` : '') +
        `Write the ${input.kind}.`,
      maxTokens: Math.min(8000, Math.ceil(spec.words * 2)),
    };
  },
};

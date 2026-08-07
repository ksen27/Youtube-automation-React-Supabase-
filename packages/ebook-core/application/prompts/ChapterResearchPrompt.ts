export const ChapterResearchPrompt = {
  build(input: {
    chapterTitle: string;
    chapterPurpose: string;
    keyPoints: string[];
    candidateMaterial: string; // pre-filtered video summaries + comment insights (keyword match)
    bookTitle?: string | undefined;
  }) {
    return {
      system:
        'You assemble a research package for one book chapter from candidate source material. ' +
        'Select and rephrase only what is relevant to this chapter. ' +
        (input.bookTitle
          ? `The book is titled "${input.bookTitle}" and this chapter must serve that title. The candidate ` +
            'material comes from the creator\'s own channel, so it defines the subject domain the book lives in ' +
            '— it is the primary source for domain facts, examples and terminology, and you should draw on it ' +
            'freely wherever it supports this chapter. Interpret the chapter INSIDE that domain. Set aside only ' +
            'material that addresses a genuinely different subject from this chapter; never stretch unrelated ' +
            'material to fit, and never pad. If little fits, return few items. '
          : '') +
        'Return ONLY JSON with keys: ' +
        'supportingStories (string[]), supportingLessons (string[]), supportingExamples (string[]), ' +
        'supportingCaseStudies (string[]), supportingFrameworks (string[]), supportingPrinciples (string[]), ' +
        'audienceQuestions (string[]).',
      user:
        (input.bookTitle ? `Book: ${input.bookTitle}\n` : '') +
        `Chapter: ${input.chapterTitle}\nPurpose: ${input.chapterPurpose}\n` +
        `Key points: ${input.keyPoints.join('; ')}\n\n` +
        `Candidate source material:\n${input.candidateMaterial}`,
    };
  },
};

export const CommentAnalysisPrompt = {
  build(input: { videoTitle: string; comments: string[] }) {
    return {
      system:
        'You analyze YouTube comments to understand audience psychology. ' +
        'Return ONLY JSON with string-array keys: commonQuestions, frustrations, fears, ' +
        'myths, objections, desiredResults, recurringProblems. Keep each item short.',
      user: `Video: ${input.videoTitle}\n\nTop comments:\n${input.comments.map((c) => `- ${c}`).join('\n')}`,
    };
  },
};

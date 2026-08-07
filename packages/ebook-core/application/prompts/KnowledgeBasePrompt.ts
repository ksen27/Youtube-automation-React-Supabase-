export const KnowledgeBasePrompt = {
  build(input: { channelTitle: string; videoSummaries: string[]; commentInsights: string[] }) {
    return {
      system:
        'You synthesize a channel-wide knowledge base from per-video knowledge and audience insights. ' +
        'Return ONLY JSON with keys: coreThemes (string[]), corePrinciples (string[]), ' +
        'recurringAdvice (string[]), commonMistakes (string[]), audiencePainPoints (string[]), ' +
        'audienceGoals (string[]), transformationJourney (string), expertPositioning (string), ' +
        'hiddenInsights (string[]). Every string[] field MUST be a JSON array of separate ' +
        'strings — never a single string, even when there is only one item.',
      user:
        `Channel: ${input.channelTitle}\n\n` +
        `Video knowledge:\n${input.videoSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
        `Audience insights from comments:\n${input.commentInsights.join('\n')}`,
    };
  },
};

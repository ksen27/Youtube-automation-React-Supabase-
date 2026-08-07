export const ChannelSummaryPrompt = {
  build(input: { channelTitle: string; videoSummaries: string[] }) {
    return {
      system:
        'You synthesize many video summaries into a single channel-level analysis. ' +
        'Return ONLY JSON: summary (string), topics (string[]), audience (string), tone (string).',
      user:
        `Channel: ${input.channelTitle}\n\n` +
        `Per-video summaries:\n${input.videoSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n\n')}`,
    };
  },
};

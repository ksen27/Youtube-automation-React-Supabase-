export const VideoSummaryPrompt = {
  build(input: { title: string; transcript: string; comments: string[] }) {
    return {
      system:
        'You are an expert content analyst extracting structured knowledge from a YouTube video ' +
        '(Phase 5 — Video Knowledge Extraction). Return ONLY JSON with keys: ' +
        'summary (string, 150-250 words), keyLessons (string[]), mistakes (string[]), ' +
        'frameworks (string[]), actionableTips (string[]), successStories (string[]), ' +
        'caseStudies (string[]), audienceProblems (string[]), audienceGoals (string[]), ' +
        'recurringAdvice (string[]). Extract real substance from the transcript; do not invent. ' +
        'Use [] for any field with no material.',
      user:
        `Video title: ${input.title}\n\n` +
        `Transcript:\n${truncate(input.transcript, 24000)}\n\n` +
        (input.comments.length
          ? `Top viewer comments (for audience problems/goals signal):\n${input.comments.join('\n')}`
          : ''),
    };
  },
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

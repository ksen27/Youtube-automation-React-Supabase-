import type { VideoSummary } from '@ebook/core';

type VideoKnowledgeProps = Parameters<typeof VideoSummary.create>[0];

const EMPTY: Omit<VideoKnowledgeProps, 'summary' | 'model' | 'inputHash'> = {
  keyLessons: [],
  mistakes: [],
  frameworks: [],
  actionableTips: [],
  successStories: [],
  caseStudies: [],
  audienceProblems: [],
  audienceGoals: [],
  recurringAdvice: [],
};

/**
 * Rebuild VideoKnowledge from a `video_summaries` row. Prefers the rich `data`
 * JSONB blob (Phase 5); falls back to legacy columns (pre-0004) by mapping the
 * old `key_points` into `keyLessons` so older rows still load.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reviveVideoKnowledge(row: any): VideoKnowledgeProps {
  if (row.data && typeof row.data === 'object') {
    return { ...EMPTY, ...row.data, summary: row.summary ?? row.data.summary, model: row.model, inputHash: row.input_hash };
  }
  return {
    ...EMPTY,
    summary: row.summary ?? '',
    keyLessons: row.key_points ?? [],
    model: row.model ?? 'claude-sonnet-4-6',
    inputHash: row.input_hash ?? '',
  };
}

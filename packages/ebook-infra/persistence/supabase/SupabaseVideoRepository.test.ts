import { describe, it, expect } from 'vitest';
import { ProjectId } from '@ebook/core';
import { SupabaseVideoRepository } from './SupabaseVideoRepository';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

interface Row {
  id: string;
  title: string;
  video_summaries: unknown;
}

/** Records the column list the repository asks for — that's what's under test. */
function fakeDb(rows: Row[]) {
  let selected = '';
  const db = {
    from: () => ({
      select: (columns: string) => {
        selected = columns;
        return {
          eq: () => ({
            order: async () => ({ data: rows, error: null }),
          }),
        };
      },
    }),
  };
  return { db, selected: () => selected };
}

function summaryRow(summary: string) {
  return { summary, data: { summary, keyLessons: ['ship early'] }, model: 'claude-sonnet-4-6', input_hash: 'h' };
}

describe('SupabaseVideoRepository.findSummarizedByProject', () => {
  // The chapter-research timeout: ranking read a title and a summary, but the
  // query embedded transcripts(*) and comments(*) — the channel's entire corpus,
  // once per chapter, ~16 chapters in flight per book. Keep those out.
  it('does not fetch transcripts or comments', async () => {
    const { db, selected } = fakeDb([]);
    await new SupabaseVideoRepository(db as never).findSummarizedByProject(ProjectId.from(PROJECT_ID));
    expect(selected()).not.toMatch(/transcripts/);
    expect(selected()).not.toMatch(/comments/);
    expect(selected()).toMatch(/video_summaries/);
  });

  it('maps rows to id, title and revived summary', async () => {
    const { db } = fakeDb([{ id: 'v1', title: 'How to ship', video_summaries: summaryRow('a summary') }]);
    const out = await new SupabaseVideoRepository(db as never).findSummarizedByProject(ProjectId.from(PROJECT_ID));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('v1');
    expect(out[0]!.title).toBe('How to ship');
    expect(out[0]!.summary.searchableText()).toContain('ship early');
  });

  it('reads the summary when PostgREST returns the embed as an array', async () => {
    const { db } = fakeDb([{ id: 'v1', title: 'T', video_summaries: [summaryRow('a summary')] }]);
    const out = await new SupabaseVideoRepository(db as never).findSummarizedByProject(ProjectId.from(PROJECT_ID));
    expect(out[0]!.summary.summary).toBe('a summary');
  });

  // An unsummarized video can't be ranked — dropping it here keeps callers from
  // having to reason about a half-populated entry.
  it('skips videos that have no summary yet', async () => {
    const { db } = fakeDb([
      { id: 'v1', title: 'summarized', video_summaries: summaryRow('s') },
      { id: 'v2', title: 'not yet', video_summaries: null },
      { id: 'v3', title: 'empty embed', video_summaries: [] },
    ]);
    const out = await new SupabaseVideoRepository(db as never).findSummarizedByProject(ProjectId.from(PROJECT_ID));
    expect(out.map((v) => v.id)).toEqual(['v1']);
  });
});

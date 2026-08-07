import { describe, it, expect } from 'vitest';
import { Project } from './Project';
import { ProjectId } from './ProjectId';
import { GenerationOptions } from './GenerationOptions';
import { ChannelUrl } from '../channel/ChannelUrl';

const now = new Date('2026-01-01T00:00:00Z');
const url = ChannelUrl.create('https://www.youtube.com/@example');

function makeProject() {
  return Project.create({
    id: ProjectId.from('p1'),
    ownerId: 'u1',
    channelUrl: (url as { value: ChannelUrl }).value,
    options: GenerationOptions.create({}),
    now,
  });
}

describe('Project state machine', () => {
  it('starts in CREATED', () => {
    const p = makeProject();
    expect(p.isOk()).toBe(true);
    expect(p.value.status.value).toBe('CREATED');
  });

  it('allows CREATED → INGESTING_CHANNEL', () => {
    const p = makeProject().value;
    expect(p.advanceTo('INGESTING_CHANNEL', now).isOk()).toBe(true);
    expect(p.status.value).toBe('INGESTING_CHANNEL');
  });

  it('rejects illegal transitions', () => {
    const p = makeProject().value;
    const r = p.advanceTo('EXPORTING', now);
    expect(r.isFail()).toBe(true);
    expect(p.status.value).toBe('CREATED');
  });

  it('emits a ProjectStatusChanged event on transition', () => {
    const p = makeProject().value;
    p.advanceTo('INGESTING_CHANNEL', now);
    const events = p.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('project.status.changed');
  });

  it('markFailed is idempotent once terminal', () => {
    const p = makeProject().value;
    p.markFailed('boom', now);
    expect(p.status.value).toBe('FAILED');
    expect(p.markFailed('again', now).isOk()).toBe(true);
    expect(p.status.value).toBe('FAILED');
  });

  it('markFailed records the reason on the error getter', () => {
    const p = makeProject().value;
    p.markFailed('boom', now);
    expect(p.error).toBe('boom');
  });
});

describe('Project cancel', () => {
  it('cancels a running project (terminal FAILED with a cancel reason)', () => {
    const p = makeProject().value;
    p.advanceTo('INGESTING_CHANNEL', now);
    expect(p.cancel(now).isOk()).toBe(true);
    expect(p.status.value).toBe('FAILED');
    expect(p.error).toBe('Cancelled by user');
  });

  it('refuses to cancel a completed project', () => {
    const p = makeProject().value;
    // Walk to COMPLETED through the full pipeline.
    const path = [
      'INGESTING_CHANNEL',
      'FETCHING_VIDEO_DATA',
      'FETCHING_TRANSCRIPTS',
      'SUMMARIZING_VIDEOS',
      'ANALYZING_COMMENTS',
      'BUILDING_KNOWLEDGE_BASE',
      'GENERATING_BOOK_STRATEGY',
      'GENERATING_OUTLINE',
      'GENERATING_CHAPTER_RESEARCH',
      'GENERATING_CHAPTERS',
      'POLISHING_BOOK',
      'ASSEMBLING',
      'EXPORTING',
      'COMPLETED',
    ] as const;
    for (const s of path) p.advanceTo(s, now);
    expect(p.status.value).toBe('COMPLETED');
    expect(p.cancel(now).isFail()).toBe(true);
  });
});

describe('Project resumeAt (retry rewind)', () => {
  it('rewinds a FAILED project to a prior stage and clears the error', () => {
    const p = makeProject().value;
    p.advanceTo('INGESTING_CHANNEL', now);
    p.markFailed('Stage book-strategy failed', now);
    expect(p.status.value).toBe('FAILED');

    const r = p.resumeAt('GENERATING_BOOK_STRATEGY', now);
    expect(r.isOk()).toBe(true);
    expect(p.status.value).toBe('GENERATING_BOOK_STRATEGY');
    expect(p.error).toBeUndefined();
  });

  it('refuses to resume a non-terminal project', () => {
    const p = makeProject().value;
    p.advanceTo('INGESTING_CHANNEL', now);
    expect(p.resumeAt('GENERATING_OUTLINE', now).isFail()).toBe(true);
    expect(p.status.value).toBe('INGESTING_CHANNEL');
  });

  it('emits a status-changed event when rewinding', () => {
    const p = makeProject().value;
    p.markFailed('boom', now);
    p.pullEvents(); // drain the failure event
    p.resumeAt('SUMMARIZING_VIDEOS', now);
    const events = p.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('project.status.changed');
  });
});

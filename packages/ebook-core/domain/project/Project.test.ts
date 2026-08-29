import { describe, it, expect } from 'vitest';
import { Project } from './Project';
import { ProjectId } from './ProjectId';
import { GenerationOptions } from './GenerationOptions';

const now = new Date('2026-01-01T00:00:00Z');
const url = 'unused';

function makeProject() {
  return Project.create({
    id: ProjectId.from('p1'),
    ownerId: 'u1',
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
    expect(p.advanceTo('GENERATING_BOOK_STRATEGY', now).isOk()).toBe(true);
    expect(p.status.value).toBe('GENERATING_BOOK_STRATEGY');
  });

  it('rejects illegal transitions', () => {
    const p = makeProject().value;
    const r = p.advanceTo('EXPORTING', now);
    expect(r.isFail()).toBe(true);
    expect(p.status.value).toBe('CREATED');
  });

  it('emits a ProjectStatusChanged event on transition', () => {
    const p = makeProject().value;
    p.advanceTo('GENERATING_BOOK_STRATEGY', now);
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
    p.advanceTo('GENERATING_BOOK_STRATEGY', now);
    expect(p.cancel(now).isOk()).toBe(true);
    expect(p.status.value).toBe('FAILED');
    expect(p.error).toBe('Cancelled by user');
  });

  it('refuses to cancel a completed project', () => {
    const p = makeProject().value;
    // Walk to COMPLETED through the full pipeline.
    const path = [
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
    p.advanceTo('GENERATING_BOOK_STRATEGY', now);
    p.markFailed('Stage book-strategy failed', now);
    expect(p.status.value).toBe('FAILED');

    const r = p.resumeAt('GENERATING_BOOK_STRATEGY', now);
    expect(r.isOk()).toBe(true);
    expect(p.status.value).toBe('GENERATING_BOOK_STRATEGY');
    expect(p.error).toBeUndefined();
  });

  it('refuses to resume a non-terminal project', () => {
    const p = makeProject().value;
    p.advanceTo('GENERATING_BOOK_STRATEGY', now);
    expect(p.resumeAt('GENERATING_OUTLINE', now).isFail()).toBe(true);
    expect(p.status.value).toBe('GENERATING_BOOK_STRATEGY');
  });

  it('emits a status-changed event when rewinding', () => {
    const p = makeProject().value;
    p.markFailed('boom', now);
    p.pullEvents(); // drain the failure event
    p.resumeAt('GENERATING_OUTLINE', now);
    const events = p.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('project.status.changed');
  });
});

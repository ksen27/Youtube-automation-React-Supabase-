import { describe, it, expect } from 'vitest';
import { Chapter } from './Chapter';
import { ChapterId } from './ids';

function makeChapter() {
  return Chapter.create({
    id: ChapterId.from('c1'),
    bookId: 'b1',
    position: 0,
    title: 'Why engines die early',
    topic: 'engine longevity',
    promise: 'Make any car last 300k miles',
    keyPoints: ['oil', 'heat'],
    wordTarget: 3750,
  });
}

describe('Chapter.editContent (manual PATCH)', () => {
  it('replaces content, recomputes word count, and marks DONE', () => {
    const ch = makeChapter();
    ch.editContent('one two three four five');
    expect(ch.content).toBe('one two three four five');
    expect(ch.totalWords()).toBe(5);
    expect(ch.status).toBe('DONE');
  });

  it('bumps the version on each edit', () => {
    const ch = makeChapter();
    expect(ch.version).toBe(1);
    ch.editContent('hello world');
    expect(ch.version).toBe(2);
    ch.editContent('hello again');
    expect(ch.version).toBe(3);
  });

  it('tags the input hash as manual so a real regeneration is never skipped', () => {
    const ch = makeChapter();
    ch.editContent('edited prose');
    expect(ch.inputHash).toBe('manual:v2');
    // A subsequent generated hash differs → isGeneratedFor returns false → not skipped.
    expect(ch.isGeneratedFor('some-generated-hash')).toBe(false);
  });

  it('counts empty content as zero words', () => {
    const ch = makeChapter();
    ch.editContent('   ');
    expect(ch.totalWords()).toBe(0);
  });
});

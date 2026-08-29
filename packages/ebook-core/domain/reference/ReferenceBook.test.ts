import { describe, expect, it } from 'vitest';
import { ReferenceBook } from './ReferenceBook';
import { ReferenceBookId } from './ReferenceBookId';
import { ReferenceSection } from './ReferenceSection';

const NOW = new Date('2026-08-29T00:00:00Z');
const ID = ReferenceBookId.from('11111111-1111-4111-8111-111111111111');

/** `words` words of filler — enough to clear the usable-length floor when asked. */
function section(position: number, words: number, title = `Chapter ${position + 1}`): ReferenceSection {
  return ReferenceSection.create({ position, title, content: Array(words).fill('prose').join(' ') });
}

function uploaded() {
  const r = ReferenceBook.uploaded({
    id: ID,
    ownerId: 'owner-1',
    title: 'The Sourdough Book',
    storagePath: 'refs/owner-1/abc.pdf',
    contentType: 'application/pdf',
    byteSize: 1_000_000,
    now: NOW,
  });
  if (r.isFail()) throw new Error(r.error);
  return r.value;
}

describe('ReferenceBook', () => {
  it('starts an upload as pending and unusable — the bytes are not yet text', () => {
    const book = uploaded();
    expect(book.status).toBe('PENDING');
    expect(book.isUsable()).toBe(false);
  });

  it('becomes usable once enough text is extracted', () => {
    const book = uploaded();
    book.markExtracting(NOW);
    const attached = book.attachSections([section(0, 1500), section(1, 1500)], NOW);
    expect(attached.isFail()).toBe(false);
    expect(book.status).toBe('DONE');
    expect(book.wordCount).toBe(3000);
    expect(book.isUsable()).toBe(true);
  });

  // The failure this guards against is a scanned PDF: the parse "succeeds" and
  // returns a page of nothing, the reference looks selectable, and the problem
  // only shows up in a finished manuscript with no voice behind it.
  it('fails a reference whose extraction produced almost no text', () => {
    const book = uploaded();
    const attached = book.attachSections([section(0, 40)], NOW);
    expect(attached.isFail()).toBe(true);
    expect(book.status).toBe('FAILED');
    expect(book.isUsable()).toBe(false);
    expect(book.error).toMatch(/scanned images, protected, or not a book/);
  });

  it('imports a generated book as ready to use, with no file', () => {
    const r = ReferenceBook.fromGeneratedBook({
      id: ID,
      ownerId: 'owner-1',
      title: 'Car Care Basics',
      originProjectId: '22222222-2222-4222-8222-222222222222',
      sections: [section(0, 1200), section(1, 1200)],
      now: NOW,
    });
    if (r.isFail()) throw new Error(r.error);
    expect(r.value.status).toBe('DONE');
    expect(r.value.storagePath).toBeNull();
    expect(r.value.isUsable()).toBe(true);
  });

  it('refuses a generated import with no chapters', () => {
    const r = ReferenceBook.fromGeneratedBook({
      id: ID,
      ownerId: 'owner-1',
      title: 'Empty',
      originProjectId: '22222222-2222-4222-8222-222222222222',
      sections: [],
      now: NOW,
    });
    expect(r.isFail()).toBe(true);
  });

  it('keeps sections in reading order however they arrive', () => {
    const book = uploaded();
    book.attachSections([section(2, 1000), section(0, 1000), section(1, 1000)], NOW);
    expect(book.sections.map((s) => s.position)).toEqual([0, 1, 2]);
  });
});

describe('ReferenceSection', () => {
  it('counts words and keeps the title out of the body', () => {
    const s = ReferenceSection.create({ position: 0, title: '  Getting Started  ', content: '  one two three  ' });
    expect(s.title).toBe('Getting Started');
    expect(s.content).toBe('one two three');
    expect(s.wordCount).toBe(3);
    expect(s.toText()).toBe('Getting Started\none two three');
  });

  it('treats a blank title as no title', () => {
    const s = ReferenceSection.create({ position: 0, title: '   ', content: 'body' });
    expect(s.title).toBeNull();
    expect(s.toText()).toBe('body');
  });
});

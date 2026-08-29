import { describe, expect, it } from 'vitest';
import { normalizeExtractedText, splitIntoSections } from './sectionText';

const prose = (words: number, word = 'prose') => Array(words).fill(word).join(' ');

describe('normalizeExtractedText', () => {
  // PDF justification splits words across line ends. Left alone, "atten-\ntion"
  // is two words that match nothing during retrieval.
  it('rejoins words hyphenated across a line break', () => {
    expect(normalizeExtractedText('atten-\ntion span')).toBe('attention span');
  });

  it('drops page numbers standing alone on a line', () => {
    expect(normalizeExtractedText('end of page\n\n42\n\nnext page')).toBe('end of page\n\nnext page');
  });

  it('turns page breaks into paragraph breaks and collapses blank runs', () => {
    expect(normalizeExtractedText('one\f\n\n\n\ntwo')).toBe('one\n\ntwo');
  });
});

describe('splitIntoSections — books with chapters', () => {
  const book = [
    'Front matter that belongs to no chapter.',
    '',
    'Chapter 1',
    prose(300),
    '',
    'Chapter 2',
    prose(300),
    '',
    'Chapter 3',
    prose(300),
  ].join('\n');

  it('splits on chapter headings and keeps the titles', () => {
    const sections = splitIntoSections(book);
    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(sections[0]!.content).not.toContain('Front matter');
  });

  // A title page and a contents list teach nothing about how the author writes.
  it('drops everything before the first heading', () => {
    const sections = splitIntoSections(book);
    expect(sections.join(' ')).not.toContain('Front matter');
  });

  it('recognises title-case headings without a chapter number', () => {
    const text = [
      'Getting Started With Dough',
      prose(300),
      '',
      'Shaping And Proofing',
      prose(300),
      '',
      'Baking The Loaf',
      prose(300),
    ].join('\n');
    const sections = splitIntoSections(text);
    expect(sections).toHaveLength(3);
    expect(sections[0]!.title).toBe('Getting Started With Dough');
  });

  // A contents page is a run of headings with nothing under them. Emitting one
  // section per entry would fill retrieval with titles and no material.
  it('folds a heading with no body into the previous section', () => {
    const text = [
      'Chapter 1',
      prose(300),
      '',
      'Part Two',
      '',
      'Chapter 2',
      prose(300),
      '',
      'Chapter 3',
      prose(300),
    ].join('\n');
    const sections = splitIntoSections(text);
    expect(sections).toHaveLength(3);
    expect(sections[0]!.content).toContain('Part Two');
  });

  // Without the stands-alone rule, every short capitalised sentence mid-paragraph
  // becomes a chapter break.
  it('does not treat a short capitalised line inside a paragraph as a heading', () => {
    const text = ['Chapter 1', `${prose(100)}\nThe Dough Rises Now\n${prose(200)}`, '', 'Chapter 2', prose(300), '', 'Chapter 3', prose(300)].join('\n');
    const sections = splitIntoSections(text);
    expect(sections).toHaveLength(3);
    expect(sections[0]!.content).toContain('The Dough Rises Now');
  });
});

describe('splitIntoSections — books with no visible chapters', () => {
  it('falls back to word-count chunks on paragraph boundaries', () => {
    const text = Array(10).fill(prose(500)).join('\n\n');
    const sections = splitIntoSections(text);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.title === null)).toBe(true);
    // Never one enormous section: that makes every retrieval return the book.
    expect(sections.length).toBeGreaterThanOrEqual(3);
  });

  it('joins a short tail onto the previous chunk instead of leaving a stub', () => {
    const text = [prose(1300), prose(30)].join('\n\n');
    const sections = splitIntoSections(text);
    expect(sections).toHaveLength(1);
  });

  it('ignores too few headings and chunks instead', () => {
    const text = ['Chapter 1', Array(6).fill(prose(400)).join('\n\n')].join('\n');
    const sections = splitIntoSections(text);
    expect(sections.length).toBeGreaterThan(1);
  });

  it('returns nothing for empty input rather than a blank section', () => {
    expect(splitIntoSections('   \n\n  ')).toEqual([]);
  });
});

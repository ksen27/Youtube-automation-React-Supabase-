import { describe, expect, it } from 'vitest';
import { titleCarriesSubject } from './GenerateBookBriefUseCase';
import { sampleSections } from './ExtractReferenceStyleUseCase';

describe('titleCarriesSubject', () => {
  // The title is the only source of subject now, so this check is the last
  // place a subjectless book can be stopped before it costs a full generation.
  it('accepts a title that names what the book is about', () => {
    expect(titleCarriesSubject('The Complete Guide to Sourdough for Beginners')).toBe(true);
    expect(titleCarriesSubject('100 Keto Dinners')).toBe(true);
    expect(titleCarriesSubject('Car Care Basics')).toBe(true);
  });

  it('rejects a title made only of format words', () => {
    expect(titleCarriesSubject('Recipes')).toBe(false);
    expect(titleCarriesSubject('My Complete Guide')).toBe(false);
    expect(titleCarriesSubject('The Ultimate Cookbook')).toBe(false);
    expect(titleCarriesSubject('Book')).toBe(false);
  });

  // A leading count is scope, not subject: "50 Recipes" says how many, not of
  // what, and would otherwise sneak past as a non-format word.
  it('does not count a bare number as a subject', () => {
    expect(titleCarriesSubject('50 Recipes')).toBe(false);
    expect(titleCarriesSubject('50 Vegan Recipes')).toBe(true);
  });

  it('ignores punctuation and case', () => {
    expect(titleCarriesSubject('SOURDOUGH: A Guide')).toBe(true);
    expect(titleCarriesSubject('The... Guide!')).toBe(false);
  });
});

describe('sampleSections', () => {
  const book = Array.from({ length: 40 }, (_, i) => i);

  it('returns everything when the book is shorter than the sample', () => {
    expect(sampleSections([1, 2, 3], 6)).toEqual([1, 2, 3]);
  });

  // A first chapter is the least representative part of most non-fiction — it
  // is the part written to sell the book — so the sample must span the whole
  // thing rather than take the opening.
  it('spans the whole book, first section to last', () => {
    const picked = sampleSections(book, 6);
    expect(picked).toHaveLength(6);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(39);
  });

  it('spaces the picks evenly and keeps reading order', () => {
    const picked = sampleSections(book, 5);
    expect(picked).toEqual([0, 10, 20, 29, 39]);
  });
});

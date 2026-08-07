import { describe, expect, it } from 'vitest';
import { LandingPagePrompt, LandingSlotCopyPrompt } from './LandingPagePrompt';

const base = {
  bookTitle: 'The DIY Repair Bible',
  subtitle: '101 repairs you can do yourself',
  channelTitle: 'Car Care Garage',
  author: 'Adrian',
  strategy: 'Save money on car repair.',
  chapterTitles: ['Reading fault codes', 'Cleaning sensors'],
  pageCount: 107,
  tone: 'professional',
  hasRealTestimonials: false,
};

describe('LandingPagePrompt', () => {
  it('asks only for the fixed fields when there is no reference', () => {
    const { system, user } = LandingPagePrompt.build(base);
    expect(system).not.toContain('templateSections');
    expect(user).not.toContain("REFERENCE PAGE'S SECTIONS");
  });

  // Without this the copy call writes prose for sections the template does not
  // have, and nothing for the ones it does — which is why generated pages only
  // followed part of the template's structure.
  it('asks for one section per reference section when given a reference', () => {
    const { system, user } = LandingPagePrompt.build({
      ...base,
      referenceTitle: 'An Almanac',
      referenceSections: [
        { heading: 'Where the money goes', excerpt: 'A table of household bills before and after.' },
        { heading: 'Choose your level', excerpt: 'Three product tiers with prices.' },
      ],
    });

    expect(system).toContain('templateSections');
    expect(system).toContain('ONE ENTRY PER REFERENCE SECTION');
    expect(user).toContain('Where the money goes');
    expect(user).toContain('Choose your level');
    expect(user).toContain('A table of household bills');
  });

  // The excerpts are somebody else's writing about somebody else's product.
  it('tells the model to take the purpose of each section, never the words', () => {
    const { user } = LandingPagePrompt.build({
      ...base,
      referenceSections: [{ heading: 'The math', excerpt: 'Save $4,000 a year on heating.' }],
    });
    expect(user).toContain('never reuse their sentences, their figures');
    expect(user).toContain('Take the purpose, write it from our book');
  });

  // A section left empty is a hole in the page — the client's whole complaint.
  it('asks for the nearest equivalent rather than an empty section', () => {
    const { user } = LandingPagePrompt.build({
      ...base,
      referenceSections: [{ heading: 'The math', excerpt: 'Cost table.' }],
    });
    expect(user).toContain('cover the nearest equivalent');
    expect(user).toContain('an empty section is a hole in the');
  });

  // A three-book page needs prose about three books. Given only book one's
  // chapters, the copywriter described that book three times over — as chapter
  // ranges 1-5, 6-10 and 11-14 pretending to be separate products.
  it('gives the slot copywriter every book on the page, with its chapters', () => {
    const { system, user } = LandingSlotCopyPrompt.build({
      ...base,
      slots: [{ key: 'inside.heading', purpose: "What's inside", maxChars: 60 }],
      otherBooks: [
        { title: 'The Smart Driver Buying Bible', chapterTitles: ['Choosing tyres', 'Reading a spec sheet'] },
        { title: 'The Mechanic Bible', chapterTitles: ['Service intervals'] },
      ],
    });

    expect(system).toContain('THIS PAGE SELLS 3 BOOKS');
    expect(system).toContain('Never describe the first book three times over');
    expect(user).toContain('BOOK 2 CHAPTERS: The Smart Driver Buying Bible');
    expect(user).toContain('Choosing tyres');
    expect(user).toContain('BOOK 3 CHAPTERS: The Mechanic Bible');
  });

  it('says nothing about a set when only one book is sold', () => {
    const { system, user } = LandingSlotCopyPrompt.build({
      ...base,
      slots: [{ key: 'inside.heading', purpose: "What's inside", maxChars: 60 }],
    });
    expect(system).not.toContain('THIS PAGE SELLS');
    expect(user).toContain('CHAPTERS (the only content you may promise)');
  });

  it('still refuses invented social proof', () => {
    const { system } = LandingPagePrompt.build({
      ...base,
      referenceSections: [{ heading: 'What readers say', excerpt: '4.9 stars from 312 readers.' }],
    });
    expect(system).toContain('NEVER invent testimonials');
  });

  it('requires a stated source for any figure table', () => {
    const { system } = LandingPagePrompt.build({
      ...base,
      referenceSections: [{ heading: 'The math', excerpt: 'Cost table.' }],
    });
    expect(system).toContain('"source" must say where');
    expect(system).toContain('set table to null');
  });
});

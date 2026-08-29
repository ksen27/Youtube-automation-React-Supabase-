/**
 * Turns a TITLE into the knowledge base a book is written from.
 *
 * This is the stage that replaced channel ingest, and it differs from it in one
 * way worth being honest about: the channel supplied real material — a
 * creator's actual frameworks, their audience's actual complaints, mined from
 * transcripts. A title supplies none of that. What comes out of here is the
 * model's own knowledge of the subject, organised into the shape the rest of the
 * pipeline already consumes.
 *
 * That makes the instruction against vagueness the load-bearing part of this
 * prompt. Generic knowledge produces a generic book, and a generic book is the
 * exact failure mode of generating from a title alone.
 */
export const BookBriefPrompt = {
  system(input: { bookType: 'normal' | 'cooking'; styleProfile: string | null; tone: string }): string {
    const cooking = input.bookType === 'cooking';
    return (
      'You are a non-fiction editor preparing the foundation for a new book. You are given its TITLE and ' +
      'nothing else about its content. Produce the knowledge base an author would need before writing.\n\n' +
      'The title is the entire specification of subject. Read it closely: it usually names an audience, a ' +
      'scope and a promise as well as a topic. "The Complete Guide to Sourdough for Beginners" specifies a ' +
      'reader who has never baked, a scope that must start at zero, and a promise of completeness. Honour ' +
      'all of it, not just the noun.\n\n' +
      'SPECIFICITY IS THE WHOLE JOB. Every item you write must be something a knowledgeable practitioner ' +
      'would say and a stranger to the field could not. "Consistency is important" could appear in a book ' +
      'about anything and belongs in none. Name the actual mistake, the actual number, the actual moment ' +
      'where people go wrong. If an item would survive being moved into a book on a different subject, ' +
      'delete it and write a real one.\n\n' +
      (cooking
        ? 'This is a COOKBOOK. Themes are cuisines, techniques and meal contexts; mistakes are the ones ' +
          'that ruin a dish; reader goals are what they want on the table and how much time they have.\n\n'
        : 'This is a prose non-fiction book. Themes are the ideas it must cover; principles are the claims ' +
          'it argues; the transformation is what changes in the reader between the first page and the last.\n\n') +
      `The book's tone is ${input.tone}.\n\n` +
      (input.styleProfile
        ? 'It will be written in the voice of an existing book, described below. This does NOT constrain ' +
          'the subject — it tells you what kind of material that author would reach for, so favour items ' +
          'they could actually use:\n\n' +
          `${input.styleProfile}\n\n`
        : '') +
      'Return ONLY a JSON object with these keys: coreThemes, corePrinciples, recurringAdvice, ' +
      'commonMistakes, audiencePainPoints, audienceGoals, hiddenInsights (arrays of strings, 5-10 items ' +
      'each), transformationJourney and expertPositioning (strings, 2-4 sentences each). ' +
      'hiddenInsights are the non-obvious things practitioners know and beginners never hear.'
    );
  },

  user(input: { title: string; targetPages: number }): string {
    return (
      `TITLE: ${input.title}\n\n` +
      `The finished book will be about ${input.targetPages} pages, so the knowledge base needs enough ` +
      'distinct material to sustain that length without repeating itself.\n\n' +
      'Produce the knowledge base for this book.'
    );
  },
};

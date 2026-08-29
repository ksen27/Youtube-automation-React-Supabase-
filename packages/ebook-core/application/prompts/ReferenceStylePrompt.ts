/**
 * Reads a reference book and describes HOW it is written.
 *
 * The hard part is not the description, it is keeping the description free of
 * subject matter. Asked to characterise a sourdough book, a model will happily
 * report "explains hydration ratios clearly" — which is a fact about bread, not
 * about style, and it poisons every future book made from this reference. The
 * system prompt spends most of its length on that one boundary.
 */
export const ReferenceStylePrompt = {
  system(): string {
    return (
      'You are a literary analyst. You are given excerpts from a published book. Describe HOW it is ' +
      'written so another writer could produce a DIFFERENT book, on a DIFFERENT subject, that reads as ' +
      'though the same author wrote it.\n\n' +
      'THE ONE RULE THAT MATTERS: describe technique, never topic. Your description will be applied to a ' +
      'book about something else entirely. "Opens each chapter with a moment of failure before naming the ' +
      'principle" is technique — it transfers. "Explains fermentation clearly" is topic — it transfers to ' +
      'nothing. If a sentence you are about to write only makes sense for THIS subject, it belongs in no ' +
      'field of your answer.\n\n' +
      'Be specific and behavioural. "Conversational tone" is worthless — every book claims it. Say what ' +
      'the author actually DOES: sentence lengths, whether they use second person, whether they admit ' +
      'uncertainty, whether they argue with the reader, how long they wait before the first instruction, ' +
      'whether paragraphs end on a beat or trail off.\n\n' +
      '`avoid` is as binding as the rest: name what this author conspicuously never does — no bulleted ' +
      'lists, no headings mid-chapter, never addresses the reader directly, no anecdotes. A writer ' +
      'imitating a voice gets caught by the habits they fail to suppress, not the ones they copy.\n\n' +
      'Set `detectedKind` to "cooking" if this is a recipe book (recipes with ingredients and steps), ' +
      '"normal" for prose non-fiction, "other" for anything else. Judge from the structure you can see, ' +
      'not from the subject.\n\n' +
      'Return ONLY a JSON object with these keys: voice, readerAddress, chapterShape, openingMove, ' +
      'closingMove, pacing, vocabulary (strings), recurringDevices, avoid (arrays of strings), ' +
      'detectedKind (one of "normal", "cooking", "other").'
    );
  },

  user(input: { title: string; excerpts: string }): string {
    return (
      `Book: ${input.title}\n\n` +
      'Excerpts, in reading order (sampled across the whole book):\n\n' +
      `${input.excerpts}\n\n` +
      'Describe how this book is written, following the rules above.'
    );
  },
};

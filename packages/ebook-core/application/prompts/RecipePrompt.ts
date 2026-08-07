/**
 * Structured recipe generation for cooking books. Unlike ChapterPrompt (which
 * bans lists and demands prose), this asks for a complete recipe as JSON:
 * measured ingredients + numbered, labelled steps + tips. The output is parsed
 * with RecipeSchema and stored as the chapter content.
 */
export const RecipePrompt = {
  /** Cacheable system prefix — shared across every recipe in the book. */
  system(input: { bookStrategy: string; knowledgeBase: string; cuisine: string }) {
    return (
      'You are a professional recipe developer writing ONE complete, kitchen-tested recipe for a published ' +
      'cookbook. The recipe must be realistic and actually cookable, with sensible measured quantities and ' +
      'clear, correctly-ordered steps. ' +
      (input.cuisine ? `Match this channel's cuisine and style: ${input.cuisine}. ` : '') +
      'Return ONLY JSON in exactly this shape — no prose, no markdown, no code fences:\n' +
      '{\n' +
      '  "title": string,\n' +
      '  "description": string,           // one appetizing sentence introducing the dish\n' +
      '  "servings": number,              // integer, e.g. 4\n' +
      '  "prepTimeMinutes": number,       // integer minutes\n' +
      '  "cookTimeMinutes": number,       // integer minutes\n' +
      '  "ingredients": string[],         // each with quantity + unit, e.g. "2 tbsp olive oil"\n' +
      '  "instructions": [{ "label": string, "text": string }],  // 4-7 ordered steps; label is a short bold heading like "Cook the pasta"\n' +
      '  "tips": string[]                 // 1-3 short "Tips and Variations"\n' +
      '}\n' +
      'Ingredients must list real, measurable amounts. Each instruction "text" is 1-2 concise sentences. ' +
      'Do NOT include step numbers in the text (the layout numbers them). Keep it authentic to the channel.\n' +
      'LENGTH: this recipe is laid out on a single printed card, so keep it tight — aim for about 8-14 ' +
      'ingredients and 4-7 short steps. Write a "description" of one sentence (≤25 words). Be concise, not verbose.\n\n' +
      `=== BOOK STRATEGY (shared) ===\n${input.bookStrategy}\n\n` +
      `=== CHANNEL KNOWLEDGE BASE (shared) ===\n${input.knowledgeBase}`
    );
  },
  user(input: { title: string; description: string }) {
    return (
      `Write the full recipe for: "${input.title}".\n` +
      (input.description ? `Concept: ${input.description}\n` : '') +
      'Return ONLY the JSON object described above.'
    );
  },
};

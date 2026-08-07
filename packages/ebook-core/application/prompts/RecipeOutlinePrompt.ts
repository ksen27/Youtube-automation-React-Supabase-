/**
 * Recipe-suggestion prompt for cooking books. Replaces the chapter outline: from
 * the channel's knowledge base (built from its top videos), the model proposes N
 * distinct recipes that fit the channel's cuisine and style. These are AI-authored
 * recipe IDEAS inspired by the channel — not transcribed from the videos.
 */
export const RecipeOutlinePrompt = {
  build(input: { bookStrategy: string; knowledgeBase: string; recipeCount: number; existingTitles?: string[] }) {
    const avoid =
      input.existingTitles && input.existingTitles.length > 0
        ? `\nDo NOT repeat or lightly reword any of these already-chosen recipes:\n${input.existingTitles
            .map((t) => `- ${t}`)
            .join('\n')}\n`
        : '';
    return {
      system:
        'You are a professional cookbook author. From a cooking YouTube channel\'s knowledge base, ' +
        `propose exactly ${input.recipeCount} DISTINCT recipes that fit this channel's cuisine, skill level, ` +
        'signature ingredients, and overall style. Cover a natural range (appetizers, mains, sides, soups, ' +
        'desserts, drinks) UNLESS the channel is clearly specialized, in which case stay on-theme. ' +
        'Every recipe must be a real, cookable dish with an appetizing, specific title ' +
        '(e.g. "Zesty Lemon Garlic Shrimp Pasta", not "Pasta Dish"). No duplicates, no near-duplicates. ' +
        'Return ONLY JSON: { "recipes": [{ "title": string, "description": string, "cuisine": string }] }. ' +
        '"description" is one appetizing sentence (≤20 words). "cuisine" is a short label (e.g. "Italian", "Thai").' +
        avoid,
      user:
        `=== BOOK STRATEGY ===\n${input.bookStrategy}\n\n` +
        `=== CHANNEL KNOWLEDGE BASE ===\n${input.knowledgeBase}\n\n` +
        `Propose ${input.recipeCount} recipes now.`,
    };
  },
};

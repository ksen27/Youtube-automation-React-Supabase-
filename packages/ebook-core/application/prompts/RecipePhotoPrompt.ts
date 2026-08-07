/**
 * Builds a photorealistic food-photography prompt for one recipe's hero photo.
 * Textless (no baked-in words) so nothing renders as garbled text. Kept under the
 * 69labs prompt-length cap (see IllustrationPrompt) with margin.
 */
const MAX_PROMPT_CHARS = 1200;

export const RecipePhotoPrompt = {
  build(input: { title: string; description: string; cuisine?: string }): string {
    const head =
      'Professional food photography of a finished dish: ';
    const tail =
      '. Appetizing, restaurant-quality plating on a clean plate, natural soft daylight, ' +
      'shallow depth of field, fresh garnish, styled on a simple neutral surface, ' +
      (input.cuisine ? `authentic ${input.cuisine} presentation, ` : '') +
      'shot from a 3/4 or top-down angle. Photorealistic, high detail, magazine cookbook quality. ' +
      'HARD CONSTRAINTS: NO text, NO letters, NO words, NO numbers, NO labels, NO logos, NO watermarks, ' +
      'NO hands, NO people. One single plated dish, not a collage or grid.';
    const budget = Math.max(40, MAX_PROMPT_CHARS - head.length - tail.length);
    const subject = `"${input.title}" — ${input.description}`.replace(/\s+/g, ' ').trim().slice(0, budget);
    return head + subject + tail;
  },
};

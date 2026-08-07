import { z } from 'zod';

/**
 * A single cookbook recipe — structured data, not prose. For a cooking book each
 * "chapter" carries one recipe, serialized as JSON in the chapter's `content`
 * field (see {@link serializeRecipe}). The cookbook renderer parses it back with
 * {@link parseRecipe} to lay out the recipe-card template.
 */
export const RecipeSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  servings: z.number().int().positive().max(100).default(4),
  prepTimeMinutes: z.number().int().nonnegative().max(1440).default(15),
  cookTimeMinutes: z.number().int().nonnegative().max(1440).default(20),
  ingredients: z.array(z.string().min(1)).min(1),
  instructions: z
    .array(
      z.object({
        label: z.string().default(''),
        text: z.string().min(1),
      }),
    )
    .min(1),
  tips: z.array(z.string().min(1)).default([]),
});

export type Recipe = z.output<typeof RecipeSchema>;

/** A recipe idea produced by the recipe-suggestion (outline) step. */
export const RecipeIdeaSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  cuisine: z.string().default(''),
});
export type RecipeIdea = z.output<typeof RecipeIdeaSchema>;

/**
 * A recipe is stored as JSON in the chapter `content` behind this marker so the
 * assembler/renderer can distinguish a structured recipe from ordinary prose,
 * even for books whose type flag was somehow lost.
 */
const RECIPE_MARKER = '<!--recipe-->';

export function serializeRecipe(recipe: Recipe): string {
  return `${RECIPE_MARKER}\n${JSON.stringify(recipe)}`;
}

/** Parse a chapter's stored content back into a Recipe, or null if it isn't one. */
export function parseRecipe(content: string | null | undefined): Recipe | null {
  if (!content) return null;
  const trimmed = content.trim();
  const body = trimmed.startsWith(RECIPE_MARKER) ? trimmed.slice(RECIPE_MARKER.length).trim() : trimmed;
  if (!body.startsWith('{')) return null;
  try {
    const parsed = RecipeSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

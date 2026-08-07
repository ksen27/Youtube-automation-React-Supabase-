import { z } from 'zod';

/**
 * Landing-page settings. The checkout URL is intentionally just a URL: the
 * store (Payhip today, anything tomorrow) is never modelled, and the value is
 * written into the page's buttons verbatim.
 *
 * All of these are optional at submit time — the product cannot exist on the
 * store until the book has been generated and uploaded — but a page cannot be
 * published until a checkout URL is set.
 */
const LandingOptionFields = {
  landingPage: z.boolean().default(false),
  landingCheckoutUrl: z.string().url().max(2000).optional().or(z.literal('')),
  landingPriceCents: z.number().int().min(0).max(10_000_00).optional(),
  landingCompareAtCents: z.number().int().min(0).max(10_000_00).optional(),
  landingCurrency: z.string().trim().length(3).default('USD'),
  landingGuaranteeDays: z.number().int().min(0).max(365).default(30),
  /** Which template: one book, or the client's three-book set. */
  landingMode: z.enum(['single', 'triple']).default('single'),
  /** Up to two other finished books sold on the same page, each with its own
   * price and checkout link (the 3-ebook template). */
  landingSiblings: z
    .array(
      z.object({
        projectId: z.string().uuid(),
        priceCents: z.number().int().min(0).max(10_000_00).optional(),
        checkoutUrl: z.string().url().max(2000).optional().or(z.literal('')),
      }),
    )
    .max(2)
    .default([]),
  landingBundlePriceCents: z.number().int().min(0).max(10_000_00).optional(),
  landingBundleCheckoutUrl: z.string().url().max(2000).optional().or(z.literal('')),
  /** Storage path of an uploaded author photograph; set by the upload route. */
  landingAuthorPhotoPath: z.string().max(400).optional().or(z.literal('')),
  /** Reference sales page this book's layout should follow. */
  landingTemplateUrl: z.string().url().max(2000).optional().or(z.literal('')),
  /**
   * A cloned template (`landing_templates.id`) to build this page from.
   *
   * Set → the clone engine runs and the page IS that template with its content
   * swapped. Unset → the built-in renderer, as before. Ownership is checked at
   * generation time, because this id arrives from the client.
   */
  landingTemplateId: z.string().uuid().optional().or(z.literal('')),
};

export const SubmitChannelDto = z.object({
  channelUrl: z.string().url(),
  options: z
    .object({
      /** Required user-provided book title; always used as the book's title. */
      bookTitle: z.string().trim().min(1).max(200),
      bookType: z.enum(['normal', 'cooking']).default('normal'),
      targetPages: z.number().int().min(10).max(200).default(100),
      maxVideos: z.number().int().min(5).max(50).default(30),
      /** Recipe count for cooking books; ignored for normal books. */
      recipeCount: z.number().int().min(10).max(120).default(60),
      tone: z.enum(['educational', 'conversational', 'professional']).default('professional'),
      includeComments: z.boolean().default(true),
      includeIllustrations: z.boolean().default(true),
      illustrationEveryPages: z.number().int().min(2).max(50).default(5),
      ...LandingOptionFields,
    }),
});

export type SubmitChannelDto = z.infer<typeof SubmitChannelDto>;

/** The landing-page settings, shared by the submit DTO and the later PATCH. */
export const LandingSettingsDto = z.object(LandingOptionFields).partial();
export type LandingSettingsDto = z.infer<typeof LandingSettingsDto>;

/**
 * AI-generated still images for the CelebForge (sourced) engine.
 *
 * Client request 2026-08-10: "for celebforge, please add ai images for the still
 * images. you can do 50% footage and 50% ai images. For this one you can use
 * GROK IMAGE or GPT Image model. They can generate celebrity images."
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE SYNTHETIC IMAGE PATH
 * -----------------------------------------------------------
 * The AI Avatar (synthetic) engine also generates stills, but three of its rules
 * are the exact OPPOSITE of what CelebForge needs, so sharing that path would
 * quietly produce wrong images:
 *
 *  1. STYLE. Synthetic appends STYLE_PROMPT ("amateur smartphone photo … slightly
 *     low quality like a real phone video frame grab") and then degrades the
 *     result further. CelebForge stills are intercut with real broadcast/press
 *     footage, so they must read as professional photojournalism. We pass
 *     rawPrompt and own the whole prompt, including style.
 *  2. NAMES. lib/synthetic/planner.ts forbids real names in image prompts because
 *     nano-banana/FLUX refuse real likenesses. Here the name is the POINT — it is
 *     what makes the still show the actual celebrity — so we deliberately keep it.
 *  3. FALLBACK. Synthetic falls 69labs → Gemini → fal.ai. For a named celebrity
 *     that chain is worthless (Gemini/FLUX refuse public figures), so we pass
 *     noFallback and fall back to the existing SCRAPED photo path instead.
 *
 * MODEL CHOICE (measured, scripts/celeb-image-spike.ts, 2026-08-10)
 * ----------------------------------------------------------------
 * gpt-image-2 via 69labs renders named public figures with true likeness at
 * press quality — verified by eye on Musk, King Charles, Ronaldo, including
 * emotionally loaded framings. Roughly 30% of prompts are refused by OpenAI's
 * safety checks (see isModerationRefusal); those fall back to scraped photos.
 * The client also named Grok, but 69labs reported grok-imagine-image as
 * "major_issues / temporarily_unavailable" and it takes qualityOptions rather
 * than a resolutions[] array, so it would 400 on the resolution field. Swap via
 * CELEB_IMAGE_MODEL (and blank CELEB_IMAGE_RESOLUTION) if it recovers.
 */

import { getEnv } from "@/lib/env";
import { uploadBuffer } from "@/lib/storage";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { logJob } from "@/lib/jobs/db";

// House style for CelebForge stills. Verified in the spike to PRESERVE celebrity
// likeness while lifting output to press quality (likeness survived the suffix
// on 4/4 test prompts). Deliberately mirrors the look of the real footage these
// stills are cut against — not the synthetic engine's low-fi phone aesthetic.
const CELEB_STYLE =
  "Professional photojournalism, press agency photograph, natural available light, " +
  "sharp focus, realistic colour, candid documentary framing, high detail, " +
  "as published by a major news outlet. No text, no captions, no watermark, no logo.";

/** Everything the composer knows about one image block. All fields optional —
 *  the matcher fills what it has, and buildCelebImagePrompt degrades gracefully. */
export interface CelebPromptInput {
  /** block_entity.name — the person/thing this block depicts. The strongest signal. */
  entityName?: string | null;
  /** block_entity.type — person | celebrity_default | company | place | … */
  entityType?: string | null;
  /** BlockPlanSchema.resolved_subject — who the block is visually about. */
  resolvedSubject?: string | null;
  /** BlockPlanSchema.specific_visual_references — concrete visual nouns
   *  ('tattoo', 'mother', 'Frida poster'). Authored for image search, which
   *  makes them the best structured prompt ingredient we have. */
  visualReferences?: string[] | null;
  /** The project's main celebrity, used when a block carries no entity. */
  mainCelebrity?: string | null;
  /** The narrated sentence. Used ONLY to mine concrete nouns — NEVER sent
   *  verbatim (see the warning in buildCelebImagePrompt). */
  scriptText?: string | null;
}

// Words that describe narration rather than a picture. A prompt built only from
// these produces a literal, off-topic still, which is the failure the synthetic
// image processor warns about ("Be honest, I read these." → a person reading).
const ABSTRACT_TOKENS = new Set([
  "the", "a", "an", "and", "but", "or", "so", "then", "this", "that", "these",
  "those", "it", "he", "she", "they", "we", "you", "i", "his", "her", "their",
  "was", "were", "is", "are", "be", "been", "had", "has", "have", "did", "does",
  "do", "of", "in", "on", "at", "to", "for", "with", "from", "by", "as", "not",
  "what", "when", "where", "who", "why", "how", "would", "could", "should",
  "said", "says", "one", "two", "just", "now", "very", "really", "about",
]);

/**
 * Compose a picture prompt for one celebrity image block.
 *
 * CRITICAL: this never sends the narration verbatim. The spoken script describes
 * what is being SAID, not what should be SEEN, and drawing it literally is a
 * known failure mode (worker/processors/synthetic/imageGenProcessor.ts:63-72).
 * We build from structured planner fields instead — subject + concrete visual
 * references — and use the script only as a source of concrete nouns.
 *
 * Returns null when there is nothing depictable, so the caller keeps the
 * scraped photo rather than generating something generic.
 */
export function buildCelebImagePrompt(input: CelebPromptInput): string | null {
  const subject =
    (input.entityName?.trim() ||
      input.resolvedSubject?.trim() ||
      input.mainCelebrity?.trim() ||
      "");
  if (!subject) return null;

  // Concrete visual nouns the planner extracted for this block.
  const refs = (input.visualReferences ?? [])
    .map((r) => (r ?? "").trim())
    .filter((r) => r.length > 1 && r.length < 60)
    // Drop a reference that merely repeats the subject — it adds no picture info.
    .filter((r) => r.toLowerCase() !== subject.toLowerCase())
    .slice(0, 4);

  // If the planner gave us nothing concrete, mine the sentence for nouns rather
  // than sending it whole. Capitalised words (proper nouns) and long content
  // words are the parts most likely to be depictable.
  let mined: string[] = [];
  if (refs.length === 0 && input.scriptText) {
    mined = input.scriptText
      .replace(/[^\w\s'-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !ABSTRACT_TOKENS.has(w.toLowerCase()))
      .filter((w) => /^[A-Z]/.test(w) || w.length > 6)
      .filter((w) => w.toLowerCase() !== subject.toLowerCase())
      .slice(0, 3);
  }

  const detail = [...refs, ...mined].join(", ");
  const isPerson =
    !input.entityType ||
    input.entityType === "person" ||
    input.entityType === "celebrity_default";

  // Person blocks get an explicit framing hint. The spike showed likeness is
  // strongest in subject-centred framings and weakest in busy multi-person
  // scenes (the Diddy arrest render came out as a lookalike), so we steer
  // toward a single clear subject.
  const core = isPerson
    ? `${subject}${detail ? `, ${detail}` : ""}, clearly visible face, single subject filling the frame`
    : `${subject}${detail ? `, ${detail}` : ""}`;

  return `${core}. ${CELEB_STYLE}`;
}

/**
 * True when an error is a provider-side content refusal rather than an outage.
 *
 * These must NOT be retried: OpenAI's safety checks reject a given public figure
 * deterministically (measured: Taylor Swift refused even in a neutral concert
 * prompt, while a distressed King Charles passed), so a retry burns paid calls
 * to reach the same answer. sixtynine-labs re-labels the provider's FAILED +
 * "blocked by the model's safety checks" payload as CENSORED for exactly this.
 */
export function isModerationRefusal(err: unknown): boolean {
  const m = (err as Error)?.message ?? "";
  return /CENSORED|safety check|blocked by|restricted content|content polic/i.test(m);
}

export interface CelebImageResult {
  url: string;
  provider: string;
  prompt: string;
}

/**
 * Generate ONE celebrity still and upload it to R2. Returns null on any
 * failure — moderation refusal, provider outage, upload error — so the caller
 * can fall back to the existing scraped-photo path. Never throws.
 *
 * `index` only disambiguates the R2 key so two blocks never collide.
 */
export async function generateCelebImage(
  projectId: string,
  prompt: string,
  index: number,
): Promise<CelebImageResult | null> {
  const env = getEnv();
  try {
    // Bound the generation with our own deadline: generateImage's internal poll
    // budget is far longer than we can afford here (this runs INLINE in the
    // match job), and a degraded provider parks every call at ~240s.
    //
    // This used to be a Promise.race against a local timer, which was wrong in
    // two ways that together produced a self-sustaining stall (observed
    // 2026-08-12: every still failing at exactly the timeout, generation getting
    // slower as the project ran):
    //
    //  1. Promise.race does not CANCEL the loser. The abandoned generation kept
    //     polling and kept holding its cluster-wide 69labs account slot until the
    //     provider's own 300s poll timeout — so each timeout removed a slot from
    //     the shared pool for minutes, to produce an image nobody would read.
    //     Fewer free slots → longer waits → more timeouts → fewer free slots.
    //  2. The clock started at the CALL, but generateImage first blocks in the
    //     Redis acquire loop waiting for one of those slots. With the celeb lanes
    //     oversubscribed against SIXTYNINE_ACCOUNT_CONCURRENCY (shared with the
    //     avatar worker on the same key), the whole budget was routinely spent
    //     QUEUEING and the call died having never submitted anything to 69labs.
    //
    // generationTimeoutMs now starts once the slot is held and genuinely aborts
    // the poll, releasing the slot immediately; slot-wait is bounded separately.
    const out = await generateImage(prompt, undefined, {
      // Own the whole prompt: no synthetic STYLE_PROMPT, no low-fi degrade.
      rawPrompt: true,
      model: env.CELEB_IMAGE_MODEL,
      resolution: env.CELEB_IMAGE_RESOLUTION,
      // Gemini/FLUX refuse named public figures; scraped photos are our fallback.
      noFallback: true,
      generationTimeoutMs: env.CELEB_IMAGE_TIMEOUT_MS,
      acquireTimeoutMs: env.CELEB_IMAGE_SLOT_WAIT_MS,
      // Pin the dedicated CelebForge key when configured. The shared pool's keys
      // are not interchangeable here: only this one is provisioned for
      // CELEB_IMAGE_MODEL, so round-robin would send half these stills out on a
      // key that cannot serve it. Unset = pool round-robin, as before.
      apiKey: env.CELEB_IMAGE_API_KEY,
    });

    const key = `projects/${projectId}/generated/${Date.now()}_${index}.jpg`;
    const up = await uploadBuffer(out.image, key, out.contentType);
    return { url: up.publicUrl, provider: out.provider, prompt };
  } catch (err) {
    const refusal = isModerationRefusal(err);
    await logJob(
      { projectId },
      refusal ? "celeb_image.refused" : "celeb_image.error",
      {
        index,
        // The prompt is the actionable part of a refusal — it names who was
        // blocked, which is what tells you this person can never be generated.
        prompt: prompt.slice(0, 200),
        err: (err as Error)?.message?.slice(0, 300),
      },
    );
    return null;
  }
}

// Narration language registry — the single source of truth for everything that
// changes when a project's script is not English.
//
// WHY THIS EXISTS
// ---------------
// The pipeline was built around an English Google Doc. Feeding it a German
// script breaks in three places that are FAR apart in the codebase, so the
// per-language knowledge lives here instead of being sprinkled as `if (de)`
// branches through the planner, the aligner, and the splitter:
//
//   1. ALIGNMENT  — Deepgram must be TOLD the language (see deepgramLanguage).
//   2. PROMPTS    — Gemini reads the foreign narration but must keep writing
//                   image/animation prompts in ENGLISH (promptLanguageRule),
//                   while setting them in the right part of the world
//                   (visualCulture).
//   3. SENTENCES  — the `.!?` splitter over-splits German abbreviations and
//                   ordinal dates (abbreviations / ordinalMonths).
//
// Adding French/Spanish later is a new entry in LOCALES — not a new migration
// and not another pass through the planner.

export const LANGUAGES = ["en", "de"] as const;
export type LanguageCode = (typeof LANGUAGES)[number];

// Every pre-existing project predates the `language` column and is English.
// The DB default matches this, so an un-migrated row and an un-set row behave
// identically.
export const DEFAULT_LANGUAGE: LanguageCode = "en";

export interface LocaleConfig {
  code: LanguageCode;
  /** Label for the intake dropdown. */
  label: string;
  /** Endonym, shown next to the label so the client recognises their own language. */
  nativeLabel: string;
  /** Language name used inside Gemini prompts ("German"). */
  promptName: string;
  /**
   * Value for Deepgram's `language=` query param.
   *
   * CRITICAL: this is passed EXPLICITLY and never left to `detect_language`.
   * On nova-3 (our DEEPGRAM_MODEL) auto-detection is English-oriented, and a
   * mis-detected language does not fail loudly — it returns plausible-looking
   * word timings that are wrong, which silently mis-times EVERY segment in the
   * finished video. Naming the language is the only safe mode.
   */
  deepgramLanguage: string;
  /**
   * Spoken words per second, used ONLY by the estimator fallback that runs when
   * word timings are unavailable. German averages slightly fewer words for the
   * same duration than English (longer compounds), so a shared 2.5 constant
   * drifts the estimate long.
   */
  wordsPerSecond: number;
  /**
   * Tokens that end in '.' WITHOUT ending a sentence. Only entries that are
   * effectively never sentence-final belong here: the splitter merges across
   * them unconditionally, so a wrong entry welds two real sentences together.
   * Deliberately EXCLUDES "usw." / "etc.", which routinely do end a sentence.
   */
  abbreviations: readonly string[];
  /**
   * Month names used to disambiguate an ordinal date ("am 1. Januar") from a
   * sentence that merely ends in a number ("Es waren 15."). Empty disables the
   * ordinal rule.
   */
  ordinalMonths: readonly string[];
  /**
   * Cultural-setting instructions appended to the planner's topic block, so the
   * generated images and clips are set in the audience's part of the world.
   * Empty for English — the prompts keep their existing behaviour exactly.
   */
  visualCulture: readonly string[];
}

const EN: LocaleConfig = {
  code: "en",
  label: "English",
  nativeLabel: "English",
  promptName: "English",
  deepgramLanguage: "en",
  wordsPerSecond: 2.5,
  abbreviations: [],
  ordinalMonths: [],
  // No culture block: English is the behaviour every existing project was
  // planned under, and adding region instructions here would change the look of
  // videos that are already signed off.
  visualCulture: [],
};

const DE: LocaleConfig = {
  code: "de",
  label: "German",
  nativeLabel: "Deutsch",
  promptName: "German",
  deepgramLanguage: "de",
  // ~2.2 wps: German runs roughly 10-15% fewer words than English for the same
  // wall-clock narration.
  wordsPerSecond: 2.2,
  abbreviations: [
    "z.B.", "u.a.", "d.h.", "bzw.", "ca.", "ggf.", "inkl.", "zzgl.", "bspw.",
    "evtl.", "sog.", "vgl.", "Nr.", "Dr.", "Prof.", "St.", "Abb.", "Mio.", "Mrd.",
  ],
  ordinalMonths: [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ],
  // The client's actual ask: a German script must not render American suburbs,
  // pickup trucks, and US supermarket shelves. These lines are appended to the
  // niche block, so they CONSTRAIN the derived niche rather than replace it —
  // a car video stays a car video, it just becomes a European one.
  visualCulture: [
    "AUDIENCE / REGION (client requirement): this video is narrated in German for a",
    "German-speaking audience (Germany, Austria, Switzerland). Every scene must look",
    "like it was shot in that part of Europe — NOT in the USA:",
    "  - People: Central European, in ordinary everyday German clothing.",
    "  - Homes: European apartments and houses — tiled roofs, roller shutters,",
    "    tilt-and-turn windows, radiators under the windows, compact fitted",
    "    kitchens. NOT US suburban houses, NOT American double-door fridges.",
    "  - Streets and towns: European streetscapes — narrower streets, trams,",
    "    cyclists, cobblestones, pavement cafés, church spires, European cars with",
    "    EU number plates. NOT US pickup trucks, NOT strip malls, NOT yellow",
    "    school buses, NOT American road signage.",
    "  - Everyday life: European supermarkets and product packaging, euro notes and",
    "    coins, German road signs, Central European weather and vegetation.",
    "Keep this regional look even when the narration does not mention a place —",
    "it is the video's default world, not a special case.",
    "",
  ],
};

const LOCALES: Record<LanguageCode, LocaleConfig> = { en: EN, de: DE };

/** Every supported locale, in intake-dropdown order. */
export const ALL_LOCALES: readonly LocaleConfig[] = LANGUAGES.map((c) => LOCALES[c]);

/** True when `value` is a language we support. */
export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Resolve any stored/user value to a locale. Unknown, null, and legacy-empty
 * values fall back to English so a bad row degrades to today's behaviour
 * instead of throwing mid-pipeline.
 */
export function getLocale(language: string | null | undefined): LocaleConfig {
  return isLanguageCode(language) ? LOCALES[language] : LOCALES[DEFAULT_LANGUAGE];
}

/** Narrow a stored/user value to a LanguageCode (English on anything else). */
export function toLanguageCode(language: string | null | undefined): LanguageCode {
  return isLanguageCode(language) ? language : DEFAULT_LANGUAGE;
}

/**
 * Instruction block forcing Gemini to ANSWER IN ENGLISH while READING a foreign
 * transcript.
 *
 * Without this, a German script makes Gemini return German `imagePrompt` /
 * `basePrompt` / `animationPrompt` values — which then go straight to the image
 * and video models. Those models (gpt-image-2 via ai33, the fal/LTX clip
 * models) are English-trained and degrade badly on German prompts: wrong
 * subjects, ignored composition, and garbled on-image text. The narration stays
 * German; only the machine-facing prompt text is forced to English.
 *
 * Returns [] for English so the existing prompt is byte-identical.
 */
export function promptLanguageRule(locale: LocaleConfig): string[] {
  if (locale.code === DEFAULT_LANGUAGE) return [];
  const lang = locale.promptName;
  return [
    `PROMPT LANGUAGE (critical): the narration you are given is in ${lang}. READ and`,
    `UNDERSTAND it in ${lang} — but EVERY value you return (basePrompt, imagePrompt,`,
    "imagePrompt2, shotType, animationPrompt) MUST be written in ENGLISH. The image",
    `and video generators downstream are English-trained and produce noticeably worse`,
    `results from ${lang} prompts. Never copy ${lang} words from the narration into a`,
    "prompt: describe what is SHOWN, in English.",
    "",
  ];
}

/**
 * The regional-look block for the planner's topic section. Empty for English.
 */
export function visualCultureRule(locale: LocaleConfig): string[] {
  return [...locale.visualCulture];
}

/**
 * On-image text rule. Images are otherwise held to a strict no-text rule, but
 * product/brand blocks are explicitly allowed to show packaging and labels
 * (productBrandRule in the planner). On a German video that packaging must not
 * read as English, or the one place text IS allowed becomes the one place the
 * video looks machine-translated. Empty for English.
 */
export function onImageTextRule(locale: LocaleConfig): string[] {
  if (locale.code === DEFAULT_LANGUAGE) return [];
  return [
    `ON-IMAGE TEXT: the no-text rule still applies to every non-product block. Where`,
    `text IS allowed (product / brand lines) or unavoidable — packaging, a shop sign,`,
    `a road sign — it must read as ${locale.promptName}, never English.`,
    "",
  ];
}

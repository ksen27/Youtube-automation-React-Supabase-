// Canonical sentence splitter for the Google Doc transcript.
//
// This is the SOURCE OF TRUTH for "what sentences exist in this project."
// The matching pipeline used to ask Gemini to chop the transcript into
// blocks; that path silently dropped short sentences ("But somehow it
// just happened.") whenever Gemini hallucinated or paraphrased. Inverting
// the dependency — split the doc here, then enrich with Gemini — makes
// sentence loss impossible: the sentence list is the INPUT to enrichment,
// not the OUTPUT.
//
// Output contract (per sentence):
//   text                       — the raw doc sentence (capitalization,
//                                punctuation preserved so the editor row
//                                reads exactly like the doc).
//   paragraph_index            — which transcript paragraph the sentence
//                                came from (0-based across `\n+`-split
//                                paragraphs). Title cards bind to these.
//   sentence_index_in_paragraph— 0 for the first sentence of a paragraph.
//                                Drives `is_section_first_sentence`.
//   is_section_first_sentence  — true when this sentence opens a paragraph
//                                that has a blue-bold title marker. Used
//                                by the builder to prepend a title_card row.
//   char_offset                — cumulative char position in the original
//                                transcript. Reserved for future use by
//                                the marker matcher when it needs to
//                                correlate a script_phrase across passes.

import { getLocale, type LocaleConfig } from "@/lib/i18n/locale";

export interface Sentence {
  text: string;
  paragraph_index: number;
  sentence_index_in_paragraph: number;
  is_section_first_sentence: boolean;
  char_offset: number;
}

// Match the segmenter's regex (lib/ai/segments.ts) so a sentence boundary
// here is the same as a sentence boundary there. Captures everything up
// to and including the terminator; the trailing branch handles paragraphs
// that don't end with .!? (e.g. a paragraph cut off mid-thought).
const SENTENCE_REGEX = /[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g;

// PROTECTING NON-TERMINAL PERIODS
// -------------------------------
// SENTENCE_REGEX breaks on EVERY '.', which is right for English but wrong for
// languages that use periods inside a sentence. German hits this constantly,
// and each false break becomes a phantom sentence — which the synthetic planner
// turns into a phantom VISUAL BLOCK, so a fragment like "am 1." gets its own
// generated image and its own sub-second slice of the voiceover.
//
// We MASK those periods before splitting rather than re-joining fragments
// afterwards. Post-merging cannot work for abbreviations that contain internal
// periods: "z.B." is already shredded into "z." + "B." by the time any merge
// pass runs, so there is no intact token left to recognise.
//
// The mask is a single private-use character, so masking is LENGTH-PRESERVING.
// That matters: char_offset is computed by indexing into the transcript, and
// every offset stays valid as long as the masked and original strings line up
// character for character. Sentences are unmasked at the very end.
const PERIOD_MASK = "";

// Escape a literal for use inside a RegExp.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A period BETWEEN DIGITS is never a sentence end: "1.500 Euro", "1.5 euros",
// "23.7%". This one is language-INDEPENDENT and applies even to English.
//
// It fixes silent TEXT LOSS, not just a bad split. SENTENCE_REGEX's first
// branch requires whitespace-or-end after the terminator, so on "Das kostet
// 1.500 Euro." it fails mid-number, resumes past the period, and the leading
// "Das kostet 1" is dropped from the output entirely — the sentence list no
// longer reproduces the transcript, and the block's generated visual describes
// a sentence that was never spoken.
//
// English uses ',' for thousands so it only hit decimals there; German and
// Spanish both use '.' in ordinary prose ("1.500 Euro"), which turns a rare
// edge case into a routine one. Requires a digit IMMEDIATELY after the period,
// so a genuine sentence break before a number ("Ich habe 5. 3 bleiben.") is
// untouched.
const NUMERIC_PERIOD = /\d\.(?=\d)/gu;

// Build the mask patterns for a locale. Always returns at least the
// language-independent numeric rule.
function buildMaskPatterns(locale: LocaleConfig): RegExp[] | null {
  const patterns: RegExp[] = [NUMERIC_PERIOD];

  // Abbreviations: "z.B.", "d.h.", "Dr." — matched whole, case-sensitively, and
  // only when followed by whitespace or end-of-input so "Dr." inside a longer
  // token is left alone. The list holds only tokens that are effectively never
  // sentence-final (it deliberately omits "usw." / "etc.", which routinely DO
  // end a sentence), so masking them is unconditional.
  if (locale.abbreviations.length > 0) {
    const alt = locale.abbreviations.map(escapeRegExp).join("|");
    patterns.push(new RegExp(`(?<![\\p{L}\\d])(?:${alt})(?=\\s|$)`, "gu"));
  }

  // Ordinals: "am 1. Januar", "vom 3. bis". A bare digits-then-period is
  // genuinely ambiguous — "Es waren 15." is a real sentence end — so we mask
  // only when what FOLLOWS continues the phrase: a month name, or a lowercase
  // word. The lowercase test holds in every language here: a new sentence is
  // capitalised, so a lowercase continuation means we are mid-sentence. (It
  // also covers Spanish months, which are written lowercase.)
  if (locale.ordinalMonths.length > 0) {
    const months = locale.ordinalMonths.map(escapeRegExp).join("|");
    patterns.push(new RegExp(`\\d{1,2}\\.(?=\\s+(?:${months})\\b)`, "giu"));
    patterns.push(new RegExp(`\\d{1,2}\\.(?=\\s+\\p{Ll})`, "gu"));
  }

  return patterns;
}

// Replace sentence-internal periods with PERIOD_MASK. Length-preserving.
function maskPeriods(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (match) => match.replace(/\./g, PERIOD_MASK));
  }
  return out;
}

function unmaskPeriods(text: string): string {
  return text.split(PERIOD_MASK).join(".");
}

// Split a single paragraph of text into its sentences. Trims each match
// and drops the trailing-space the regex captures via its lookbehind-ish
// `(\s|$)` group. Empty paragraphs produce an empty array.
//
// Operates on ALREADY-MASKED text (see maskPeriods), so a masked period is
// invisible to SENTENCE_REGEX and simply cannot end a sentence.
function splitParagraphIntoSentences(paragraph: string): string[] {
  const matches = paragraph.match(SENTENCE_REGEX);
  if (!matches) return [];
  return matches
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Split the full transcript into ordered Sentence[] across paragraphs.
//
// Paragraph splitting:
//   We split on `\n+` to match parse.ts:transcript (which joins paragraphs
//   with a single `\n`). Multiple consecutive newlines collapse so an
//   accidental double-blank line in the doc doesn't produce phantom empty
//   paragraphs.
//
// Title-card binding:
//   The caller passes the set of paragraph indices that have a blue-bold
//   title_card marker (lib/gdocs/parse.ts:350-403 emits these per
//   paragraph). The first sentence of any such paragraph is flagged with
//   is_section_first_sentence = true so the builder knows to prepend a
//   title_card row at that sentence's vo_start.
//
// Edge cases:
//   - Empty transcript → returns [].
//   - Paragraph with no terminating punctuation → still becomes one
//     sentence (the trailing `[^.!?]+$` regex branch).
//   - Whitespace-only paragraphs → skipped (no sentences emitted).
//   - char_offset is computed against the ORIGINAL transcript, including
//     paragraph separators, so callers can slice the transcript by
//     [char_offset, char_offset + text.length] reliably.
export function splitTranscriptIntoSentences(
  transcript: string,
  titleCardParagraphIndices: ReadonlySet<number> = new Set(),
  // Narration language (projects.language). Controls the false-break rules
  // above; defaults to English, which contributes none — so every existing
  // caller keeps its exact current behaviour.
  language?: string | null,
): Sentence[] {
  if (!transcript || !transcript.trim()) return [];

  const locale: LocaleConfig = getLocale(language);

  // Hide sentence-internal periods before ANY splitting or offset arithmetic
  // happens. Masking is length-preserving, so `masked` and `transcript` are
  // positionally identical and every char_offset computed below indexes the
  // original transcript correctly. English gets only the numeric rule, which
  // is a bug fix rather than a behaviour change (see NUMERIC_PERIOD).
  const masked = maskPeriods(transcript, buildMaskPatterns(locale));

  const sentences: Sentence[] = [];
  const paragraphs = masked.split(/\n+/);

  // Walking offset in the original transcript. We track this so each
  // sentence carries its char_offset for downstream code that wants to
  // correlate a sentence to the raw doc text. We advance per paragraph
  // by paragraph.length + 1 (for the `\n` separator), and per sentence
  // by scanning for its first character in the current paragraph.
  let offset = 0;
  let paragraphIndex = 0;

  for (const paragraph of paragraphs) {
    const para = paragraph.trim();
    if (!para) {
      // Skip the blank — still advance the offset past the original
      // characters so subsequent paragraphs get accurate positions.
      offset += paragraph.length + 1;
      continue;
    }
    const isSectionParagraph = titleCardParagraphIndices.has(paragraphIndex);
    const sentenceTexts = splitParagraphIntoSentences(para);

    // Track where each sentence's first character lives in the transcript. We
    // scan forward from the paragraph's start offset so a sentence that
    // contains whitespace at its head doesn't end up with a char_offset
    // pointing into the previous sentence.
    //
    // These searches run against `masked` because `para` / `text` are masked —
    // but masking is length-preserving, so the offsets they yield are equally
    // valid in the ORIGINAL transcript, which is what callers slice.
    let cursor = masked.indexOf(para, offset);
    if (cursor < 0) cursor = offset;

    for (let i = 0; i < sentenceTexts.length; i++) {
      const text = sentenceTexts[i];
      // Find this sentence's exact start. indexOf from `cursor` keeps narration
      // order even when a sentence happens to appear verbatim earlier in the doc.
      const found = masked.indexOf(text, cursor);
      const sentenceOffset = found >= 0 ? found : cursor;
      sentences.push({
        // Restore the real periods — the mask is an internal splitting device
        // and must never reach a caller, a prompt, or the review screen.
        text: unmaskPeriods(text),
        paragraph_index: paragraphIndex,
        sentence_index_in_paragraph: i,
        // Only the FIRST sentence of a blue-bold paragraph carries the
        // title-card flag. Later sentences in the same paragraph play
        // the section's content as normal.
        is_section_first_sentence: isSectionParagraph && i === 0,
        char_offset: sentenceOffset,
      });
      cursor = sentenceOffset + text.length;
    }
    offset += paragraph.length + 1;
    paragraphIndex++;
  }

  return sentences;
}

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

// Split a single paragraph of text into its sentences. Trims each match
// and drops the trailing-space the regex captures via its lookbehind-ish
// `(\s|$)` group. Empty paragraphs produce an empty array.
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
): Sentence[] {
  if (!transcript || !transcript.trim()) return [];

  const sentences: Sentence[] = [];
  const paragraphs = transcript.split(/\n+/);

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

    // Track where each sentence's first character lives in the original
    // transcript. We scan forward from the paragraph's start offset so
    // a sentence that contains whitespace at its head doesn't end up with
    // a char_offset pointing into the previous sentence.
    let cursor = transcript.indexOf(para, offset);
    if (cursor < 0) cursor = offset;

    for (let i = 0; i < sentenceTexts.length; i++) {
      const text = sentenceTexts[i];
      // Find this sentence's exact start in the original transcript.
      // indexOf from `cursor` keeps narration order even when a sentence
      // happens to appear verbatim earlier in the doc.
      const found = transcript.indexOf(text, cursor);
      const sentenceOffset = found >= 0 ? found : cursor;
      sentences.push({
        text,
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

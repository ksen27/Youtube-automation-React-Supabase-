import { describe, it, expect } from "vitest";
import { splitTranscriptIntoSentences } from "@/lib/ai/sentences";

// The sentence list is what the synthetic planner turns into VISUAL BLOCKS, so
// a false split is not cosmetic: each phantom sentence becomes its own
// generated image with its own sub-second slice of the voiceover. These assert
// the German false-break rules, and — just as importantly — that English is
// completely unchanged by them.

const texts = (transcript: string, language?: string) =>
  splitTranscriptIntoSentences(transcript, undefined, language).map((s) => s.text);

describe("splitTranscriptIntoSentences — English (unchanged)", () => {
  it("splits on sentence terminators", () => {
    expect(texts("One thing. Two things! Three?")).toEqual([
      "One thing.",
      "Two things!",
      "Three?",
    ]);
  });

  it("applies no false-break rules — English contributes none", () => {
    // "Dr." IS in the German abbreviation list. An English project must not
    // inherit it, or the two languages would silently share splitting rules.
    expect(texts("Ask Dr. Smith. He knows.")).toEqual(["Ask Dr.", "Smith.", "He knows."]);
  });

  it("defaults to English when no language is given", () => {
    expect(texts("Ask Dr. Smith.")).toEqual(texts("Ask Dr. Smith.", "en"));
  });
});

describe("splitTranscriptIntoSentences — German", () => {
  it("does not split inside an abbreviation", () => {
    expect(texts("Nimm z.B. das Auto. Es ist alt.", "de")).toEqual([
      "Nimm z.B. das Auto.",
      "Es ist alt.",
    ]);
  });

  it("handles several abbreviations in one sentence", () => {
    expect(texts("Das ist d.h. u.a. wichtig. Fertig.", "de")).toEqual([
      "Das ist d.h. u.a. wichtig.",
      "Fertig.",
    ]);
  });

  it("keeps an ordinal date together when a month follows", () => {
    expect(texts("Am 1. Januar beginnt es. Dann sehen wir.", "de")).toEqual([
      "Am 1. Januar beginnt es.",
      "Dann sehen wir.",
    ]);
  });

  it("keeps an ordinal together when a lowercase word follows", () => {
    expect(texts("Vom 3. bis zum 5. Mai. Danach nicht.", "de")).toEqual([
      "Vom 3. bis zum 5. Mai.",
      "Danach nicht.",
    ]);
  });

  it("still ends the sentence when a number is genuinely final", () => {
    // The ordinal rule must NOT weld two real sentences together just because
    // the first ends in a number — "Danach" is capitalised and is not a month.
    expect(texts("Es waren 15. Danach ging es weiter.", "de")).toEqual([
      "Es waren 15.",
      "Danach ging es weiter.",
    ]);
  });

  it("does not merge across 'usw.', which routinely ends a sentence", () => {
    expect(texts("Äpfel, Birnen usw. Das reicht.", "de")).toEqual([
      "Äpfel, Birnen usw.",
      "Das reicht.",
    ]);
  });

  it("reports char offsets that still index into the original transcript", () => {
    // The merge pass rejoins with a single space, so offsets must survive it —
    // downstream alignment slices the transcript by [char_offset, +length].
    const transcript = "Nimm z.B. das Auto. Es ist alt.";
    for (const s of splitTranscriptIntoSentences(transcript, undefined, "de")) {
      expect(transcript.slice(s.char_offset, s.char_offset + s.text.length)).toBe(s.text);
    }
  });

  it("preserves umlauts and ß untouched", () => {
    expect(texts("Die Straße ist schön. Größer geht nicht.", "de")).toEqual([
      "Die Straße ist schön.",
      "Größer geht nicht.",
    ]);
  });

  it("falls back to English rules for an unknown language code", () => {
    expect(texts("Nimm z.B. das Auto.", "fr")).toEqual(texts("Nimm z.B. das Auto."));
  });
});

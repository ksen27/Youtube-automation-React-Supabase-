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

describe("splitTranscriptIntoSentences — Spanish", () => {
  it("does not split inside an abbreviation", () => {
    expect(texts("Pregunta al Sr. García. Él sabe.", "es")).toEqual([
      "Pregunta al Sr. García.",
      "Él sabe.",
    ]);
  });

  it("handles an abbreviation with internal periods", () => {
    expect(texts("Usa p.ej. el aceite. Es mejor.", "es")).toEqual([
      "Usa p.ej. el aceite.",
      "Es mejor.",
    ]);
  });

  it("keeps an ordinal date together (Spanish months are lowercase)", () => {
    expect(texts("El 1. de enero empieza todo. Luego veremos.", "es")).toEqual([
      "El 1. de enero empieza todo.",
      "Luego veremos.",
    ]);
  });

  it("still ends the sentence when a number is genuinely final", () => {
    expect(texts("Eran 15. Después continuó.", "es")).toEqual([
      "Eran 15.",
      "Después continuó.",
    ]);
  });

  it("handles inverted question and exclamation marks", () => {
    expect(texts("¡Hola! ¿Qué tal estás? Muy bien.", "es")).toEqual([
      "¡Hola!",
      "¿Qué tal estás?",
      "Muy bien.",
    ]);
  });

  it("preserves accents and ñ untouched", () => {
    expect(texts("El niño está aquí. Mañana también.", "es")).toEqual([
      "El niño está aquí.",
      "Mañana también.",
    ]);
  });
});

// A period between digits is never a sentence end. This rule is
// language-INDEPENDENT because the bug it fixes is text LOSS, not just a bad
// split: SENTENCE_REGEX fails mid-number and drops everything before it.
describe("splitTranscriptIntoSentences — numbers (all languages)", () => {
  it("does not lose text around a German thousands separator", () => {
    expect(texts("Das kostet 1.500 Euro im Jahr. Wirklich.", "de")).toEqual([
      "Das kostet 1.500 Euro im Jahr.",
      "Wirklich.",
    ]);
  });

  it("does not lose text around a Spanish thousands separator", () => {
    expect(texts("Cuesta 1.500 euros al año. De verdad.", "es")).toEqual([
      "Cuesta 1.500 euros al año.",
      "De verdad.",
    ]);
  });

  it("does not lose text around an English decimal", () => {
    expect(texts("It costs 1.5 million a year. Really.")).toEqual([
      "It costs 1.5 million a year.",
      "Really.",
    ]);
  });

  it("still splits when a sentence genuinely ends in a number", () => {
    // The digit must follow the period IMMEDIATELY, so a real break before a
    // number is untouched.
    expect(texts("I have 5. 3 remain.")).toEqual(["I have 5.", "3 remain."]);
  });

  it("keeps char offsets valid across masked numbers", () => {
    const transcript = "Das kostet 1.500 Euro im Jahr. Wirklich.";
    for (const s of splitTranscriptIntoSentences(transcript, undefined, "de")) {
      expect(transcript.slice(s.char_offset, s.char_offset + s.text.length)).toBe(s.text);
    }
  });
});

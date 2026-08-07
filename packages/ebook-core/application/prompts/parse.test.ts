import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseJsonCompletion, escapeControlCharsInStrings } from './parse';

const LayoutSchema = z.object({ css: z.string(), bodyHtml: z.string() });

describe('parseJsonCompletion', () => {
  it('parses a plain JSON object', () => {
    const result = parseJsonCompletion('{"css":"a{}","bodyHtml":"<p>x</p>"}', LayoutSchema);
    expect(result.isOk()).toBe(true);
    expect(result.value.css).toBe('a{}');
  });

  it('tolerates a ```json fence and surrounding prose', () => {
    const result = parseJsonCompletion('Here you go:\n```json\n{"css":"a{}","bodyHtml":"b"}\n```\nHope that helps.', LayoutSchema);
    expect(result.isOk()).toBe(true);
  });

  /**
   * The failure this repair exists for. A model returning a multi-line
   * stylesheet inside a JSON string writes real line breaks, because that is
   * the natural thing to do — and JSON forbids them. It cost a whole layout
   * attempt each time, and three of those fall back to the built-in template.
   */
  describe('raw control characters in string literals', () => {
    it('recovers a multi-line stylesheet written with real newlines', () => {
      const broken = '{"css":"body {\n  margin: 0;\n}","bodyHtml":"<p>x</p>"}';
      expect(() => JSON.parse(broken)).toThrow(); // precondition: genuinely invalid

      const result = parseJsonCompletion(broken, LayoutSchema);
      expect(result.isOk()).toBe(true);
      expect(result.value.css).toBe('body {\n  margin: 0;\n}');
    });

    it('recovers tabs and carriage returns too', () => {
      const result = parseJsonCompletion('{"css":"a{\r\n\tcolor: red;\r\n}","bodyHtml":"b"}', LayoutSchema);
      expect(result.isOk()).toBe(true);
      expect(result.value.css).toContain('\t');
    });

    it('still reports genuinely malformed JSON rather than silently passing', () => {
      const result = parseJsonCompletion('{"css":"a{}", "bodyHtml":}', LayoutSchema);
      if (result.isOk()) throw new Error('expected malformed JSON to be rejected');
      expect(result.error).toContain('Invalid JSON');
    });
  });
});

describe('escapeControlCharsInStrings', () => {
  it('leaves valid JSON untouched', () => {
    const valid = '{\n  "a": "already \\n escaped",\n  "b": 1\n}';
    expect(escapeControlCharsInStrings(valid)).toBe(valid);
  });

  it('escapes only inside strings, not the whitespace between tokens', () => {
    const out = escapeControlCharsInStrings('{\n"a": "x\ny"\n}');
    expect(out).toBe('{\n"a": "x\\ny"\n}');
  });

  /**
   * An escaped quote must not flip the scanner's string state. A stylesheet
   * containing `content: "\""` would otherwise put it out of phase and corrupt
   * everything after it — turning a recoverable response into a mangled one.
   */
  it('does not mistake an escaped quote for the end of a string', () => {
    const out = escapeControlCharsInStrings('{"css":"a::after{content:\\"\\"}\nb{}"}');
    expect(out).toBe('{"css":"a::after{content:\\"\\"}\\nb{}"}');
    expect(JSON.parse(out).css).toBe('a::after{content:""}\nb{}');
  });

  it('handles a trailing backslash without running off the end', () => {
    expect(() => escapeControlCharsInStrings('{"a":"x\\')).not.toThrow();
  });

  it('escapes an exotic control character as a \\u sequence', () => {
    expect(escapeControlCharsInStrings('{"a":"x\u0001y"}')).toBe('{"a":"x\\u0001y"}');
  });
});

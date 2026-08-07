import { Result } from '../../domain/shared/Result';
import type { z } from 'zod';

/**
 * Parse a Claude completion that should contain JSON. Tolerates ```json fences
 * and surrounding prose. AI output is validated, never trusted.
 */
// Infer the schema's OUTPUT type (`z.output`), not a single combined type. This
// matters for schemas using `z.preprocess`/transforms, where the input type is
// `unknown` but the parsed output is concrete (e.g. `string[]`) — typing on the
// output gives callers the post-validation shape they actually receive.
export function parseJsonCompletion<S extends z.ZodTypeAny>(text: string, schema: S): Result<z.output<S>> {
  const json = extractJson(text);
  if (!json) return Result.fail('No JSON object found in completion');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (first) {
    // A raw newline inside a string literal is the single most common way a
    // completion fails to parse, and it costs a whole attempt when it does. It
    // happens whenever the model returns multi-line content in a string field —
    // a stylesheet, a chapter, a block of markup — because writing an actual
    // line break there is the natural thing to do and JSON forbids it.
    //
    // Repairing is safe: the only characters touched are ones that cannot
    // legally appear unescaped where they are, so valid JSON is never altered.
    // Tried only after a straight parse fails, so the normal path is untouched.
    try {
      raw = JSON.parse(escapeControlCharsInStrings(json));
    } catch {
      return Result.fail(`Invalid JSON: ${(first as Error).message}`);
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return Result.fail(`Schema mismatch: ${parsed.error.message}`);
  return Result.ok(parsed.data);
}

/**
 * Escapes control characters that appear INSIDE a JSON string literal.
 *
 * Walks the text tracking string state, so a `"` that is itself escaped never
 * flips it — without that, a stylesheet containing `content: "\""` would put
 * the scanner out of phase and corrupt the rest of the document.
 *
 * Characters outside string literals are left exactly as they are: whitespace
 * between tokens is legal JSON and re-escaping it would produce nonsense.
 */
export function escapeControlCharsInStrings(json: string): string {
  const ESCAPES: Record<number, string> = {
    0x08: '\\b',
    0x09: '\\t',
    0x0a: '\\n',
    0x0c: '\\f',
    0x0d: '\\r',
  };

  let out = '';
  let inString = false;
  let afterBackslash = false;

  for (const ch of json) {
    if (afterBackslash) {
      // Consumed literally: this is the second half of an escape sequence, so
      // it can be neither a string terminator nor a control character.
      out += ch;
      afterBackslash = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      afterBackslash = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (inString && code < 0x20) {
      out += ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return null;
}

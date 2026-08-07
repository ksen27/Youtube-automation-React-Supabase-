import { preferredStackFor } from './fontStacks';
import type { TypographyTokens } from './TemplateManifest';

/**
 * Repairs the font stacks of a cloned stylesheet.
 *
 * The clone pipeline strips every captured `@font-face` and re-adds only the
 * faces whose licence permits redistribution. What it does NOT touch are the
 * `font-family` declarations naming those faces — they are ordinary CSS. So a
 * template using a self-hosted face shipped a page still asking for "Canela",
 * with nothing providing it and nothing after it in the stack. The browser fell
 * through to its default serif, and the clone matched its template everywhere
 * except the type.
 *
 * The fix is to append the closest renderable stack to declarations whose lead
 * family did not survive. Appending rather than replacing is what makes this
 * safe to run unconditionally: when the face DID embed it still wins, because a
 * font stack is already a preference list. So the same output is correct whether
 * or not embedding succeeded, and the two never have to be kept in step.
 */

/** A `font-family` declaration's value, and where it sat in the source. */
const FONT_FAMILY_RE = /(^|[;{\s])(font-family\s*:\s*)([^;}!]+)/gi;

/** Generic keywords already terminate a stack; a real family name does not. */
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|-apple-system|BlinkMacSystemFont|inherit|initial|unset|revert)$/i;

function familyNames(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.replace(/["']/g, '').trim())
    .filter(Boolean);
}

/** Whether a declaration already ends in a generic, i.e. can never fall through. */
function isTerminated(names: string[]): boolean {
  const last = names[names.length - 1];
  return !!last && GENERIC.test(last);
}

export interface FontFallbackInput {
  css: string;
  /** Families an `@font-face` in the bundle actually provides. */
  embeddedFamilies: string[];
  /** The measured typography, used to decide serif vs sans for unknown faces. */
  typography: TypographyTokens;
}

export interface FontFallbackResult {
  css: string;
  /** Families that had to fall back, i.e. the typography actually lost. */
  lostFamilies: string[];
}

/**
 * Appends a renderable fallback to every declaration whose lead face is missing.
 */
export function repairFontStacks(input: FontFallbackInput): FontFallbackResult {
  const embedded = new Set(input.embeddedFamilies.map((f) => f.replace(/["']/g, '').trim().toLowerCase()));
  const lost = new Set<string>();

  // Which roles are serif, so an unrecognised face inherits the right bucket
  // rather than defaulting every unknown to a book serif.
  const serifByFamily = new Map<string, boolean>();
  for (const role of [input.typography.heading, input.typography.body]) {
    if (role) serifByFamily.set(role.family.toLowerCase(), role.serif);
  }

  const css = input.css.replace(FONT_FAMILY_RE, (whole, lead: string, prop: string, value: string) => {
    const names = familyNames(value);
    const first = names[0];
    if (!first) return whole;

    // `var(--font-display)` resolves at render time to a family this pass
    // cannot see. Leave it alone: rewriting it would replace a working
    // indirection with a guess, and the token's own definition is repaired
    // when its declaration is visited.
    if (/^var\(/i.test(first)) return whole;
    if (GENERIC.test(first)) return whole;
    if (embedded.has(first.toLowerCase())) return whole;
    // Already falls through to something renderable on its own.
    if (isTerminated(names) && names.length > 1) return whole;

    lost.add(first);
    const serif = serifByFamily.get(first.toLowerCase()) ?? /serif|display|book|times|georgia/i.test(first);
    const stack = preferredStackFor(first, serif);
    // preferredStackFor already leads with the original family, so the embedded
    // face — or a copy the visitor happens to have installed — still wins.
    const extra = names.slice(1).filter((n) => !GENERIC.test(n));
    const merged = extra.length > 0 ? withExtras(stack, extra) : stack;
    return `${lead}${prop}${merged}`;
  });

  return { css, lostFamilies: [...lost] };
}

/**
 * Keeps the template's own secondary choices ahead of ours.
 *
 * A stylesheet that said `"Canela", "Georgia Pro", serif` named Georgia Pro for
 * a reason; our stack is the last resort, not the second.
 */
function withExtras(stack: string, extras: string[]): string {
  const parts = stack.split(',').map((p) => p.trim());
  const head = parts[0];
  const quoted = extras.map((n) => (/\s/.test(n) ? `"${n}"` : n));
  return [head, ...quoted, ...parts.slice(1)].join(', ');
}

/**
 * Which of the page's families no embedded face provides.
 *
 * Kept separate from the rewrite because the report needs it even when the CSS
 * needed no repair — a template whose faces all embedded still reports what it
 * measured.
 */
export function lostFamiliesOf(familiesUsed: string[], embeddedFamilies: string[]): string[] {
  const embedded = new Set(embeddedFamilies.map((f) => f.replace(/["']/g, '').trim().toLowerCase()));
  return familiesUsed.filter((f) => !embedded.has(f.replace(/["']/g, '').trim().toLowerCase()));
}

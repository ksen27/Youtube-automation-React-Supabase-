import { describe, expect, it } from 'vitest';
import { preferredStackFor, systemStackFor } from './fontStacks';

describe('systemStackFor', () => {
  // Both are serif and read nothing alike; mapping both to Georgia lost most
  // of what makes a template recognisable.
  it('separates a display serif from a book serif', () => {
    const display = systemStackFor('Playfair Display', true);
    const book = systemStackFor('Merriweather', true);
    expect(display).not.toBe(book);
    expect(display).toContain('Didot');
    expect(book).toContain('Georgia');
  });

  it('separates a geometric sans from a neo-grotesque', () => {
    expect(systemStackFor('Poppins', false)).toContain('Century Gothic');
    expect(systemStackFor('Inter', false)).toContain('Inter');
  });

  // Stylesheets spell the same face several ways.
  it.each(['Playfair Display', 'PlayfairDisplay', 'playfair-display', '"Playfair Display"'])(
    'recognises %s',
    (name) => {
      expect(systemStackFor(name, true)).toContain('Didot');
    },
  );

  // Licensed faces nobody else has are the common case.
  it('falls back by serif flag for an unknown face', () => {
    expect(systemStackFor('Некий Шрифт', true)).toContain('Georgia');
    expect(systemStackFor('Some Bespoke Grotesk', false)).toContain('Inter');
    expect(systemStackFor(null, false)).toContain('Inter');
  });

  it('always ends in a generic family so the page still renders', () => {
    for (const name of ['Playfair', 'Poppins', 'Oswald', 'IBM Plex Mono', null]) {
      expect(systemStackFor(name, false)).toMatch(/(serif|sans-serif|monospace)$/);
    }
  });
});

describe('preferredStackFor', () => {
  // Naming an unavailable family costs nothing — that is what a stack is for —
  // so the same value is correct whether or not the font was legally embedded.
  it('names the reference family first, then the closest system fallback', () => {
    const stack = preferredStackFor('Playfair Display', true);
    expect(stack.startsWith('"Playfair Display"')).toBe(true);
    expect(stack).toContain('Didot');
    expect(stack).toMatch(/serif$/);
  });

  it('does not repeat a family the mapped stack already leads with', () => {
    expect(preferredStackFor('Inter', false).startsWith('Inter,')).toBe(true);
    expect(preferredStackFor('Inter', false)).not.toContain('"Inter", Inter');
  });

  it('falls back cleanly when no family was detected', () => {
    expect(preferredStackFor(null, true)).toBe(systemStackFor(null, true));
  });
});

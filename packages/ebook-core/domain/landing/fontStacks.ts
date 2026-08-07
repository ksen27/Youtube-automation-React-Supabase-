/**
 * Maps a reference site's typeface to the closest stack we can actually render.
 *
 * Landing pages deploy as ONE self-contained file that must render with no
 * network at all, so a webfont cannot be loaded — Playfair Display, Poppins and
 * Bebas Neue are simply not available to us. What we can do is stop treating
 * every serif as Georgia and every sans as Inter: a high-contrast display serif
 * and an old-style book serif read nothing alike, and neither does a geometric
 * sans beside a neo-grotesque one.
 *
 * Each entry names fonts likely to be installed on the reader's machine, in
 * descending order of resemblance, ending in the generic family so the page
 * always renders.
 */

const DISPLAY_SERIF = '"Didot", "Bodoni MT", "Playfair Display", "Times New Roman", serif';
const BOOK_SERIF = 'Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, serif';
const SLAB_SERIF = 'Rockwell, "Roboto Slab", "Courier New", Georgia, serif';
const GEOMETRIC_SANS = '"Century Gothic", "Avenir Next", Avenir, Futura, "Trebuchet MS", sans-serif';
const NEO_GROTESQUE = 'Inter, "Helvetica Neue", Helvetica, system-ui, -apple-system, "Segoe UI", sans-serif';
const HUMANIST_SANS = '"Segoe UI", "Gill Sans", "Gill Sans MT", Calibri, system-ui, sans-serif';
const CONDENSED_SANS = '"Arial Narrow", "Helvetica Neue Condensed", Impact, sans-serif';
const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Courier New", monospace';

/**
 * Families grouped by how they READ, not by vendor. A name is matched loosely
 * (lowercased, punctuation-insensitive) because stylesheets spell the same face
 * many ways — "PlayfairDisplay", "Playfair Display", "playfair-display".
 */
const FAMILIES: Array<{ stack: string; names: string[] }> = [
  {
    // High-contrast display serifs: thin hairlines, dramatic at large sizes.
    stack: DISPLAY_SERIF,
    names: ['playfair', 'didot', 'bodoni', 'prata', 'cormorant', 'abril', 'canela', 'tiempos headline', 'ogg'],
  },
  {
    // Old-style and transitional serifs: even colour, built for reading.
    stack: BOOK_SERIF,
    names: [
      'georgia', 'merriweather', 'lora', 'source serif', 'pt serif', 'crimson', 'garamond',
      'baskerville', 'libre baskerville', 'noto serif', 'charter', 'freight', 'tiempos', 'spectral',
    ],
  },
  { stack: SLAB_SERIF, names: ['roboto slab', 'zilla', 'rockwell', 'arvo', 'bitter', 'josefin slab'] },
  {
    // Geometric sans: circular bowls, single-storey a.
    stack: GEOMETRIC_SANS,
    names: ['futura', 'poppins', 'montserrat', 'jost', 'century gothic', 'questrial', 'gilroy', 'circular'],
  },
  { stack: CONDENSED_SANS, names: ['oswald', 'bebas', 'anton', 'archivo narrow', 'barlow condensed'] },
  {
    stack: HUMANIST_SANS,
    names: ['gill sans', 'segoe', 'open sans', 'lato', 'source sans', 'pt sans', 'noto sans', 'fira sans'],
  },
  {
    stack: NEO_GROTESQUE,
    names: [
      'inter', 'helvetica', 'roboto', 'arial', 'work sans', 'dm sans', 'manrope', 'satoshi',
      'general sans', 'neue haas', 'graphik', 'suisse',
    ],
  },
  { stack: MONO, names: ['mono', 'courier', 'consolas', 'menlo', 'ibm plex mono'] },
];

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/["']/g, '')
    // "PlayfairDisplay" and "playfair-display" must both reach "playfair display".
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The closest renderable stack for a named typeface.
 *
 * `serif` is the fallback when the name is unknown — which is common, since
 * these sites often use licensed faces nobody else has.
 */
export function systemStackFor(name: string | null | undefined, serif: boolean): string {
  const wanted = normalise(name ?? '');
  if (wanted) {
    for (const family of FAMILIES) {
      if (family.names.some((candidate) => wanted.includes(candidate))) return family.stack;
    }
  }
  return serif ? BOOK_SERIF : NEO_GROTESQUE;
}

export const FONT_STACKS = {
  displaySerif: DISPLAY_SERIF,
  bookSerif: BOOK_SERIF,
  neoGrotesque: NEO_GROTESQUE,
} as const;

/**
 * The resolved stack with the reference's OWN family named first.
 *
 * Costs nothing when the font is unavailable — that is what a font stack is
 * for — and means an embedded @font-face is actually used when one was legally
 * inlined into the page. So the same value is correct whether or not the
 * embedding succeeded, and the two never have to be kept in step.
 */
export function preferredStackFor(name: string | null | undefined, serif: boolean): string {
  const stack = systemStackFor(name, serif);
  const clean = (name ?? '').replace(/["']/g, '').trim();
  if (!clean) return stack;
  // Skip when the mapped stack already leads with it, to avoid "Inter, Inter, …".
  if (stack.toLowerCase().startsWith(clean.toLowerCase())) return stack;
  return `"${clean}", ${stack}`;
}

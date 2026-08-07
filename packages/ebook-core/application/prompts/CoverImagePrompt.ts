interface CoverImageInput {
  title: string;
  /** Rendered INTO the artwork as the deck under the title (reference-cover style). */
  subtitle: string;
  /**
   * THIS book's own brief — the strategy text (core promise, transformation, key
   * principles, audience). Per-book, so two books from the same channel get
   * genuinely different art. Falls back to the channel knowledge base only when a
   * book has no strategy.
   */
  subject: string;
  tone: string;
  /**
   * Stable per-book key (the project id) used to pick a style variant. Must be
   * stable so a retry after a storage failure reproduces the same cover.
   */
  variantKey: string;
  /**
   * Up to 5 SHORT labels (2-3 words) for the navy benefit bar across the foot of
   * the cover. Derived from the strategy's key principles. Fewer than 2 and the
   * bar is dropped rather than rendered half-empty.
   */
  featureLabels?: string[];
}

/**
 * The client's reference cover fixes the LAYOUT, TYPOGRAPHY and PALETTE — that
 * template is the house look and does not vary. What still rotates is the
 * PHOTOGRAPH filling the lower half, so two books from one channel remain
 * visually distinct without breaking the template.
 */
interface CoverVariant {
  name: string;
  /** How the lower-half photograph is shot and what it depicts. */
  photoDirection: string;
}

/**
 * Five ways to shoot the lower-half photograph. Picked deterministically from
 * the project id, so covers vary across books but never across retries of the
 * same book. Every one of these must still read as warm, aspirational lifestyle
 * photography sitting under a cream typographic panel — they vary the SUBJECT of
 * the photo, not the template around it.
 */
const NONFICTION_VARIANTS: CoverVariant[] = [
  {
    name: 'aspirational-portrait',
    photoDirection:
      'A warm, candid lifestyle photograph of a real person who represents the target reader, seen in a ' +
      'calm, positive moment that embodies the book\'s promise — often from behind or in three-quarter ' +
      'profile, looking toward the thing they want. Natural window or golden-hour light, soft shallow ' +
      'depth of field, gentle warm tones.',
  },
  {
    name: 'in-the-moment',
    photoDirection:
      "A candid documentary photograph of the book's activity actually being done — hands at work, the " +
      'real setting around them, caught mid-action rather than posed. Natural directional light, honest ' +
      'textures, shallow depth of field isolating the moment.',
  },
  {
    name: 'hero-still-life',
    photoDirection:
      "A beautifully lit still-life of the objects central to the book's subject, arranged with editorial " +
      'care on a clean warm surface — overhead or gentle three-quarter angle, soft directional light, ' +
      'natural shadows, premium materials and real texture.',
  },
  {
    name: 'destination-outcome',
    photoDirection:
      'A wide, inviting photograph of the RESULT the reader is promised — the place, state, or finished ' +
      'outcome they are working toward, shot at golden hour with generous depth and warm inviting light. ' +
      'Aspirational but real, never stock-generic.',
  },
  {
    name: 'quiet-detail',
    photoDirection:
      "An intimate close-up detail from the book's world — a texture, tool, surface, or small telling " +
      'object — shot macro-close with beautiful soft light and a creamy out-of-focus background. Calm, ' +
      'tactile, and premium.',
  },
];

/**
 * Builds a premium, bestseller-grade cover brief matching the CLIENT'S REFERENCE
 * COVER: a cream typographic upper half (small-caps eyebrow, huge navy serif
 * title with one gold italic line, gold rule, small-caps navy deck), a warm
 * lifestyle photograph filling the lower half, an optional gold-ruled roundel
 * badge, and a navy benefit bar with icons across the foot.
 *
 * The whole cover — every word — is rendered INTO the image: the export shows it
 * full-bleed with no HTML overlay, so anything not requested here simply will not
 * appear. Unlike the previous revision the SUBTITLE is now part of the artwork.
 *
 * LAYOUT, TYPOGRAPHY and PALETTE are fixed (that template IS the client's house
 * look). Only the lower-half PHOTOGRAPH rotates, chosen deterministically from
 * the project id, so books from one channel stay visually distinct while a retry
 * of the SAME book reproduces the same cover.
 */
export const CoverImagePrompt = {
  build(input: CoverImageInput): string {
    const subject = compact(input.subject, 900);
    const title = compact(input.title, 200);
    const subtitle = compact(input.subtitle, 180);
    const variant = pickVariant(NONFICTION_VARIANTS, input.variantKey);
    // Half-empty bars look broken, so render the foot bar only with enough labels.
    const labels = (input.featureLabels ?? []).map((l) => compact(l, 24).toUpperCase()).filter(Boolean).slice(0, 5);
    const hasBar = labels.length >= 2;
    const accentWord = pickAccentWord(title);

    return [
      'Design a premium bestselling NON-FICTION book cover in the following EXACT editorial template.',
      '',
      'STYLE:',
      'Commercial publishing quality, comparable to top-selling nonfiction books on Amazon and bookstore ' +
        'shelves. Warm, elegant, trustworthy, and expensive — designed by an award-winning editorial ' +
        'designer, never AI-generated, template-based, or Canva-like.',
      '',
      'OVERALL LAYOUT (follow this structure precisely, top to bottom):',
      '1. A small GOLD line-art ICON centred at the very top, flanked left and right by thin horizontal ' +
        'gold rules that stop short of the margins.',
      '2. The TITLE BLOCK in large elegant serif type on a clean CREAM background.',
      '3. A short thin GOLD rule, centred, in the gap BETWEEN the title block and the subtitle — never ' +
        'below the subtitle.',
      '4. The SUBTITLE deck in small, widely-letterspaced navy capitals, centred, 2-3 lines.',
      '5. A warm PHOTOGRAPH filling the LOWER HALF of the cover, blending softly upward into the cream ' +
        'background with no hard seam.',
      ...(hasBar
        ? [
            '6. A solid NAVY BAR across the very bottom carrying small gold line icons with tiny capital ' +
              'labels beneath them.',
            '   The bar must be FULL-BLEED: it touches the left edge, the right edge, and the very bottom ' +
              'edge of the cover with NO margin or gap of any kind around it.',
          ]
        : ['6. A calm, uncluttered lower edge — no bar, no band, no strip, and no extra text of any kind.']),
      '',
      'PHOTOGRAPH (lower half):',
      variant.photoDirection,
      'It must sit BEHIND and BELOW the typography, never competing with it, and must fade gently into the ' +
        'cream panel above. Real photography, never illustration or 3D render.',
      '',
      'THIS BOOK:',
      `Subject and premise: """${subject}"""`,
      'The photograph and the top icon must be specific to THIS book — drawn from the subject and premise ' +
        'above, never generic stock imagery.',
      '',
      'TEXT ON THE COVER — render EXACTLY these words, spelled correctly, and NOTHING else:',
      `- TITLE: "${title}"`,
      ...(subtitle ? [`- SUBTITLE DECK: "${subtitle}"`] : []),
      ...(hasBar ? [`- BENEFIT BAR LABELS (one per icon, in this order): ${labels.map((l) => `"${l}"`).join(', ')}`] : []),
      '- NO author name, NO publisher, NO price, NO series line, NO invented tagline, NO extra words of any ' +
        'kind beyond those listed above.',
      '',
      'TYPOGRAPHY:',
      '- Title set in a refined high-contrast SERIF (Didot / Bodoni / Playfair character), centred.',
      '- Break the title across 2-4 lines by meaning, with clear size hierarchy: a small letterspaced ' +
        'capitals line for any leading words, then the KEY WORD very large, then the remaining lines.',
      // Naming the exact word beats a positional rule ("one line"): the model was
      // reliably colouring only PART of a word — "D|etailing" — when left to choose.
      `- MANDATORY ACCENT: set the word "${accentWord}" in WARM GOLD ITALIC serif. Every other word of the ` +
        'title stays DEEP NAVY upright. This two-colour contrast is the signature of the design.',
      `- CRITICAL: ALL letters of "${accentWord}" are gold italic — the first letter and the last letter ` +
        'included. Never leave a leading capital navy, never change colour or style part-way through a ' +
        'word, never split one word across two colours. Every word is entirely one colour and one style.',
      '- Subtitle deck in small navy SANS or serif CAPITALS with generous letterspacing and line spacing.',
      '- Benefit-bar labels tiny, gold, letterspaced capitals, centred under their own icon, evenly spaced ' +
        'across the bar. Keep each label on a SINGLE line, with a clear normal word space between words — ' +
        'never run two words together, never let a label wrap or collide with its neighbour.',
      '- The title block occupies roughly the upper 40-45% of the cover.',
      '- CRITICAL: every letter of every word must be FULLY VISIBLE, correctly spelled, and contained well ' +
        'inside the cover with generous safe margins — never cropped, overlapping, or overflowing.',
      '- SPELLING IS THE HIGHEST PRIORITY. Copy every string above letter by letter exactly as written. Do ' +
        'not substitute, drop, double, or invent a single character — a misspelled word makes the cover ' +
        'unusable. Re-read each word against the list before finishing.',
      '- CRITICAL: text must sit on calm background, never over a busy part of the photograph.',
      '',
      'COLOR PALETTE:',
      '- Warm cream / off-white upper background',
      '- Deep navy for primary typography and the bottom bar',
      '- Warm gold / soft ochre for accents, rules, icons, and the italic title line',
      '- Naturally warm photographic tones in the lower half',
      '- Restrained and premium — no neon, no harsh saturation, no gradients behind text',
      '',
      'DESIGN FEATURES:',
      '- Thin gold rules and delicate line-art icons (outline style, never filled or 3D)',
      '- Soft, seamless blend between photograph and cream panel',
      '- Symmetrical, centred, generously margined editorial composition',
      '- Clear visual hierarchy with real breathing space',
      '- High-end editorial composition',
      '',
      'MOOD:',
      `Expertise, warmth, reassurance, authority, sophistication, aspiration. Match a ${input.tone} tone.`,
      '',
      'QUALITY REQUIREMENTS:',
      '- Bestseller-quality book cover',
      '- Professional publishing standard',
      '- Sharp, correctly spelled typography',
      '- Clean composition',
      '- No clutter',
      '- No stock-photo appearance',
      '- No generic Canva style',
      '- No amateur design elements',
      '',
      'OUTPUT:',
      'Front cover only.',
      'Portrait book format.',
      'Ultra-high detail.',
      'Commercial publishing quality.',
    ].join('\n');
  },

  /**
   * Vintage cookbook cover — for cooking books. Styled after early-1900s to
   * mid-century American recipe books (War-Time Cook Book, Book of Recipes,
   * Metropolitan Cook Book, etc.): aged paper/cloth binding, ornate decorative
   * typography, a framed central illustration, and a muted period palette. The
   * TITLE is rendered into the art and is the only text on the cover.
   *
   * The period look is fixed; the binding material, frame treatment, and palette
   * era rotate deterministically so two cookbooks from the same channel are not
   * the same artifact.
   */
  buildVintage(input: CoverImageInput): string {
    const subject = compact(input.subject, 700);
    const title = compact(input.title, 200);
    const era = pickVariant(VINTAGE_ERAS, input.variantKey);

    return [
      'Design the FRONT COVER of an antique vintage American cookbook, in the exact style of early-1900s to ' +
        'mid-century recipe books (1900s-1960s).',
      '',
      'OVERALL LOOK:',
      'An old, well-loved cookbook cover — aged, slightly worn and faded, as if photographed from a real ' +
        'antique book. It should look like a genuine period artifact, NOT a modern or digital design, and NOT ' +
        'glossy or photorealistic-modern.',
      `Specifically: ${era.look}`,
      '',
      'MATERIAL & TEXTURE:',
      `- ${era.material}`,
      '- Subtle stains, gentle wear at the edges and corners, a faint vintage patina',
      '- A soft letterpress / worn-ink printed feel, with slightly imperfect old printing',
      '',
      'COMPOSITION (classic cookbook cover):',
      `- ${era.frame}`,
      '- A single framed CENTRAL ILLUSTRATION in a vintage style: a hand-drawn or engraved image of a ' +
        'homemaker/cook, a laid table, produce, or a kitchen still-life — line-art or muted flat colour, ' +
        'in the manner of old recipe-book engravings and lithographs (NOT a modern photo)',
      '- Symmetrical, centred, calm layout with generous margins',
      `- The illustration must be specific to THIS book's subject: """${subject}""".`,
      '',
      'TYPOGRAPHY:',
      `- Render ONLY the book TITLE, spelled EXACTLY and correctly: "${title}"`,
      '- ABSOLUTELY NO other text of any kind: no subtitle, no tagline, no descriptive',
      '  line, no author, no price, no "used to make"-style phrase under the title.',
      '  The ONLY words anywhere on the cover are the title above — any extra text',
      '  ruins the cover.',
      `- ${era.lettering}`,
      '- Title placed prominently in the UPPER or CENTRE of the cover, fully legible, every letter contained ' +
        'well inside the frame with safe margins — never cropped',
      '- Leave the BOTTOM ~18% as calm negative space (no text) inside the frame',
      '',
      'COLOR PALETTE (muted, period-authentic):',
      ...era.palette,
      '- Soft, low-saturation, slightly yellowed by age — NEVER bright, neon, or modern',
      '',
      'MOOD:',
      'Nostalgic, homely, heritage, hand-made, trustworthy — a treasured family recipe book from decades past.',
      '',
      'AVOID:',
      '- Modern/minimalist/flat-vector or Canva-style design',
      '- Glossy studio food photography',
      '- Neon or high-saturation colours',
      '- Sans-serif corporate typography',
      '- ANY text other than the title — no subtitle, tagline, or second line under the',
      '  title (e.g. no "Grandma Used To Make"). Title only.',
      '',
      'OUTPUT:',
      'Front cover only. Portrait book format. Ultra-high detail. Looks like a real antique cookbook.',
    ].join('\n');
  },
};

/** Period variations for the vintage cookbook cover. */
interface VintageEra {
  name: string;
  look: string;
  material: string;
  frame: string;
  lettering: string;
  palette: string[];
}

const VINTAGE_ERAS: VintageEra[] = [
  {
    name: 'edwardian-1900s',
    look: 'an Edwardian-era household recipe book, roughly 1900-1915, printed in one or two ink colours only.',
    material: 'Aged cream or lightly foxed laid paper with visible fibre and a soft deckle feel',
    frame:
      'An ornate art-nouveau decorative BORDER with flowing corner flourishes and a fine double-rule keyline ' +
      'around the whole cover',
    lettering:
      'Use ornate art-nouveau hand-lettering with elongated forms and decorative swashes, the kind seen on ' +
      'turn-of-the-century recipe books',
    palette: [
      '- Faded cream and ecru base',
      '- Sepia brown and muted olive as the only inks',
      '- A single dusty barn-red accent',
    ],
  },
  {
    name: 'deco-1920s',
    look: 'a 1920s-30s art-deco kitchen manual with a cloth-bound spine and stamped cover.',
    material: 'A worn cloth or linen hardcover binding with a lightly stamped, slightly debossed surface',
    frame:
      'A geometric art-deco FRAME — stepped corners, symmetrical fan or sunburst motifs, and crisp straight ' +
      'keylines around the whole cover',
    lettering:
      'Use geometric art-deco display lettering with strong verticals and tight even spacing, stamped as if ' +
      'in faded gold or dark ink on cloth',
    palette: [
      '- Muted sage or dusty teal cloth ground',
      '- Faded gold or bronze stamping',
      '- Deep sepia brown for detail',
    ],
  },
  {
    name: 'wartime-1940s',
    look: 'a 1940s wartime economy cook book — plain, thrifty, printed on cheap stock with limited inks.',
    material: 'Thin, slightly yellowed pulp paper with visible age spots, soft creases, and worn corners',
    frame: 'A simple plain double-rule keyline border, honest and unornamented, with wide calm margins',
    lettering:
      'Use a sturdy condensed slab-serif or plain bold serif, printed with slightly uneven worn ink — ' +
      'practical rather than decorative',
    palette: [
      '- Yellowed newsprint cream base',
      '- Dusty barn red and ink black as the only colours',
      '- A trace of faded mustard ochre',
    ],
  },
  {
    name: 'midcentury-1950s',
    look: 'a cheerful 1950s American home cookbook with warm lithographed illustration.',
    material: 'Smooth aged coated board with a gentle patina and softly rounded, bumped corners',
    frame:
      'A friendly rounded-rectangle FRAME with a hand-drawn scalloped or ric-rac edge and small kitchen ' +
      'motifs at the corners',
    lettering:
      'Use warm mid-century hand-lettered script with a bouncing baseline, in the style of 1950s recipe ' +
      'book covers',
    palette: [
      '- Warm buttercream base',
      '- Muted cherry red and soft turquoise',
      '- Faded mustard ochre accents',
    ],
  },
  {
    name: 'homespun-1960s',
    look: 'a 1960s community or church recipe collection — homespun, printed simply, gently faded.',
    material: 'Textured pebbled cover stock or a soft matte board, faded unevenly by sun and handling',
    frame:
      'A hand-drawn folk-art BORDER of simple repeated motifs — leaves, wheat, or checkered edging — ' +
      'slightly irregular as if drawn by hand',
    lettering:
      'Use a warm rounded serif or gentle hand-drawn lettering with small imperfections, homely rather ' +
      'than professional',
    palette: [
      '- Faded ecru and oat base',
      '- Avocado and forest green with harvest gold',
      '- Warm sepia brown for line work',
    ],
  },
];

/** Articles and prepositions that would waste the cover's one gold accent. */
const WEAK_TITLE_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to',
  'with', 'your', 'you', 'my', 'our', 'how', 'what', 'why', 'that', 'this',
]);

/**
 * Choose the single title word to set in gold italic. Naming it explicitly is
 * what stops the model colouring half a word; leaving the choice to the model
 * reliably produced "D|etailing". Prefers the longest meaningful word, which is
 * usually the subject noun, and falls back to the longest word of any kind so a
 * title made entirely of small words still gets its accent.
 */
function pickAccentWord(title: string): string {
  const words = title.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  if (words.length === 0) return title;
  const strong = words.filter((w) => !WEAK_TITLE_WORDS.has(w.toLowerCase()));
  const pool = strong.length > 0 ? strong : words;
  return pool.reduce((best, w) => (w.length > best.length ? w : best));
}

/** Collapse whitespace and clamp to a budget. */
function compact(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Deterministic variant choice — FNV-1a over the key, so the same project always
 * gets the same art direction (retries reproduce the cover) while different
 * projects spread evenly across the variants.
 */
function pickVariant<T>(variants: T[], key: string): T {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return variants[hash % variants.length]!;
}

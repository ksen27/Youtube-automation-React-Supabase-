/**
 * Splitting a book's extracted text into retrievable sections.
 *
 * WHY THIS IS HEURISTIC AND WHY THAT IS FINE: chapter research ranks sections by
 * keyword overlap and takes the best few. A section boundary in the wrong place
 * costs a little relevance; it does not corrupt anything. So this aims to be
 * ROBUST rather than clever — it never fails, and its fallback (fixed-size
 * chunks on paragraph boundaries) is perfectly usable material.
 *
 * The one thing it must not do is return a single enormous section. That would
 * make retrieval meaningless: every query would return the whole book.
 */

export interface ExtractedSection {
  title: string | null;
  content: string;
}

/** Chunk size for the fallback. Roughly a chapter — big enough to carry an idea. */
const TARGET_CHUNK_WORDS = 1200;
/** Below this a "chapter" is a heading with nothing under it; fold it forward. */
const MIN_SECTION_WORDS = 120;
/** Headings are short by nature; a long line is prose that happens to be alone. */
const MAX_HEADING_CHARS = 80;
/** Fewer than this and the "headings" are probably a stray front-matter page. */
const MIN_HEADINGS = 3;

const NUMBERED_HEADING =
  /^\s*(chapter|part|section|lesson|step|recipe|day)\s+(\d{1,3}|[ivxlcdm]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;

/**
 * PDF text extraction breaks words across line ends and leaves page furniture
 * behind. Neither is fatal for retrieval, but both corrupt word counts and make
 * headings hard to spot.
 */
export function normalizeExtractedText(raw: string): string {
  return (
    raw
      // Windows and old-Mac line endings, and the form feeds PDF pages carry.
      .replace(/\r\n?/g, '\n')
      .replace(/\f/g, '\n\n')
      // "atten-\ntion" is one word split across a line break by justification.
      .replace(/(\w)-\n(\w)/g, '$1$2')
      // A page number alone on a line is furniture, not content.
      .replace(/^\s*\d{1,4}\s*$/gm, '')
      // Collapse runs of blank lines to exactly one paragraph break.
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

/** Whether a line looks like a chapter heading rather than a line of prose. */
function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HEADING_CHARS) return false;
  if (NUMBERED_HEADING.test(trimmed)) return true;
  // A heading does not end in sentence punctuation and is not a fragment of one.
  if (/[.,;:]$/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 12) return false;
  // ALL CAPS, or Title Case With Most Words Capitalised.
  const letters = trimmed.replace(/[^a-z]/gi, '');
  if (letters.length === 0) return false;
  if (letters === letters.toUpperCase()) return true;
  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
  return words.length >= 2 && capitalised / words.length >= 0.7;
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Split on detected headings. Returns null when the text does not look like it
 * has chapters — the caller then falls back to fixed-size chunking.
 */
function splitOnHeadings(text: string): ExtractedSection[] | null {
  const lines = text.split('\n');
  const marks: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // A heading stands alone: preceded by a blank line (or the start of the
    // book). Without this, every short capitalised sentence inside a paragraph
    // becomes a chapter break.
    const standsAlone = i === 0 || lines[i - 1]!.trim() === '';
    if (standsAlone && isHeading(lines[i]!)) marks.push(i);
  }
  if (marks.length < MIN_HEADINGS) return null;

  const sections: ExtractedSection[] = [];
  for (let m = 0; m < marks.length; m++) {
    const start = marks[m]!;
    const end = m + 1 < marks.length ? marks[m + 1]! : lines.length;
    const title = lines[start]!.trim();
    const content = lines.slice(start + 1, end).join('\n').trim();
    if (wordCount(content) < MIN_SECTION_WORDS) {
      // A heading with almost nothing under it — a part divider, or a
      // table-of-contents entry that matched. Fold it into the previous section
      // rather than emitting a section that retrieval can only waste a slot on.
      const previous = sections[sections.length - 1];
      if (previous) previous.content = `${previous.content}\n\n${title}\n${content}`.trim();
      continue;
    }
    sections.push({ title, content });
  }
  // Everything before the first heading is front matter — a title page, a
  // dedication, a contents list. Dropped deliberately: it teaches nothing about
  // how the author writes.
  return sections.length >= MIN_HEADINGS ? sections : null;
}

/** Fixed-size chunks on paragraph boundaries, for a book with no visible chapters. */
function chunkByWords(text: string): ExtractedSection[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const sections: ExtractedSection[] = [];
  let buffer: string[] = [];
  let words = 0;
  for (const paragraph of paragraphs) {
    buffer.push(paragraph.trim());
    words += wordCount(paragraph);
    if (words >= TARGET_CHUNK_WORDS) {
      sections.push({ title: null, content: buffer.join('\n\n') });
      buffer = [];
      words = 0;
    }
  }
  // The tail joins the previous chunk rather than becoming a stub of its own.
  if (buffer.length > 0) {
    const tail = buffer.join('\n\n');
    const previous = sections[sections.length - 1];
    if (previous && wordCount(tail) < MIN_SECTION_WORDS) previous.content += `\n\n${tail}`;
    else sections.push({ title: null, content: tail });
  }
  return sections;
}

/**
 * Turn a book's raw extracted text into sections.
 *
 * Never throws and never returns an empty array for non-empty input: the worst
 * case is one section, which the caller's minimum-length check will catch as an
 * unusable reference.
 */
export function splitIntoSections(raw: string): ExtractedSection[] {
  const text = normalizeExtractedText(raw);
  if (text.length === 0) return [];
  return splitOnHeadings(text) ?? chunkByWords(text);
}

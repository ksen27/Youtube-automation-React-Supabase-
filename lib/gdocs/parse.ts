import type {
  GoogleDocsDocument,
  GoogleDocsParagraph,
  GoogleDocsTextRun,
} from "./fetch";

// Parse a Google Doc into the editorial structure the rest of the pipeline
// expects. The doc carries three special bits of formatting:
//
//   • The first blue-bold line at the top is the "intro" — a YouTube clip
//     to play before the voiceover starts. It is paired with the next
//     paragraph, which carries the timestamp range (e.g. "0.00-0.08") and
//     usually a hyperlink to the source video.
//
//   • Subsequent blue-bold lines are title cards. They follow the same
//     "blue title + timestamped range below" pattern. After the card shows,
//     the renderer cuts and plays exactly that YouTube window.
//
//   • Red text runs INSIDE regular paragraphs are lower-thirds — drawn as
//     a drawtext overlay while the narrator says those words.
//
// Everything else flows into the plain transcript text.
//
// Why this lives apart from the fetcher: parsing is pure (input = parsed
// JSON, output = ParsedScript) so it's trivially unit-testable without a
// network call or API key.

export type ScriptMarkerKind =
  | "intro_card"
  // First clip after a blue-bold title in the doc. Carries the title text
  // (rendered as the on-screen card) plus its own YouTube URL + window.
  | "title_card"
  // Additional bare-timestamp lines stacked under the same title. Each one
  // becomes a forced-footage clip played BACK-TO-BACK after the title card
  // and the first clip — no separate title card is shown for these. The
  // matcher pairs them with the preceding title_card marker by ordinal
  // adjacency: title_card_clip rows always immediately follow their
  // title_card row in the ordinal stream.
  | "title_card_clip"
  | "lower_third";

export interface ScriptMarker {
  kind: ScriptMarkerKind;
  text: string;
  // Title-card and intro markers carry a forced YouTube window. Lower-third
  // markers leave these undefined.
  youtubeUrl?: string;
  startSeconds?: number;
  endSeconds?: number;
  // Paragraph index in the parsed body (0-based, intro paragraph EXCLUDED).
  // Lower-third markers also carry their char offset within the paragraph.
  paragraphIndex?: number;
  charOffset?: number;
  // Ordinal of this marker among markers of its kind. Used to disambiguate
  // when the same phrase appears multiple times — we align the Nth doc
  // occurrence to the Nth spoken occurrence.
  ordinal: number;
}

export interface ParsedScript {
  // Concatenated plain text of every non-intro paragraph. This is what gets
  // saved to projects.transcript so the existing Gemini/search pipeline
  // works unchanged.
  transcript: string;
  // Intro pre-roll. Plays back-to-back BEFORE the voiceover begins. Each
  // entry corresponds to a blue-bold timestamp block at the top of the doc.
  // No title text is rendered on screen for intros — only the clip + its
  // original audio. Multiple intros = multiple clips concatenated as the
  // pre-roll, in doc order.
  introCards: ScriptMarker[];
  titleCards: ScriptMarker[];
  lowerThirds: ScriptMarker[];
}

// Blue = web-link blue or any blue-ish foreground color. Docs API exposes
// foregroundColor.rgbColor with r/g/b in [0, 1]. We treat "blue" loosely:
// the blue channel must dominate and red must be low, so the standard
// hyperlink color (#1155cc ≈ 0.067, 0.333, 0.8) and slight variants all
// match. Black/white default text returns no foregroundColor at all.
function isBlueish(run: GoogleDocsTextRun): boolean {
  const c = run.textStyle?.foregroundColor?.color?.rgbColor;
  if (!c) return false;
  const r = c.red ?? 0;
  const g = c.green ?? 0;
  const b = c.blue ?? 0;
  return b > 0.5 && b > r + 0.1 && b > g + 0.05;
}

// Red = red channel dominates clearly. Docs' default "red" is #cc0000
// (0.8, 0, 0). We accept any color whose red is high and other channels low.
function isReddish(run: GoogleDocsTextRun): boolean {
  const c = run.textStyle?.foregroundColor?.color?.rgbColor;
  if (!c) return false;
  const r = c.red ?? 0;
  const g = c.green ?? 0;
  const b = c.blue ?? 0;
  return r > 0.5 && r > g + 0.3 && r > b + 0.3;
}

function isBold(run: GoogleDocsTextRun): boolean {
  return run.textStyle?.bold === true;
}

interface ParsedParagraph {
  text: string;            // concatenated plain text
  runs: Array<{
    text: string;
    bold: boolean;
    blue: boolean;
    red: boolean;
    linkUrl: string | null;
  }>;
}

function paragraphToText(p: GoogleDocsParagraph): ParsedParagraph {
  const runs: ParsedParagraph["runs"] = [];
  let text = "";
  for (const el of p.elements ?? []) {
    const run = el.textRun;
    if (!run?.content) continue;
    const segment = run.content;
    runs.push({
      text: segment,
      bold: isBold(run),
      blue: isBlueish(run),
      red: isReddish(run),
      linkUrl: run.textStyle?.link?.url ?? null,
    });
    text += segment;
  }
  return { text, runs };
}

// Accepts:
//   "0.00-0.08"   → 0..8           (mm.ss-mm.ss, dot as separator)
//   "0:32-0:45"   → 32..45         (mm:ss-mm:ss)
//   "1:23 - 1:30" → 83..90         (whitespace tolerant)
//   "12-18"       → 12..18         (plain seconds-seconds)
// Returns null when the string doesn't look like a timestamp range at all.
export function parseTimestampRange(raw: string): { start: number; end: number } | null {
  const s = raw.trim();
  if (!s) return null;
  // Split on the first hyphen or en-dash that isn't followed by a digit prefix
  // (so "12-18" splits but "12.5-1.0" still works — both sides are valid).
  const m = s.match(/^([\d:.]+)\s*[–—-]\s*([\d:.]+)$/);
  if (!m) return null;
  const a = parseOneTimestamp(m[1]);
  const b = parseOneTimestamp(m[2]);
  if (a == null || b == null) return null;
  if (b <= a) return null;
  return { start: a, end: b };
}

function parseOneTimestamp(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  // mm:ss or mm:ss.ms
  const colon = s.match(/^(\d+):([0-5]?\d)(?:\.(\d+))?$/);
  if (colon) {
    const min = Number(colon[1]);
    const sec = Number(colon[2]);
    const ms = colon[3] ? Number(`0.${colon[3]}`) : 0;
    return min * 60 + sec + ms;
  }
  // mm.ss — the dot-format used in the user's docs. This is ambiguous with
  // "X point Y seconds" but the convention in the input we're targeting is
  // unambiguous: dot separates minutes and seconds, never sub-second.
  const dot = s.match(/^(\d+)\.([0-5]?\d)$/);
  if (dot) {
    const min = Number(dot[1]);
    const sec = Number(dot[2]);
    return min * 60 + sec;
  }
  // Plain seconds.
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return null;
}

// Extract a youtube URL from anywhere within a string. Falls back to null.
export function extractYoutubeUrl(s: string): string | null {
  const m = s.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[\w-]+(?:\?[^\s]*)?)/);
  return m ? m[0] : null;
}

// Combine "linkUrl from any run" with "regex-find inside paragraph text".
// Some docs hyperlink the title, some put the bare URL in the timestamp
// paragraph, some do both. We try both sources and prefer the explicit link.
function findParagraphYoutubeUrl(p: ParsedParagraph): string | null {
  for (const r of p.runs) {
    if (r.linkUrl && /youtu/.test(r.linkUrl)) return r.linkUrl;
  }
  return extractYoutubeUrl(p.text);
}

// Heuristic: a paragraph is a "title block" when it contains at least one
// run that is BOTH bold AND blue. Docs sometimes splits a single line into
// multiple runs (e.g. the trailing newline ends up in a non-bold run), so
// we check at the run level, not the whole paragraph.
function isTitleParagraph(p: ParsedParagraph): boolean {
  return p.runs.some((r) => r.bold && r.blue && r.text.trim().length > 0);
}

// Pull the title text out of a title paragraph: concatenate the blue-bold
// runs and strip surrounding whitespace.
function titleParagraphText(p: ParsedParagraph): string {
  const parts = p.runs
    .filter((r) => r.bold && r.blue)
    .map((r) => r.text);
  return parts.join("").replace(/\s+/g, " ").trim();
}

// A paragraph is a "bare timestamp line" when its trimmed text is
// *exclusively* a parseable timestamp range (optionally surrounded by
// whitespace or a hyperlink URL). The two-intros-stacked screenshot from
// the user has lines like "0.00-0.08" carrying a hyperlink — these are
// intro clips with no title text. We pull the YouTube URL from the
// run-level hyperlink since the visible text is just the timestamp.
function bareTimestampInfo(p: ParsedParagraph): { range: { start: number; end: number }; url: string } | null {
  const trimmed = p.text.trim();
  if (!trimmed) return null;
  const range = parseTimestampRange(trimmed);
  if (!range) return null;
  const url = findParagraphYoutubeUrl(p);
  if (!url) return null;
  return { range, url };
}

export function parseScriptDoc(doc: GoogleDocsDocument): ParsedScript {
  const rawParagraphs: ParsedParagraph[] = [];
  for (const el of doc.body?.content ?? []) {
    if (!el.paragraph) continue;
    const parsed = paragraphToText(el.paragraph);
    rawParagraphs.push(parsed);
  }

  // Step 1: walk the top of the doc collecting intro clips. Every blue-bold
  // block we recognize as an intro is consumed. The walk stops at the first
  // paragraph that's neither a bare timestamp line nor a (title + timestamp)
  // pair, AND has non-empty prose text — that paragraph is the first line of
  // the narrator's script. Empty paragraphs at the top are skipped.
  //
  // We support two doc patterns:
  //   • Pattern A — bare timestamp line. The paragraph's text is just the
  //     range (e.g. "0.00-0.08") and the hyperlink on that line carries the
  //     YouTube URL. One intro clip per such line.
  //   • Pattern B — title + timestamp pair. A blue-bold title paragraph
  //     followed (after any blank lines) by a bare timestamp line. The
  //     title text is captured for reference but NEVER rendered — intros
  //     are silent visual cuts. One intro clip per pair.
  //
  // Either pattern can repeat; the screenshot the user shared stacks two
  // Pattern-A lines (two bare timestamps back-to-back) before any prose.
  const introCards: ScriptMarker[] = [];
  // Indices of paragraphs consumed by the intro walk, so they're excluded
  // from the transcript pass below.
  const consumedAsIntro = new Set<number>();
  let introOrdinal = 0;
  {
    let i = 0;
    while (i < rawParagraphs.length) {
      const p = rawParagraphs[i];
      if (p.text.trim() === "") {
        consumedAsIntro.add(i);
        i++;
        continue;
      }
      // Pattern A: bare timestamp line.
      const bare = bareTimestampInfo(p);
      if (bare) {
        introCards.push({
          kind: "intro_card",
          text: "",
          youtubeUrl: bare.url,
          startSeconds: bare.range.start,
          endSeconds: bare.range.end,
          ordinal: introOrdinal++,
        });
        consumedAsIntro.add(i);
        i++;
        continue;
      }
      // Pattern B: blue-bold title followed by a bare timestamp line.
      if (isTitleParagraph(p)) {
        let j = i + 1;
        while (j < rawParagraphs.length && rawParagraphs[j].text.trim() === "") j++;
        if (j < rawParagraphs.length) {
          const nextBare = bareTimestampInfo(rawParagraphs[j]);
          if (nextBare) {
            introCards.push({
              kind: "intro_card",
              text: titleParagraphText(p),
              youtubeUrl: nextBare.url,
              startSeconds: nextBare.range.start,
              endSeconds: nextBare.range.end,
              ordinal: introOrdinal++,
            });
            consumedAsIntro.add(i);
            for (let k = i + 1; k <= j; k++) consumedAsIntro.add(k);
            i = j + 1;
            continue;
          }
        }
      }
      // First non-intro, non-blank paragraph — prose begins here. Stop.
      break;
    }
  }

  // Step 2: walk the remaining paragraphs. Title paragraphs (with a
  // following timestamp + URL) become title-card markers. Red runs inside
  // any paragraph become lower-third markers. Everything else flows into
  // the plain transcript.
  const titleCards: ScriptMarker[] = [];
  const lowerThirds: ScriptMarker[] = [];
  let titleOrdinal = 0;
  let lowerOrdinal = 0;
  // Per-text-key occurrence counter so multiple instances of the same
  // phrase get distinct ordinals. Lower-thirds with identical text in the
  // doc map 1:1 to the Nth spoken occurrence in the audio.
  const lowerKeyCounts = new Map<string, number>();

  // We track our own "transcript paragraph index" so it excludes the intro
  // pair and any title paragraphs we consume — the matchProcessor uses this
  // index to scope its alignment search.
  const transcriptParagraphTexts: string[] = [];
  // Count of CONTENT (non-blank) paragraphs pushed so far. Used as the
  // marker's `paragraphIndex` so a marker's index lines up 1:1 with the
  // saved transcript's content-paragraph index (transcript.split(/\n\n+/)).
  // The raw transcriptParagraphTexts.length counts blank-separator rows too,
  // so it drifts away from the saved transcript by the number of blanks
  // before each marker — the matcher relies on these two staying in sync.
  let contentParagraphCount = 0;

  let i = 0;
  while (i < rawParagraphs.length) {
    if (consumedAsIntro.has(i)) {
      i++;
      continue;
    }
    const p = rawParagraphs[i];

    // Title card detection: blue-bold paragraph followed (after blanks) by
    // ONE OR MORE consecutive bare-timestamp lines. The first timestamp
    // pairs with the title text to form a title_card marker; any additional
    // stacked timestamps under the same title become title_card_clip
    // markers that play back-to-back after the first clip with no extra
    // card flash. URL for each clip comes from the hyperlink on its own
    // timestamp line (fallback: regex-find inside that line's text;
    // fallback: the title paragraph's hyperlink).
    if (isTitleParagraph(p)) {
      let j = i + 1;
      while (j < rawParagraphs.length && rawParagraphs[j].text.trim() === "") j++;
      if (j < rawParagraphs.length) {
        const firstBare = bareTimestampInfo(rawParagraphs[j]);
        // Allow the title to fall back to its own paragraph for URL only if
        // the first timestamp line itself has no link/URL — most docs put
        // the link on the timestamp, but the older single-line "title + url"
        // pattern is still supported.
        const firstUrl = firstBare?.url
          ?? (parseTimestampRange(rawParagraphs[j].text.trim())
              ? findParagraphYoutubeUrl(rawParagraphs[j]) ?? findParagraphYoutubeUrl(p)
              : null);
        const firstRange = firstBare?.range ?? parseTimestampRange(rawParagraphs[j].text);
        if (firstRange && firstUrl) {
          titleCards.push({
            kind: "title_card",
            text: titleParagraphText(p),
            youtubeUrl: firstUrl,
            startSeconds: firstRange.start,
            endSeconds: firstRange.end,
            // Index of the FIRST content paragraph that will follow this
            // title in the saved transcript. The title belongs between
            // saved-transcript paragraphs [contentParagraphCount - 1] and
            // [contentParagraphCount] (the latter being the one whose
            // narration the title introduces).
            paragraphIndex: contentParagraphCount,
            ordinal: titleOrdinal++,
          });
          // Consume the title paragraph + the first timestamp paragraph.
          let k = j + 1;
          // Walk forward collecting any ADDITIONAL bare-timestamp lines
          // immediately stacked under the first one. Blank paragraphs are
          // allowed between stacked timestamps but anything else (prose,
          // another title block) ends the run.
          while (k < rawParagraphs.length) {
            const candidate = rawParagraphs[k];
            if (candidate.text.trim() === "") { k++; continue; }
            const extra = bareTimestampInfo(candidate);
            if (!extra) break;
            titleCards.push({
              kind: "title_card_clip",
              text: "",
              youtubeUrl: extra.url,
              startSeconds: extra.range.start,
              endSeconds: extra.range.end,
              paragraphIndex: contentParagraphCount,
              ordinal: titleOrdinal++,
            });
            k++;
          }
          i = k;
          continue;
        }
      }
      // Title-looking paragraph without a following timestamp+URL — treat
      // as regular prose so we don't lose its text. Falls through to the
      // generic paragraph branch below.
    }

    // Regular paragraph. Pull any red runs out as lower-third markers
    // before persisting the plain text. Use the content-paragraph counter
    // (skips blank-line paragraphs) so the marker's paragraphIndex maps
    // 1:1 to transcript.split(/\n\n+/) at match time.
    const isBlank = p.text.trim().length === 0;
    const pIndex = contentParagraphCount;
    let charOffset = 0;
    for (const r of p.runs) {
      if (r.red && r.text.trim().length > 0) {
        const text = r.text.replace(/\s+/g, " ").trim();
        if (text) {
          const key = text.toLowerCase();
          const seenSoFar = lowerKeyCounts.get(key) ?? 0;
          lowerKeyCounts.set(key, seenSoFar + 1);
          lowerThirds.push({
            kind: "lower_third",
            text,
            paragraphIndex: pIndex,
            charOffset,
            ordinal: lowerOrdinal++,
          });
        }
      }
      charOffset += r.text.length;
    }
    transcriptParagraphTexts.push(p.text);
    if (!isBlank) contentParagraphCount++;
    i++;
  }

  // Join paragraphs with a single newline. The Docs API already includes a
  // trailing "\n" inside each paragraph's text via its last run, so we
  // don't add extra separators.
  const transcript = transcriptParagraphTexts.join("").replace(/\n{3,}/g, "\n\n").trim();

  return { transcript, introCards, titleCards, lowerThirds };
}

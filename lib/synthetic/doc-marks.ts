import {
  fetchGoogleDoc,
  extractDocumentId,
  type GoogleDocsTextRun,
  type GoogleDocsDocument,
} from "@/lib/gdocs/fetch";

// AI-Avatar (synthetic) Google-Doc extractor.
//
// SEPARATE from lib/gdocs/parse.ts (the celebrity parser), which stays
// untouched. The AI-Avatar doc is just plain narration text; the ONLY special
// formatting is RED or ORANGE highlighted spans, which mark the parts that
// should become AVATAR (talking-head) segments. Everything else flows into the
// plain transcript and the planner/Gemini decides its block type.
//
// Output:
//   transcript   — the doc's plain text (what the rest of the pipeline aligns)
//   avatarRanges — [start, end) character offsets INTO `transcript` that were
//                  red/orange. The planner forces any segment overlapping one
//                  of these ranges to block_type = 'avatar'.

export interface AvatarMarkRange {
  start: number; // inclusive char offset into transcript
  end: number;   // exclusive
}

export interface ExtractedDoc {
  title: string | null;
  transcript: string;
  avatarRanges: AvatarMarkRange[];
}

// Red = red channel dominates (Docs default red #cc0000 ≈ 0.8,0,0). Mirrors
// isReddish() in the celebrity parser so detection is consistent.
function isRed(c: { red?: number; green?: number; blue?: number }): boolean {
  const r = c.red ?? 0, g = c.green ?? 0, b = c.blue ?? 0;
  return r > 0.5 && r > g + 0.3 && r > b + 0.3;
}

// Orange = high red, MODERATE green, low blue (Docs "orange" ≈ #ff9900 →
// 1.0, 0.6, 0.0; "dark orange 1" ≈ #e69138 → 0.9, 0.57, 0.22). We accept a
// band where red is high, green is mid (clearly above blue), and blue is low —
// which separates orange from both pure red (green≈0) and yellow (green≈red).
function isOrange(c: { red?: number; green?: number; blue?: number }): boolean {
  const r = c.red ?? 0, g = c.green ?? 0, b = c.blue ?? 0;
  return r > 0.6 && g >= 0.25 && g <= 0.75 && r > g + 0.15 && g > b + 0.15;
}

// A run is an avatar mark if its foreground color is red OR orange.
function isAvatarMarked(run: GoogleDocsTextRun): boolean {
  const c = run.textStyle?.foregroundColor?.color?.rgbColor;
  if (!c) return false;
  return isRed(c) || isOrange(c);
}

/** Walk a fetched doc into transcript + avatar char-ranges. Pure (testable). */
export function extractAvatarDoc(doc: GoogleDocsDocument): ExtractedDoc {
  let transcript = "";
  const ranges: AvatarMarkRange[] = [];

  for (const el of doc.body?.content ?? []) {
    const para = el.paragraph;
    if (!para) continue;
    for (const pe of para.elements ?? []) {
      const run = pe.textRun;
      const content = run?.content;
      if (!content) continue;
      const start = transcript.length;
      transcript += content;
      const end = transcript.length;
      if (run && isAvatarMarked(run)) {
        ranges.push({ start, end });
      }
    }
  }

  // Merge adjacent/overlapping ranges so a multi-run highlighted sentence
  // becomes one span (Docs splits a styled sentence into several runs).
  ranges.sort((a, b) => a.start - b.start);
  const merged: AvatarMarkRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  return {
    title: doc.title ?? null,
    transcript: transcript.replace(/\s+\n/g, "\n").trim(),
    avatarRanges: merged,
  };
}

/** Fetch + extract by Google Doc URL or id. Throws on bad url / fetch error. */
export async function fetchAndExtractAvatarDoc(docUrlOrId: string): Promise<ExtractedDoc> {
  const documentId = extractDocumentId(docUrlOrId);
  if (!documentId) throw new Error("Could not extract a Google Doc ID from the input.");
  const doc = await fetchGoogleDoc(documentId);
  const out = extractAvatarDoc(doc);
  if (!out.transcript) throw new Error("The doc parsed but contained no text.");
  return out;
}

// Does a segment's [segStart, segEnd) char window overlap any avatar range?
// The planner uses this to force block_type = 'avatar'. We trim because the
// doc transcript and the (possibly re-segmented) script text are aligned by
// the same plain text, so offsets line up.
export function segmentIsAvatarMarked(
  segStart: number,
  segEnd: number,
  ranges: AvatarMarkRange[],
): boolean {
  for (const r of ranges) {
    if (segStart < r.end && r.start < segEnd) return true;
  }
  return false;
}

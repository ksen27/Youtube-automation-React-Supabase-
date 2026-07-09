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
// The highlight COLOR additionally picks the HeyGen model:
//   red    -> Avatar IV  ("avatar_iv") — the photo-to-video composer
//   orange -> Avatar III ("avatar_iii") — the cheaper Avatar-Shots flow
//
// Output:
//   transcript   — the doc's plain text (what the rest of the pipeline aligns)
//   avatarRanges — [start, end) character offsets INTO `transcript` that were
//                  red/orange, each tagged with its model. The planner forces
//                  any segment overlapping one of these ranges to
//                  block_type = 'avatar' and copies the model onto it.

export type AvatarModel = "avatar_iv" | "avatar_iii";

export interface AvatarMarkRange {
  start: number; // inclusive char offset into transcript
  end: number;   // exclusive
  model: AvatarModel; // red -> avatar_iv, orange -> avatar_iii
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

// Classify a run's foreground color into an avatar model, or null if it is not
// an avatar highlight. BOTH red and orange now map to Avatar III (client
// 2026-07-09): the client wants every avatar part rendered with the cheaper
// Avatar-Shots (Avatar III) flow, so the highlight color only marks a run as an
// avatar part — it no longer selects the model. (split_2 blocks are still forced
// to Avatar IV downstream in the avatar processor, since Avatar III can't render
// the split-screen half-cell.) We keep testing orange FIRST purely for clarity;
// both branches return the same model.
function avatarModelForRun(run: GoogleDocsTextRun): AvatarModel | null {
  const c = run.textStyle?.foregroundColor?.color?.rgbColor;
  if (!c) return null;
  if (isOrange(c)) return "avatar_iii";
  if (isRed(c)) return "avatar_iii";
  return null;
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
      const model = run ? avatarModelForRun(run) : null;
      if (model) {
        ranges.push({ start, end, model });
      }
    }
  }

  // Merge adjacent/overlapping ranges so a multi-run highlighted sentence
  // becomes one span (Docs splits a styled sentence into several runs). Only
  // merge runs of the SAME model — a red span abutting an orange span must stay
  // two separate ranges so each drives its own HeyGen model.
  ranges.sort((a, b) => a.start - b.start);
  const merged: AvatarMarkRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.model === last.model && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  // CRITICAL: do NOT mutate `transcript` after this point. The ranges above are
  // character offsets INTO this exact string; trimming/replacing would shift
  // every offset and scramble which sentences are marked as avatar. We trim
  // only the LEADING whitespace and shift the ranges by the same amount to keep
  // them aligned; trailing whitespace is harmless to leave (no range follows
  // it). This was the bug that made avatar marks land on the wrong segments.
  const leadingWs = transcript.length - transcript.replace(/^\s+/, "").length;
  const trimmedStart = transcript.replace(/^\s+/, "").replace(/\s+$/, "");
  const adjusted = merged
    .map((r) => ({ start: r.start - leadingWs, end: r.end - leadingWs, model: r.model }))
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(trimmedStart.length, r.end), model: r.model }))
    .filter((r) => r.end > r.start);

  return {
    title: doc.title ?? null,
    transcript: trimmedStart,
    avatarRanges: adjusted,
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

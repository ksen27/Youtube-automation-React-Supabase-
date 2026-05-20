// Post-process timeline items with script-doc markers.
//
// After the regular matcher has built its ordered items list, this module:
//   1. Reads project_script_markers (title_card and lower_third) and
//      Deepgram's per-word timings (projects.transcript_words).
//   2. Aligns each marker's text to the spoken word stream to get a
//      timestamp `t` in the voiceover.
//   3. Inserts a title_card timeline item at `t` followed by a "forced
//      footage" item (clip_id null, metadata.forced_clip set) that the
//      renderer downloads from the marker's YouTube window on-the-fly.
//   4. Stamps metadata.lower_third on whichever existing item is playing
//      at the lower-third marker's spoken moment.
//
// Why we mutate the items array in-memory rather than running this as a
// separate post-insert pass: the matcher already does its own complex
// position/duration arithmetic on `items`. Re-numbering positions there is
// trivial; doing it after a database round-trip would mean re-fetching,
// re-sorting, and re-writing the whole timeline. Same effect, more risk.

import type { WordTiming } from "@/lib/ai/deepgram";

export interface TimelineItemDraft {
  project_id: string;
  clip_id: string | null;
  type: string;
  position: number;
  duration: number;
  start_time?: number | null;
  script_text: string | null;
  overlay_text: string | null;
  metadata: Record<string, unknown>;
  approved: boolean;
}

export interface ScriptMarkerRow {
  id: string;
  // intro_card rows are filtered out by the caller before being passed to
  // applyScriptMarkers — intros are pre-roll, never aligned to the
  // narrator's spoken audio. The matchProcessor's loader drops them so
  // this type only ever sees the in-script kinds.
  kind: "title_card" | "lower_third";
  text: string;
  ordinal: number;
  paragraph_index: number | null;
  char_offset: number | null;
  youtube_url: string | null;
  start_seconds: number | null;
  end_seconds: number | null;
}

// Default duration for a freshly-inserted title_card row when the marker
// itself doesn't pin the on-screen time (only the FOLLOWING clip carries
// the YouTube window's start/end). 3s is enough to read a short heading
// without making the card overstay its welcome.
const TITLE_CARD_DEFAULT_DURATION = 3;

// Token-strip: lowercased word with surrounding punctuation removed. Both
// sides (Deepgram words and marker phrases) go through this so "Walliams,"
// matches "walliams" and "Don't" matches "don't".
function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")
    .replace(/['']/g, "'");
}

function tokenize(s: string): string[] {
  return s
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
}

// Locate the first Deepgram-word index where the marker phrase begins,
// starting the search at `fromIndex`. We do exact contiguous matching on
// normalized tokens — punctuation differences are absorbed by normalizeToken,
// and small ASR slips (homophones, contractions split differently) fail
// gracefully by returning -1 so the caller can skip the marker rather than
// snapping it to the wrong moment.
function findPhraseIndex(
  words: WordTiming[],
  phraseTokens: string[],
  fromIndex: number,
): number {
  if (phraseTokens.length === 0) return -1;
  const limit = words.length - phraseTokens.length;
  for (let i = fromIndex; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < phraseTokens.length; j++) {
      const w = normalizeToken(words[i + j].word);
      if (w !== phraseTokens[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

// Given the ordered items list, compute the cumulative start_time of each
// (so a marker timestamp can be mapped to the item whose window contains it).
function computeStarts(items: TimelineItemDraft[]): number[] {
  const out: number[] = new Array(items.length);
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    out[i] = acc;
    acc += items[i].duration;
  }
  return out;
}

// Find the item index whose [start, start+duration) window contains time t.
// Returns -1 if t is past the end of the timeline.
function findItemIndexAtTime(starts: number[], items: TimelineItemDraft[], t: number): number {
  if (items.length === 0) return -1;
  if (t < starts[0]) return 0;
  for (let i = 0; i < items.length; i++) {
    const end = starts[i] + items[i].duration;
    if (t < end) return i;
  }
  return -1;
}

export interface ApplyMarkersResult {
  titleCardsInserted: number;
  titleCardsSkipped: number;
  lowerThirdsApplied: number;
  lowerThirdsSkipped: number;
}

export function applyScriptMarkers(
  items: TimelineItemDraft[],
  markers: ScriptMarkerRow[],
  words: WordTiming[] | null | undefined,
  projectId: string,
): ApplyMarkersResult {
  const result: ApplyMarkersResult = {
    titleCardsInserted: 0,
    titleCardsSkipped: 0,
    lowerThirdsApplied: 0,
    lowerThirdsSkipped: 0,
  };
  if (!words || words.length === 0 || markers.length === 0) return result;

  // Resolve each marker's spoken-time `t` once. Multiple markers may share
  // the same phrase (e.g. a person's name appearing many times) — we walk
  // forward, only matching each phrase the Nth time per (phrase, ordinal)
  // so duplicate phrases align to distinct spoken instances.
  const phraseSearchCursor = new Map<string, number>();
  const resolved: Array<{ marker: ScriptMarkerRow; t: number | null }> = [];
  // Sort by ordinal so the cursor walk respects doc order across kinds.
  const ordered = [...markers].sort((a, b) => a.ordinal - b.ordinal);
  for (const m of ordered) {
    const tokens = tokenize(m.text);
    if (tokens.length === 0) {
      resolved.push({ marker: m, t: null });
      continue;
    }
    const key = tokens.join(" ");
    const from = phraseSearchCursor.get(key) ?? 0;
    const idx = findPhraseIndex(words, tokens, from);
    if (idx < 0) {
      resolved.push({ marker: m, t: null });
      continue;
    }
    phraseSearchCursor.set(key, idx + tokens.length);
    resolved.push({ marker: m, t: words[idx].start });
  }

  // Apply lower-thirds first because they only mutate existing items'
  // metadata — order independent. Title-card insertions shift positions
  // and must happen second, after we've taken metadata reads.
  const starts = computeStarts(items);
  for (const { marker, t } of resolved) {
    if (marker.kind !== "lower_third") continue;
    if (t == null) { result.lowerThirdsSkipped++; continue; }
    const k = findItemIndexAtTime(starts, items, t);
    if (k < 0) { result.lowerThirdsSkipped++; continue; }
    const meta = (items[k].metadata ?? {}) as Record<string, unknown>;
    // Don't overwrite an existing lower_third stamped by the entity-name
    // pipeline — that one was driven by Gemini's entity context and is
    // probably already correct. Doc markers fill in the gaps.
    if (meta.lower_third && typeof meta.lower_third === "object") {
      result.lowerThirdsSkipped++;
      continue;
    }
    meta.lower_third = { text: marker.text, type: "doc_marker", marker_id: marker.id };
    items[k].metadata = meta;
    result.lowerThirdsApplied++;
  }

  // Title cards: insert in reverse spoken-time order so an earlier
  // insertion doesn't shift the index of a later one.
  const titleCardResolutions = resolved
    .filter((r) => r.marker.kind === "title_card" && r.t != null && r.marker.youtube_url)
    .sort((a, b) => (b.t as number) - (a.t as number));

  for (const { marker, t } of titleCardResolutions) {
    const tt = t as number;
    const currentStarts = computeStarts(items);
    const k = findItemIndexAtTime(currentStarts, items, tt);
    if (k < 0) { result.titleCardsSkipped++; continue; }

    const start = marker.start_seconds != null ? Number(marker.start_seconds) : 0;
    const end = marker.end_seconds != null ? Number(marker.end_seconds) : start + 6;
    const forcedDuration = Math.max(1, end - start);

    const titleCardRow: TimelineItemDraft = {
      project_id: projectId,
      clip_id: null,
      type: "title_card",
      position: 0, // re-numbered below
      duration: TITLE_CARD_DEFAULT_DURATION,
      script_text: null,
      overlay_text: marker.text,
      metadata: {
        placeholder: false,
        planned: false,
        pick_source: "doc_marker",
        doc_marker_id: marker.id,
        doc_marker_kind: "title_card",
      },
      approved: false,
    };
    const forcedFootageRow: TimelineItemDraft = {
      project_id: projectId,
      clip_id: null,
      type: "footage",
      position: 0, // re-numbered below
      duration: forcedDuration,
      script_text: null,
      overlay_text: null,
      metadata: {
        placeholder: false,
        planned: false,
        pick_source: "doc_marker_forced",
        doc_marker_id: marker.id,
        forced_clip: {
          youtube_url: marker.youtube_url,
          start_seconds: start,
          end_seconds: end,
        },
      },
      approved: false,
    };

    // Insert just BEFORE the item that's playing at `tt`. We intentionally
    // don't try to split the host item — the host gets pushed back, and the
    // total timeline grows by (title_card + forced_footage) seconds. The
    // matcher's duration-reclaim already happens before we run, so growing
    // the timeline here is acceptable: the render simply pushes the audio
    // tail back; the voiceover speaker doesn't care about the gap.
    items.splice(k, 0, titleCardRow, forcedFootageRow);
    result.titleCardsInserted++;
  }

  // Re-number positions across the final array.
  for (let i = 0; i < items.length; i++) {
    items[i].position = i;
  }
  return result;
}

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
import {
  resolveLowerThird,
  type LowerThirdResolverContext,
} from "@/lib/gdocs/lower-third-resolver";

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
  // image_url / right_image_url are written by matchProcessor on items that
  // resolve to image / split_2 visuals. We touch image_url here when a
  // lower-third's noun resolves to a canonical reference image (the noun
  // overrides whatever visual the matcher previously assigned).
  image_url?: string | null;
}

export interface ScriptMarkerRow {
  id: string;
  // intro_card rows are filtered out by the caller before being passed to
  // applyScriptMarkers — intros are pre-roll, never aligned to the
  // narrator's spoken audio. The matchProcessor's loader drops them so
  // this type only ever sees the in-script kinds.
  //
  // title_card_clip rows are extra timestamps stacked under a title_card in
  // the doc. They share the title_card's spoken-audio anchor (we don't try
  // to align them independently — there's no text to align). The matcher
  // appends them as forced-footage rows immediately after the title_card's
  // own forced-footage row, with no second card flash between them.
  kind: "title_card" | "title_card_clip" | "lower_third";
  text: string;
  ordinal: number;
  paragraph_index: number | null;
  char_offset: number | null;
  youtube_url: string | null;
  start_seconds: number | null;
  end_seconds: number | null;
}

// Fallback duration when we can't measure the title phrase's spoken time
// (Deepgram words missing, exact match failed before falling back to a
// best-effort anchor). 3s reads a short heading comfortably.
const TITLE_CARD_FALLBACK_DURATION = 3;
// Floor on the typewriter card so a very short title ("Go.", "Now.") still
// has enough on-screen time to register. The renderer types the text in
// over the card's full duration, so the floor is also the minimum total
// animation time the viewer sees.
const TITLE_CARD_MIN_DURATION = 1.5;
// Extra hold added after the typewriter finishes typing — gives the viewer
// a beat to read the fully-typed title before the next clip cuts in. Without
// it, the animation ends exactly when the narrator stops saying the phrase
// and the last character lands on the last frame, which reads as abrupt.
const TITLE_CARD_HOLD_TAIL = 0.8;

// Token-strip: lowercased word with surrounding punctuation removed. Both
// sides (Deepgram words and marker phrases) go through this so "Walliams,"
// matches "walliams" and "Don't" matches "don't".
function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")
    .replace(/['']/g, "'");
}

// Split on whitespace AND internal punctuation, so a doc-authored title like
// "Back,The" (comma with no following space) tokenizes to ["back","the"]
// instead of the single garbage token "backthe" that never matches any
// Deepgram word. Apostrophes stay attached so "Walliams'" / "don't" survive
// — normalizeToken handles the trailing apostrophe.
function tokenize(s: string): string[] {
  return s
    .split(/[\s,;:.!?()\[\]"–—…]+/u)
    .map(normalizeToken)
    .filter(Boolean);
}

// Locate the first Deepgram-word index where the marker phrase begins,
// starting the search at `fromIndex`. We do exact contiguous matching on
// normalized tokens — punctuation differences are absorbed by normalizeToken,
// and small ASR slips (homophones, contractions split differently) fail
// gracefully by returning -1 so the caller can skip the marker rather than
// snapping it to the wrong moment.
// Return the first word index whose start time is >= t. Used by the
// section-window resolver to convert a section-start audio time into a
// word-stream cursor that findPhraseIndex can search from.
function findWordIndexAtOrAfter(words: WordTiming[], t: number): number {
  for (let i = 0; i < words.length; i++) {
    if (words[i].start >= t) return i;
  }
  return words.length;
}

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

// Compute each item's voiceover-relative start time.
//
// Prefer metadata.vo_start_seconds when the matcher recorded it (this is
// the REAL spoken-audio start of the narration the item covers, derived
// from Deepgram word timings via the planner). Falling back to a
// cumulative-duration sum is wrong because item durations don't
// faithfully add up to spoken time — Gemini's per-block hints don't
// cover every word in the audio, and the planner rounds each block to
// 0.1s. With a 60-block timeline those small gaps compound into
// 10–20s of drift, which is enough to land a marker on the wrong item.
//
// type='intro' rows are pre-roll (their own YouTube audio plays BEFORE
// the voiceover starts), so they're not on the voiceover time axis at
// all. They get start=0 and don't advance the cumulative cursor — same
// as treating them as zero-duration. Items without vo_start_seconds in
// metadata (very old data, or fallback path) fall through to the
// cumulative-duration estimate so legacy projects keep working.
function computeStarts(items: TimelineItemDraft[]): number[] {
  const out: number[] = new Array(items.length);
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type === "intro") {
      out[i] = acc;
      continue;
    }
    const meta = (items[i].metadata ?? {}) as Record<string, unknown>;
    const stored = meta.vo_start_seconds;
    if (typeof stored === "number" && Number.isFinite(stored)) {
      out[i] = stored;
      acc = stored + items[i].duration;
      continue;
    }
    out[i] = acc;
    acc += items[i].duration;
  }
  return out;
}

// Extract the spoken narration in [tStart, tEnd) from the Deepgram word
// stream and return it as a single space-joined sentence. Used to populate
// the script_text of overlay rows (title card + forced footage) so the
// editor shows which words the narrator is saying under each clip — without
// this, those rows render as "No script text" even though the voiceover is
// playing continuously underneath them.
function spokenTextInWindow(
  words: WordTiming[],
  tStart: number,
  tEnd: number,
): string | null {
  if (!(tEnd > tStart)) return null;
  const picked: string[] = [];
  for (const w of words) {
    // A word counts as inside the window if it starts before the window
    // ends AND ends after the window starts — captures partials at both
    // boundaries so a word straddling the cut still appears as one or the
    // other clip's script_text.
    if (w.start >= tEnd) break;
    if (w.end <= tStart) continue;
    picked.push(w.word);
  }
  const joined = picked.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 0 ? joined : null;
}

// Find the splice index for inserting a marker spoken at voiceover time
// `t`. Returns the first item whose voiceover start is at-or-after t —
// so an `items.splice(k, 0, ...marker)` call lands the marker AFTER the
// last item that finished before t, and BEFORE the next item the
// narrator hasn't reached yet.
//
// Why not "find the item whose window contains t": the narration has
// short gaps between sentences. A marker spoken at t=47.75s might fall
// 0.24s after one sentence ends (item ending 47.51s) and 2.88s before
// the next sentence begins (item starting 50.63s). The marker belongs
// AFTER the finished sentence, not before it. The old "first item
// whose end > t" rule returned the FINISHED sentence's index — landing
// the marker in front of an item that should appear before it.
//
// type='intro' rows live on a different time axis (pre-roll); they
// don't compete for placement against voiceover-time markers. They're
// skipped here so a marker at voiceover t=1s lands after the intros,
// not before them.
function findItemIndexAtTime(starts: number[], items: TimelineItemDraft[], t: number): number {
  if (items.length === 0) return -1;
  // First skip past any intro items at the head — they don't have
  // voiceover-time positions.
  let firstScript = 0;
  while (firstScript < items.length && items[firstScript].type === "intro") {
    firstScript++;
  }
  if (firstScript >= items.length) return -1;
  for (let i = firstScript; i < items.length; i++) {
    if (items[i].type === "intro") continue;
    if (starts[i] >= t - 0.01) return i;
  }
  // Marker is past the start of every item — splice at the end.
  return items.length;
}

export interface ApplyMarkersResult {
  titleCardsInserted: number;
  titleCardsSkipped: number;
  // Count of extra title_card_clip rows that successfully attached to their
  // parent title_card. Reported separately from titleCardsInserted so logs
  // can show how many doc-stacked clips actually got into the timeline.
  titleCardExtraClipsInserted: number;
  lowerThirdsApplied: number;
  lowerThirdsSkipped: number;
}

// Override a single timeline item's visual to the canonical reference
// image for a lower-third's noun, when the noun resolves to a roster
// entity.
//
// Per the client spec, a lower-third anchored to a named noun MUST
// show that noun's canonical image on screen: a person photo for a
// named person, a logo for a company, a poster for a movie/show, cover
// art for a song, a building photo for a place. The matcher's earlier
// visual assignment for this item is replaced.
//
// resolveLowerThird returns null for:
//   - abstract concepts ("ten year run", "ceremony", "lawsuit")
//   - bare dates / years
//   - nouns that don't map to any roster entity (Wikipedia miss)
//   - ambiguous last-name matches (two Cowells in the script)
// In all these cases the item is left alone — the existing assignment
// (usually the project celebrity) keeps showing, which matches the
// spec's celebrity_default fallback. We stamp lower_third_unresolved on
// the metadata so the audit log surfaces which doc nouns couldn't be
// grounded.
function applyLowerThirdVisualOverride(
  item: TimelineItemDraft,
  markerText: string,
  resolverCtx?: LowerThirdResolverContext,
): void {
  if (!resolverCtx) return;
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const resolution = resolveLowerThird(markerText, resolverCtx);
  if (resolution) {
    item.image_url = resolution.reference_url;
    item.type = "image";
    item.clip_id = null;
    // Clear split_2 / footage metadata so the renderer takes the
    // single-image path. Leave lower_third + block_index alone —
    // downstream logs and renderer text overlays still need them.
    delete meta.right_image_url;
    delete meta.left_image_url;
    delete meta.clip_duration;
    delete meta.duration_clamped;
    meta.lower_third_override = {
      entity_type: resolution.entity_type,
      entity_name: resolution.entity_name,
      match: resolution.match,
      reference_url: resolution.reference_url,
    };
  } else {
    meta.lower_third_unresolved = true;
  }
  item.metadata = meta;
}

export function applyScriptMarkers(
  items: TimelineItemDraft[],
  markers: ScriptMarkerRow[],
  words: WordTiming[] | null | undefined,
  projectId: string,
  transcript: string,
  // Optional resolver: when provided, every lower-third's noun is run
  // through resolveLowerThird against the project's face_references roster.
  // If the noun maps to a canonical entity with a reference image, the
  // item carrying the lower-third has its visual overridden to that image
  // (item.image_url + item.type="image"). Pass undefined to skip the
  // override and keep the legacy text-stamp-only behaviour.
  resolverCtx?: LowerThirdResolverContext,
): ApplyMarkersResult {
  const result: ApplyMarkersResult = {
    titleCardsInserted: 0,
    titleCardsSkipped: 0,
    titleCardExtraClipsInserted: 0,
    lowerThirdsApplied: 0,
    lowerThirdsSkipped: 0,
  };
  if (!words || words.length === 0 || markers.length === 0) return result;
  // Local non-null alias so TS narrows inside nested closures (the
  // `words` parameter is typed as nullable for the public API).
  const wordsNN: WordTiming[] = words;

  // Build a word-index → transcript-char-offset map. The transcript is
  // the SAME text the narrator reads, so Deepgram's word stream and the
  // transcript text are the same words in the same order (modulo whitespace
  // differences). Walk both in parallel: for each Deepgram word, scan
  // forward in the transcript until we find a normalized-token match,
  // then record that transcript position. This lets us anchor markers by
  // their AUTHORED character offset in the doc — bypassing the "first
  // textual occurrence wins" problem entirely.
  //
  // The marker for the red-marked "London Palladium" in paragraph 6
  // has char_offset pointing at that exact red run. A plain-text
  // "London Palladium" earlier in paragraph 3 has a different char
  // offset. Each is mapped to a distinct word index → distinct timestamp.
  const wordToTranscriptOffset: number[] = new Array(wordsNN.length).fill(-1);
  {
    let tCursor = 0;
    const normalizedTranscript = transcript;
    for (let wi = 0; wi < wordsNN.length; wi++) {
      const tok = normalizeToken(wordsNN[wi].word);
      if (!tok) continue;
      // Skip past whitespace / punctuation in the transcript.
      while (tCursor < normalizedTranscript.length) {
        const ch = normalizedTranscript[tCursor];
        if (/[\p{L}\p{N}']/u.test(ch)) break;
        tCursor++;
      }
      if (tCursor >= normalizedTranscript.length) break;
      // Read the next word-token from the transcript at this position.
      let end = tCursor;
      while (end < normalizedTranscript.length && /[\p{L}\p{N}']/u.test(normalizedTranscript[end])) {
        end++;
      }
      const transWord = normalizeToken(normalizedTranscript.slice(tCursor, end));
      // If the transcript word matches this Deepgram word, record the
      // offset and advance. If they don't match (Deepgram heard something
      // different from the transcript), skip the Deepgram word and try
      // again next iteration — the transcript cursor stays put so the
      // next Deepgram word can match it.
      if (transWord === tok) {
        wordToTranscriptOffset[wi] = tCursor;
        tCursor = end;
      } else {
        // Soft retry: scan forward up to 5 transcript words for a match
        // (handles small transcription drift like a missed filler word).
        let probe = end;
        let hops = 0;
        let matched = false;
        while (probe < normalizedTranscript.length && hops < 5) {
          while (probe < normalizedTranscript.length && !/[\p{L}\p{N}']/u.test(normalizedTranscript[probe])) probe++;
          let probeEnd = probe;
          while (probeEnd < normalizedTranscript.length && /[\p{L}\p{N}']/u.test(normalizedTranscript[probeEnd])) probeEnd++;
          const probeWord = normalizeToken(normalizedTranscript.slice(probe, probeEnd));
          if (probeWord === tok) {
            wordToTranscriptOffset[wi] = probe;
            tCursor = probeEnd;
            matched = true;
            break;
          }
          probe = probeEnd;
          hops++;
        }
        if (!matched) {
          // Leave wordToTranscriptOffset[wi] = -1; this Deepgram word has
          // no clean transcript anchor (rare — heavy filler/noise word).
          // The next Deepgram word will try from the same tCursor.
        }
      }
    }
  }

  // Compute each content paragraph's starting offset in the transcript.
  // The transcript is paragraphs joined with newlines; the parser uses
  // contentParagraphCount which skips blank paragraphs. We mirror that
  // here by counting only non-blank paragraphs.
  const paragraphStart: number[] = [];
  {
    const paragraphs = transcript.split(/\n+/);
    let cursor = 0;
    for (const p of paragraphs) {
      if (p.trim().length === 0) {
        cursor += p.length + 1; // +1 for the newline separator
        continue;
      }
      paragraphStart.push(cursor);
      cursor += p.length + 1;
    }
  }

  // Convert a marker's (paragraph_index, char_offset) into the audio
  // word whose transcript position is closest to (but not past) the
  // marker's absolute transcript offset. Returns -1 when no anchor can
  // be derived (paragraph out of range, word map empty, etc.).
  function wordIndexForMarkerOffset(pIdx: number | null, charOffset: number | null): number {
    if (pIdx == null || pIdx < 0 || pIdx >= paragraphStart.length) return -1;
    const absOffset = paragraphStart[pIdx] + (charOffset ?? 0);
    // Walk wordToTranscriptOffset to find the last word whose mapped
    // offset is <= absOffset. Linear scan is fine — markers are sparse.
    let bestWi = -1;
    for (let wi = 0; wi < wordToTranscriptOffset.length; wi++) {
      const off = wordToTranscriptOffset[wi];
      if (off < 0) continue;
      if (off <= absOffset) bestWi = wi;
      else break;
    }
    return bestWi;
  }

  // Resolve each marker's spoken-time window by finding its text in the
  // Deepgram word stream.
  //
  // Two-pass design driven by a real bug: the doc author's red-marked
  // lower-third "London Palladium" sits in paragraph 3 of a section. But
  // the same phrase also appears in the doc's intro paragraph (NOT
  // red-marked). A single-pass forward scan would lock the marker onto
  // the intro's earlier spoken mention (~t=10s) instead of the
  // paragraph-3 mention (~t=40s), placing the overlay on the wrong clip.
  //
  // Pass 1: anchor all title-card markers in doc order. Title cards are
  // doc headings; the narrator reads each section's body right after.
  // A title's spoken anchor (or fallback to the previous title's anchor
  // when this one's text isn't in the narration) marks where the next
  // section's audio starts.
  //
  // Pass 2: for each lower-third, the search start = the audio anchor
  // of the most recent title-card marker that precedes it in ordinal
  // order. That way, a lower-third in section N can only anchor inside
  // section N's audio — never the intro, never an earlier section.
  // Within one section, identical phrases still use a per-phrase forward
  // cursor so multiple occurrences pick distinct instances.
  const resolved: Array<{ marker: ScriptMarkerRow; t: number | null; tEnd: number | null }> = [];
  const ordered = [...markers].sort((a, b) => a.ordinal - b.ordinal);

  // Pass 1: title-card audio anchors, keyed by paragraph_index. Title
  // cards use one ordinal counter and lower-thirds use another (they're
  // independent sequences), so we use paragraph_index — which IS shared
  // across all kinds — to bracket lower-thirds into sections.
  //
  // Sort title cards by their paragraph_index so the forward search
  // through the audio respects doc order. Title cards without a paragraph
  // index are dropped from the bracketing logic (rare; would only happen
  // for malformed parser output).
  // `anchored: true` means the title's own text was found in the audio.
  // `anchored: false` means it's an interpolated fallback — its `t` came
  // from neighboring titles' positions, not its own phrase match. We track
  // both so section bracketing (sectionStartForParagraph / End) still
  // covers titles whose text isn't spoken (editorial headings the narrator
  // skips) or doesn't tokenize cleanly. Without this, every lower-third
  // in an unanchored title's section inherits the PREVIOUS section's
  // anchor and searches a huge wrong window — usually returning -1.
  const titleAnchors: Array<{ pIdx: number; t: number; anchored: boolean }> = [];
  const unanchoredTitlePIdx: number[] = [];
  {
    const titleCards = ordered
      .filter((m) => m.kind === "title_card" && m.paragraph_index != null)
      .sort((a, b) => (a.paragraph_index as number) - (b.paragraph_index as number));
    let lastTitleEnd = 0;
    for (const m of titleCards) {
      const tokens = tokenize(m.text);
      const pIdx = m.paragraph_index as number;
      if (tokens.length === 0) {
        unanchoredTitlePIdx.push(pIdx);
        continue;
      }
      const idx = findPhraseIndex(words, tokens, lastTitleEnd);
      if (idx < 0) {
        unanchoredTitlePIdx.push(pIdx);
        continue;
      }
      titleAnchors.push({ pIdx, t: words[idx].start, anchored: true });
      lastTitleEnd = idx + tokens.length;
    }
    // Fill in unanchored titles by linear interpolation against the
    // surrounding successful anchors. Paragraph index is a rough proxy
    // for narration time — close enough to keep section brackets correct
    // for lower-thirds, which is all we need this for. (The unanchored
    // title still gets t=null in Pass 2 if its own text doesn't match —
    // it just won't be inserted as a timeline card. But its forced clips
    // and the section's lower-thirds are now rescued.)
    if (unanchoredTitlePIdx.length > 0 && titleAnchors.length >= 1) {
      for (const pIdx of unanchoredTitlePIdx) {
        let prev: { pIdx: number; t: number } | null = null;
        let next: { pIdx: number; t: number } | null = null;
        for (const a of titleAnchors) {
          if (!a.anchored) continue;
          if (a.pIdx < pIdx && (!prev || a.pIdx > prev.pIdx)) prev = a;
          if (a.pIdx > pIdx && (!next || a.pIdx < next.pIdx)) next = a;
        }
        let interpolated: number;
        if (prev && next) {
          const frac = (pIdx - prev.pIdx) / (next.pIdx - prev.pIdx);
          interpolated = prev.t + frac * (next.t - prev.t);
        } else if (prev) {
          // Last section: assume the unanchored title sits roughly at the
          // same paragraph-per-second pace as the preceding stretch.
          interpolated = prev.t + 1;
        } else if (next) {
          // First section is unanchored: bracket it at the very start.
          interpolated = 0;
        } else {
          continue; // shouldn't happen — guarded by length check above
        }
        titleAnchors.push({ pIdx, t: interpolated, anchored: false });
      }
      titleAnchors.sort((a, b) => a.pIdx - b.pIdx);
    }
  }
  // For a lower-third at paragraph_index P: the section it belongs to
  // starts at the most recent title-card anchor whose paragraph_index <= P.
  // Returns 0 when no title card precedes the marker (e.g. markers
  // sitting in the intro paragraph).
  function sectionStartForParagraph(pIdx: number | null): number {
    if (pIdx == null) return 0;
    let bestT = 0;
    for (const a of titleAnchors) {
      if (a.pIdx <= pIdx && a.t > bestT) bestT = a.t;
    }
    return bestT;
  }
  // Section END is the NEXT title card's anchor — used to bound the
  // search so a lower-third can't accidentally drift into the next
  // section's audio when its own phrase isn't present. Returns +Infinity
  // when no later title card exists.
  function sectionEndForParagraph(pIdx: number | null): number {
    if (pIdx == null) return Number.POSITIVE_INFINITY;
    let bestT = Number.POSITIVE_INFINITY;
    for (const a of titleAnchors) {
      if (a.pIdx > pIdx && a.t < bestT) bestT = a.t;
    }
    return bestT;
  }

  // Pass 2: resolve all markers.
  // Per-phrase cursor still used WITHIN a section for distinct
  // occurrences of the same phrase (e.g. a name said multiple times
  // within one section). Reset per section to avoid the cursor leaking
  // forward across sections.
  const phraseSearchCursor = new Map<string, number>();
  let cursorSectionOrdinal = -1;
  const debugRows: Array<Record<string, unknown>> = [];
  for (const m of ordered) {
    if (m.kind === "title_card_clip") {
      resolved.push({ marker: m, t: null, tEnd: null });
      debugRows.push({
        ord: m.ordinal, kind: m.kind, pIdx: m.paragraph_index,
        text: m.text.slice(0, 40), skipped: "title_card_clip",
      });
      continue;
    }
    const tokens = tokenize(m.text);
    if (tokens.length === 0) {
      resolved.push({ marker: m, t: null, tEnd: null });
      debugRows.push({
        ord: m.ordinal, kind: m.kind, pIdx: m.paragraph_index,
        text: m.text.slice(0, 40), skipped: "empty_tokens",
      });
      continue;
    }
    // For lower-thirds: anchor by the marker's authored (paragraph_index,
    // char_offset) in the doc. The transcript is the same text the
    // narrator reads, so a marker at transcript char offset O maps to
    // the audio word spoken at that position. This picks the EXACT
    // red-marked occurrence even when the phrase repeats earlier or
    // later in the same paragraph.
    //
    // Phrase-text fallback (findPhraseIndex from a section-bracketed
    // start) only kicks in when the offset map can't anchor — e.g. the
    // transcript-to-Deepgram word alignment failed at that position.
    let searchStart: number;
    let offsetAnchoredIdx = -1;
    if (m.kind === "lower_third") {
      const anchorWi = wordIndexForMarkerOffset(m.paragraph_index, m.char_offset);
      if (anchorWi >= 0) {
        // Verify the phrase actually starts at this anchor (within a
        // small forward tolerance to absorb minor alignment drift).
        // findPhraseIndex with from=anchorWi will find the next match —
        // if it matches at-or-very-near anchorWi, we accept it.
        const probe = findPhraseIndex(words, tokens, anchorWi);
        if (probe >= 0 && probe - anchorWi <= 5) {
          offsetAnchoredIdx = probe;
        }
      }
    }
    if (m.kind === "title_card") {
      // Lower bound: the latest title anchor whose pIdx is strictly less.
      searchStart = 0;
      if (m.paragraph_index != null) {
        for (const a of titleAnchors) {
          if (a.pIdx < m.paragraph_index && a.t > searchStart) searchStart = a.t;
        }
      }
      searchStart = findWordIndexAtOrAfter(words, searchStart);
    } else {
      // lower_third fallback path: locked to its section's audio window.
      const sectionStartT = sectionStartForParagraph(m.paragraph_index);
      const sectionStartIdx = findWordIndexAtOrAfter(words, sectionStartT);
      const sectionKey = sectionStartT;
      if (sectionKey !== cursorSectionOrdinal) {
        phraseSearchCursor.clear();
        cursorSectionOrdinal = sectionKey;
      }
      const key = tokens.join(" ");
      const cursorFromMap = phraseSearchCursor.get(key);
      searchStart = cursorFromMap != null && cursorFromMap > sectionStartIdx
        ? cursorFromMap
        : sectionStartIdx;
    }
    const idx = offsetAnchoredIdx >= 0
      ? offsetAnchoredIdx
      : findPhraseIndex(words, tokens, Math.floor(searchStart));
    // For lower-thirds, also enforce the upper bound — don't accept a
    // hit that sits past the next title-card's audio anchor (that would
    // be a different section).
    let outOfBounds = false;
    if (idx >= 0 && m.kind === "lower_third") {
      const sectionEndT = sectionEndForParagraph(m.paragraph_index);
      if (Number.isFinite(sectionEndT) && words[idx].start >= sectionEndT) {
        outOfBounds = true;
      }
    }
    if (idx < 0 || outOfBounds) {
      resolved.push({ marker: m, t: null, tEnd: null });
      debugRows.push({
        ord: m.ordinal, kind: m.kind, pIdx: m.paragraph_index,
        text: m.text.slice(0, 40),
        searchedFrom: searchStart,
        found: idx < 0 ? -1 : idx,
        skipped: outOfBounds ? "out_of_section" : undefined,
      });
      continue;
    }
    if (m.kind === "lower_third") {
      const key = tokens.join(" ");
      phraseSearchCursor.set(key, idx + tokens.length);
    }
    const lastIdx = idx + tokens.length - 1;
    resolved.push({
      marker: m,
      t: words[idx].start,
      tEnd: words[lastIdx].end,
    });
    debugRows.push({
      ord: m.ordinal, kind: m.kind, pIdx: m.paragraph_index,
      cOff: m.char_offset,
      text: m.text.slice(0, 40),
      anchorSrc: offsetAnchoredIdx >= 0 ? "char_offset" : "phrase_search",
      searchedFrom: searchStart, foundAtWord: idx,
      tStart: Math.round(words[idx].start * 100) / 100,
      tEnd: Math.round(words[lastIdx].end * 100) / 100,
    });
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    msg: "markers.resolve.debug",
    projectId,
    totalMarkers: ordered.length,
    totalWords: words.length,
    titleAnchors: titleAnchors.map((a) => ({
      pIdx: a.pIdx,
      t: Math.round(a.t * 100) / 100,
      anchored: a.anchored,
    })),
    rows: debugRows,
  }));

  // Apply lower-thirds first because they only mutate existing items'
  // metadata — order independent. Title-card insertions shift positions
  // and must happen second, after we've taken metadata reads.
  const starts = computeStarts(items);
  for (const { marker, t } of resolved) {
    // tEnd is only used by title cards; ignore here.
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
    applyLowerThirdVisualOverride(items[k], marker.text, resolverCtx);
    result.lowerThirdsApplied++;
  }

  // Group title_card + its following title_card_clip rows together. The
  // doc author can stack multiple timestamps under one blue title; each
  // stacked timestamp becomes its own forced footage clip played
  // back-to-back after the title card, with no second card flash. The
  // parser persists those stacked entries as title_card_clip rows
  // immediately after the parent title_card in the ordinal stream — so
  // adjacency by ordinal is what we look for here.
  const orderedResolutions = [...resolved].sort(
    (a, b) => a.marker.ordinal - b.marker.ordinal,
  );
  interface TitleCardGroup {
    parent: ScriptMarkerRow;
    parentT: number;
    // Total card duration in seconds = typewriter window + TITLE_CARD_HOLD_TAIL.
    // The typing animation finishes at `typewriterDuration` (matching the
    // narrator), then the fully-typed title holds on screen for the tail so
    // the viewer has a beat to read it before the next clip cuts in.
    parentDuration: number;
    // Sub-window inside parentDuration during which the typewriter types.
    // Equals max(MIN, spokenDuration). After this point, the renderer holds
    // the fully-typed text on screen until parentDuration elapses.
    typewriterDuration: number;
    extras: ScriptMarkerRow[];
  }
  const groups: TitleCardGroup[] = [];
  for (let g = 0; g < orderedResolutions.length; g++) {
    const r = orderedResolutions[g];
    if (r.marker.kind !== "title_card") continue;
    if (r.t == null || !r.marker.youtube_url) {
      result.titleCardsSkipped++;
      continue;
    }
    const spokenDuration = r.tEnd != null && r.tEnd > r.t ? r.tEnd - r.t : null;
    const typewriterDuration = spokenDuration != null
      ? Math.max(TITLE_CARD_MIN_DURATION, spokenDuration)
      : TITLE_CARD_FALLBACK_DURATION;
    const parentDuration = spokenDuration != null
      ? typewriterDuration + TITLE_CARD_HOLD_TAIL
      : TITLE_CARD_FALLBACK_DURATION;
    const extras: ScriptMarkerRow[] = [];
    // Walk forward collecting sibling clips. Two cases count as a sibling:
    //   1. title_card_clip — the parser's clean case (a bare timestamp
    //      stacked under the title with no label text).
    //   2. title_card whose text could NOT be aligned in the spoken audio
    //      (r.t == null) but DOES carry a youtube_url. The author labeled
    //      the stacked clip in the doc (e.g. "I, extra clip 2 — 0:00-0:08")
    //      so the parser classified it as its own title_card; since the
    //      label isn't spoken by the narrator, the matcher would otherwise
    //      drop the clip silently. We absorb it as an extra here so both
    //      clips play under the previous title's card.
    let h = g + 1;
    while (h < orderedResolutions.length) {
      const sibRes = orderedResolutions[h];
      // lower_third markers use an independent ordinal counter from the
      // title_* markers, so a lower_third can land BETWEEN a title_card
      // and its title_card_clip in the ordinal-sorted stream. Skip past
      // it without breaking the sibling walk — it's not a sibling and not
      // a barrier; the next title_card_clip after it still belongs to
      // this group.
      if (sibRes.marker.kind === "lower_third") {
        h++;
        continue;
      }
      if (sibRes.marker.kind === "title_card_clip") {
        if (sibRes.marker.youtube_url) extras.push(sibRes.marker);
        h++;
        continue;
      }
      if (
        sibRes.marker.kind === "title_card"
        && sibRes.t == null
        && sibRes.marker.youtube_url
      ) {
        extras.push(sibRes.marker);
        h++;
        continue;
      }
      break;
    }
    groups.push({ parent: r.marker, parentT: r.t, parentDuration, typewriterDuration, extras });
    // Skip the absorbed siblings so the outer loop doesn't re-process them
    // (the inner `if (r.marker.kind !== "title_card") continue;` would
    // skip title_card_clip extras anyway, but unaligned title_card extras
    // would otherwise come back through as their own groups and get
    // counted under titleCardsSkipped).
    g = h - 1;
  }

  // Insert groups in reverse spoken-time order so an earlier insertion
  // doesn't shift the index of a later one.
  const groupsByTimeDesc = [...groups].sort((a, b) => b.parentT - a.parentT);
  for (const group of groupsByTimeDesc) {
    const currentStarts = computeStarts(items);
    const k = findItemIndexAtTime(currentStarts, items, group.parentT);
    if (k < 0) { result.titleCardsSkipped++; continue; }

    function forcedFootageFromMarker(m: ScriptMarkerRow, voStart: number): TimelineItemDraft {
      const start = m.start_seconds != null ? Number(m.start_seconds) : 0;
      const end = m.end_seconds != null ? Number(m.end_seconds) : start + 6;
      const dur = Math.max(1, end - start);
      // Cheap YouTube thumbnail derived from the URL. The editor UI picks
      // this up from metadata.thumbnail_url and shows it on the block
      // instead of the empty grey-box-with-"footage" placeholder. It's
      // the source video's poster frame, not the exact cut window, but
      // it's free and immediate — no extra ffmpeg work at ingest time.
      const ytIdMatch = m.youtube_url?.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|v\/)([A-Za-z0-9_-]{11})/);
      const ytId = ytIdMatch?.[1] ?? null;
      const thumbnailUrl = ytId ? `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg` : null;
      // Forced clips now play SILENT (per user direction 2026-05-27) — the
      // mid-timeline audio splice is disabled in renderProcessor, so the
      // narrator voiceover keeps playing under the clip's video. That means
      // the forced row occupies real narrator time and should show the
      // spoken words for its window in script_text — same as any other
      // footage row. Without this the editor shows "No script text" on the
      // forced clip and the words that were spoken during its window
      // appear on the NEXT row, making the timeline look desynced.
      const scriptText = spokenTextInWindow(wordsNN, voStart, voStart + dur);
      return {
        project_id: projectId,
        clip_id: null,
        type: "footage",
        position: 0, // re-numbered below
        duration: dur,
        script_text: scriptText,
        overlay_text: null,
        metadata: {
          placeholder: false,
          planned: false,
          pick_source: "doc_marker_forced",
          doc_marker_id: m.id,
          thumbnail_url: thumbnailUrl,
          // Voiceover-time window for this forced clip, mirroring what the
          // planner stamps on regular footage rows. Used by the lower-third
          // rescue pass downstream and by any post-pass that maps timeline
          // items back to audio position.
          vo_start_seconds: voStart,
          vo_end_seconds: voStart + dur,
          // Pin the row's duration so the post-processor's duration_reclaim
          // pass leaves it alone. Forced clips are cut to a fixed YouTube
          // window (start_seconds..end_seconds); stretching the row past
          // that window would either repeat the last frame or run black
          // tail frames, neither of which the user wants.
          duration_clamped: true,
          forced_clip: {
            youtube_url: m.youtube_url,
            start_seconds: start,
            end_seconds: end,
          },
        },
        approved: false,
      };
    }

    // Title card's spoken window: [parentT, parentT + parentDuration).
    // The narrator is saying the title text itself during this window
    // (that's how parentDuration was measured — see line 365 above).
    const titleSpokenText = spokenTextInWindow(
      wordsNN,
      group.parentT,
      group.parentT + group.parentDuration,
    );
    const titleCardRow: TimelineItemDraft = {
      project_id: projectId,
      clip_id: null,
      type: "title_card",
      position: 0, // re-numbered below
      duration: group.parentDuration,
      script_text: titleSpokenText,
      overlay_text: group.parent.text,
      metadata: {
        placeholder: false,
        planned: false,
        pick_source: "doc_marker",
        doc_marker_id: group.parent.id,
        doc_marker_kind: "title_card",
        // Signal to the renderer that this card should be typed in. The
        // typewriter animation runs for `typewriter_seconds` (the spoken
        // duration of the title phrase); the remaining segment time holds
        // the fully-typed text on screen so the viewer has a beat to read
        // it before the next clip cuts in.
        animation: "typewriter",
        typewriter_seconds: group.typewriterDuration,
      },
      approved: false,
    };
    // Forced clips play in sequence right after the title card. Their
    // voiceover windows are back-to-back starting at parentT + parentDuration,
    // and each row's script_text is sliced from the spoken words inside its
    // own window so the editor shows the right narration on each clip.
    let forcedVoCursor = group.parentT + group.parentDuration;
    const parentForced = forcedFootageFromMarker(group.parent, forcedVoCursor);
    forcedVoCursor += Number(parentForced.duration);
    const rows: TimelineItemDraft[] = [titleCardRow, parentForced];
    for (const extra of group.extras) {
      const extraForced = forcedFootageFromMarker(extra, forcedVoCursor);
      forcedVoCursor += Number(extraForced.duration);
      rows.push(extraForced);
    }

    // Compute the overlay window in voiceover-time before we mutate
    // items. With forced clips now playing SILENT (per user direction
    // 2026-05-27) under a continuing narrator voiceover, BOTH the
    // title_card AND its trailing forced-footage rows consume narrator
    // time. The overlay window spans the entire inserted block —
    // [parentT, parentT + parentDuration + sum(forced clip durations)) —
    // so the dedup pass below removes every script item whose narration
    // window falls under the title card OR its forced clips. Without
    // this, a script item's narration would play twice (once on the
    // forced footage row, once on the script item just past the
    // overlay), creating the audio/visual desync the user reported.
    const overlayWindowStart = group.parentT;
    const overlayWindowEnd = forcedVoCursor;

    // Align the title card's video-time position with the narrator's
    // title-start moment.
    //
    // The renderer concatenates segments back-to-back, so a title card
    // inserted at index k will appear in the final video at video-time
    // = sum(items[0..k-1].duration). The narrator reaches the title
    // text at voiceover-time `parentT`. For audio and video to line up,
    // those two must be equal.
    //
    // They aren't, for two reasons:
    //   (1) Each item's duration = spoken duration of its sentence,
    //       which excludes the silence after the sentence. The audio
    //       file does include that silence. So cumulative video-time
    //       runs ahead of voiceover-time by the accumulated silence.
    //   (2) Inter-sentence gaps near the title-card location add up
    //       to several seconds — exactly the "4-5s early" symptom.
    //
    // Pad the immediately-preceding non-intro item so that the
    // cumulative video sum just before the inserted title card equals
    // parentT exactly. Mark the row as duration_clamped so the
    // duration_reclaim pass downstream doesn't stretch it further
    // (which would push the card past parentT in the other direction).
    let prevIdx = k - 1;
    while (prevIdx >= 0 && items[prevIdx].type === "intro") prevIdx--;
    if (prevIdx >= 0) {
      const prevItem = items[prevIdx];
      // Cumulative video-time at the start of items[k] = sum of
      // durations of items[0..k-1] (skipping intro rows, which live
      // on a different time axis). The card will appear here unless
      // we pad prevItem.
      let cumulativeVideoSec = 0;
      for (let q = 0; q < k; q++) {
        if (items[q].type === "intro") continue;
        cumulativeVideoSec += Number(items[q].duration ?? 0);
      }
      const drift = group.parentT - cumulativeVideoSec;
      if (drift > 0.05) {
        prevItem.duration = Number(prevItem.duration ?? 0) + drift;
        const prevMeta = (prevItem.metadata ?? {}) as Record<string, unknown>;
        // Lock the padded row so reclaim doesn't stretch it further and
        // shift the card off its spoken moment again.
        prevMeta.duration_clamped = true;
        prevItem.metadata = prevMeta;
      }
    }

    // Insert the title card + forced footage BEFORE the script item playing
    // at the title's spoken moment. The narrator reaches the title text at
    // voiceover time `parentT`; the item at index k is whatever scene the
    // editor is showing at that moment. Splicing before k makes the title
    // appear at exactly the right narration beat, with the surrounding
    // script items unchanged on either side of it.
    items.splice(k, 0, ...rows);
    result.titleCardsInserted++;
    result.titleCardExtraClipsInserted += group.extras.length;

    // De-dup pass: forced footage clips play OVER the voiceover (the
    // narrator keeps talking under the visual), so they REPLACE script
    // items rather than adding length on top. We must remove enough
    // subsequent script items to cover the inserted overlay rows'
    // duration — otherwise the timeline grows past voiceover length.
    //
    // Two-stage strategy:
    //   1. Window-based: remove items whose vo_start_seconds falls in
    //      [overlayWindowStart, overlayWindowEnd). This is precise when
    //      the metadata is present.
    //   2. Duration-matched: if we haven't yet absorbed enough duration
    //      to cover the overlay rows, keep removing the next script
    //      items until the total removed duration ≈ the overlay rows'
    //      total. This catches script items with missing vo_start_seconds
    //      OR items whose vo_start falls just past the window but whose
    //      narration the forced clips were meant to cover.
    //
    // Intro rows are never removed — they live on a different time axis
    // (pre-roll, not voiceover).
    // Title_card AND its forced-footage rows all consume narrator time
    // now (forced clips play silent under a continuing voiceover, per
    // user direction 2026-05-27). The dedup pass must absorb script
    // items totaling the full inserted block — otherwise script items
    // covering the forced clips' narration window remain in the timeline,
    // their voiceover plays under both the forced clip AND the script
    // item, and the timeline runs long.
    const insertedDuration = rows.reduce((s, r) => s + Number(r.duration ?? 0), 0);
    let absorbedDuration = 0;
    const afterOverlayIdx = k + rows.length;
    // Track lower-thirds rescued from items the dedup pass is about to
    // remove. The doc-marker lower-third loop above stamped them onto
    // whichever script item was playing at the spoken moment — but the
    // very items that overlap the title's overlay window are exactly the
    // ones we're about to delete. Without rescue, a lower-third whose
    // spoken word falls inside the first title's window vanishes from the
    // final video (this was the "first 3 lower-thirds invisible" bug).
    // After the removal loop we re-stamp these onto the forced-footage
    // rows (which now play during that narration window) in spoken-time
    // order, so the overlay still appears with the correct word.
    const rescuedLowerThirds: Array<{
      text: string;
      type: string;
      marker_id?: string;
      voStart: number;
    }> = [];
    function rescueIfPresent(it: TimelineItemDraft, voStart: number): void {
      const m = (it.metadata ?? {}) as Record<string, unknown>;
      const lt = m.lower_third as { text?: string; type?: string; marker_id?: string } | undefined;
      if (lt?.text) {
        rescuedLowerThirds.push({
          text: lt.text,
          type: String(lt.type ?? "doc_marker"),
          marker_id: lt.marker_id,
          voStart,
        });
      }
    }
    // Stage 1: window-based removal.
    for (let r = afterOverlayIdx; r < items.length; ) {
      const it = items[r];
      if (it.type === "intro") { r++; continue; }
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      const itStart = meta.vo_start_seconds;
      if (typeof itStart !== "number") { r++; continue; }
      if (itStart >= overlayWindowEnd - 0.05) break;
      if (itStart >= overlayWindowStart - 0.05) {
        rescueIfPresent(it, Number(itStart));
        absorbedDuration += Number(it.duration ?? 0);
        items.splice(r, 1);
        continue;
      }
      r++;
    }
    // Stage 2: keep removing subsequent script items until the absorbed
    // duration covers the inserted rows. Tolerance of 0.5s keeps us from
    // removing one item too many over rounding. We only remove
    // footage/image/split rows (the kinds the planner emits); never
    // intro rows (different time axis) and never title_card / overlay
    // rows the markers pass inserted earlier in this same loop (those
    // have pick_source set by markers.ts).
    while (absorbedDuration + 0.5 < insertedDuration && afterOverlayIdx < items.length) {
      const it = items[afterOverlayIdx];
      if (it.type === "intro") break;
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      const pickSource = meta.pick_source;
      if (pickSource === "doc_marker" || pickSource === "doc_marker_forced") break;
      const itStart = typeof meta.vo_start_seconds === "number"
        ? Number(meta.vo_start_seconds)
        : overlayWindowStart;
      rescueIfPresent(it, itStart);
      absorbedDuration += Number(it.duration ?? 0);
      items.splice(afterOverlayIdx, 1);
    }

    // Re-stamp rescued lower-thirds. Two cases:
    //   (a) The rescued marker's spoken moment falls INSIDE the forced-
    //       footage window — the narrator says it while the doc-author's
    //       YouTube clip is on screen. Stamp onto that forced footage row.
    //   (b) The marker's spoken moment falls OUTSIDE the forced-footage
    //       window — the narrator says it AFTER the forced clips end, but
    //       stage 2's duration-matching swept the host item up anyway.
    //       Stamp onto the nearest surviving script item by voStart so the
    //       overlay appears at roughly the right narration beat, not
    //       crammed onto the forced footage at the start of the section.
    //
    // Title-card rows are intentionally skipped as targets — burning a
    // chyron on top of a typewriter card looks awful, and the overlay
    // belongs on the footage clip the narrator is actually talking over.
    if (rescuedLowerThirds.length > 0) {
      rescuedLowerThirds.sort((a, b) => a.voStart - b.voStart);
      const forcedRows: Array<{ row: TimelineItemDraft; voStart: number; voEnd: number }> = [];
      let cursor = group.parentT + group.parentDuration; // forced footage begins right after the title card
      for (let r = 1; r < rows.length; r++) {
        const fr = rows[r];
        if (fr.type !== "footage") continue;
        const dur = Number(fr.duration ?? 0);
        forcedRows.push({ row: fr, voStart: cursor, voEnd: cursor + dur });
        cursor += dur;
      }
      const forcedWindowEnd = forcedRows.length > 0
        ? forcedRows[forcedRows.length - 1].voEnd
        : group.parentT + group.parentDuration;
      // Cache surviving script items by voStart for case (b) — built lazily
      // so we don't walk items[] when no rescues need it.
      let scriptItemsByVo: Array<{ item: TimelineItemDraft; voStart: number }> | null = null;
      function buildScriptIndex(): Array<{ item: TimelineItemDraft; voStart: number }> {
        const idx: Array<{ item: TimelineItemDraft; voStart: number }> = [];
        for (const it of items) {
          if (it.type === "intro" || it.type === "title_card") continue;
          const m = (it.metadata ?? {}) as Record<string, unknown>;
          // Skip the forced-footage rows we just inserted — they're for case (a).
          const ps = m.pick_source;
          if (ps === "doc_marker_forced") continue;
          const vs = m.vo_start_seconds;
          if (typeof vs !== "number") continue;
          idx.push({ item: it, voStart: Number(vs) });
        }
        idx.sort((a, b) => a.voStart - b.voStart);
        return idx;
      }
      for (const lt of rescuedLowerThirds) {
        // Case (a): inside the forced-footage window.
        if (forcedRows.length > 0 && lt.voStart >= forcedRows[0].voStart && lt.voStart < forcedWindowEnd) {
          const target = forcedRows.find((f) => lt.voStart >= f.voStart && lt.voStart < f.voEnd)
            ?? forcedRows[forcedRows.length - 1];
          const targetMeta = (target.row.metadata ?? {}) as Record<string, unknown>;
          if (targetMeta.lower_third && typeof targetMeta.lower_third === "object") continue;
          targetMeta.lower_third = {
            text: lt.text,
            type: lt.type,
            ...(lt.marker_id ? { marker_id: lt.marker_id } : {}),
          };
          target.row.metadata = targetMeta;
          applyLowerThirdVisualOverride(target.row, lt.text, resolverCtx);
          continue;
        }
        // Case (b): outside the forced-footage window. Find the surviving
        // script item whose voStart is closest to lt.voStart and stamp there.
        if (!scriptItemsByVo) scriptItemsByVo = buildScriptIndex();
        if (scriptItemsByVo.length === 0) continue;
        let best = scriptItemsByVo[0];
        let bestGap = Math.abs(best.voStart - lt.voStart);
        for (let i = 1; i < scriptItemsByVo.length; i++) {
          const cand = scriptItemsByVo[i];
          const gap = Math.abs(cand.voStart - lt.voStart);
          if (gap < bestGap) { best = cand; bestGap = gap; }
        }
        const bestMeta = (best.item.metadata ?? {}) as Record<string, unknown>;
        if (bestMeta.lower_third && typeof bestMeta.lower_third === "object") continue;
        bestMeta.lower_third = {
          text: lt.text,
          type: lt.type,
          ...(lt.marker_id ? { marker_id: lt.marker_id } : {}),
        };
        best.item.metadata = bestMeta;
        applyLowerThirdVisualOverride(best.item, lt.text, resolverCtx);
      }
    }
  }

  // Bookkeeping: surface how many title_card_clip rows the matcher saw but
  // couldn't attach to a parent title_card. Most often this is benign (the
  // parser invariant says every title_card_clip immediately follows its
  // parent by ordinal), but a missing parent can sneak in if the parent's
  // phrase failed to align in the spoken audio. Logging this catches the
  // "user added a second timestamp but only one clip appears in the final
  // video" case cleanly.
  const orphanedClipCount = orderedResolutions.filter((r, idx) => {
    if (r.marker.kind !== "title_card_clip") return false;
    // Walk back past lower_third markers (independent ordinal counter,
    // can interleave) to find the real preceding marker — the one the
    // sibling walk uses as the parent.
    let prevIdx = idx - 1;
    while (prevIdx >= 0 && orderedResolutions[prevIdx].marker.kind === "lower_third") {
      prevIdx--;
    }
    const prev = prevIdx >= 0 ? orderedResolutions[prevIdx] : null;
    if (!prev) return true;
    if (prev.marker.kind === "title_card") {
      return prev.t == null || !prev.marker.youtube_url;
    }
    if (prev.marker.kind === "title_card_clip") return false; // chain
    return true;
  }).length;
  if (orphanedClipCount > 0) {
    (result as ApplyMarkersResult & { orphanedTitleCardClips: number })
      .orphanedTitleCardClips = orphanedClipCount;
  }

  // Re-number positions across the final array.
  for (let i = 0; i < items.length; i++) {
    items[i].position = i;
  }
  return result;
}

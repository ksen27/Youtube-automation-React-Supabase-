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
  //
  // inline_clip rows are bare hyperlinked timestamp lines mid-doc with no
  // blue-bold heading above them. They have no text to align either —
  // they're anchored to the START of their paragraph_index's spoken audio
  // (the paragraph directly below the timestamp in the doc) and inserted as
  // cardless forced-footage rows.
  kind: "title_card" | "title_card_clip" | "inline_clip" | "lower_third";
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

// Common-word stoplist used by the distinctive-token anchor. We rank
// title-card tokens by "uncommonness" and keep the top few to retry the
// phrase search when the full-phrase exact match fails — handles the
// case where one ASR slip (mis-transcribed word, comma-pause filler)
// breaks the contiguous match for an otherwise correct title.
const COMMON_TITLE_TOKENS = new Set<string>([
  "a","an","the","and","or","but","of","to","in","on","at","for","with","by",
  "is","was","are","were","be","been","being","that","this","these","those",
  "it","its","as","from","into","about","over","under","up","down","out",
  "he","she","they","we","you","i","his","her","their","our","my","your",
  "what","which","who","whom","whose","when","where","why","how",
  "not","no","so","if","than","then","do","does","did","done","kept","keep",
]);

// Distinctive-token fallback for title cards. When the full contiguous
// phrase doesn't match (one ASR slip kills the whole search), retry with
// progressively shorter "core" sub-phrases built from the rarest tokens
// (proper nouns first, common words last). Returns the audio index where
// the first matching sub-phrase starts, or -1 if nothing anchors.
//
// We keep sub-phrases CONTIGUOUS in the original token order so we don't
// match across unrelated sentence boundaries — pulling "Walliams" + "fights"
// from the title finds them only when they appear together in the audio.
function findTitlePhraseIndexLoose(
  words: WordTiming[],
  phraseTokens: string[],
  fromIndex: number,
): { idx: number; matchedTokens: string[] } | null {
  if (phraseTokens.length === 0) return null;
  // Score each token by uncommonness: 0 for stoplist, 1 otherwise. Then
  // walk contiguous windows of the original phrase, preferring windows
  // that maximize uncommon-token count for their length.
  const distinctive: number[] = [];
  for (let i = 0; i < phraseTokens.length; i++) {
    if (!COMMON_TITLE_TOKENS.has(phraseTokens[i])) distinctive.push(i);
  }
  if (distinctive.length === 0) return null;
  // Try windows in decreasing length: full uncommon-only set, then
  // shrinking ranges centered around the first distinctive token.
  // We try a couple of contiguous sub-phrases of the ORIGINAL phrase
  // (keeping word order, stopwords included) anchored on distinctive
  // tokens — that matches the doc title's reading order while tolerating
  // a missing/changed word at the edges.
  const attempts: string[][] = [];
  // Attempt 1: shortest contiguous slice covering all distinctive tokens.
  if (distinctive.length >= 2) {
    const lo = distinctive[0];
    const hi = distinctive[distinctive.length - 1];
    attempts.push(phraseTokens.slice(lo, hi + 1));
  }
  // Attempt 2: the first 2-3 distinctive tokens as a tight contiguous block
  // anchored at the first distinctive token. Length capped at 3 so a
  // single ASR slip in the middle still anchors.
  if (distinctive.length >= 2) {
    const lo = distinctive[0];
    const hiIdx = Math.min(distinctive.length - 1, 2);
    const hi = distinctive[hiIdx];
    const block = phraseTokens.slice(lo, hi + 1);
    if (block.length > 0 && block.length <= 5) attempts.push(block);
  }
  // Attempt 3: just the first distinctive token (last-resort anchor).
  attempts.push([phraseTokens[distinctive[0]]]);
  for (const sub of attempts) {
    const idx = findPhraseIndex(words, sub, fromIndex);
    if (idx >= 0) return { idx, matchedTokens: sub };
  }
  return null;
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

// Find the index of the item that is PLAYING at voiceover time `t` — i.e. the
// host item a lower-third overlay should be stamped on so the chyron burns in
// over whatever is on screen when the narrator says the marked word.
//
// This is DIFFERENT from findItemIndexAtTime (which returns the first item
// whose start is at-or-AFTER t, the correct rule for SPLICING a new row
// between items). For an overlay we need CONTAINMENT: the last item whose
// start is at-or-before t. Using the splice rule stamped the overlay on the
// NEXT block instead of the playing one — so a word spoken at t=95.4s landed
// on a block starting at 103.4s, showing e.g. "Marcella" a whole block late
// (the 2026-06-10 wrong-clip lower-third bug).
//
// Narration has short gaps between sentences, so t can fall AFTER one item's
// window ends and BEFORE the next begins. In that gap the previous item is
// still the one on screen (its visual holds until the next cut), so the
// last-start-<=-t rule is still correct: it returns that previous item.
//
// intro rows live on the pre-roll axis and never host a voiceover-time
// overlay, so they're skipped.
function findHostItemIndexAtTime(starts: number[], items: TimelineItemDraft[], t: number): number {
  // The host is the item with the LATEST start that is still at-or-before t.
  // Scan fully (no early break) so we don't depend on starts[] being perfectly
  // monotonic at this pre-splice stage — pick the closest start <= t.
  let host = -1;
  let bestStart = -Infinity;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type === "intro") continue;
    const s = starts[i];
    if (s <= t + 0.01 && s > bestStart) {
      bestStart = s;
      host = i;
    }
  }
  return host;
}

export interface ApplyMarkersResult {
  titleCardsInserted: number;
  titleCardsSkipped: number;
  // Count of extra title_card_clip rows that successfully attached to their
  // parent title_card. Reported separately from titleCardsInserted so logs
  // can show how many doc-stacked clips actually got into the timeline.
  titleCardExtraClipsInserted: number;
  // Cardless mid-doc clips (kind=inline_clip) that made it into the
  // timeline as forced-footage rows, and ones that couldn't be anchored to
  // their paragraph's spoken audio.
  inlineClipsInserted: number;
  inlineClipsSkipped: number;
  lowerThirdsApplied: number;
  lowerThirdsSkipped: number;
  // Forced YouTube clips that were trimmed because their requested duration
  // overflowed the narration budget for their section. The doc author chose
  // a clip longer than the sentences underneath; we shortened the playback
  // to stop the visual from leaking into the next section's audio.
  forcedClipTrimmings: Array<{
    markerId: string;
    requestedDur: number;
    trimmedDur: number;
    narrationBudget: number;
  }>;
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
  // Doc-authored forced clips (YouTube cuts attached to a title_card or
  // title_card_clip) must keep their video — the doc author picked that
  // exact source window on purpose. The lower_third's text overlay is
  // already stamped in meta.lower_third by the caller; we only skip the
  // VISUAL swap here so the forced clip plays as authored.
  if (meta.forced_clip) {
    meta.lower_third_skipped_on_forced_clip = true;
    item.metadata = meta;
    return;
  }
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
    inlineClipsInserted: 0,
    inlineClipsSkipped: 0,
    lowerThirdsApplied: 0,
    lowerThirdsSkipped: 0,
    forcedClipTrimmings: [],
  };
  if (!words || words.length === 0 || markers.length === 0) return result;
  // Local non-null alias so TS narrows inside nested closures (the
  // `words` parameter is typed as nullable for the public API).
  const wordsNN: WordTiming[] = words;

  // Drop any title_card rows the upstream planner already prepended for the
  // doc's blue-bold headings. The transcript-driven builder
  // (transcript-driven-builder.ts) prepends a "section start" title_card row
  // at every paragraph that carries a title_card marker — including clipless
  // headings. THIS pass is the authoritative title-card inserter: it rebuilds
  // each heading's card (with the typewriter animation + spoken-audio anchor)
  // and, for clip-bearing headings, its forced footage. So every pre-existing
  // planner title_card is a duplicate of a card we're about to insert.
  //
  // For CLIP-BEARING headings the dedup pass below happened to absorb the
  // planner card (it falls in the overlay window). For CLIPLESS headings it
  // does NOT reliably absorb it: this pass anchors the card to the spoken
  // heading PHRASE, which can be a later word index than the section-first
  // sentence the builder anchored to — so the planner card sits BEFORE our
  // insertion index and the dedup scan (which only looks forward from the
  // inserted rows) never sees it. The result was two near-identical title
  // cards back-to-back (one with the spoken sentence as script_text, one with
  // the heading text). Removing planner title cards up-front makes THIS pass
  // the single source of truth for every doc title card and kills the
  // duplicate at the root for both kinds.
  //
  // Identifying a planner title_card: type === "title_card" with no
  // doc_marker_id (this pass stamps doc_marker_id on every card it inserts).
  // Removing the row shrinks the picture timeline by its slice duration, but
  // it carries no unique narration (the sentence's full audio stays on its
  // content block) and the downstream proportional-fit / title-card anchor
  // passes rebalance the picture sum back to voiceoverSeconds.
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type !== "title_card") continue;
    const meta = (it.metadata ?? {}) as Record<string, unknown>;
    if (meta.doc_marker_id != null) continue;
    items.splice(i, 1);
  }

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
          // Hard resync: the 5-word probe assumes small drift, but the
          // narrator can skip (or reword) a WHOLE sentence relative to the
          // doc — e.g. the 2026-06-12 Diana project, where the audio jumps
          // from "...Nothing at all." straight to "When people talk..."
          // and the doc's intervening 9-word sentence stalls the cursor
          // forever. Every later word then has no mapping, killing every
          // offset-anchored marker (lower-thirds AND inline clips) for the
          // remaining 70% of the video.
          //
          // Recovery: scan up to 80 transcript words ahead for a position
          // where THIS Deepgram word and the NEXT one match two consecutive
          // transcript words. A single common word ("the") could false-jump
          // the cursor; a consecutive pair is strong evidence of genuine
          // realignment. When a third Deepgram token exists we verify it
          // too, rejecting candidates whose third word disagrees.
          let tok2 = "";
          let tok3 = "";
          for (let wj = wi + 1; wj < wordsNN.length && !tok3; wj++) {
            const t = normalizeToken(wordsNN[wj].word);
            if (!t) continue;
            if (!tok2) tok2 = t;
            else tok3 = t;
          }
          if (tok2) {
            const isWordChar = (ch: string) => /[\p{L}\p{N}']/u.test(ch);
            const readWordAt = (from: number): { start: number; end: number; word: string } | null => {
              let s = from;
              while (s < normalizedTranscript.length && !isWordChar(normalizedTranscript[s])) s++;
              if (s >= normalizedTranscript.length) return null;
              let e = s;
              while (e < normalizedTranscript.length && isWordChar(normalizedTranscript[e])) e++;
              return { start: s, end: e, word: normalizeToken(normalizedTranscript.slice(s, e)) };
            };
            let scanFrom = tCursor;
            for (let hops = 0; hops < 80; hops++) {
              const w1 = readWordAt(scanFrom);
              if (!w1) break;
              if (w1.word === tok) {
                const w2 = readWordAt(w1.end);
                if (w2 && w2.word === tok2) {
                  const w3 = tok3 ? readWordAt(w2.end) : null;
                  if (!tok3 || (w3 && w3.word === tok3)) {
                    wordToTranscriptOffset[wi] = w1.start;
                    tCursor = w1.end;
                    break;
                  }
                }
              }
              scanFrom = w1.end;
            }
          }
          // Still unmatched: leave wordToTranscriptOffset[wi] = -1 (heavy
          // filler/noise word). The next Deepgram word retries from the
          // same tCursor.
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

  // Spoken-audio start of a content paragraph: the first Deepgram word
  // whose mapped transcript offset is at-or-after the paragraph's starting
  // offset. Used to anchor inline_clip markers, which carry no text to
  // align — the doc puts the timestamp line ABOVE the paragraph it covers,
  // so the clip starts exactly when the narrator begins that paragraph.
  // Returns null when the paragraph is out of range or no word maps past
  // its offset (e.g. a trailing paragraph Deepgram never matched).
  function paragraphAudioStart(pIdx: number | null): number | null {
    if (pIdx == null || pIdx < 0 || pIdx >= paragraphStart.length) return null;
    const absOffset = paragraphStart[pIdx];
    for (let wi = 0; wi < wordToTranscriptOffset.length; wi++) {
      const off = wordToTranscriptOffset[wi];
      if (off < 0) continue;
      if (off >= absOffset) return wordsNN[wi].start;
    }
    // Offset-map fallback: the transcript↔word walk can still die when the
    // voiceover diverges from the doc beyond what the resync above bridges,
    // leaving every word past the divergence unmapped. Anchor by the
    // paragraph's OPENING PHRASE instead — match its first tokens
    // contiguously in the word stream, the same way title cards anchor.
    // Try progressively shorter prefixes; require at least 3 tokens so a
    // common two-word opener ("She was") can't false-anchor on an earlier
    // sentence.
    const paraEnd = pIdx + 1 < paragraphStart.length
      ? paragraphStart[pIdx + 1]
      : transcript.length;
    const opening = tokenize(
      transcript.slice(absOffset, Math.min(paraEnd, absOffset + 240)),
    );
    for (let n = Math.min(6, opening.length); n >= 3; n--) {
      const idx = findPhraseIndex(wordsNN, opening.slice(0, n), 0);
      if (idx >= 0) return wordsNN[idx].start;
    }
    return null;
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
    // title_card_clip rows anchor via their parent title_card; inline_clip
    // rows anchor via paragraphAudioStart at group-build time. Neither has
    // text to phrase-search here.
    if (m.kind === "title_card_clip" || m.kind === "inline_clip") {
      resolved.push({ marker: m, t: null, tEnd: null });
      debugRows.push({
        ord: m.ordinal, kind: m.kind, pIdx: m.paragraph_index,
        text: m.text.slice(0, 40), skipped: m.kind,
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
    let idx = offsetAnchoredIdx >= 0
      ? offsetAnchoredIdx
      : findPhraseIndex(words, tokens, Math.floor(searchStart));
    // Title-card fallback: when the full contiguous phrase fails (one
    // ASR slip — uncommon name transcribed differently, comma-pause
    // filler — kills the whole match), retry with the rarest contiguous
    // sub-phrase from the title. Keeps the title anchored to the right
    // section even when Deepgram disagrees with the doc on one word.
    // The matched token count is used below so the visual hold reflects
    // only the sub-phrase that actually anchored.
    let looseTokens: string[] | null = null;
    if (idx < 0 && m.kind === "title_card" && offsetAnchoredIdx < 0) {
      const loose = findTitlePhraseIndexLoose(words, tokens, Math.floor(searchStart));
      if (loose) {
        idx = loose.idx;
        looseTokens = loose.matchedTokens;
      }
    }
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
    // tEnd marks the end of the matched audio span. For an exact full-phrase
    // match this is the last token of the title; for a loose match it's the
    // last token of the sub-phrase that actually anchored (otherwise tEnd
    // would extrapolate past the matched audio and inflate typewriterDuration
    // into silence).
    const matchedLen = looseTokens ? looseTokens.length : tokens.length;
    const lastIdx = idx + matchedLen - 1;
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
    // Stamp the overlay on the item PLAYING at t (containment), not the next
    // item that starts at-or-after t. findItemIndexAtTime is a splice rule and
    // would land the chyron one block late (the wrong-clip bug). See
    // findHostItemIndexAtTime.
    const k = findHostItemIndexAtTime(starts, items, t);
    if (k < 0) { result.lowerThirdsSkipped++; continue; }
    const meta = (items[k].metadata ?? {}) as Record<string, unknown>;
    // Don't overwrite an existing lower_third stamped by the entity-name
    // pipeline — that one was driven by Gemini's entity context and is
    // probably already correct. Doc markers fill in the gaps.
    if (meta.lower_third && typeof meta.lower_third === "object") {
      result.lowerThirdsSkipped++;
      continue;
    }
    // Persist the EXACT spoken time of the red-marked word (t = words[idx]
    // .start, resolved above). The renderer offsets the chyron's slide-in to
    // this moment WITHIN its host block so the lower-third appears when the
    // narrator says the word — not at the block's start, which can be several
    // seconds earlier on a long footage/image host (the client's "lower third
    // appears too early" note). Downstream falls back to the block start when
    // this is absent (entity-name LTs stamped elsewhere have no word time).
    meta.lower_third = {
      text: marker.text,
      type: "doc_marker",
      marker_id: marker.id,
      vo_start_seconds: t,
    };
    items[k].metadata = meta;
    applyLowerThirdVisualOverride(items[k], marker.text, resolverCtx);
    result.lowerThirdsApplied++;
    // Diagnostic: prove (in logs) that the chosen host actually CONTAINS the
    // word time at stamp-time. If hostContainsWord is false here, the host
    // finder picked the wrong block; if it's true here but the final video
    // shows the LT one block off, the discrepancy is a LATER pass moving the
    // item's window (vo_start_duration_pass / anchor reorder), not this finder.
    {
      const hostStart = starts[k];
      const hostDur = Number(items[k].duration ?? 0);
      const hostEnd = hostStart + hostDur;
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        msg: "markers.lower_third.host_pick",
        text: marker.text,
        wordT: Math.round(t * 100) / 100,
        hostIndex: k,
        hostType: items[k].type,
        hostStart: Math.round(hostStart * 100) / 100,
        hostEnd: Math.round(hostEnd * 100) / 100,
        hostContainsWord: t >= hostStart - 0.05 && t <= hostEnd + 0.05,
      }));
    }
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
    // Clipless ("overlay-only") title card: a blue-bold heading in the doc
    // with NO force clip under it (no youtube_url / start_seconds /
    // end_seconds). It renders as a standalone typed title card with NO
    // forced footage following it — the project's normal visuals keep
    // playing underneath while the narration continues. We branch on this in
    // the insertion loop to (a) skip building any forcedFootageFromMarker
    // rows for the parent, and (b) absorb NOTHING in dedup when the title's
    // text wasn't actually spoken (anchor came from interpolation).
    clipless: boolean;
    // True only when the clipless card's anchor is a GENUINE spoken match
    // (r.t != null — the title text was found in the Deepgram word stream).
    // When the anchor was interpolated from neighboring title positions
    // (titleAnchors fallback, text not spoken), this is false and the dedup
    // pass must absorb nothing — the narrator never paused to "say the
    // title", so the typewriter window overlaps a real sentence's narration
    // that must NOT be deleted. Always true for clip-bearing cards (their
    // grouping requires r.t != null upstream).
    spokenAnchor: boolean;
    // Cardless group (kind=inline_clip): forced footage only, NO title-card
    // row is inserted and no typewriter audio share is claimed. parentT is
    // the start of the anchor paragraph's narration; typewriterDuration and
    // parentDuration are both 0.
    cardless: boolean;
  }
  const groups: TitleCardGroup[] = [];
  for (let g = 0; g < orderedResolutions.length; g++) {
    const r = orderedResolutions[g];
    // INLINE CLIP path: a bare hyperlinked timestamp mid-doc. No card, no
    // text to align — anchor to the start of its paragraph's spoken audio
    // (the paragraph directly below the timestamp line in the doc) and
    // play the forced window over that narration. Consecutive timestamp
    // lines stacked above the SAME paragraph share one group and play
    // back-to-back.
    if (r.marker.kind === "inline_clip") {
      const anchorT = paragraphAudioStart(r.marker.paragraph_index);
      if (anchorT == null || !r.marker.youtube_url) {
        result.inlineClipsSkipped++;
        continue;
      }
      const extras: ScriptMarkerRow[] = [];
      let h = g + 1;
      while (h < orderedResolutions.length) {
        const sib = orderedResolutions[h];
        // lower_third markers use an independent ordinal counter and can
        // interleave — skip without ending the stack walk.
        if (sib.marker.kind === "lower_third") { h++; continue; }
        if (
          sib.marker.kind === "inline_clip"
          && sib.marker.paragraph_index === r.marker.paragraph_index
          && sib.marker.youtube_url
        ) {
          extras.push(sib.marker);
          h++;
          continue;
        }
        break;
      }
      groups.push({
        parent: r.marker,
        parentT: anchorT,
        // No card: nothing types in and no audio share is claimed beyond
        // what the forced rows themselves hold.
        parentDuration: 0,
        typewriterDuration: 0,
        extras,
        clipless: false,
        spokenAnchor: false,
        cardless: true,
      });
      g = h - 1;
      continue;
    }
    if (r.marker.kind !== "title_card") continue;
    // CLIPLESS TITLE CARD path. A blue-bold heading with NO force clip
    // (youtube_url == null) is a standalone typed title card: it must appear
    // ON SCREEN as a typewriter title with NO forced footage after it, while
    // the project's normal visuals + narration continue underneath. The
    // parser emits these with no youtube_url / start_seconds / end_seconds.
    //
    // Anchoring: the heading text is OFTEN editorial (not spoken by the
    // narrator), so r.t is frequently null. Fall back to the interpolated
    // paragraph anchor in titleAnchors (built in Pass 1, which holds a `t`
    // for every title-card paragraph_index INCLUDING anchored:false
    // interpolated entries). We also remember whether the anchor was a
    // genuine spoken match (spokenAnchor) so the dedup pass below can decide
    // whether to claim narration time (spoken) or absorb nothing (overlay).
    if (!r.marker.youtube_url) {
      let cliplessT: number | null = r.t;
      let cliplessSpoken = r.t != null;
      if (cliplessT == null && r.marker.paragraph_index != null) {
        // Fallback: the title's own paragraph anchor (spoken or interpolated).
        for (const a of titleAnchors) {
          if (a.pIdx === r.marker.paragraph_index) { cliplessT = a.t; break; }
        }
        // An interpolated anchor means the text wasn't spoken — treat as an
        // overlay laid on top of continuing narration (absorb nothing).
        cliplessSpoken = false;
      }
      if (cliplessT == null) {
        // No spoken anchor AND no interpolated paragraph anchor — we have no
        // real video-time to place it at, so skip rather than guess.
        result.titleCardsSkipped++;
        continue;
      }
      // Duration: same typewriter logic. For a clipless card r.tEnd is
      // usually null (text not spoken / no measured span), so spokenDuration
      // is null and we fall through to the TITLE_CARD_FALLBACK_DURATION path
      // — keeping the overlay card SMALL (~3s) so it doesn't bloat the
      // timeline (title_card rows are non-adjustable downstream).
      const spokenDuration = r.tEnd != null && r.tEnd > cliplessT ? r.tEnd - cliplessT : null;
      const typewriterDuration = spokenDuration != null
        ? Math.max(TITLE_CARD_MIN_DURATION, spokenDuration)
        : TITLE_CARD_FALLBACK_DURATION;
      const parentDuration = spokenDuration != null
        ? typewriterDuration + TITLE_CARD_HOLD_TAIL
        : TITLE_CARD_FALLBACK_DURATION;
      // No sibling walk: a clipless card has no force clip and therefore no
      // stacked title_card_clip extras (those only follow a clip-bearing
      // title). Leave the outer loop cursor untouched so any following
      // markers are processed normally.
      groups.push({
        parent: r.marker,
        parentT: cliplessT,
        parentDuration,
        typewriterDuration,
        extras: [],
        clipless: true,
        spokenAnchor: cliplessSpoken,
        cardless: false,
      });
      continue;
    }
    if (r.t == null) {
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
    groups.push({
      parent: r.marker,
      parentT: r.t,
      parentDuration,
      typewriterDuration,
      extras,
      // Clip-bearing card: it always carries a youtube_url and is grouped
      // only when r.t != null (genuine spoken anchor), so the dedup pass
      // claims its typewriter audio share exactly as before.
      clipless: false,
      spokenAnchor: true,
      cardless: false,
    });
    // Skip the absorbed siblings so the outer loop doesn't re-process them
    // (the inner `if (r.marker.kind !== "title_card") continue;` would
    // skip title_card_clip extras anyway, but unaligned title_card extras
    // would otherwise come back through as their own groups and get
    // counted under titleCardsSkipped).
    g = h - 1;
  }

  // Section narration-end time for each group: the next title_card's
  // parentT in spoken-audio time, or +Infinity when this is the last
  // section. Used to clamp the forced YouTube clip's playback duration
  // so it never overflows into the next section's narration ("the doc
  // author picked a 30s clip but the section is only 18s of audio" case).
  const orderedGroupsAsc = [...groups].sort((a, b) => a.parentT - b.parentT);
  const sectionEndByGroupId = new Map<string, number>();
  for (let gi = 0; gi < orderedGroupsAsc.length; gi++) {
    const cur = orderedGroupsAsc[gi];
    const nxt = orderedGroupsAsc[gi + 1];
    sectionEndByGroupId.set(
      cur.parent.id,
      nxt ? nxt.parentT : Number.POSITIVE_INFINITY,
    );
  }

  // Insert groups in reverse spoken-time order so an earlier insertion
  // doesn't shift the index of a later one.
  const groupsByTimeDesc = [...groups].sort((a, b) => b.parentT - a.parentT);
  for (const group of groupsByTimeDesc) {
    const currentStarts = computeStarts(items);
    const k = findItemIndexAtTime(currentStarts, items, group.parentT);
    if (k < 0) {
      if (group.cardless) result.inlineClipsSkipped += 1 + group.extras.length;
      else result.titleCardsSkipped++;
      continue;
    }

    // How much audio narration sits between this title's audio-end and the
    // NEXT title's start. Forced YouTube clips must collectively play for
    // at most this many seconds — otherwise the visual continues past the
    // narrator entering the next section, producing the "wrong clip under
    // the wrong narration" mismatch the user reported.
    const sectionEndT = sectionEndByGroupId.get(group.parent.id) ?? Number.POSITIVE_INFINITY;
    const forcedAudioBudget = Number.isFinite(sectionEndT)
      ? Math.max(0, sectionEndT - (group.parentT + group.typewriterDuration))
      : Number.POSITIVE_INFINITY;
    // Running cursor: how much forced-clip duration we've already committed
    // for this section. Each new forced clip can take at most
    // (forcedAudioBudget - usedForcedAudio) before it overflows.
    let usedForcedAudio = 0;
    // Telemetry — surfaced via the result object so the matcher can log
    // when a clip got trimmed and by how much.
    const forcedClipTrimmings: Array<{
      markerId: string;
      requestedDur: number;
      trimmedDur: number;
      narrationBudget: number;
    }> = [];

    function forcedFootageFromMarker(m: ScriptMarkerRow, voStart: number): TimelineItemDraft {
      const start = m.start_seconds != null ? Number(m.start_seconds) : 0;
      const end = m.end_seconds != null ? Number(m.end_seconds) : start + 6;
      const requestedDur = Math.max(1, end - start);
      // Trim to fit the remaining narration budget for this section.
      // "Trim" = lower the playback duration only; the doc author's
      // YouTube URL + start_seconds stay intact, the renderer just plays
      // less of the clip than requested. Minimum playback = 1s so the
      // viewer at least registers the visual switched.
      const remainingBudget = Math.max(0, forcedAudioBudget - usedForcedAudio);
      const dur = Number.isFinite(remainingBudget)
        ? Math.max(1, Math.min(requestedDur, remainingBudget))
        : requestedDur;
      if (dur + 0.05 < requestedDur) {
        forcedClipTrimmings.push({
          markerId: m.id,
          requestedDur: Math.round(requestedDur * 100) / 100,
          trimmedDur: Math.round(dur * 100) / 100,
          narrationBudget: Math.round(forcedAudioBudget * 100) / 100,
        });
      }
      usedForcedAudio += dur;
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
      // When trimmed, the renderer should play start..start+dur, not
      // start..end (the doc author's original window). Adjusting
      // forced_clip.end_seconds here keeps the doc author's chosen IN
      // point intact while ensuring the cut is exactly the playback
      // duration we settled on.
      const trimmedEnd = start + dur;
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
          // Doc author's original requested duration before any trim. Lets
          // the editor surface "trimmed from 30s" UI and lets analyze-time
          // warnings cross-reference what the doc said vs. what the timeline
          // committed to.
          forced_clip_original_duration: Math.round(requestedDur * 100) / 100,
          forced_clip: {
            youtube_url: m.youtube_url,
            start_seconds: start,
            end_seconds: trimmedEnd,
          },
        },
        approved: false,
      };
    }

    // Title card's AUDIO window: [parentT, parentT + typewriterDuration).
    // The narrator is saying the title text itself only during the
    // typewriter window — the additional TITLE_CARD_HOLD_TAIL is a VISUAL
    // hold (so the viewer has a beat to read the fully-typed card) and
    // does not correspond to title narration. We previously used
    // parentDuration here, which over-claimed audio time by the tail
    // (~0.8s) and shifted every downstream row's vo_start metadata by
    // that amount.
    const audioWindowEnd = group.parentT + group.typewriterDuration;
    const titleSpokenText = spokenTextInWindow(
      wordsNN,
      group.parentT,
      audioWindowEnd,
    );
    const titleCardRow: TimelineItemDraft = {
      project_id: projectId,
      clip_id: null,
      type: "title_card",
      position: 0, // re-numbered below
      // Card occupies EXACTLY its narration (typewriter) span on the
      // timeline — NOT typewriterDuration + HOLD_TAIL. The narrator keeps
      // talking under the card (it's an overlay-style beat, not a pause), so
      // adding the ~0.8s visual hold tail as extra timeline length pushed
      // every following row — and therefore every later title card and
      // lower-third — ~0.8s later than its spoken moment. Across a handful of
      // cards that compounded into the multi-second "cards appear late" drift.
      // Using the typewriter span keeps the card's video length equal to its
      // audio window, so cumulative video-time tracks the voiceover and the
      // next clip cuts in exactly when the narrator moves on. The typewriter
      // animation still fits because typewriterDuration IS the typing time.
      duration: group.typewriterDuration,
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
        // Spoken-audio window the title card occupies. Without these the
        // proportional-fit pass treats the title card as "no audio" and
        // stretches surrounding image rows to absorb the narrator's title
        // phrase time — making an image hold past its sentence's real
        // spoken end. The window covers the typewriter (= narrated)
        // portion; the trailing visual hold (TITLE_CARD_HOLD_TAIL) is a
        // post-narration beat where the narrator has already moved on.
        vo_start_seconds: group.parentT,
        vo_end_seconds: audioWindowEnd,
      },
      approved: false,
    };
    // Forced clips play in sequence right after the title card. Their
    // voiceover windows are back-to-back starting at audioWindowEnd
    // (parentT + typewriterDuration), NOT parentT + parentDuration. The
    // 0.8s TITLE_CARD_HOLD_TAIL inside parentDuration is a VISUAL hold
    // (so the viewer reads the typed card) — the narrator has already
    // moved on to the next sentence during that tail. Anchoring forced
    // clips to audioWindowEnd keeps each row's vo_start metadata aligned
    // with what's actually being narrated under it.
    let forcedVoCursor = audioWindowEnd;
    // CLIPLESS card: build ONLY the title-card row, no forced footage. The
    // parent marker has no youtube_url / start_seconds / end_seconds, so
    // calling forcedFootageFromMarker on it would synthesize a bogus 6s clip
    // (end = start + 6 fallback) — guard against that by skipping it
    // entirely. A clipless card also never has extras (no sibling clips).
    //
    // CARDLESS group (inline_clip): the inverse — forced footage ONLY, no
    // title-card row. audioWindowEnd == parentT (typewriterDuration is 0)
    // so the forced rows' voiceover windows start right at the anchor
    // paragraph's first spoken word.
    const rows: TimelineItemDraft[] = group.cardless ? [] : [titleCardRow];
    if (!group.clipless) {
      const parentForced = forcedFootageFromMarker(group.parent, forcedVoCursor);
      forcedVoCursor += Number(parentForced.duration);
      rows.push(parentForced);
      for (const extra of group.extras) {
        const extraForced = forcedFootageFromMarker(extra, forcedVoCursor);
        forcedVoCursor += Number(extraForced.duration);
        rows.push(extraForced);
      }
    }

    // Compute the overlay window in voiceover-time before we mutate
    // items. The dedup pass deletes script rows whose vo_start_seconds
    // falls in [overlayWindowStart, overlayWindowEnd) — i.e. rows that
    // would have covered the SAME narration window the inserted block
    // now covers.
    //
    // overlayWindowStart = parentT (title narration begins)
    // overlayWindowEnd   = forcedVoCursor (parentT + audio window +
    //                      sum of forced clip durations)
    //
    // NOTE: forced clips ARE real rows that hold their own narration —
    // they're not silent overlays needing separate absorption. So the
    // overlay window ends where the forced clips end, but the dedup
    // pass only needs to absorb the TITLE CARD's narration share (the
    // forced clips already account for theirs by being rows). See the
    // dedup target below.
    // For clip-bearing AND spoken clipless cards, the overlay window runs to
    // forcedVoCursor (clipless: == audioWindowEnd, since there are no forced
    // rows — so it covers just the title card's own typewriter audio share).
    //
    // OVERLAY-ONLY clipless cards (spokenAnchor == false — the title text was
    // NOT found in the audio and the anchor came from interpolation) must
    // absorb NOTHING: the narrator never paused to "say the title", so the
    // typewriter window overlaps narration that belongs to a REAL sentence.
    // Deleting that sentence would lose script content. Collapse the window
    // to zero width (start == end) so Stage 1's removal loop deletes no rows
    // — we just splice the visual title-card row in on top of the continuing
    // narration. (Its duration is the small TITLE_CARD_FALLBACK_DURATION,
    // since overlay-only cards have r.tEnd == null → spokenDuration == null,
    // so it doesn't bloat the non-adjustable timeline.)
    const overlayOnly = group.clipless && !group.spokenAnchor;
    const overlayWindowStart = group.parentT;
    const overlayWindowEnd = overlayOnly ? overlayWindowStart : forcedVoCursor;

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
    if (group.cardless) {
      // Every row in a cardless group is a forced-footage clip.
      result.inlineClipsInserted += rows.length;
    } else {
      result.titleCardsInserted++;
      result.titleCardExtraClipsInserted += group.extras.length;
    }
    if (forcedClipTrimmings.length > 0) {
      result.forcedClipTrimmings.push(...forcedClipTrimmings);
    }

    // De-dup pass: when we insert the title card + forced clips at index k,
    // some script-driven rows already in the timeline cover the SAME
    // narration window. Without dedup, the same audio words would map to
    // both the inserted rows AND the surviving script rows, and the
    // timeline would grow past the voiceover length.
    //
    // CRITICAL DISTINCTION (this used to be wrong and caused missing
    // sentences):
    //   - The TITLE CARD is a true overlay row: the narrator is saying the
    //     title words during this window, but no script-driven row was
    //     going to cover those words (the planner doesn't know the title
    //     exists). So the title card's narration share IS new — but it
    //     also doesn't push other rows out, because typewriterDuration
    //     equals the spoken title duration.
    //   - FORCED CLIPS are also full rows that hold their own narration
    //     window (script_text = spokenTextInWindow over their voStart). A
    //     forced clip at vo_start=X with duration=D consumes exactly the
    //     narration of [X, X+D]. That narration was previously covered by
    //     whatever script row sat at vo_start=X; THAT script row is the one
    //     we need to delete. The forced clip is the REPLACEMENT, not an
    //     overlay on top of the replacement.
    //
    // So the dedup target is the TITLE CARD's audio duration PLUS the sum
    // of forced clip durations — but we only need to delete script rows
    // that fall in [overlayWindowStart, overlayWindowEnd). The previous
    // code summed ALL inserted rows (title card visual length + forced
    // clip durations) which over-absorbed by TITLE_CARD_HOLD_TAIL when
    // the title card's parentDuration included a visual hold tail. Now
    // that we've stopped over-claiming on the title card's audio window
    // (audioWindowEnd = parentT + typewriterDuration), the dedup target
    // is the simple sum of (title card audio share) + (forced clip durs).
    const titleCardAudioShare = audioWindowEnd - group.parentT; // == typewriterDuration
    // Filter by type rather than slicing past the card: cardless groups
    // have no title-card row, so rows[0] is already forced footage.
    const forcedClipsDuration = rows
      .filter((r) => r.type === "footage")
      .reduce((s, r) => s + Number(r.duration ?? 0), 0);
    const insertedDuration = titleCardAudioShare + forcedClipsDuration;
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
      // Never delete a row this pass itself inserted from a doc marker — a
      // title_card or forced-footage row belonging to ANOTHER group (groups
      // are inserted in reverse spoken-time order, so a neighboring group may
      // already sit inside this group's overlay window). Deleting it would
      // make that title card silently vanish. This is the case for two
      // clipless headings anchored close together: the earlier-spoken one's
      // dedup window covers the later one's card, which must survive. Only
      // script-driven rows (the planner's footage/image blocks) are eligible
      // for absorption here.
      if (meta.doc_marker_id != null) { r++; continue; }
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
    // Stage 2 (REMOVED): the old loop kept deleting subsequent script items
    // until absorbedDuration matched insertedDuration. That over-deleted
    // whenever insertedDuration > the actual spoken window — e.g. a 5s
    // typewriter + 8s forced clip = 13s "inserted", but if Stage 1 only
    // found 8s of overlapping script content (because some sentences sit
    // AFTER the title+clip audio window), Stage 2 would keep deleting
    // post-window sentences to "fill" the missing 5s. Those sentences are
    // narrated in audio that plays AFTER the forced clip ends — they need
    // their own visuals, not deletion.
    //
    // The fix: window-based deletion only. Stage 1 already deletes every
    // script row whose vo_start falls inside [overlayWindowStart,
    // overlayWindowEnd). That's the correct set — any sentence whose audio
    // is being covered by the doc-author's title card or forced clip.
    // Sentences past overlayWindowEnd narrate over their own clips and
    // must stay in the editor.
    //
    // Any residual mismatch between insertedDuration and absorbedDuration
    // is handled downstream by the proportional-fit pass, which sums the
    // picture timeline against voiceoverSeconds and scales adjustable rows
    // to close the gap. No row content needs to be deleted.
    void insertedDuration;
    void absorbedDuration;

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
      // Forced footage begins at the AUDIO end of the title card, not the
      // visual end — same anchor we used to set the forced clips'
      // vo_start_seconds metadata above. Using parentDuration here used
      // to shift the rescue window by TITLE_CARD_HOLD_TAIL (0.8s),
      // dropping lower-thirds whose spoken word fell in that 0.8s gap.
      let cursor = audioWindowEnd;
      // Start at 0, not 1: cardless groups have no title-card row at index
      // 0. The type check below skips the card when one is present.
      for (let r = 0; r < rows.length; r++) {
        const fr = rows[r];
        if (fr.type !== "footage") continue;
        const dur = Number(fr.duration ?? 0);
        forcedRows.push({ row: fr, voStart: cursor, voEnd: cursor + dur });
        cursor += dur;
      }
      const forcedWindowEnd = forcedRows.length > 0
        ? forcedRows[forcedRows.length - 1].voEnd
        : audioWindowEnd;
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

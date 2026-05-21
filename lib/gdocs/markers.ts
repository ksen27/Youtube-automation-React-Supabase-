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
  // Count of extra title_card_clip rows that successfully attached to their
  // parent title_card. Reported separately from titleCardsInserted so logs
  // can show how many doc-stacked clips actually got into the timeline.
  titleCardExtraClipsInserted: number;
  lowerThirdsApplied: number;
  lowerThirdsSkipped: number;
  // Total script items removed from the timeline because their narration
  // window was consumed by an inserted title_card + forced_footage overlay
  // (their script_text is being spoken under the overlay; rendering them
  // as separate scenes would duplicate the narration's visible position).
  itemsConsumed: number;
}

export function applyScriptMarkers(
  items: TimelineItemDraft[],
  markers: ScriptMarkerRow[],
  words: WordTiming[] | null | undefined,
  projectId: string,
  // Saved transcript paragraphs, in order. Used to translate a marker's
  // doc paragraph_index into a spoken-time window so the title-text
  // search is scoped to where the narrator is actually reading that
  // paragraph (instead of being free to false-match across the whole
  // audio). When omitted/empty, falls back to whole-audio search — same
  // behaviour as before this change.
  paragraphs: string[] = [],
): ApplyMarkersResult {
  const result: ApplyMarkersResult = {
    titleCardsInserted: 0,
    titleCardsSkipped: 0,
    titleCardExtraClipsInserted: 0,
    lowerThirdsApplied: 0,
    lowerThirdsSkipped: 0,
    itemsConsumed: 0,
  };
  if (!words || words.length === 0 || markers.length === 0) return result;

  // Pre-compute word-index ranges for each doc paragraph. The narrator
  // speaks paragraphs in order, so paragraph N occupies Deepgram words
  // [wordStart_N, wordEnd_N). We use this to scope a marker's title-text
  // search to the audio window for the paragraph it belongs to — the
  // marker's paragraph_index from parse.ts says exactly which paragraph
  // the title introduces.
  //
  // We find each paragraph's START by searching for its first ~5 tokens
  // in the Deepgram word stream (forward from the previous paragraph's
  // start). Naive word-count cumulation drifts because Deepgram word
  // counts diverge from doc word counts (filler words, contraction
  // splits, punctuation-attached tokens), and a drift of even 5 words
  // can land the title card a full sentence too early in the paragraph.
  const paragraphWordRanges: Array<{ start: number; end: number }> = [];
  if (paragraphs.length > 0) {
    let cursor = 0;
    for (let p = 0; p < paragraphs.length; p++) {
      const paraTokens = tokenize(paragraphs[p]);
      // Use 5 tokens as the anchor needle. Most paragraphs start with a
      // distinctive proper noun or sentence opener; 5 tokens is enough
      // to avoid false matches from short common phrases.
      const needleLen = Math.min(5, paraTokens.length);
      const needle = paraTokens.slice(0, needleLen);
      let foundStart = -1;
      if (needle.length > 0) {
        foundStart = findPhraseIndex(words, needle, cursor);
      }
      // Compute end as next paragraph's start (set in the next iteration)
      // or, for now, an estimate based on the paragraph's own word count.
      // We overwrite end below once we know the next paragraph's start.
      const start = foundStart >= 0 ? foundStart : cursor;
      const wordCount = paraTokens.length;
      const end = Math.min(words.length, start + wordCount);
      paragraphWordRanges.push({ start, end });
      cursor = Math.max(cursor, start + 1);
    }
    // Snap each paragraph's `end` to the next paragraph's `start` (when
    // available) so the search window for paragraph N covers everything
    // up to paragraph N+1's first word.
    for (let p = 0; p < paragraphWordRanges.length - 1; p++) {
      const nextStart = paragraphWordRanges[p + 1].start;
      if (nextStart > paragraphWordRanges[p].start) {
        paragraphWordRanges[p].end = nextStart;
      }
    }
  }

  // Resolve each marker's spoken-time window once. We store both the start
  // (`t`) — the moment the narrator begins saying the phrase — and the end
  // (`tEnd`) — the moment they finish. The title card uses tEnd to pin its
  // own duration so the typewriter animation completes in sync with the
  // narrator. Multiple markers may share the same phrase (e.g. a person's
  // name appearing many times) — we walk forward, only matching each
  // phrase the Nth time so duplicate phrases align to distinct spoken
  // instances.
  const phraseSearchCursor = new Map<string, number>();
  const resolved: Array<{ marker: ScriptMarkerRow; t: number | null; tEnd: number | null }> = [];
  // Sort by ordinal so the cursor walk respects doc order across kinds.
  const ordered = [...markers].sort((a, b) => a.ordinal - b.ordinal);
  for (const m of ordered) {
    const tokens = tokenize(m.text);
    // Determine the search window for this marker. Title cards anchor at
    // the paragraph they introduce: search starts at that paragraph's
    // first word. Lower-thirds keep the old whole-audio walk because they
    // are commonly short phrases that may legitimately appear anywhere
    // their text matches the narration.
    const paraIdx = m.paragraph_index;
    const useParagraphWindow =
      (m.kind === "title_card" || m.kind === "title_card_clip")
      && paraIdx != null
      && paraIdx >= 0
      && paraIdx < paragraphWordRanges.length;
    // For a title_card, the spoken anchor is the FIRST WORD of the
    // paragraph the title introduces — that is what the doc structure
    // says: "title sits between paragraph N-1 and paragraph N, so it
    // appears on screen as the narrator begins paragraph N". The title
    // text itself may or may not be spoken verbatim by the narrator;
    // we still try to find it inside the paragraph window to derive a
    // real duration, but the position is anchored by the doc.
    if (m.kind === "title_card_clip") {
      // Extras share the parent's anchor (no own text). The grouping
      // pass below uses the parent's resolved t.
      resolved.push({ marker: m, t: null, tEnd: null });
      continue;
    }
    if (useParagraphWindow && m.kind === "title_card") {
      const range = paragraphWordRanges[paraIdx as number];
      // Anchor position = paragraph's first word.
      const anchorT = words[range.start]?.start ?? null;
      if (anchorT == null) {
        resolved.push({ marker: m, t: null, tEnd: null });
        continue;
      }
      // Try to find the title text WITHIN the paragraph window so we can
      // size the card to the spoken length. If found, use that range.
      // If not, leave tEnd null — the title-card pass uses
      // TITLE_CARD_FALLBACK_DURATION in that case.
      let foundT: number | null = null;
      let foundTEnd: number | null = null;
      if (tokens.length > 0) {
        const searchEnd = Math.max(range.start + tokens.length, range.end);
        for (let i = range.start; i + tokens.length <= searchEnd && i + tokens.length <= words.length; i++) {
          let ok = true;
          for (let j = 0; j < tokens.length; j++) {
            if (normalizeToken(words[i + j].word) !== tokens[j]) { ok = false; break; }
          }
          if (ok) {
            foundT = words[i].start;
            foundTEnd = words[i + tokens.length - 1].end;
            break;
          }
        }
      }
      resolved.push({
        marker: m,
        t: foundT ?? anchorT,
        tEnd: foundTEnd,
      });
      continue;
    }
    // Legacy whole-audio search path: lower_thirds, and title_cards
    // without a usable paragraph_index (pre-fix markers).
    if (tokens.length === 0) {
      resolved.push({ marker: m, t: null, tEnd: null });
      continue;
    }
    const key = tokens.join(" ");
    const from = phraseSearchCursor.get(key) ?? 0;
    const idx = findPhraseIndex(words, tokens, from);
    if (idx < 0) {
      resolved.push({ marker: m, t: null, tEnd: null });
      continue;
    }
    phraseSearchCursor.set(key, idx + tokens.length);
    const lastIdx = idx + tokens.length - 1;
    resolved.push({
      marker: m,
      t: words[idx].start,
      tEnd: words[lastIdx].end,
    });
  }

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
    // Card duration in seconds — measured from Deepgram word timings as
    // (last word end - first word start) so the typewriter animation
    // finishes when the narrator finishes saying the phrase. Floored at
    // TITLE_CARD_MIN_DURATION for very short titles. Null only when the
    // resolution lacked a tEnd (shouldn't happen when t is set, but defensive).
    parentDuration: number;
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
    const parentDuration = spokenDuration != null
      ? Math.max(TITLE_CARD_MIN_DURATION, spokenDuration)
      : TITLE_CARD_FALLBACK_DURATION;
    const extras: ScriptMarkerRow[] = [];
    // Walk forward collecting title_card_clip siblings. Stop at the next
    // non-clip marker (another title_card, lower_third with intervening
    // text, etc) or end of stream.
    let h = g + 1;
    while (h < orderedResolutions.length
        && orderedResolutions[h].marker.kind === "title_card_clip") {
      const sib = orderedResolutions[h].marker;
      if (sib.youtube_url) extras.push(sib);
      h++;
    }
    groups.push({ parent: r.marker, parentT: r.t, parentDuration, extras });
  }

  // Insert groups in reverse spoken-time order so an earlier insertion
  // doesn't shift the index of a later one.
  const groupsByTimeDesc = [...groups].sort((a, b) => b.parentT - a.parentT);
  for (const group of groupsByTimeDesc) {
    const currentStarts = computeStarts(items);
    const k = findItemIndexAtTime(currentStarts, items, group.parentT);
    if (k < 0) { result.titleCardsSkipped++; continue; }

    function forcedFootageFromMarker(m: ScriptMarkerRow): TimelineItemDraft {
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
      return {
        project_id: projectId,
        clip_id: null,
        type: "footage",
        position: 0, // re-numbered below
        duration: dur,
        script_text: null,
        overlay_text: null,
        metadata: {
          placeholder: false,
          planned: false,
          pick_source: "doc_marker_forced",
          doc_marker_id: m.id,
          thumbnail_url: thumbnailUrl,
          forced_clip: {
            youtube_url: m.youtube_url,
            start_seconds: start,
            end_seconds: end,
          },
        },
        approved: false,
      };
    }

    const titleCardRow: TimelineItemDraft = {
      project_id: projectId,
      clip_id: null,
      type: "title_card",
      position: 0, // re-numbered below
      duration: group.parentDuration,
      script_text: null,
      overlay_text: group.parent.text,
      metadata: {
        placeholder: false,
        planned: false,
        pick_source: "doc_marker",
        doc_marker_id: group.parent.id,
        doc_marker_kind: "title_card",
        // Signal to the renderer that this card should be typed in,
        // animating across the full segment duration. The renderer reads
        // this in buildTitleCardVideo to switch from static to typewriter.
        animation: "typewriter",
      },
      approved: false,
    };
    const rows: TimelineItemDraft[] = [titleCardRow, forcedFootageFromMarker(group.parent)];
    for (const extra of group.extras) {
      rows.push(forcedFootageFromMarker(extra));
    }

    // Consume-and-trim: the narrator's voiceover plays continuously under
    // the title card + forced footage. The script items in the window
    // [parentT, parentT + overlayDuration) are being spoken under the
    // overlay; rendering them as separate scenes would duplicate the
    // narration's visible position and grow the timeline past the
    // voiceover. So we REMOVE those items and splice the overlay in their
    // place, preserving total timeline length.
    //
    // Last consumed item may overshoot — keep only the residual seconds
    // after the overlay window so the narration AFTER the overlay still
    // has a scene tied to it.
    const overlayDuration = rows.reduce((s, r) => s + r.duration, 0);
    const overlayStart = currentStarts[k];
    const overlayEnd = overlayStart + overlayDuration;
    let consumedCount = 0;
    let trimmedResidualDuration: number | null = null;
    for (let c = k; c < items.length; c++) {
      const itemStart = currentStarts[c];
      const itemEnd = itemStart + items[c].duration;
      if (itemEnd <= overlayEnd + 0.01) {
        // Item fully inside overlay window — consume entirely.
        consumedCount++;
        continue;
      }
      // Item straddles the overlay end — trim its head, keep the residual.
      // The narration after the overlay reads the tail of this item's
      // script_text, so we keep script_text intact and just shrink duration.
      trimmedResidualDuration = Math.round((itemEnd - overlayEnd) * 10) / 10;
      consumedCount++;
      break;
    }
    if (trimmedResidualDuration != null && trimmedResidualDuration > 0.05) {
      // Mutate the straddling item to its residual length BEFORE splicing
      // so the splice indices are stable.
      items[k + consumedCount - 1].duration = trimmedResidualDuration;
      // Splice in overlay rows BEFORE the residual, removing (consumedCount - 1)
      // fully-consumed items in the same call.
      items.splice(k, consumedCount - 1, ...rows);
      result.itemsConsumed += consumedCount - 1;
    } else {
      // No residual — every overlapping item is fully inside the overlay.
      items.splice(k, consumedCount, ...rows);
      result.itemsConsumed += consumedCount;
    }
    result.titleCardsInserted++;
    result.titleCardExtraClipsInserted += group.extras.length;
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
    // An extra is "orphaned" if the preceding ordinal isn't a title_card
    // OR that title_card was skipped (no t, no youtube_url).
    const prev = orderedResolutions[idx - 1];
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

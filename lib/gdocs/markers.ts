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

export function applyScriptMarkers(
  items: TimelineItemDraft[],
  markers: ScriptMarkerRow[],
  words: WordTiming[] | null | undefined,
  projectId: string,
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

  // Resolve each marker's spoken-time window by finding its text in the
  // Deepgram word stream. The narrator speaks the title text aloud in the
  // audio (e.g. "the moment that changed everything the walliams recording"
  // is spoken between the end of one paragraph and the start of the next);
  // we anchor the card at that exact spoken moment. Walking a cursor
  // forward through `words` keeps duplicate phrases (a name appearing many
  // times) aligned to distinct spoken instances rather than all snapping
  // to the first hit.
  const phraseSearchCursor = new Map<string, number>();
  const resolved: Array<{ marker: ScriptMarkerRow; t: number | null; tEnd: number | null }> = [];
  // Sort by ordinal so the cursor walk respects doc order across kinds.
  const ordered = [...markers].sort((a, b) => a.ordinal - b.ordinal);
  for (const m of ordered) {
    // title_card_clip rows are doc-stacked extra timestamps under a title
    // — they share the parent title's spoken anchor and have no own text
    // to search for. Resolution is deferred to the grouping pass below.
    if (m.kind === "title_card_clip") {
      resolved.push({ marker: m, t: null, tEnd: null });
      continue;
    }
    const tokens = tokenize(m.text);
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
    groups.push({ parent: r.marker, parentT: r.t, parentDuration, extras });
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

    // Voiceover-time cursor: advanced as we build each row so every row's
    // script_text reflects what the narrator is saying during its own
    // window. Title card starts at `parentT` (the title's spoken moment),
    // forced footage continues from where the title ends, and stacked
    // extras chain after the first forced footage.
    let voCursor = group.parentT;
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
      // Capture the narration spoken in this clip's voiceover window so
      // the editor shows the script text the user will hear under this
      // clip, instead of "No script text".
      const voStart = voCursor;
      const voEnd = voCursor + dur;
      const scriptText = spokenTextInWindow(wordsNN, voStart, voEnd);
      voCursor = voEnd;
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
    voCursor = group.parentT + group.parentDuration;
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

    // Compute the overlay window in voiceover-time before we mutate
    // items. We use this below to remove any subsequent script items
    // whose narration falls entirely inside the overlay — their
    // script_text already appears on the title card / forced footage
    // rows (those rows pulled the spoken words via spokenTextInWindow
    // above), so leaving them as separate scenes shows the same line
    // of narration twice in the editor.
    const overlayWindowStart = group.parentT;
    const overlayWindowEnd = group.parentT + rows.reduce((s, r) => s + r.duration, 0);

    // Insert the title card + forced footage BEFORE the script item playing
    // at the title's spoken moment. The narrator reaches the title text at
    // voiceover time `parentT`; the item at index k is whatever scene the
    // editor is showing at that moment. Splicing before k makes the title
    // appear at exactly the right narration beat, with the surrounding
    // script items unchanged on either side of it.
    items.splice(k, 0, ...rows);
    result.titleCardsInserted++;
    result.titleCardExtraClipsInserted += group.extras.length;

    // De-dup pass: any script item whose narration falls inside the
    // overlay window is redundant — the overlay rows we just inserted
    // already display that narration in their own script_text fields
    // (spokenTextInWindow extracts the narrator's words during each
    // overlay row's duration). Leaving the original script items in
    // place shows the same line of narration twice in the editor.
    //
    // We use itStart as the test: an item whose vo START is inside the
    // overlay window has its narration playing under the overlay (even
    // if its stored vo_end overshoots slightly past the overlay end —
    // a 0.3s overshoot still represents the same spoken sentence the
    // forced-footage row already captured).
    //
    // Walk forward from just after the inserted rows. Stop as soon as
    // we hit an item whose start is past the overlay end — items in
    // narration order beyond that point can't be inside the overlay.
    // Items without stored vo_start are left alone (they predate the
    // vo_start metadata and can't be reliably classified).
    const afterOverlayIdx = k + rows.length;
    for (let r = afterOverlayIdx; r < items.length; ) {
      const it = items[r];
      if (it.type === "intro") { r++; continue; }
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      const itStart = meta.vo_start_seconds;
      if (typeof itStart !== "number") { r++; continue; }
      if (itStart >= overlayWindowEnd - 0.05) break;
      if (itStart >= overlayWindowStart - 0.05) {
        items.splice(r, 1);
        continue;
      }
      r++;
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

// Transcript-driven block sequence builder.
//
// Replaces buildBlockSequenceFromHints (timeline-plan.ts). The fundamental
// difference: input is the SENTENCE LIST (deterministic, never drops a
// sentence), not the Gemini hint stream (which silently dropped/merged
// sentences). Per-sentence visual metadata is looked up from Gemini via
// gemini-enrichment.ts; sentences with no Gemini match default to
// footage on the project celebrity.
//
// Output: PlannedBlockWithHint[] with one logical block per sentence
// plus optional title_card prepends. The matcher consumes this array
// the same way it consumed buildBlockSequenceFromHints' output — no
// downstream changes required.
//
// Short-sentence grouping (visual-only):
//   When a sentence is under SHORT_SENTENCE_SECONDS, it would produce a
//   1-2 second visual flash that looks choppy. Instead we GROUP it with
//   a neighbor that shares the same subject so they share one visual
//   block (one clip / one image). The grouping is recorded on the
//   block's metadata as `group_id` so the renderer reuses the same
//   clip slot across all sentences in the group, while the editor UI
//   still sees one row per sentence (each row's script_text is its
//   own sentence's text).

import type { AlignedSentence } from "./sentence-alignment";
import type { EnrichmentLookup } from "./gemini-enrichment";
import { enrichmentForSentence } from "./gemini-enrichment";
import type { PlannedBlockWithHint } from "./timeline-plan";
import { IMAGE_HOLD_SECONDS } from "./timeline-plan";

// Sentence shorter than this is considered "short" — its visual block
// looks too brief on its own, so we try to fold it into a neighbor's
// visual block. Editor rows stay 1:1 with sentences; only the clip
// assignment is shared.
export const SHORT_SENTENCE_SECONDS = 3;

// Title-card hold time. Renderer treats this as a black-card visual
// segment over the voiceover audio. Per client spec — section title
// shows for exactly this long while the narrator speaks the section's
// first sentence underneath.
//
// NOTE: this is the UPPER BOUND on the card's on-screen hold, NOT the
// amount of the sentence's spoken time the card consumes. The narrator
// says the title phrase in ~1-1.5s and then keeps talking; the card is an
// OVERLAY over that continuing narration, not a pause. We therefore
// consume only the title phrase's estimated SPOKEN duration (see
// estimateTitleSpokenSeconds) from the sentence's window — capped at this
// value — so the section's first sentence keeps the rest of its real
// spoken time on its own content block instead of being shoved forward.
export const TITLE_CARD_HOLD_SECONDS = 5;

// Standard English voiceover narration cadence (words/sec) used to
// estimate how long the narrator spends SAYING a title phrase. 2.5 wps
// (150 wpm) matches the alignment fallback (sentence-alignment.ts:
// FALLBACK_WPS). The builder doesn't have the title's measured Deepgram
// span (markers.ts does, and re-anchors the card later), so we estimate
// from the title's word count.
const TITLE_SPOKEN_WPS = 2.5;

// Floor on the consumed title time. A one- or two-word heading ("Now.",
// "The End.") still needs a readable beat, and a card shorter than this
// reads as a flash. Mirrors markers.ts TITLE_CARD_MIN_DURATION (1.5s).
const TITLE_SPOKEN_FLOOR_SECONDS = 1.5;

// Estimate how many seconds the narrator spends speaking a title phrase,
// from its word count. Bounded to [floor, TITLE_CARD_HOLD_SECONDS]. This
// is what the card CONSUMES from the section-first sentence — far less
// than the old flat TITLE_CARD_HOLD_SECONDS, which over-claimed up to ~4s
// of a short opener and pushed its content block past the real spoken
// start.
function estimateTitleSpokenSeconds(titleText: string): number {
  const words = titleText.trim().split(/\s+/).filter((w) => w.length > 0).length;
  const est = words > 0 ? words / TITLE_SPOKEN_WPS : TITLE_SPOKEN_FLOOR_SECONDS;
  return Math.min(TITLE_CARD_HOLD_SECONDS, Math.max(TITLE_SPOKEN_FLOOR_SECONDS, est));
}

// Combined cap on a sentence group's TOTAL spoken duration. Keeps a
// chain of 3+ tiny sentences from collapsing into one ungainly 10s
// visual block. ~8s is the upper end of a normal clip length.
const GROUP_TOTAL_CAP_SECONDS = 8;

// Image-hold policy: see projects.image_hold_policy column. The user
// confirmed "sentence_duration" is the right default — visual stays on
// screen for exactly the sentence's spoken time. For long sentences
// (>10s) we split into multiple back-to-back IMAGE_HOLD_SECONDS slots
// of the SAME subject so the viewer sees fresh framing every ~5s
// without breaking the audio/visual sync rule.
export type ImageHoldPolicy = "sentence_duration" | "fixed_5s";

export interface TranscriptBuildArgs {
  sentences: AlignedSentence[];
  enrichment: EnrichmentLookup;
  // Set of paragraph indices that have a blue-bold title_card marker.
  // The builder prepends a 5s title_card row at each section-first
  // sentence's vo_start. Use the marker's text as the title.
  titleCardTextByParagraph: Map<number, string>;
  // Project celebrity / main subject. Used as the fallback resolved_subject
  // when a sentence has no Gemini match or Gemini left it empty.
  mainCelebrity: string;
  // How to size image blocks for long sentences. "sentence_duration"
  // keeps the image on screen for the full sentence; "fixed_5s" splits
  // long image sentences into N back-to-back ~5s slots.
  imageHoldPolicy: ImageHoldPolicy;
  // Upper bound on the fraction of CONTENT blocks (image + footage; title
  // cards and intro excluded) that may be images. Gemini's per-sentence
  // recommended_visual_type tends to land ~50% images, which (a) over-uses
  // the verified image pool — forcing the same celebrity photo to repeat
  // across many slots — and (b) reads as a slideshow. The clip pool is
  // plentiful, so we cap images at this ratio and convert the LOWEST
  // visual_priority image blocks to footage until the cap is met. Default
  // 0.30 → a 30:70 image:footage split. Set 0.40 for 40:60.
  maxImageRatio?: number;
}

export interface TranscriptBuildResult {
  blocks: PlannedBlockWithHint[];
  // Per-block sentence index. blocks[i] corresponds to sentence[blockSentenceIndex[i]].
  // Title-card prepend blocks carry the sentence index they're attached to.
  blockSentenceIndex: number[];
  // Per-block group id. Sentences in the same short-sentence group share
  // the same id; standalone sentences each have a unique id. The matcher
  // uses this to assign one clip per group instead of one per block.
  blockGroupId: string[];
  // True when the block is a title_card prepend (vs. a sentence's own
  // content block). The matcher writes is_title_card_overlay=true on
  // these so the editor / renderer can treat them as overlays.
  blockIsTitleCard: boolean[];
  // Diagnostics — surfaced via logJob so we can audit short-grouping
  // behavior on real projects.
  shortSentencesGrouped: number;
  titleCardsInserted: number;
  imageSplitCount: number;
  // Number of short sentences merged into a neighboring sentence's editor
  // row by the pre-pass that folds rhythmic narration beats. Higher =
  // fewer 1-2s flash blocks in the final editor view.
  shortSentencesMerged: number;
  // Number of image blocks converted to footage by the image:footage ratio
  // cap (lowest visual_priority first). 0 when Gemini's split was already
  // within the cap.
  imagesConvertedToFootage: number;
}

// Decide which neighbor a short sentence groups with.
//
// The rule (per user spec): match by subject. If the short sentence's
// resolved_subject matches the PREVIOUS sentence's, group backward.
// Else if it matches the NEXT, group forward. Else fall back to FORWARD
// (so a short opening sentence becomes a head of the next sentence's
// visual rather than a tail of the prior section's).
function pickGroupDirection(
  prev: { subj: string } | null,
  cur: { subj: string },
  next: { subj: string } | null,
): "backward" | "forward" | "alone" {
  const curSubj = cur.subj.trim().toLowerCase();
  const prevSubj = prev?.subj.trim().toLowerCase() ?? "";
  const nextSubj = next?.subj.trim().toLowerCase() ?? "";
  const prevMatch = curSubj.length > 0 && prevSubj === curSubj;
  const nextMatch = curSubj.length > 0 && nextSubj === curSubj;
  if (prevMatch) return "backward";
  if (nextMatch) return "forward";
  // No subject match in either direction. Prefer FORWARD so short
  // openings join the next section's visual; short trailing thoughts
  // (where next is null) fall to "alone" and stay their own block.
  if (next != null) return "forward";
  if (prev != null) return "backward";
  return "alone";
}

// Group short sentences into visual groups. Returns per-sentence
// group-id assignments. Sentences in the same group share one visual
// block; standalone sentences each get their own group.
//
// Important: this DOES NOT merge editor rows. The block sequence still
// has one block per sentence — the group only affects clip assignment.
function assignGroups(
  sentences: AlignedSentence[],
  subjects: string[],
): { groupIds: string[]; grouped: number } {
  const n = sentences.length;
  const groupIds = new Array<string>(n);
  let nextGroupCounter = 0;
  function newGroupId(): string {
    nextGroupCounter++;
    return `g${nextGroupCounter}`;
  }
  let grouped = 0;
  for (let i = 0; i < n; i++) {
    if (groupIds[i]) continue;
    const dur = sentences[i].vo_end - sentences[i].vo_start;
    if (dur >= SHORT_SENTENCE_SECONDS) {
      groupIds[i] = newGroupId();
      continue;
    }
    // Short sentence — try to attach to a neighbor by subject match.
    const prev = i > 0 ? { subj: subjects[i - 1] } : null;
    const cur = { subj: subjects[i] };
    const next = i < n - 1 ? { subj: subjects[i + 1] } : null;
    const dir = pickGroupDirection(prev, cur, next);
    if (dir === "backward" && prev) {
      // Check the combined group's total duration won't exceed the cap.
      const groupTotal = sumGroupDuration(sentences, groupIds, i - 1) + dur;
      if (groupTotal <= GROUP_TOTAL_CAP_SECONDS) {
        groupIds[i] = groupIds[i - 1] || (groupIds[i - 1] = newGroupId());
        grouped++;
        continue;
      }
    }
    if (dir === "forward" && next) {
      // Pre-assign the next sentence's group too if it doesn't have one,
      // so subsequent shorts can chain onto the same group.
      let nextId = groupIds[i + 1];
      if (!nextId) {
        nextId = newGroupId();
        groupIds[i + 1] = nextId;
      }
      const nextDur = sentences[i + 1].vo_end - sentences[i + 1].vo_start;
      if (dur + nextDur <= GROUP_TOTAL_CAP_SECONDS) {
        groupIds[i] = nextId;
        grouped++;
        continue;
      }
    }
    // No grouping possible — stay alone.
    groupIds[i] = newGroupId();
  }
  return { groupIds, grouped };
}

function sumGroupDuration(
  sentences: AlignedSentence[],
  groupIds: string[],
  upToIndex: number,
): number {
  if (upToIndex < 0) return 0;
  const targetId = groupIds[upToIndex];
  if (!targetId) {
    return sentences[upToIndex].vo_end - sentences[upToIndex].vo_start;
  }
  let total = 0;
  for (let i = 0; i <= upToIndex; i++) {
    if (groupIds[i] === targetId) {
      total += sentences[i].vo_end - sentences[i].vo_start;
    }
  }
  return total;
}

// Build the timeline. Walks aligned sentences in narration order,
// prepends title_card rows at section starts, and emits one block per
// sentence with its enrichment-derived visual type.
//
// Image hold policy:
//   - sentence_duration: a 9s image-typed sentence becomes ONE 9s image
//     block (visual changes when sentence changes).
//   - fixed_5s: a 9s image-typed sentence becomes TWO ~4.5s image blocks
//     of the same subject (more visual variety, but the visual changes
//     mid-sentence).
//   In BOTH cases the block sentence index points to the same sentence
//   so the editor still shows one row per sentence; the fixed_5s split
//   produces extra sub-blocks that share the row's metadata.
//
// Title cards:
//   - For each blue-bold section paragraph, prepend a TITLE_CARD_HOLD_SECONDS
//     block at the section's first sentence's vo_start. The card overlays
//     the first 5s of the narrator speaking the sentence — the renderer's
//     voiceover audio track plays continuously underneath.
//   - The title_card block's vo_start/vo_end == the FIRST 5s of the
//     sentence's audio window. The sentence's own block carries the
//     sentence's FULL audio window (including those first 5s — the
//     renderer overlays them visually).
//
// Returns the block list plus parallel arrays (sentence index, group id,
// is-title-card) so the matcher can write per-block metadata without
// recomputing.
export function buildBlockSequenceFromTranscript(
  args: TranscriptBuildArgs,
): TranscriptBuildResult {
  // imageHoldPolicy is accepted for forward compatibility but no longer
  // gates the multi-image split — long image sentences always split
  // (sentence_duration / N per slot) and short ones hold for the exact
  // sentence duration. The narrator's spoken time is the source of truth
  // either way.
  const { sentences, enrichment, titleCardTextByParagraph, mainCelebrity } = args;
  const blocks: PlannedBlockWithHint[] = [];
  const blockSentenceIndex: number[] = [];
  const blockGroupId: string[] = [];
  const blockIsTitleCard: boolean[] = [];

  // Resolve subjects up front so the grouping pass can match on them.
  const enrichments = sentences.map((_, i) =>
    enrichmentForSentence(enrichment, i, mainCelebrity),
  );
  const subjects = enrichments.map((e) => e.resolved_subject);

  // Short-sentence MERGE pass — combine consecutive short sentences into a
  // single block instead of producing 1-2s editor rows. The narrator writes
  // punchy beats ("About the pain. About the recovery. About the years.")
  // that, at sentence-per-row granularity, become flash-cut visual chaos:
  // the viewer's eye can't land on a 1s clip before it jumps to the next.
  //
  // We merge when ALL of these hold for adjacent sentences:
  //   • Both are SHORT (< SHORT_SENTENCE_SECONDS)
  //   • Same paragraph (never cross a doc paragraph boundary)
  //   • Neither is a section opener (title card always anchors its own row)
  //   • Combined duration stays below MERGE_TOTAL_CAP (no giant blocks)
  //
  // The resulting merged "sentence" carries concatenated text, the earliest
  // sentence's enrichment, and the union of vo_start/vo_end. It looks like
  // a single sentence to the rest of this function.
  // Two-pass merge strategy. The earlier single-pass design only merged
  // FORWARD (a short sentence absorbing later short sentences), which
  // missed the most common pattern from real narration: a short beat
  // ("Three times.", "He said he was sorry.") sitting between two
  // independently-LONG sentences. The base sentence was long, so the
  // outer loop's "non-mergeable base" branch passed it through; then the
  // short sentence's only neighbor was another long one, so forward-merge
  // also failed. Result: the 2s short sentence ended up as its own editor
  // row anyway.
  //
  // Pass 1 — Forward-merge runs of short same-paragraph sentences into
  //          single combined blocks (rhythmic beats like "About the pain.
  //          About the recovery." still collapse into one row).
  // Pass 2 — Any short sentence that's STILL standalone after Pass 1
  //          gets appended BACKWARD onto the previous block when the
  //          combined duration stays under MERGE_TOTAL_CAP and both
  //          live in the same paragraph. This catches the "Three times."
  //          pattern that Pass 1 can't reach.
  //
  // Visual outcome: per-block durations stay >= 5s (the IMAGE_HOLD floor),
  // matching the user's "every visual must hold for at least 5s" rule.
  const MERGE_TOTAL_CAP = 8; // max combined duration after merging
  const MIN_MERGEABLE = 5;   // sentences shorter than 5s are merge candidates
  type MergedSentence = AlignedSentence & { _sourceIndices: number[] };
  const mergedSentences: MergedSentence[] = [];
  const mergedEnrichments: typeof enrichments = [];
  const mergedSubjects: string[] = [];

  // Pass 1: forward-merge runs of short same-paragraph sentences.
  {
    let i = 0;
    while (i < sentences.length) {
      const base = sentences[i];
      const baseDur = base.vo_end - base.vo_start;
      // Non-mergeable BASE: long sentence, section opener, or last sentence.
      // Long sentences pass through unchanged. Pass 2 will optionally append
      // a trailing short sentence to them.
      if (
        baseDur >= MIN_MERGEABLE ||
        base.is_section_first_sentence ||
        i === sentences.length - 1
      ) {
        mergedSentences.push({ ...base, _sourceIndices: [i] });
        mergedEnrichments.push(enrichments[i]);
        mergedSubjects.push(subjects[i]);
        i++;
        continue;
      }
      // Walk forward absorbing consecutive short same-paragraph sentences.
      const indices = [i];
      let accStart = base.vo_start;
      let accEnd = base.vo_end;
      let accText = base.text;
      let lookahead = i + 1;
      while (lookahead < sentences.length) {
        const cand = sentences[lookahead];
        if (cand.paragraph_index !== base.paragraph_index) break;
        if (cand.is_section_first_sentence) break;
        const candDur = cand.vo_end - cand.vo_start;
        if (candDur >= MIN_MERGEABLE) break;
        if ((accEnd - accStart) + candDur > MERGE_TOTAL_CAP) break;
        accEnd = cand.vo_end;
        accText = `${accText} ${cand.text}`;
        indices.push(lookahead);
        lookahead++;
      }
      mergedSentences.push({
        ...base,
        text: accText,
        vo_end: accEnd,
        _sourceIndices: indices,
      });
      mergedEnrichments.push(enrichments[i]);
      mergedSubjects.push(subjects[i]);
      i = lookahead;
    }
  }

  // Pass 2: backward-fold any remaining standalone short blocks into the
  // previous block when it still has headroom. We walk the post-pass-1
  // array and remove short blocks whose previous block can absorb them.
  // Section openers never absorb (they anchor title cards) and never get
  // folded into a predecessor (their paragraph is the start of a chapter).
  {
    const out: typeof mergedSentences = [];
    const outEnr: typeof mergedEnrichments = [];
    const outSubj: typeof mergedSubjects = [];
    for (let i = 0; i < mergedSentences.length; i++) {
      const cur = mergedSentences[i];
      const curDur = cur.vo_end - cur.vo_start;
      const isShortStandalone =
        curDur < MIN_MERGEABLE &&
        cur._sourceIndices.length === 1 &&
        !cur.is_section_first_sentence;
      if (out.length > 0 && isShortStandalone) {
        const prev = out[out.length - 1];
        // Don't cross paragraph boundaries; don't absorb into a section
        // opener (those carry title cards and must stay clean). The
        // section-opener exclusion was previously only described in this
        // comment but never enforced — folding a trailing short sentence
        // INTO the opener stretched the opener's spoken window, which then
        // let the title-card prepend consume more of it and shoved the
        // opener's CONTENT block several seconds past its real spoken start
        // (the "title card holds 7s, next sentence squeezed to 1s" bug).
        if (
          prev.paragraph_index === cur.paragraph_index &&
          !prev.is_section_first_sentence &&
          (prev.vo_end - prev.vo_start) + curDur <= MERGE_TOTAL_CAP
        ) {
          prev.text = `${prev.text} ${cur.text}`;
          prev.vo_end = cur.vo_end;
          prev._sourceIndices.push(...cur._sourceIndices);
          continue;
        }
      }
      out.push(cur);
      outEnr.push(mergedEnrichments[i]);
      outSubj.push(mergedSubjects[i]);
    }
    mergedSentences.length = 0;
    mergedSentences.push(...out);
    mergedEnrichments.length = 0;
    mergedEnrichments.push(...outEnr);
    mergedSubjects.length = 0;
    mergedSubjects.push(...outSubj);
  }
  const shortSentencesMerged = sentences.length - mergedSentences.length;

  // From here on, operate on the merged sequence as if it were the
  // original sentence list. Group assignment, title-card prepend, and
  // block emission all use mergedSentences.
  const workingSentences = mergedSentences as AlignedSentence[];
  const workingEnrichments = mergedEnrichments;

  // Decide visual groups for any remaining short sentences. After the merge
  // pass most short sentences are folded in, but the grouping logic stays
  // as a safety net for any short opener / paragraph-trailing sentence
  // that couldn't be merged.
  const { groupIds, grouped } = assignGroups(workingSentences, mergedSubjects);

  let titleCardsInserted = 0;
  let imageSplitCount = 0;

  for (let i = 0; i < workingSentences.length; i++) {
    const s = workingSentences[i];
    const enr = workingEnrichments[i];
    const fullSentenceDuration = Math.max(0.1, s.vo_end - s.vo_start);

    // Title-card prepend. Only triggers on the FIRST sentence of a
    // blue-bold paragraph (is_section_first_sentence is set by the
    // splitter when titleCardParagraphIndices includes that paragraph).
    //
    // The renderer plays the title card SEQUENTIALLY, not as a true overlay
    // (no compositing pipeline for live title-on-video). To keep the picture
    // timeline equal to the voiceover timeline, we CONSUME a slice of the
    // sentence's spoken time for the title card and SHIFT the sentence's
    // content block to start AFTER the title card. Net: title-card seconds
    // + sentence-content seconds == sentence's spoken duration. Without
    // this, every title card added 5s of phantom timeline time, which
    // showed up downstream as 1-2s of misalignment after the validator's
    // reclaim pass smeared the overrun across neighboring rows.
    let titleCardConsumed = 0;
    if (s.is_section_first_sentence) {
      const titleText = (titleCardTextByParagraph.get(s.paragraph_index) ?? "").trim();
      if (titleText) {
        // Title card duration = the title phrase's estimated SPOKEN time
        // (not a flat 5s), clamped so at least 1s of sentence-content time
        // remains. The narrator says the title in ~1-1.5s then continues
        // into the sentence; consuming only that spoken slice keeps the
        // sentence's content block anchored near its REAL spoken start
        // instead of being shoved forward by the full card hold. We keep at
        // least 1s of sentence-content time so the sentence row still exists
        // in the editor for review/swap. When the sentence is shorter than
        // the floor + 1s, skip the title card entirely — the sentence is too
        // short to coexist with a card.
        const MIN_SENTENCE_AFTER_CARD = 1.0;
        const maxCard = fullSentenceDuration - MIN_SENTENCE_AFTER_CARD;
        if (maxCard > 0.5) {
          const cardDur = Math.min(estimateTitleSpokenSeconds(titleText), maxCard);
          blocks.push({
            type: "title_card",
            duration: cardDur,
            // Use the section TITLE as the title card row's text so the
            // matcher's blockTexts lookup picks it up via the hint-text path
            // instead of falling back to buildBlockTexts' proportional word
            // slicer. The proportional slicer accumulates by block.duration
            // and doesn't know about title cards, so it carves the first ~5s
            // of the section's first sentence words and writes that as the
            // title card row's script_text — which then displays in the
            // editor as a corrupted prefix of the next sentence. Stamping
            // the section title here makes the editor row show the title
            // itself, and leaves the sentence row's text undisturbed.
            text: titleText,
            resolved_subject: enr.resolved_subject,
            section_title: titleText,
            vo_start_seconds: s.vo_start,
            vo_end_seconds: s.vo_start + cardDur,
            paragraph_index: s.paragraph_index,
          });
          blockSentenceIndex.push(i);
          blockGroupId.push(`title-${s.paragraph_index}`);
          blockIsTitleCard.push(true);
          titleCardsInserted++;
          titleCardConsumed = cardDur;
        }
      }
    }

    // Sentence's own content block.
    // Demote Gemini title_card recommendations to footage — title cards
    // come EXCLUSIVELY from blue-bold doc markers, never from Gemini.
    let effectiveType: PlannedBlockWithHint["type"] = enr.recommended_visual_type;
    if (effectiveType === "title_card") effectiveType = "footage";

    // Effective sentence window AFTER the title-card slice. The audio still
    // plays the full sentence underneath, but the picture timeline only
    // covers the remainder so the picture sum equals the voiceover sum.
    const sentenceStart = s.vo_start + titleCardConsumed;
    const sentenceDuration = Math.max(0.1, fullSentenceDuration - titleCardConsumed);
    const groupId = groupIds[i];

    if (effectiveType === "image" && sentenceDuration > IMAGE_HOLD_SECONDS + 1.5) {
      // Long image sentence → split into N back-to-back fragments sharing
      // the same enrichment. Sizing is exact: slot_duration =
      // sentenceDuration / N, with the LAST slot absorbing the floating-
      // point residue so the sum equals sentenceDuration exactly.
      const slots = Math.max(2, Math.round(sentenceDuration / IMAGE_HOLD_SECONDS));
      const slotDur = sentenceDuration / slots;
      let accumulated = 0;
      for (let k = 0; k < slots; k++) {
        const isLast = k === slots - 1;
        const dur = isLast ? sentenceDuration - accumulated : slotDur;
        const slotStart = sentenceStart + accumulated;
        const slotEnd = slotStart + dur;
        accumulated += dur;
        blocks.push({
          type: "image",
          duration: dur,
          text: s.text,
          resolved_subject: enr.resolved_subject,
          section_title: undefined,
          specific_visual_references: enr.specific_visual_references,
          mentioned_entities: enr.mentioned_entities,
          subject_type: enr.subject_type,
          visual_priority: enr.visual_priority,
          block_entity: enr.block_entity,
          paragraph_index: s.paragraph_index,
          vo_start_seconds: slotStart,
          vo_end_seconds: slotEnd,
        });
        blockSentenceIndex.push(i);
        blockGroupId.push(groupId);
        blockIsTitleCard.push(false);
        imageSplitCount++;
      }
      continue;
    }

    // Single block — duration equals the post-card remainder of the
    // sentence's spoken time. The narrator's vo_end is unchanged in the
    // audio; only the picture row is shorter to make room for the card.
    blocks.push({
      type: effectiveType,
      duration: sentenceDuration,
      text: s.text,
      resolved_subject: enr.resolved_subject,
      section_title: undefined,
      specific_visual_references: enr.specific_visual_references,
      mentioned_entities: enr.mentioned_entities,
      subject_type: enr.subject_type,
      visual_priority: enr.visual_priority,
      block_entity: enr.block_entity,
      paragraph_index: s.paragraph_index,
      vo_start_seconds: sentenceStart,
      vo_end_seconds: s.vo_end,
    });
    blockSentenceIndex.push(i);
    blockGroupId.push(groupId);
    blockIsTitleCard.push(false);
  }

  // ---- image:footage ratio cap ----------------------------------------
  // Gemini's per-sentence recommended_visual_type lands ~50% images on a
  // typical biography script. That over-draws the verified image pool (the
  // same celebrity photo repeats across many slots) and reads as a slideshow.
  // Footage supply is plentiful, so cap images at maxImageRatio of all
  // CONTENT blocks (image + footage; title cards / intro excluded) and
  // convert the surplus — the LOWEST visual_priority image blocks first, so
  // the images that genuinely matter (high-priority portraits, logos,
  // posters) stay images while generic descriptive sentences become footage.
  const maxImageRatio = typeof args.maxImageRatio === "number"
    && args.maxImageRatio > 0 && args.maxImageRatio < 1
    ? args.maxImageRatio
    : 0.30;
  let imagesConvertedToFootage = 0;
  {
    // Content blocks only — title cards (overlays) and intro don't count
    // toward the visual-style ratio.
    const isContent = (b: (typeof blocks)[number], idx: number): boolean =>
      !blockIsTitleCard[idx] && b.type !== "intro";
    const contentIdxs: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      if (isContent(blocks[i], i)) contentIdxs.push(i);
    }
    const imageIdxs = contentIdxs.filter(
      (i) => blocks[i].type === "image" || blocks[i].type === "split_2",
    );
    const contentTotal = contentIdxs.length;
    const maxImages = Math.floor(contentTotal * maxImageRatio);
    const surplus = imageIdxs.length - maxImages;
    if (surplus > 0) {
      // Convert the surplus lowest-priority image blocks to footage. Sort by
      // visual_priority ascending (lowest first); ties broken by longer
      // duration first (a long generic image hold is the most slideshow-like,
      // best replaced by motion). split_2 blocks are left alone — they're a
      // deliberate side-by-side composition, not a generic still.
      const convertible = imageIdxs
        .filter((i) => blocks[i].type === "image")
        .sort((a, b) => {
          const pa = Number(blocks[a].visual_priority ?? 0);
          const pb = Number(blocks[b].visual_priority ?? 0);
          if (pa !== pb) return pa - pb;
          return Number(blocks[b].duration ?? 0) - Number(blocks[a].duration ?? 0);
        });
      const toConvert = convertible.slice(0, surplus);
      for (const idx of toConvert) {
        blocks[idx] = { ...blocks[idx], type: "footage" };
        imagesConvertedToFootage++;
      }
    }
  }

  return {
    blocks,
    blockSentenceIndex,
    blockGroupId,
    blockIsTitleCard,
    shortSentencesGrouped: grouped,
    titleCardsInserted,
    imageSplitCount,
    shortSentencesMerged,
    imagesConvertedToFootage,
  };
}

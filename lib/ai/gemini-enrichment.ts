// Per-sentence Gemini enrichment lookup.
//
// In the old flow Gemini's per-block hint stream was the SOURCE OF TRUTH
// for the block sequence — the matcher walked Gemini's hints and built
// blocks from them. That coupling let Gemini drop, merge, or duplicate
// sentences, and the planner needed brittle filters to compensate.
//
// In the new flow the SENTENCE LIST is the source of truth. Gemini's
// output becomes an enrichment LOOKUP: for each canonical sentence, find
// the Gemini block whose text best matches and pull across its visual
// metadata (recommended_visual_type, subject_type, references, etc.).
// A sentence with no Gemini match defaults to footage on the project
// celebrity — never dropped.
//
// Matching strategy:
//   Prefix-token overlap with a forward-walking cursor. We index every
//   Gemini block by its first 10 normalized tokens (lowercased, punctuation
//   stripped). For each sentence we compute its own 10-token prefix and
//   look up. On miss we narrow to 6, then 3, then accept any block whose
//   prefix is contained in the sentence's text (covers Gemini paraphrases).
//
//   The walking cursor enforces narration order — a given Gemini block
//   can match at most one sentence, and the search for sentence N
//   starts at the Gemini block after the one matched by N-1. This
//   prevents Gemini hallucination (duplicated hints) from doubling up.

import type { BlockPlan } from "./segments";
import type { Sentence } from "./sentences";

export interface SentenceEnrichment {
  recommended_visual_type: BlockPlan["recommended_visual_type"];
  resolved_subject: string;
  subject_type: BlockPlan["subject_type"];
  mentioned_entities: string[];
  specific_visual_references: string[];
  visual_priority: BlockPlan["visual_priority"];
  block_entity: BlockPlan["block_entity"];
}

export interface EnrichmentLookup {
  // For each sentence index (in narration order), the matched Gemini
  // enrichment, or null when no match was found.
  perSentence: Array<SentenceEnrichment | null>;
  // Diagnostics — exposed so the matcher's logs can audit match quality.
  totalGeminiBlocks: number;
  matchedSentences: number;
  matchedAtPrefix10: number;
  matchedAtPrefix6: number;
  matchedAtPrefix3: number;
  matchedByContainment: number;
  unmatched: number;
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function prefixKey(tokens: string[], n: number): string {
  return tokens.slice(0, n).join(" ");
}

// Build a lookup from Gemini blocks to enrichments keyed by sentence
// index. The blocks are matched IN ORDER against the sentences — a
// Gemini block at array position k can match a sentence only if every
// prior block has been considered first. This mirrors how the doc and
// Gemini's output are both narration-ordered.
//
// Why forward-only: Gemini occasionally emits two adjacent blocks
// covering the same sentence (hallucination). The cursor advances past
// the first match, so the duplicate just goes unmatched — the sentence
// list already gave that sentence one slot, and we don't need a second.
export function buildEnrichmentLookup(
  sentences: Sentence[],
  geminiBlocks: BlockPlan[],
): EnrichmentLookup {
  const perSentence: Array<SentenceEnrichment | null> = new Array(sentences.length).fill(null);
  const lookup: EnrichmentLookup = {
    perSentence,
    totalGeminiBlocks: geminiBlocks.length,
    matchedSentences: 0,
    matchedAtPrefix10: 0,
    matchedAtPrefix6: 0,
    matchedAtPrefix3: 0,
    matchedByContainment: 0,
    unmatched: 0,
  };

  if (geminiBlocks.length === 0) {
    lookup.unmatched = sentences.length;
    return lookup;
  }

  // Precompute Gemini block tokens + prefix keys.
  const geminiTokens = geminiBlocks.map((b) => normalizeTokens(b.text ?? ""));
  const geminiPrefix10 = geminiTokens.map((t) => prefixKey(t, 10));
  const geminiPrefix6 = geminiTokens.map((t) => prefixKey(t, 6));
  const geminiPrefix3 = geminiTokens.map((t) => prefixKey(t, 3));
  const geminiNormText = geminiBlocks.map((b) =>
    normalizeTokens(b.text ?? "").join(" "),
  );

  let geminiCursor = 0;

  for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
    const sTokens = normalizeTokens(sentences[sIdx].text);
    if (sTokens.length === 0) {
      lookup.unmatched++;
      continue;
    }
    const sPrefix10 = prefixKey(sTokens, 10);
    const sPrefix6 = prefixKey(sTokens, 6);
    const sPrefix3 = prefixKey(sTokens, 3);
    const sNormText = sTokens.join(" ");

    // Try matches from the cursor forward. We scan a bounded window
    // (the next 20 Gemini blocks) so a single missing sentence in the
    // middle doesn't cause every subsequent search to scan the whole
    // remaining array.
    const scanLimit = Math.min(geminiCursor + 20, geminiBlocks.length);
    let matchedIdx = -1;
    let matchedKind: "p10" | "p6" | "p3" | "contain" | null = null;

    // Pass 1: 10-token prefix equality. Tightest — almost certainly the
    // same sentence text on both sides.
    if (sPrefix10) {
      for (let g = geminiCursor; g < scanLimit; g++) {
        if (geminiPrefix10[g] && geminiPrefix10[g] === sPrefix10) {
          matchedIdx = g;
          matchedKind = "p10";
          break;
        }
      }
    }

    // Pass 2: 6-token prefix equality. Covers Gemini paraphrases that
    // changed words in the back half of the sentence.
    if (matchedIdx < 0 && sPrefix6) {
      for (let g = geminiCursor; g < scanLimit; g++) {
        if (geminiPrefix6[g] && geminiPrefix6[g] === sPrefix6) {
          matchedIdx = g;
          matchedKind = "p6";
          break;
        }
      }
    }

    // Pass 3: 3-token prefix equality. Covers Gemini paraphrases that
    // dropped or reordered tokens in the first half.
    if (matchedIdx < 0 && sPrefix3) {
      for (let g = geminiCursor; g < scanLimit; g++) {
        if (geminiPrefix3[g] && geminiPrefix3[g] === sPrefix3) {
          matchedIdx = g;
          matchedKind = "p3";
          break;
        }
      }
    }

    // Pass 4: containment. The Gemini block's normalized text is a
    // substring of the sentence's, or vice versa. Covers the case where
    // Gemini grouped 2 short doc sentences into one hint — both doc
    // sentences will match the same Gemini block (the second one might
    // win as the cursor advances past the first).
    if (matchedIdx < 0) {
      for (let g = geminiCursor; g < scanLimit; g++) {
        const gNorm = geminiNormText[g];
        if (!gNorm) continue;
        if (sNormText.includes(gNorm) || gNorm.includes(sNormText)) {
          matchedIdx = g;
          matchedKind = "contain";
          break;
        }
      }
    }

    if (matchedIdx < 0) {
      lookup.unmatched++;
      continue;
    }

    const b = geminiBlocks[matchedIdx];
    perSentence[sIdx] = {
      recommended_visual_type: b.recommended_visual_type,
      resolved_subject: b.resolved_subject ?? "",
      subject_type: b.subject_type,
      mentioned_entities: Array.isArray(b.mentioned_entities) ? b.mentioned_entities : [],
      specific_visual_references: Array.isArray(b.specific_visual_references)
        ? b.specific_visual_references
        : [],
      visual_priority: b.visual_priority,
      block_entity: b.block_entity,
    };
    lookup.matchedSentences++;
    if (matchedKind === "p10") lookup.matchedAtPrefix10++;
    else if (matchedKind === "p6") lookup.matchedAtPrefix6++;
    else if (matchedKind === "p3") lookup.matchedAtPrefix3++;
    else if (matchedKind === "contain") lookup.matchedByContainment++;
    // Advance cursor past the matched block. A Gemini block matches at
    // most one sentence; subsequent sentences search from after it.
    geminiCursor = matchedIdx + 1;
  }

  return lookup;
}

// Default enrichment used when a sentence has no Gemini match. The
// matcher fills resolved_subject in with the project celebrity later,
// so we leave it empty here.
export function defaultEnrichment(): SentenceEnrichment {
  return {
    recommended_visual_type: "footage",
    resolved_subject: "",
    subject_type: "general",
    mentioned_entities: [],
    specific_visual_references: [],
    visual_priority: "person_default",
    block_entity: { type: "celebrity_default", name: "" },
  };
}

// Resolve enrichment for a sentence index. Returns the looked-up
// enrichment when present, otherwise the default with `resolved_subject`
// set to `fallbackSubject` (typically the project's main celebrity).
export function enrichmentForSentence(
  lookup: EnrichmentLookup,
  sentenceIndex: number,
  fallbackSubject: string,
): SentenceEnrichment {
  const found = lookup.perSentence[sentenceIndex];
  if (found) {
    // If Gemini didn't name the subject for this block (pronoun-only
    // narration), backfill with the project celebrity so downstream
    // image / clip resolution always has something to anchor on.
    if (!found.resolved_subject || found.resolved_subject.trim().length === 0) {
      return { ...found, resolved_subject: fallbackSubject };
    }
    return found;
  }
  const def = defaultEnrichment();
  return { ...def, resolved_subject: fallbackSubject };
}

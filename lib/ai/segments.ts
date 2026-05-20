import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { withGeminiRetry, isRetryableGeminiError } from "@/lib/ai/gemini";

// Segment-aware analysis used by the "Analyze & Search" UX.
// We split a transcript into ~5-minute spoken chunks, then ask Gemini for a
// human-readable understanding of each segment plus search intents.

const WORDS_PER_MINUTE = 150;          // typical narration cadence
const TARGET_SEGMENT_MINUTES = 5;
const MIN_SEGMENT_WORDS = 250;          // don't split tiny scripts at all

function getModel() {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const genai = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return genai.getGenerativeModel({ model: env.GEMINI_MODEL });
}

export interface RawSegment {
  index: number;
  text: string;
  wordCount: number;
  startSeconds: number;
  endSeconds: number;
}

export function estimateDurationSeconds(transcript: string): number {
  const words = countWords(transcript);
  return Math.round((words / WORDS_PER_MINUTE) * 60);
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export interface SplitOptions {
  // Topic boundary phrases — typically the text of each blue-bold title
  // card in the user's Google Doc. When provided, the splitter searches
  // for each boundary's text in the transcript and starts a new segment
  // at every match it finds. Boundaries that don't appear in the
  // transcript (because Deepgram heard them slightly differently than the
  // doc reads them, or the title is purely an editorial label not spoken
  // aloud) are silently ignored — the splitter still cuts at the matches
  // it DID find, and falls back to the word-count split only when no
  // boundaries matched at all.
  topicBoundaries?: string[];
}

export function splitTranscriptIntoSegments(
  transcript: string,
  options: SplitOptions = {},
): RawSegment[] {
  const cleaned = transcript.trim();
  if (!cleaned) return [];
  const totalWords = countWords(cleaned);
  if (totalWords < MIN_SEGMENT_WORDS) {
    return [{
      index: 0,
      text: cleaned,
      wordCount: totalWords,
      startSeconds: 0,
      endSeconds: Math.round((totalWords / WORDS_PER_MINUTE) * 60),
    }];
  }

  // Topic-driven split. We try this first when boundaries are provided —
  // the doc's chapter structure usually gives Gemini much tighter context
  // than an arbitrary 5-minute split (queries get the chapter's actual
  // subject instead of mixing two unrelated topics). If we find at least
  // one boundary in the transcript, we use the topic-split result; if
  // none match we fall through to the word-count split below.
  const boundaries = (options.topicBoundaries ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (boundaries.length > 0) {
    const topicSegments = splitByTopicBoundaries(cleaned, boundaries);
    if (topicSegments.length >= 2) return topicSegments;
    // If only one boundary matched, the result is effectively a single
    // segment — that's worse than the word-count split for long scripts,
    // so fall through.
  }

  const targetWords = TARGET_SEGMENT_MINUTES * WORDS_PER_MINUTE;     // ~750
  const segmentCount = Math.max(1, Math.round(totalWords / targetWords));
  const wordsPerSegment = Math.ceil(totalWords / segmentCount);

  // Prefer sentence boundaries — split on terminal punctuation followed by
  // whitespace, but keep the punctuation attached to the preceding sentence.
  const sentences = cleaned.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [cleaned];

  const out: RawSegment[] = [];
  let buffer: string[] = [];
  let bufferWords = 0;
  let cursorWords = 0;

  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    const w = countWords(s);
    buffer.push(s);
    bufferWords += w;
    if (bufferWords >= wordsPerSegment && out.length < segmentCount - 1) {
      out.push(buildSegment(out.length, buffer.join(" "), cursorWords, bufferWords));
      cursorWords += bufferWords;
      buffer = [];
      bufferWords = 0;
    }
  }
  if (buffer.length) {
    out.push(buildSegment(out.length, buffer.join(" "), cursorWords, bufferWords));
  }
  return out;
}

// Locate each topic boundary phrase in the transcript and cut a new
// segment at every match. Matching is fuzzy-ish: punctuation and case are
// ignored on both sides, and we look at the first 6–10 normalized words of
// the boundary so a slightly longer doc title still anchors against the
// spoken opening. Returns segments in order, including the leading
// portion (before the first boundary) as segment 0.
function splitByTopicBoundaries(
  transcript: string,
  boundaries: string[],
): RawSegment[] {
  // Normalize: lowercase + collapse whitespace + strip non-letter chars.
  // We keep apostrophes so "didn't" stays "didnt" not "didn t".
  function normalize(s: string): string {
    return s
      .toLowerCase()
      .replace(/[''`]/g, "")
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const normTranscript = normalize(transcript);
  // Build a parallel index that maps each character in normTranscript
  // back to its position in the original transcript. We walk the original
  // once, applying the same normalization rules and recording for each
  // emitted character which original-index it came from.
  const indexMap: number[] = [];
  let normBuf = "";
  let prevWasSpace = true;
  for (let i = 0; i < transcript.length; i++) {
    const ch = transcript[i];
    const code = ch.charCodeAt(0);
    // Same character class logic as normalize() — keep this in sync.
    const isApostrophe = ch === "'" || ch === "‘" || ch === "’" || ch === "`";
    const isLetterOrDigit =
      (code >= 97 && code <= 122) || // a-z
      (code >= 65 && code <= 90)  || // A-Z (we lowercase below)
      (code >= 48 && code <= 57);   // 0-9
    const isWs = /\s/.test(ch);
    if (isApostrophe) continue; // dropped by normalize
    if (isLetterOrDigit) {
      normBuf += ch.toLowerCase();
      indexMap.push(i);
      prevWasSpace = false;
    } else if (isWs || !isLetterOrDigit) {
      // Coalesce runs of separators to a single space.
      if (!prevWasSpace) {
        normBuf += " ";
        indexMap.push(i);
        prevWasSpace = true;
      }
    }
  }
  // Trim trailing whitespace from the normalized form.
  while (normBuf.endsWith(" ")) {
    normBuf = normBuf.slice(0, -1);
    indexMap.pop();
  }
  // Sanity check: indexMap should align with normBuf 1:1.
  if (normBuf.length !== indexMap.length) {
    // Defensive — should never happen. Bail to word-count split.
    return [];
  }
  if (normBuf !== normTranscript) {
    // Our two normalization paths disagreed somewhere; the simplest fix
    // is to fall back, which the caller treats as "no topic split".
    return [];
  }

  // For each boundary, find its first occurrence in normTranscript at or
  // after the previous match's end. We use the first ~8 normalized words
  // of the boundary so a slightly longer doc title still anchors.
  function boundaryNeedle(b: string): string {
    const n = normalize(b);
    const words = n.split(" ").slice(0, 8);
    return words.join(" ");
  }

  const cuts: number[] = []; // original-transcript character positions
  let searchFrom = 0;
  for (const b of boundaries) {
    const needle = boundaryNeedle(b);
    if (!needle) continue;
    const found = normTranscript.indexOf(needle, searchFrom);
    if (found < 0) continue;
    const origPos = indexMap[found];
    cuts.push(origPos);
    searchFrom = found + needle.length;
  }
  if (cuts.length === 0) return [];

  // Build segments from [0..cuts[0]], [cuts[0]..cuts[1]], etc. We snap the
  // cut position back to the nearest preceding paragraph or sentence
  // boundary so the resulting segment ends cleanly mid-prose isn't split.
  function snapToSentenceStart(pos: number): number {
    // Scan backward for the nearest sentence end (.!?) followed by ws, or
    // a paragraph break. Limit lookback to ~200 chars so we don't pull a
    // cut multiple paragraphs back from where the title actually appears.
    const minPos = Math.max(0, pos - 200);
    for (let k = pos - 1; k >= minPos; k--) {
      const ch = transcript[k];
      if (ch === "\n") return k + 1;
      if ((ch === "." || ch === "!" || ch === "?") && /\s/.test(transcript[k + 1] ?? "")) {
        // Move forward past the whitespace so the next segment starts
        // with the next sentence's first letter, not its leading space.
        let j = k + 1;
        while (j < transcript.length && /\s/.test(transcript[j])) j++;
        return j;
      }
    }
    return pos;
  }
  const snappedCuts = cuts.map(snapToSentenceStart);

  // De-duplicate cuts (a tiny boundary might snap to the same position
  // as the previous one).
  const uniq: number[] = [];
  for (const c of snappedCuts) {
    if (uniq.length === 0 || c > uniq[uniq.length - 1]) uniq.push(c);
  }

  // Build raw slices first.
  const rawSlices: string[] = [];
  let prev = 0;
  for (const c of uniq) {
    rawSlices.push(transcript.slice(prev, c).trim());
    prev = c;
  }
  rawSlices.push(transcript.slice(prev).trim());

  // Fold the LEADING slice (everything before the first title card) into
  // slice[1]. That leading slice is "hook" narration with no chapter
  // heading — the user wrote chapters as title-card-marked sections, so
  // anything before the first card is preamble to chapter 1, not its own
  // chapter. Merging the hook forward gives chapter 1's Gemini call the
  // hook's entity context (names, places mentioned in the opening) without
  // burning a separate analysis pass on a chapterless preamble.
  //
  // Slices 1..N (post-first-title) stay separate even when short — each
  // one has its own title card defining its identity, so a 30-second
  // chapter is still a real chapter.
  const slices = rawSlices.filter((s) => s.length > 0);
  if (slices.length >= 2) {
    const leading = slices.shift() as string;
    slices[0] = `${leading} ${slices[0]}`.trim();
  }
  if (slices.length < 2) return []; // caller falls back to word-count split

  const out: RawSegment[] = [];
  let priorWords = 0;
  for (let i = 0; i < slices.length; i++) {
    const text = slices[i];
    const words = countWords(text);
    out.push(buildSegment(out.length, text, priorWords, words));
    priorWords += words;
  }
  return out;
}

function buildSegment(index: number, text: string, priorWords: number, words: number): RawSegment {
  const startSeconds = Math.round((priorWords / WORDS_PER_MINUTE) * 60);
  const endSeconds = Math.round(((priorWords + words) / WORDS_PER_MINUTE) * 60);
  return { index, text, wordCount: words, startSeconds, endSeconds };
}

// ---------------------------------------------------------------------------
// Per-segment understanding
// ---------------------------------------------------------------------------

// "talking_head" = interview/host speaking direct to camera (long-form OK).
// "broll"        = visual filler — places, objects, action, archival montages
//                  (often <2 min on YouTube; the duration filter must be loose).
// "archival"     = older news/event footage tied to a specific moment in time.
export const IntentType = z.enum(["talking_head", "broll", "archival"]);
export type IntentType = z.infer<typeof IntentType>;

// Per-block visual plan emitted by Gemini alongside searchIntents. Drives
// the new script-aware planner (Phase A of the celebrity-style refactor):
// each narration chunk gets its own visual recommendation rather than being
// fitted into a pre-computed footage/image quota.
//
// Naming follows the client spec exactly so the planner can be reasoned
// about against the requirements doc without translation.
export const SubjectType = z.enum([
  "person", "place", "movie", "show", "company",
  "event", "object", "general",
]);
export type SubjectType = z.infer<typeof SubjectType>;

export const VisualType = z.enum([
  "footage", "image", "title_card", "split_2",
]);
export type VisualType = z.infer<typeof VisualType>;

// Documentary-editor visual priority per the client spec. Drives the
// matcher's pick logic with a coarser axis than recommended_visual_type:
//   - "person_default"  — show the current person (general narration about
//                         them, their career, abstract topics like lawsuits,
//                         legal arguments). Always falls back to person clip.
//   - "specific_event"  — narration references a concrete event/object
//                         (tattoo, wedding, movie, courthouse). Use exact
//                         image; fall back to PERSON image (never random).
//   - "specific_object" — narration references a specific named thing
//                         (logo, building, document). Same fallback rule.
//   - "title_card"      — chapter break.
//   - "split_2"         — pair of named people / entities.
// This is orthogonal to recommended_visual_type — the matcher uses both:
// recommended_visual_type drives the block TYPE (footage / image / etc.),
// visual_priority drives the FALLBACK chain when a specific match fails.
export const VisualPriority = z.enum([
  "person_default", "specific_event", "specific_object", "title_card", "split_2",
]);
export type VisualPriority = z.infer<typeof VisualPriority>;

export const BlockPlanSchema = z.object({
  text: z.string().min(1),
  // The person/thing the block is "about". For pronoun-only blocks Gemini
  // may emit "" — the deterministic continuity pass fills it in afterward
  // from the previous block's subject.
  resolved_subject: z.string().default(""),
  subject_type: SubjectType.default("general"),
  // Named entities literally appearing in this block's text.
  mentioned_entities: z.array(z.string()).default([]),
  // Specific reference words that should drive an image search instead of
  // footage matching (e.g. "tattoo", "mother", "1998", "Frida"). The image
  // matcher in Phase C consumes this list directly.
  specific_visual_references: z.array(z.string()).default([]),
  // Did the block use pronouns (he/she/him/her) without naming the subject?
  // The continuity pass uses this as a hint when deciding whether to keep
  // the previous resolved_subject.
  pronouns_detected: z.boolean().default(false),
  // Free-text reason describing what the block is visually trying to convey.
  // Used in the per-block log so reviewers can see why a visual type was
  // picked, not just what was picked.
  visual_intent: z.string().default(""),
  // Gemini's recommended visual type. The planner is allowed to override
  // this (e.g. demote split_2 → image when only one image is available, or
  // promote a stretch of footage to title_card when a section title fits)
  // but the recommendation is the starting point.
  recommended_visual_type: VisualType.default("footage"),
  // Person-first documentary axis. See VisualPriority docs above.
  // Defaults to "person_default" — the safest fallback when Gemini omits
  // the field. The matcher uses this to decide WHEN to fall back to the
  // person on a failed specific match (per the client's "NEVER random"
  // rule).
  visual_priority: VisualPriority.default("person_default"),
});
export type BlockPlan = z.infer<typeof BlockPlanSchema>;

export const SegmentUnderstandingSchema = z.object({
  mainTopic: z.string().min(1),
  people: z.array(z.string()).default([]),
  places: z.array(z.string()).default([]),
  events: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  relatedKeywords: z.array(z.string()).default([]),
  // The person / entity this SEGMENT is visually about. Filled in either by
  // Gemini (when the section explicitly names a subject) or by the deterministic
  // inheritance pass below (when the section uses pronouns / continues the
  // global subject's story). Always non-empty after analyzeSegment() returns
  // when a project-level subject is available.
  segmentSubject: z.string().default(""),
  // True when segmentSubject came from the global project subject rather than
  // being explicitly named in this section. Drives the hard-reject rule in the
  // YouTube ranker (an inherited segment must surface results that mention the
  // subject, an alias, or a context term — otherwise it's noise).
  inheritedSubject: z.boolean().default(false),
  // Short focus topic for the section, e.g. "lawsuit / Creative Controls" or
  // "early career". Used to anchor non-subject tokens in queries and to score
  // results' titles against the segment's specific story beat.
  segmentTopic: z.string().default(""),
  // Optional section title for the segment. When present, the planner uses
  // it as the text of a black title_card inserted at the section boundary.
  sectionTitle: z.string().default(""),
  searchIntents: z.array(z.object({
    label: z.string().min(1),       // human-friendly: "Searching for early life interviews"
    query: z.string().min(1),       // raw query passed to YouTube
    intentType: IntentType.default("talking_head"),
  })).min(1).max(6),
  // Per-block visual plan. Empty array is allowed when Gemini decides the
  // whole segment is one block — the planner handles that gracefully by
  // synthesizing a single block from the segment text.
  blocks: z.array(BlockPlanSchema).default([]),
});
export type SegmentUnderstanding = z.infer<typeof SegmentUnderstandingSchema>;

export interface SegmentContext {
  // The main subject of the whole video (e.g., "Dave Kindig"). Every search
  // query for this segment is forced to include this name when set, so we
  // don't drift into generic footage for legal/news/event segments where the
  // narration mentions a place or year without re-stating the subject.
  mainSubject?: string;
  // Short forms, nicknames, and company-form variants of the main subject
  // ("Dave", "Kindig", "Kindig It Design") — used to decide whether the
  // current segment's narration counts as a subject re-statement or whether
  // the segment is inheriting the global subject.
  subjectAliases?: string[];
  // Recurring proper nouns tied to the main subject — secondary anchors for
  // search queries when the segment doesn't restate the subject's name.
  contextTerms?: string[];
  // Other proper nouns extracted from the whole script — companies, related
  // people, etc. Gemini can pick the most relevant ones for this section.
  relatedCompanies?: string[];
  relatedPeople?: string[];
  // Subject of the previous segment, used for topic-continuation inheritance
  // (segment N uses pronouns AND segment N-1 just established a non-global
  // subject → segment N inherits that subject, not the global one).
  previousSegmentSubject?: string;
}

// Generic / ambiguous keywords that pull unrelated content when searched alone.
// Queries that consist ONLY of these tokens (no subject, no proper noun) are
// rewritten to prepend the global subject — or dropped entirely if no subject
// is available. The set is intentionally short and behaviour-driven; growing
// it is cheaper than adding more prompt rules to Gemini.
const GENERIC_QUERY_KEYWORDS = new Set([
  "lawsuit","lawsuits","court","ruling","trial","legal","dispute","case",
  "litigation","judgment","verdict","subpoena",
  "company","profile","overview","business","corporation","brand",
  "tutorial","how","guide","review","tips","unboxing","setup",
  "app","application","feature","features","controls","setting","settings",
  "donation","charity","custom","build","project","renovation","restoration",
  "creative","creative controls","creative power controls",
]);

// Token a generic / ambiguous phrase set against. Lowercases and strips
// punctuation so "Creative Controls" matches "creative controls".
function isGenericPhrase(s: string): boolean {
  const norm = s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (!norm) return true;
  if (GENERIC_QUERY_KEYWORDS.has(norm)) return true;
  // Split into tokens and check whether EVERY token is generic. "Utah court
  // ruling 2016" has a year and a place so it survives; "court ruling 2016"
  // (no proper noun) would be flagged because "court","ruling" are generic
  // and a bare year isn't a strong enough anchor on its own.
  const toks = norm.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return true;
  const nonGenericTokens = toks.filter((t) => !GENERIC_QUERY_KEYWORDS.has(t) && !/^\d{4}$/.test(t));
  return nonGenericTokens.length === 0;
}

// Deterministic query post-processor. Guarantees that every query passed to
// YouTube contains either the global subject, an alias, or a context term —
// generic local keywords on their own pull "Creative Power Controls company
// profile" and "iPhone Creative Controls" tutorials, which is exactly the
// failure the user reported.
export function buildSegmentQuery(
  rawQuery: string,
  context: SegmentContext,
  segmentSubject: string,
): string {
  const subject = (segmentSubject || context.mainSubject || "").trim();
  const aliases = (context.subjectAliases ?? []).map((s) => s.toLowerCase());
  const contextTerms = (context.contextTerms ?? []).map((s) => s.toLowerCase());
  const cleaned = sanitizeQuery(rawQuery).trim();
  if (!cleaned) return subject; // last-ditch fallback — better than empty
  const lower = cleaned.toLowerCase();
  const containsSubject = subject && lower.includes(subject.toLowerCase());
  const containsAlias = aliases.some((a) => a && lower.includes(a));
  const containsContext = contextTerms.some((t) => t && lower.includes(t));
  if (containsSubject || containsAlias || containsContext) {
    // Already anchored. Return as-is.
    return cleaned;
  }
  // No anchor present. If we have a subject, prepend it; otherwise, prepend
  // the strongest context term (typically the subject's company). If neither
  // exists, fall back to the cleaned query unchanged — the ranker still has
  // the no-content-signal guard to drop irrelevant hits downstream.
  if (subject) return `${subject} ${cleaned}`;
  const firstContext = (context.contextTerms ?? [])[0];
  if (firstContext) return `${firstContext} ${cleaned}`;
  return cleaned;
}

export { GENERIC_QUERY_KEYWORDS, isGenericPhrase };

export async function analyzeSegment(
  segment: RawSegment,
  context: SegmentContext = {},
): Promise<SegmentUnderstanding> {
  const model = getModel();
  const subject = context.mainSubject?.trim();
  const aliasList = (context.subjectAliases ?? []).filter(Boolean);
  const contextTermList = (context.contextTerms ?? []).filter(Boolean);
  const subjectBlock = subject
    ? `\nPROJECT SUBJECT: ${subject}\nThis whole video is about ${subject}. The current section may not re-state the name, but every visual we pull must still be about ${subject} or directly involve them.${
        aliasList.length ? `\nAliases the script may use: ${aliasList.join(", ")}.` : ""
      }${
        contextTermList.length ? `\nContext terms tied to ${subject}: ${contextTermList.join(", ")}.` : ""
      }\n`
    : "";
  const relatedBlock = (() => {
    const parts: string[] = [];
    if (context.relatedCompanies?.length) parts.push(`Companies in this script: ${context.relatedCompanies.join(", ")}.`);
    if (context.relatedPeople?.length) parts.push(`Other people in this script: ${context.relatedPeople.join(", ")}.`);
    return parts.length ? `\n${parts.join(" ")}\n` : "";
  })();
  const subjectQueryRule = subject
    ? `- ANCHOR RULE: every "query" MUST mention "${subject}" (or an alias / context term uniquely tied to ${subject}, like ${
        [...aliasList, ...contextTermList].slice(0, 3).join(" / ") || "their business"
      }). A generic query like "Utah court ruling 2016" will pull unrelated trials — instead write "${subject} lawsuit 2016" or "${(contextTermList[0]) ?? subject} court ruling". If you cannot anchor a query to ${subject} or one of their named entities, drop the intent.`
    : "";
  const prompt = `You are helping a video editor understand one section of a celebrity-focused voiceover.
${subjectBlock}${relatedBlock}Return STRICT JSON ONLY in this shape:
{
  "mainTopic": "short phrase, e.g. 'Margot Robbie's early career'",
  "segment_subject": "the ONE person or entity this section is visually about. If the narration uses pronouns or only mentions topics (a lawsuit, a place, a year) without naming a person, leave this EMPTY — do NOT guess. The code will inherit the project subject for empty values.",
  "segment_topic": "short focus topic, 2-5 words, e.g. 'lawsuit / Creative Controls', 'early career', 'wedding 2019'. This is the story beat, not the subject.",
  "people": ["EVERY named person in this section, INCLUDING the main subject when their name appears. Do not omit the subject just because the whole video is about them."],
  "places": ["cities, countries, venues"],
  "events": ["awards, premieres, news moments"],
  "topics": ["broader themes like 'method acting', 'family life'"],
  "relatedKeywords": ["3-8 short phrases a viewer would say to describe the visuals"],
  "sectionTitle": "OPTIONAL short title for this section if the narration clearly opens a new chapter (e.g. 'The Cancellation', 'Marriage', 'Early Career'). Empty string if no clear chapter break.",
  "searchIntents": [
    { "label": "human-friendly description of what we are searching for",
      "query": "concrete YouTube search query, no quotes, max 8 words",
      "intentType": "talking_head | broll | archival" }
  ],
  "blocks": [
    {
      "text": "the verbatim 1-3 sentence chunk of narration this block covers",
      "resolved_subject": "the person/thing this block is visually ABOUT. For a pronoun-only block, leave \\"\\" and the code will inherit from the previous block.",
      "subject_type": "person | place | movie | show | company | event | object | general",
      "mentioned_entities": ["proper nouns literally appearing in this block"],
      "specific_visual_references": ["concrete objects/references that should drive a still-image search, e.g. 'tattoo', 'mother', '1998', 'Frida poster'. Leave [] for blocks that are just general narration about the subject."],
      "pronouns_detected": true,
      "visual_intent": "one short phrase describing what the screen should show here",
      "recommended_visual_type": "footage | image | title_card | split_2",
      "visual_priority": "person_default | specific_event | specific_object | title_card | split_2"
    }
  ]
}

Rules:
- Use plain language in "label" — like "Looking for award show clips", not "youtube.com search 'Oscars'".
- Provide 2 to 4 searchIntents that together cover the visual story of THIS section.
- Skip the section's narration tone and writing style. Focus on what should appear on screen.
- Skip duplicates. Skip empty arrays — return [] if you have nothing.

PERSON-FIRST DOCUMENTARY PRINCIPLE — read this BEFORE choosing block types.
This video is edited like a celebrity documentary. The viewer is here to see the
person. So:
- DEFAULT — show the current person on screen ("footage" / "person_default").
  This includes narration about their life, career, business, abstract concepts
  (innovation, lawsuit, authority, jurisdiction), and any general statement.
- SPECIFIC REFERENCE — only when the narration calls out a concrete thing or
  event whose image is a recognizable thing in the world: a tattoo, a wedding,
  a movie title, a company logo, a courthouse, a specific named building, a
  specific document, a family. Then "image" + "specific_event" or
  "specific_object". The visual is that exact thing.
- FALLBACK — if no exact image exists, the matcher falls back to the person's
  image. NEVER random unrelated visuals. You don't need to handle the fallback
  — just mark the block correctly and the matcher does the rest.

visual_priority axis (REQUIRED — drives matcher fallback chain):
- "person_default"  → person footage / person image. Always the safe default.
- "specific_event"  → a named event (wedding, tattoo getting, courthouse hearing,
                      premiere). Pair with recommended_visual_type "image".
- "specific_object" → a named object/entity (company logo, movie poster,
                      specific building/document). Pair with "image".
- "title_card"      → chapter heading. Pair with recommended_visual_type "title_card".
- "split_2"         → two named people / entities compared. Pair with "split_2".
When in doubt, choose "person_default". The matcher reuses person footage
gracefully — it spreads reuse across the timeline so the viewer never sees
the same shot twice in a row.

Block-level visual rules (these matter — they drive what appears on screen):
- ONE BLOCK = ONE COMPLETE SENTENCE. Never split a sentence across blocks.
  Each block's "text" must be a full sentence as it appears in the
  narration, ending at terminal punctuation (.!?). Quotations and
  parentheticals that complete the thought stay attached. Block durations
  are derived from the sentence's spoken length — short sentences become
  short holds (~3s), long sentences become longer holds (up to ~10s) or
  multiple back-to-back image holds. Do NOT pre-trim sentences for pacing;
  emit them as written.
- The number of blocks per section therefore equals the number of complete
  sentences. A 10-sentence section produces 10 blocks; a 4-sentence
  section produces 4 blocks. No 4-12 cap.
- Choose "recommended_visual_type" per block based on subject_type:
  * When subject_type is "person" or "general" → "footage". The viewer needs to see the person on screen.
  * When subject_type is "company" / "movie" / "show" / "place" / "event" / "object" AND the block names that entity → "image". The visual should be of THE ENTITY (a company logo, a movie poster, a place photo, an event's archival footage), NOT the celebrity. Put the entity name in "mentioned_entities" — downstream code routes "company" entities to logo search, "movie" entities to poster search, "place" entities to place-photo search, etc.
  * IMPORTANT — place restriction: only emit subject_type "place" for SPECIFIC named buildings, courthouses, landmarks, stadiums, venues whose image search returns recognizable photographs (e.g. "Utah District Court", "Wembley Stadium", "Buckingham Palace"). DO NOT emit "place" for countries, states, regions, or continents ("Utah", "Michigan", "United States", "Europe"). Those return flags, outline maps, and coats of arms — useless as B-roll. A block whose only place reference is a country / state / region should be subject_type "general" with recommended_visual_type "footage", and the visual will be the project celebrity.
  * IMPORTANT — event restriction: only emit subject_type "event" for NAMED historical events with a recognizable title ("Royal Wedding 1981", "Apollo 11", "Kindig It Design lawsuit ruling"). DO NOT emit "event" for bare dates ("January 2016", "2019", "the early 2000s") — image search on a date alone returns calendar pages and stock photos. A block whose only event reference is a date should be subject_type "general" with recommended_visual_type "footage".
  * "title_card" — block is a section heading or a strong topic shift. Rare; only if the narration explicitly opens a chapter.
  * "split_2" — block compares/relates TWO named people or two named entities (e.g. "Salma Hayek and Danny Trejo worked together"). Only when both are important visuals.
- DO NOT default to "footage" for blocks whose subject is a non-person entity. A block like "Creative Controls argued that the Utah court did not have authority" has subject_type="company" and subject="Creative Controls" — that is an "image" block, NOT a footage block. Footage of the project's main celebrity is wrong there; the visual must be of the named entity (or fall back to the celebrity ONLY when no entity image is available — the matcher handles that fallback, you don't need to).
- Use "image" for specific references even when the celebrity is the subject (e.g. "Her mother raised three kids" → image of mother). The reference is what drives the visual, not the celebrity.
- For pronoun-only blocks (he/she/him/her) leave "resolved_subject" as "" — the code inherits from the previous block.
- "mentioned_entities" should contain literal names in this block's text, not synonyms.
- Classify each intent's "intentType":
  * "talking_head" — interviews, host shots, podcasts (long-form, 4–25 min videos)
  * "broll" — places, locations, objects, scenery, action shots (often short clips)
  * "archival" — old news footage, vintage events, historical moments tied to a year
  Prefer "broll" or "archival" when the script mentions a place, event, year, or visual moment.

Query construction rules — these matter most. YouTube indexes against the
literal query string, so abstract or editorial words pull in the wrong videos:
${subjectQueryRule}
- Every "query" MUST contain at least one proper noun: a person's name, a place
  name, a 4-digit year, or a specific event name. If you can't anchor the query
  to a proper noun, drop the intent — don't pad with filler.
- NEVER use these editorial framing words in a query (they don't appear in real
  YouTube titles): institution, powerful, iconic, legendary, legacy, modern,
  classic, important, significant, historic, beautiful, stunning, ultimate,
  amazing, incredible, story, journey.
- For "archival" intents, the query MUST include one of: a 4-digit year,
  "newsreel", "archive footage", "original footage", or "vintage".
- For "broll" intents, prefer plural concrete nouns ("royal guards", "London
  streets") over singular abstractions ("the monarchy", "the city").
- Keep queries 3–8 words. If you only have 3 words of real signal, leave it at
  3 — do not add adjectives just to reach 8.
- Bad: "Buckingham Palace exterior royal guards institution"
  Good: "Buckingham Palace royal guards changing"
- Bad: "Princess Diana powerful early royal life"
  Good: "Princess Diana Charles wedding 1981"

SECTION (~${TARGET_SEGMENT_MINUTES} minutes, words ${segment.wordCount}):
"""${segment.text.slice(0, 8000)}"""`;

  let txt: string;
  try {
    const res = await withGeminiRetry(`analyzeSegment[${segment.index}]`, () =>
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      })
    );
    txt = res.response.text();
  } catch (e) {
    // 503/429 spikes on gemini-2.5-flash were taking down the entire analyze
    // request because Promise.all rejects on the first failure. Falling back
    // to a heuristic understanding keeps the pipeline running — the search
    // step is still useful with just the section's first sentence as a query.
    console.error(JSON.stringify({
      msg: "analyzeSegment.gemini_failed",
      segment: segment.index,
      retryable: isRetryableGeminiError(e),
      err: (e as Error).message?.slice(0, 200),
    }));
    return fallbackUnderstanding(segment, context);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    return fallbackUnderstanding(segment, context);
  }
  // Gemini emits snake_case (segment_subject / segment_topic) per the prompt
  // contract but our zod schema uses camelCase. Normalise before parsing so a
  // present-but-empty subject still lands in the schema's default and the
  // inheritance pass below has a value to act on.
  const normalised = (() => {
    if (!parsed || typeof parsed !== "object") return parsed;
    const p = parsed as Record<string, unknown>;
    if ("segment_subject" in p && !("segmentSubject" in p)) p.segmentSubject = p.segment_subject;
    if ("segment_topic" in p && !("segmentTopic" in p)) p.segmentTopic = p.segment_topic;
    return p;
  })();
  const safe = SegmentUnderstandingSchema.safeParse(normalised);
  if (!safe.success) {
    console.error(JSON.stringify({
      msg: "analyzeSegment.schema_failed",
      raw: txt.slice(0, 400),
      issues: safe.error.flatten(),
    }));
    return fallbackUnderstanding(segment, context);
  }

  // 1) Resolve the segment's subject + inheritance flag deterministically.
  //    Gemini was instructed to leave segment_subject blank when the section
  //    doesn't explicitly name a person; we fill it in here so downstream
  //    code can rely on a non-empty value whenever a project subject exists.
  const resolved = resolveSegmentSubject(safe.data, context);

  // 2) Belt-and-suspenders: even with the prompt rules, Gemini occasionally
  //    emits a query with NO subject anchor when the section is pronoun-heavy.
  //    Rewrite each query through buildSegmentQuery so the YouTube call always
  //    sees subject + topic — generic "Utah court ruling 2016" becomes
  //    "Dave Kindig Utah court ruling 2016". Also strip editorial framing
  //    words via sanitizeQuery (already invoked inside buildSegmentQuery).
  const rewrittenIntents = safe.data.searchIntents.map((it) => ({
    ...it,
    query: buildSegmentQuery(it.query, context, resolved.segmentSubject),
  }));

  const blocks = applySubjectContinuity(safe.data.blocks, resolved.segmentSubject || context.mainSubject);
  return {
    ...safe.data,
    segmentSubject: resolved.segmentSubject,
    inheritedSubject: resolved.inheritedSubject,
    segmentTopic: safe.data.segmentTopic?.trim() || safe.data.mainTopic.slice(0, 80),
    searchIntents: rewrittenIntents,
    blocks,
  };
}

// Decide what subject the segment is "about" and whether it was inherited.
// Inheritance priority:
//   1. Gemini explicitly named a subject in this section → use it.
//   2. Otherwise prefer the previous segment's subject if it was non-global
//      (topic continuation through pronouns).
//   3. Otherwise inherit the global project subject.
//   4. If none of the above, leave empty — search will skip the anchor rule.
//
// `inheritedSubject` is true unless rule 1 fired with a value that is NOT just
// a restatement of the global subject. Even when Gemini emits the project
// subject as the segment subject (a section that DOES re-state "Dave Kindig"),
// we keep inheritedSubject = false because the section anchored itself.
function resolveSegmentSubject(
  parsed: { segmentSubject?: string; people?: string[] },
  context: SegmentContext,
): { segmentSubject: string; inheritedSubject: boolean } {
  const global = (context.mainSubject ?? "").trim();
  const explicit = (parsed.segmentSubject ?? "").trim();
  if (explicit) {
    return { segmentSubject: explicit, inheritedSubject: false };
  }
  // No explicit segment_subject. Did Gemini at least name the global subject
  // (or an alias) in the people array? If so, treat the section as anchored.
  const aliases = [global, ...(context.subjectAliases ?? [])].map((s) => s.toLowerCase()).filter(Boolean);
  const peopleHit = (parsed.people ?? []).find((p) => aliases.includes(p.toLowerCase()));
  if (peopleHit) {
    return { segmentSubject: global || peopleHit, inheritedSubject: false };
  }
  const prev = (context.previousSegmentSubject ?? "").trim();
  if (prev && prev.toLowerCase() !== global.toLowerCase()) {
    return { segmentSubject: prev, inheritedSubject: true };
  }
  if (global) {
    return { segmentSubject: global, inheritedSubject: true };
  }
  return { segmentSubject: "", inheritedSubject: false };
}

// Words that describe how the writer feels about a subject but never appear in
// real YouTube titles. Keep in sync with the prompt rules above.
const FORBIDDEN_QUERY_WORDS = new Set([
  "institution","powerful","iconic","legendary","legacy","modern","classic",
  "important","significant","historic","beautiful","stunning","ultimate",
  "amazing","incredible","story","journey",
]);

export function sanitizeQuery(raw: string): string {
  const tokens = raw.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((t) => !FORBIDDEN_QUERY_WORDS.has(t.toLowerCase().replace(/[^a-z0-9]/g, "")));
  // If sanitizing emptied the query, return the original — better to search
  // something than nothing, and the ranker will reject irrelevant hits.
  return kept.length ? kept.join(" ") : raw;
}

// Deterministic post-processor. Walks an ordered block list and fills in
// resolved_subject for pronoun-only blocks by inheriting from the previous
// block's subject. Also normalises subject_type when a clear named person
// shows up in mentioned_entities.
//
// Why this exists separate from Gemini: Gemini's per-block subject inference
// is noisy when the narration uses pronouns for several blocks in a row. A
// deterministic pass that says "if this block has no explicit name and the
// previous block had one, keep it" is both cheap and easy to reason about.
// The client spec calls out pronoun continuity as a hard requirement.
export function applySubjectContinuity(blocks: BlockPlan[], fallbackSubject?: string): BlockPlan[] {
  if (blocks.length === 0) return blocks;
  let currentSubject = fallbackSubject?.trim() || "";
  let currentSubjectType: SubjectType = currentSubject ? "person" : "general";
  return blocks.map((b) => {
    const explicit = b.resolved_subject?.trim() || "";
    if (explicit) {
      // Explicit subject — adopt it as the running subject for following
      // pronoun-only blocks. Trust Gemini's subject_type on explicit blocks.
      currentSubject = explicit;
      currentSubjectType = b.subject_type;
      return b;
    }
    // No explicit subject. If the block is pronoun-only OR Gemini left it
    // blank, inherit. If neither current nor inherited is available, fall
    // back to whatever Gemini sent (likely "").
    if (currentSubject) {
      return { ...b, resolved_subject: currentSubject, subject_type: currentSubjectType };
    }
    return b;
  });
}

function fallbackUnderstanding(segment: RawSegment, context: SegmentContext = {}): SegmentUnderstanding {
  const firstSentence = segment.text.split(/[.!?]/, 1)[0]?.slice(0, 80) ?? "Section";
  // No Gemini understanding available, so we have no segment-level evidence
  // either way. Treat as inherited from the global subject when one exists —
  // the ranker's hard-reject rule will then still keep results on-topic.
  const subject = (context.mainSubject ?? "").trim();
  const rawQuery = firstSentence || `Part ${segment.index + 1}`;
  const query = buildSegmentQuery(rawQuery, context, subject);
  return {
    mainTopic: firstSentence || `Part ${segment.index + 1}`,
    people: subject ? [subject] : [],
    places: [], events: [], topics: [],
    relatedKeywords: [],
    segmentSubject: subject,
    inheritedSubject: !!subject,
    segmentTopic: firstSentence.slice(0, 60),
    sectionTitle: "",
    searchIntents: [{ label: "Looking for relevant background footage", query, intentType: "talking_head" }],
    // No Gemini analysis available — emit a single footage-typed block from
    // the whole segment so the planner has something to align against.
    blocks: [{
      text: segment.text,
      resolved_subject: subject,
      subject_type: subject ? "person" : "general",
      mentioned_entities: [],
      specific_visual_references: [],
      pronouns_detected: false,
      visual_intent: "",
      recommended_visual_type: "footage",
      visual_priority: "person_default",
    }],
  };
}

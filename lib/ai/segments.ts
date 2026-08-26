import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { withGeminiRetry, isRetryableGeminiError } from "@/lib/ai/gemini";

// Segment-aware analysis used by the "Analyze & Search" UX.
// We split a transcript into ~5-minute spoken chunks, then ask Gemini for a
// human-readable understanding of each segment plus search intents.

const WORDS_PER_MINUTE = 150;          // typical narration cadence
// 3-minute target (~450 words / ~30-40 sentences per segment) keeps each
// Gemini analyzeSegment call small enough that the model reliably emits
// one block per sentence. At 5 minutes the model under-emitted blocks on
// long-form audios, which surfaced in the editor as the same sentence
// repeated across many scenes (one Gemini block being split into N slots
// by the planner). Segments still run in parallel via Promise.all so the
// 10-segment 31-min case isn't materially slower than the old 6-segment
// split.
const TARGET_SEGMENT_MINUTES = 3;
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
  // subject instead of mixing two unrelated topics), AND it keeps the
  // first-block-of-segment title_card promotion (matchProcessor) aligned
  // with the actual blue-bold title positions in the source doc.
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
      .replace(/[‘’`]/g, "")
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
  while (normBuf.endsWith(" ")) {
    normBuf = normBuf.slice(0, -1);
    indexMap.pop();
  }
  if (normBuf.length !== indexMap.length) return [];
  if (normBuf !== normTranscript) return [];

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

  function snapToSentenceStart(pos: number): number {
    const minPos = Math.max(0, pos - 200);
    for (let k = pos - 1; k >= minPos; k--) {
      const ch = transcript[k];
      if (ch === "\n") return k + 1;
      if ((ch === "." || ch === "!" || ch === "?") && /\s/.test(transcript[k + 1] ?? "")) {
        let j = k + 1;
        while (j < transcript.length && /\s/.test(transcript[j])) j++;
        return j;
      }
    }
    return pos;
  }
  const snappedCuts = cuts.map(snapToSentenceStart);

  const uniq: number[] = [];
  for (const c of snappedCuts) {
    if (uniq.length === 0 || c > uniq[uniq.length - 1]) uniq.push(c);
  }

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
  // chapter.
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

// Closed-world block-entity type per the client's matching rule. The matcher
// is only allowed to fetch a visual for these six entity types. Anything that
// doesn't cleanly map to one of them falls through to "celebrity_default",
// which renders the project's main subject (footage or Wikipedia image). This
// is the architectural fix for the "random images and off-topic clips"
// problem — it makes "wrong visual for the block" impossible by construction
// rather than relying on downstream filters to catch it.
//
//   person          → a real, named person other than the project celebrity.
//                     Visual: that person's footage or face image.
//   company         → a named company / organisation. Visual: their logo.
//   tv_show         → a named TV programme. Visual: show artwork / poster.
//   movie           → a named feature film. Visual: movie poster.
//   song            → a named song / single. Visual: cover art.
//   place           → a named building / venue / landmark / city.
//                     Visual: photo of the place.
//   celebrity_default → no clean match — show the project celebrity.
//                     This is the FALLBACK for everything: abstract narration,
//                     transitions, recaps, dates without a named event, etc.
//                     The matcher must never invent a search for these blocks.
export const BlockEntityType = z.enum([
  "person", "company", "tv_show", "movie", "song", "place",
  "celebrity_default",
]);
export type BlockEntityType = z.infer<typeof BlockEntityType>;

// The matchable entity bound to a block. Drives clip/image selection at
// assignment time — the matcher looks for an asset tagged with this exact
// (type, name) pair, and falls back to the celebrity pool if none is found.
//
// For "celebrity_default" the name field is the project celebrity's name —
// set by the deterministic post-processor after Gemini returns, so Gemini
// only has to pick the type.
export const BlockEntitySchema = z.object({
  type: BlockEntityType.default("celebrity_default"),
  // The literal name to match against. For person/company/tv_show/movie/
  // song/place this is the exact proper noun from the script (verbatim, no
  // editorial framing). For celebrity_default this is the project celebrity's
  // name (filled in by post-processor; Gemini may leave it empty).
  name: z.string().default(""),
});
export type BlockEntity = z.infer<typeof BlockEntitySchema>;

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
  // Closed-world entity binding (Slice 1 of the matching-quality refactor).
  // Gemini picks ONE of the seven entity types per block. Everything that
  // doesn't cleanly map to person/company/tv_show/movie/song/place falls
  // through to "celebrity_default", which renders the project celebrity.
  // The closed-world matcher (Slice 6) selects assets by this field's
  // (type, name) pair instead of by the loose mentioned_entities /
  // specific_visual_references / topics / related_keywords surface. Those
  // old fields stay populated for backward compatibility with the existing
  // matcher until Slice 6 ships, then become metadata-only.
  block_entity: BlockEntitySchema.default({ type: "celebrity_default", name: "" }),
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
  intentType?: "talking_head" | "broll" | "archival",
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
  // Content b-roll is the one intent type allowed to leave the subject out.
  // A section narrating a process/place/object searches for THAT content
  // ("rifle factory assembly line"); prepending the subject would turn the
  // content query back into a subject query and re-create the every-part-
  // shows-the-subject repetition the client rejects. Generic b-roll phrasing
  // ("company profile") still falls through to the subject prepend below.
  if (intentType === "broll" && !isGenericPhrase(cleaned)) {
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
    ? `\nPROJECT SUBJECT: ${subject}\nThis whole video is about ${subject}, so ${subject} is the DEFAULT visual for narration that is about them. But match each section to its OWN content: when this section's narration is concretely about something else — a process (how something is made), an industry, a place, an object, another named person — the visuals for that stretch must show THAT content, not ${subject} again. Showing ${subject} over every section regardless of what the words say is the repetitive-video failure the client rejects. Fall back to ${subject} only for pronoun-heavy or general narration with no concrete content of its own.${
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
    ? `- ANCHOR RULE: a query about ${subject}'s OWN story MUST mention "${subject}" (or an alias / context term uniquely tied to ${subject}, like ${
        [...aliasList, ...contextTermList].slice(0, 3).join(" / ") || "their business"
      }). A generic query like "Utah court ruling 2016" will pull unrelated trials — instead write "${subject} lawsuit 2016" or "${(contextTermList[0]) ?? subject} court ruling".
- CONTENT EXCEPTION to the anchor rule: when THIS section's narration is concretely about something other than ${subject} — a process, an industry, a place, a machine, how something is built or made — add a "broll" intent whose query names THAT content with its own concrete nouns and NO forced ${subject} mention (e.g. for a section describing a manufacturing process, "<that product> factory assembly line", NOT "${subject} factory"; for a section about a city, that city's own streets). Take the nouns from THIS section's narration, never from this instruction. Forcing ${subject} into a content query turns the section's footage back into more ${subject}, which is the repetitive-video failure we are fixing. Drop an intent only when it is BOTH un-anchored to ${subject} AND has no concrete content nouns of its own.`
    : "";
  const prompt = `You are helping a video editor understand one section of a celebrity-focused voiceover.
${subjectBlock}${relatedBlock}Return STRICT JSON ONLY in this shape:
{
  "mainTopic": "short phrase, e.g. 'Margot Robbie's early career'",
  "segment_subject": "the ONE person or entity this section is visually about. Fill this when ANY of the following ground the section to one named person: (a) the person is named at least once anywhere in this section's text, (b) the section uses last-name references (e.g. 'Walliams said', 'Robbie was cast'), (c) the section uses pronouns that clearly continue from a person named earlier in the section. Use the PROJECT SUBJECT (above) by default when the section is anchored to them this way — do not leave empty just because most sentences use pronouns. Leave EMPTY ONLY when the section genuinely names no one and references no prior person.",
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
      "visual_priority": "person_default | specific_event | specific_object | title_card | split_2",
      "block_entity": {
        "type": "person | company | tv_show | movie | song | place | celebrity_default",
        "name": "the exact proper noun from the script, or \"\" for celebrity_default"
      }
    }
  ]
}

Rules:
- Use plain language in "label" — like "Looking for award show clips", not "youtube.com search 'Oscars'".
- Provide 2 to 4 searchIntents that together cover the visual story of THIS section.
- For searchIntents ONLY: skip the section's narration tone and writing style and focus on what should appear on screen. This rule does NOT apply to blocks — blocks must cover every sentence (see COMPLETENESS below).
- Skip duplicates. Skip empty arrays — return [] if you have nothing.

QUERY MINING — HARD REQUIREMENT FOR BUILDING searchIntents.
The chapter title / sectionTitle is often editorial ("Three words", "The
Cancellation", "Marriage", "Aftermath") and NOT searchable on YouTube. DO
NOT use the editorial title as the query basis. Instead, walk THIS
section's actual narration sentence by sentence and harvest every
searchable specific that already appears in the text:
  - named people (the project subject + any other person named)
  - named TV shows / movies / songs / podcasts
  - named companies / publications (e.g. "The Guardian", "HarperCollins")
  - named venues / buildings (e.g. "London Palladium")
  - 4-digit years
  - named events / lawsuits / awards / incidents
Also harvest concrete CONTENT the narration describes at length — a
process (how a thing gets made, built, cooked, filmed, repaired), an
industry, a machine, a trade, a place — those become content "broll"
intents built from the content's own nouns as THIS section words them
(see the content exception in the query rules below).
Then BUILD each searchIntent's query by combining the project subject
with ONE OR TWO of those harvested specifics (content "broll" intents
keep their own nouns instead). Every searchIntent must be grounded in
something that LITERALLY appears in this section's narration.
If the section uses pronouns and you can't find any harvested specific,
build queries from secondary anchors (the show, the year, the publication,
the venue) — never default to a bare subject query.

Example — for a section titled "Three words" whose narration says
"In December 2022 The Guardian published a transcript of David Walliams's
Britain's Got Talent comments…", the queries are:
  - "David Walliams Guardian transcript 2022"
  - "David Walliams Britain's Got Talent comments"
  - "David Walliams BGT scandal Guardian"
NOT "David Walliams three words" (chapter title is editorial).
NOT "David Walliams interview" (no story specifics).

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
- CONTENT STRETCH — when one or more sentences narrate a process, industry,
  place, or activity in its own right (how something is built or made, a
  factory, a trade, a journey), those blocks show THAT content, not the
  person: set "visual_intent" to describe the content, use "footage" with a
  matching content "broll" searchIntent, or "image" + "specific_object" with
  the content in "specific_visual_references". The person's face returning
  over words about something else is the repetitive-video failure the client
  rejects.
- FALLBACK — if no exact image exists, the matcher falls back to the person's
  image. NEVER random unrelated visuals. You don't need to handle the fallback
  — just mark the block correctly and the matcher does the rest.

CLOSED-WORLD BLOCK ENTITY (HARD REQUIREMENT — every block must have one).
The matcher is only allowed to fetch a visual for six entity types. Pick ONE
type per block via "block_entity". If the block doesn't cleanly map to one
of the six, pick "celebrity_default" — that tells the matcher to show the
project celebrity. This rule is non-negotiable; off-topic visuals come from
blocks trying to invent entities outside this list.

IMPORTANT — DO NOT confuse "block_entity.type" with "subject_type". They are
two different fields with two different value sets:
  - "subject_type" uses: person | place | movie | show | company | event |
                          object | general  (NOTE: "show", NOT "tv_show")
  - "block_entity.type" uses: person | company | tv_show | movie | song |
                              place | celebrity_default  (NOTE: "tv_show",
                              NOT "show")
For a block about a TV programme, write subject_type="show" AND
block_entity.type="tv_show". Mixing them — e.g. subject_type="tv_show" —
will be rejected by validation and the whole segment will fall back to a
generic plan. Get both right.

The six matchable types and what each one means:
- "person"     — the block is ABOUT a real, named person OTHER than the
                 project celebrity (a co-host, a relative, a rival, a public
                 figure mentioned by name). "name" = that person's exact name.
- "company"    — the block names a real company / organisation / publication
                 (e.g. "The Guardian", "Apple", "Manchester United"). "name"
                 = the company's exact name. Visual will be their logo.
- "tv_show"    — the block names a TV programme (e.g. "Britain's Got Talent",
                 "Strictly Come Dancing"). "name" = the show's exact title.
- "movie"      — the block names a feature film. "name" = the film's exact
                 title. Year in parentheses if disambiguating.
- "song"       — the block names a song / single. "name" = song title (add
                 "— Artist" if the artist is also named in the block).
- "place"      — the block names a specific building / venue / landmark
                 ("London Palladium", "Buckingham Palace", "Wembley Stadium").
                 NOT countries, regions, or vague locations.
- "celebrity_default" — EVERYTHING ELSE. Use this when the block is about
                 the PROJECT CELEBRITY specifically, or for abstract
                 narration, transitions, recaps, dates without a named event,
                 generic concepts, or anything that doesn't have a clean
                 proper-noun match for one of the six types above. "name" = ""
                 (the code fills in the project celebrity's name automatically).
                 CRITICAL: "celebrity_default" is ONLY for the project celebrity
                 (the PROJECT SUBJECT named above) or for genuinely subject-less
                 narration. If the
                 block is about a DIFFERENT named real person — even if that
                 person is a major figure in the story — use "person" with
                 their exact name, NOT "celebrity_default". Demoting a named
                 non-celebrity to "celebrity_default" makes the matcher show the
                 WRONG person's footage. When in doubt between "person" and
                 "celebrity_default", and a non-celebrity person is named and
                 is what the block is about, choose "person".

Decision procedure (apply IN ORDER, stop at the first match):
1. Does the block PROMINENTLY name a non-celebrity person? → "person"
2. Does the block PROMINENTLY name a company/publication? → "company"
3. Does the block PROMINENTLY name a TV show? → "tv_show"
4. Does the block PROMINENTLY name a movie? → "movie"
5. Does the block PROMINENTLY name a song? → "song"
6. Does the block PROMINENTLY name a specific building/venue? → "place"
7. Otherwise → "celebrity_default"

"PROMINENTLY" means the entity is what the sentence is actually about, not
just mentioned in passing. "He spoke at the London Palladium" → "place"
(the venue is the visual hook). "He spoke about his time in London" →
"celebrity_default" (the visual is him, not a generic London shot). If you
can't decide, pick "celebrity_default" — it is the safe default.

When multiple entities fit, pick the ONE that most carries the block's
visual meaning. A block whose subject is a NAMED PERSON other than the
project celebrity is "person" with that person's exact name — even if a
company or venue is also mentioned in passing (e.g. where something was
published, or where it happened). The publication/venue only wins when it
is itself the subject of the sentence.

KEY DISTINCTION (applies to EVERY project, whoever the celebrity is):
- A block about a NAMED non-celebrity person → "person" (their exact name),
  NOT "celebrity_default". This holds even when that person is a major
  figure in the story — "celebrity_default" is reserved for the project
  celebrity and subject-less narration only.
- A block about the PROJECT CELEBRITY themselves → "celebrity_default".
- A block with no clear named subject (abstract narration, transitions,
  recaps, generic concepts) → "celebrity_default".

Examples (the placeholder "[CELEBRITY]" is whoever the project celebrity is;
"[OTHER PERSON]" is any different named person in the script):
- "[OTHER PERSON] made a crude remark"        → person, "[OTHER PERSON]"
- "[OTHER PERSON] issued an apology"          → person, "[OTHER PERSON]"
- "[OTHER PERSON] was brought in to replace him" → person, "[OTHER PERSON]"
- "The Guardian published the transcript"     → company, "The Guardian"
- "He had been a judge on Britain's Got Talent" → tv_show, "Britain's Got Talent"
- "The recording was captured at the London Palladium" → place, "London Palladium"
- "[CELEBRITY] called the comments unacceptable" → celebrity_default (it's the celebrity)
- "Private conversations between friends"      → celebrity_default
- "What he didn't say was louder"              → celebrity_default
- "Three years on the show"                    → celebrity_default

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
- COMPLETENESS (HARD REQUIREMENT — read this twice). You MUST emit a block
  for EVERY complete sentence in the SECTION text below, in the order they
  appear. Do NOT skip, summarize, merge, paraphrase, or drop sentences for
  any reason — not because the sentence is "narration framing", not because
  it "recaps", not because it has no obvious visual, not because it feels
  like a transition. Recap sentences, transition sentences, and "tone"
  sentences each get their OWN block with subject_type "general",
  recommended_visual_type "footage", visual_priority "person_default". The
  matcher handles the fallback — you must not pre-filter the script. Before
  returning, count the sentences in SECTION (each terminal .!? marks one)
  and confirm blocks.length equals that count. If it does not, fix it.
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
  name, a 4-digit year, or a specific event name — EXCEPT content "broll"
  queries (see the content exception above), which may instead carry two or
  more concrete nouns taken from what THIS section's narration describes. If a
  query has neither a proper noun nor concrete content nouns, drop the intent —
  don't pad with filler.
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
"""${segment.text}"""`;

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
  //
  // Also coerce subject_type "tv_show" → "show". The legacy SubjectType
  // enum uses "show" but the new closed-world BlockEntityType uses "tv_show";
  // Gemini occasionally bleeds the latter into the former and would
  // otherwise blow up the whole segment via schema validation. The mapping
  // is unambiguous (both mean "TV programme") so we fix it silently. Same
  // logic for block_entity.type values that mis-flow into subject_type.
  const normalised = (() => {
    if (!parsed || typeof parsed !== "object") return parsed;
    const p = parsed as Record<string, unknown>;
    if ("segment_subject" in p && !("segmentSubject" in p)) p.segmentSubject = p.segment_subject;
    if ("segment_topic" in p && !("segmentTopic" in p)) p.segmentTopic = p.segment_topic;
    if (Array.isArray(p.blocks)) {
      for (const b of p.blocks as Array<Record<string, unknown>>) {
        if (b && typeof b === "object" && b.subject_type === "tv_show") {
          b.subject_type = "show";
        }
        // Inverse defensive: if block_entity.type came back as "show",
        // remap to the closed-world "tv_show" so BlockEntitySchema parses.
        const be = b?.block_entity as Record<string, unknown> | undefined;
        if (be && typeof be === "object" && be.type === "show") {
          be.type = "tv_show";
        }
      }
    }
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
    query: buildSegmentQuery(it.query, context, resolved.segmentSubject, it.intentType),
  }));

  // 2b) Deterministic story-anchor backstop. The new prompt asks Gemini to
  //     mine the section text for searchable specifics, but when the
  //     chapter title is purely editorial ("Three words", "The Cancellation")
  //     Gemini sometimes still collapses to a single bare-subject query.
  //     We synthesize additional queries by combining the segment subject
  //     with concrete anchors LITERALLY present in the section text:
  //     named people other than the subject, places, events, and 4-digit
  //     years. The result is appended (deduped) so Gemini's own intents
  //     stay primary but the segment never ends up with a single generic
  //     query when the narration has real specifics to anchor on.
  const storyAnchoredIntents = synthesizeStoryAnchoredIntents({
    sectionText: segment.text,
    subject: resolved.segmentSubject || context.mainSubject || "",
    parsed: safe.data,
    existingQueries: rewrittenIntents.map((it) => it.query.toLowerCase()),
    context,
  });
  const mergedIntents = [...rewrittenIntents, ...storyAnchoredIntents].slice(0, 6);

  // Reconcile Gemini's blocks against the section's actual sentences.
  // Gemini occasionally drops "recap" or "transition" sentences from blocks[]
  // even when the prompt forbids it (LLMs are bad at count-and-verify
  // contracts). This pass guarantees every spoken sentence in the section
  // ends up as a block — uncovered sentences get a default footage block
  // synthesized in their correct narration position so nothing in the
  // audio is missing from the timeline.
  const reconciledBlocks = reconcileBlocksAgainstSection(
    segment.text,
    applySubjectContinuity(safe.data.blocks, resolved.segmentSubject || context.mainSubject),
    resolved.segmentSubject || context.mainSubject || "",
  );
  const continuityBlocks = applySubjectContinuity(reconciledBlocks, resolved.segmentSubject || context.mainSubject);
  const blocks = normalizeBlockEntities(
    continuityBlocks,
    context.mainSubject || resolved.segmentSubject || "",
  );
  return {
    ...safe.data,
    segmentSubject: resolved.segmentSubject,
    inheritedSubject: resolved.inheritedSubject,
    segmentTopic: safe.data.segmentTopic?.trim() || safe.data.mainTopic.slice(0, 80),
    searchIntents: mergedIntents,
    blocks,
  };
}

// Harvest 4-digit years (1900-2099) literally present in the section text.
// Used by the deterministic story-anchor backstop to ground at least one
// query in a specific year when the narration mentions one. We dedupe and
// cap to keep the output bounded — five distinct years per section is far
// more than the matcher can use anyway.
function harvestYearsFromText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\b(19|20)\d{2}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const y = m[0];
    if (!seen.has(y)) {
      seen.add(y);
      out.push(y);
      if (out.length >= 5) break;
    }
  }
  return out;
}

// Build extra story-anchored queries from the parsed segment understanding
// PLUS years harvested directly from the section text. Each synthesized
// query is "<subject> <anchor>" where anchor is a literal proper noun
// (person, place, event) or a year that appears in the section. Skips
// anchors that are restatements of the subject and queries that duplicate
// an existing intent. Returns up to 3 extra intents so the merged list
// stays manageable.
//
// Output shape mirrors SegmentUnderstanding["searchIntents"][number] so
// the caller can splice directly into the searchIntents array.
function synthesizeStoryAnchoredIntents(args: {
  sectionText: string;
  subject: string;
  parsed: SegmentUnderstanding;
  existingQueries: string[]; // already-lowercased
  context: SegmentContext;
}): SegmentUnderstanding["searchIntents"] {
  const { sectionText, subject, parsed, existingQueries, context } = args;
  if (!subject) return [];
  const subjectLower = subject.toLowerCase();
  const aliasSet = new Set(
    [subject, ...(context.subjectAliases ?? [])].map((s) => s.toLowerCase()),
  );

  // Anchor pool — concrete specifics from the parsed understanding. Order
  // matters: events / places / non-subject people tend to be the strongest
  // YouTube anchors, then topics, then years (years alone are too generic).
  const anchors: string[] = [];
  for (const e of parsed.events ?? []) if (e.trim()) anchors.push(e.trim());
  for (const p of parsed.places ?? []) if (p.trim()) anchors.push(p.trim());
  for (const person of parsed.people ?? []) {
    const t = person.trim();
    if (!t) continue;
    if (aliasSet.has(t.toLowerCase())) continue; // skip subject restatements
    anchors.push(t);
  }
  for (const topic of parsed.topics ?? []) {
    const t = topic.trim();
    if (!t) continue;
    // Topics are sometimes editorial labels — skip ones that consist only
    // of generic words. isGenericPhrase covers "creative controls" /
    // "court ruling" / "interview" etc.
    if (isGenericPhrase(t)) continue;
    anchors.push(t);
  }
  for (const y of harvestYearsFromText(sectionText)) anchors.push(y);

  // Dedupe anchors case-insensitively while preserving order.
  const seenAnchor = new Set<string>();
  const uniqueAnchors = anchors.filter((a) => {
    const k = a.toLowerCase();
    if (seenAnchor.has(k)) return false;
    seenAnchor.add(k);
    return true;
  });

  const out: SegmentUnderstanding["searchIntents"] = [];
  for (const anchor of uniqueAnchors) {
    if (out.length >= 3) break;
    // Construct "<subject> <anchor>" — buildSegmentQuery would re-prepend
    // the subject if missing anyway, but doing it explicitly here keeps
    // the query human-readable and avoids subtle word-order surprises.
    const rawQuery = anchor.toLowerCase().includes(subjectLower)
      ? anchor
      : `${subject} ${anchor}`;
    const finalQuery = buildSegmentQuery(rawQuery, context, subject).trim();
    if (!finalQuery) continue;
    const lower = finalQuery.toLowerCase();
    if (existingQueries.includes(lower)) continue;
    existingQueries.push(lower);
    out.push({
      label: `Looking for ${subject} + ${anchor}`,
      query: finalQuery,
      // Default to talking_head — the ranker is loose enough on intentType
      // that this rarely matters for synthesized queries. Years skew
      // toward archival but we'd need to inspect the anchor's shape to
      // pick; keeping it talking_head matches the safest default the
      // schema uses.
      intentType: /^(19|20)\d{2}$/.test(anchor) ? "archival" : "talking_head",
    });
  }
  return out;
}

// Closed-world block-entity post-processor.
//
// Gemini fills in block_entity.type per block; we normalise the result so
// downstream code (Slice 4-6) can rely on three invariants:
//
//   1. block_entity.type is always one of the seven enum values (the schema
//      enforces this — but a missing field defaults to celebrity_default, so
//      legacy blocks emitted before this prompt change still parse cleanly).
//   2. block_entity.name is non-empty whenever type !== celebrity_default.
//      If Gemini emits e.g. type="person" with empty name, we demote the
//      block to celebrity_default rather than ship an unmatchable entity to
//      the matcher.
//   3. For celebrity_default blocks, name is the project celebrity's name
//      (so the matcher can look up the celebrity pool with a single field
//      lookup instead of resolving "celebrity_default → project subject"
//      everywhere).
//
// The function is pure — it does not consult Gemini or any external state.
// It only mutates block_entity; the rest of the block is passed through.
// Tokenize a string into lowercase word tokens for substring matching.
// We strip non-letter/digit chars so "BGT," and "BGT" both yield ["bgt"].
function tokenizeForGrounding(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

// Words too generic to count as proper-noun evidence even when Gemini puts
// them in block_entity.name. "the" / "of" / "a" appear capitalized at the
// start of every sentence; using them as the sole grounding signal lets
// "The transcript" pass when only "The" matched. We exclude these from the
// "primary token" calculation but still accept names whose OTHER tokens
// ground in the text.
const GROUNDING_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "but", "to", "for", "in", "on", "at",
  "by", "with", "from", "as", "is", "was", "were", "be", "been", "it", "its",
]);

// Decide whether block_entity.name is grounded in the block's own text.
// The rule:
//   1. Strip stopwords from the entity name. Pick the longest remaining
//      token as the "primary token" (e.g. "The Guardian" → "guardian",
//      "London Palladium" → "palladium" or "london" — whichever is longer).
//   2. The primary token must appear in the block text (tokenwise).
//   3. The primary token must appear CAPITALIZED in the original-casing
//      block text — that's the proper-noun signal. Lowercase appearance
//      ("transcript" in "...published the transcript") fails because the
//      sentence treated it as a common noun.
//
// This catches both classes of Gemini misfire:
//   - Pure common nouns ("transcript", "announcement") — fail rule (3).
//   - Plausible-but-absent names ("BGT Series 16" in a sentence that
//     only says "the show") — fail rule (2).
//
// We do NOT consult any external denylist. The block's own text is the
// ground truth — if the proper noun isn't there, the binding is wrong.
function isEntityNameGroundedInText(name: string, blockText: string): boolean {
  const nameTokensAll = tokenizeForGrounding(name);
  if (nameTokensAll.length === 0) return false;
  const meaningfulTokens = nameTokensAll.filter((t) => !GROUNDING_STOPWORDS.has(t));
  if (meaningfulTokens.length === 0) return false;
  // Primary token = the longest non-stopword token. Longer = more
  // specific, so "Palladium" beats "London" for grounding precision.
  const primary = meaningfulTokens.reduce(
    (best, cur) => (cur.length > best.length ? cur : best),
    meaningfulTokens[0],
  );
  // Rule 2: primary token must appear in the block text.
  const textTokensLower = tokenizeForGrounding(blockText);
  if (!textTokensLower.includes(primary)) return false;
  // Rule 3: primary token must appear with a capital first letter in
  // the original-casing text. We scan the raw text for the token,
  // case-insensitively, then check the character at the match start.
  const re = new RegExp(`\\b${primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const m = blockText.match(re);
  if (!m || m.index == null) return false;
  const firstChar = blockText[m.index];
  return firstChar >= "A" && firstChar <= "Z";
}

// Closed-world block-entity post-processor.
//
// Gemini fills in block_entity.{type,name} per block; we normalise the
// result so the matcher can rely on three invariants:
//
//   1. block_entity.type is always one of the seven enum values.
//   2. block_entity.name is non-empty whenever type !== celebrity_default.
//   3. For celebrity_default blocks, name is the project celebrity's name.
//
// We ALSO verify that the name is grounded in the block's own text —
// see isEntityNameGroundedInText above. Gemini occasionally hallucinates
// names that aren't in the script (sentence-keyword common nouns like
// "transcript", or plausible-but-absent show names like "BGT Series 16").
// Rather than maintain a denylist of bad words (which is endless), we
// require the name to physically appear as a capitalized token in the
// block. If it doesn't, the binding is wrong — demote to celebrity_default
// so the block renders the project celebrity instead of chasing a
// fictional entity through image search.
//
// Continuity exception: a block whose narration uses pronouns to refer
// back to the previous block's named entity ("It was published two years
// later") should keep that binding. We allow inheritance from the prior
// block when the current block has no proper noun of its own but the
// previous block's entity type+name was already accepted.
//
// The function is pure (no external state). Input is the block plan as
// emitted by Gemini; output is the same blocks with normalized
// block_entity bindings.
export function normalizeBlockEntities(blocks: BlockPlan[], projectCelebrity: string): BlockPlan[] {
  const celebrity = projectCelebrity.trim();
  // Walk in order so continuity inheritance can look at the previous
  // block's FINAL binding (post-normalization), not Gemini's raw one.
  const out: BlockPlan[] = [];
  let prevBinding: { type: BlockEntityType; name: string } | null = null;
  // Diagnostic trace — captures every decision the normaliser makes so
  // an analyze run can be audited from logs. Each entry says what
  // Gemini emitted vs. what we kept/demoted and why. Logged once per
  // segment at the call site (analyzeSegment) so noise stays bounded.
  const trace: Array<{
    blockIdx: number;
    text: string;
    geminiType: string;
    geminiName: string;
    decision: "kept_celebrity_default" | "demoted_empty_name" | "kept_grounded" | "kept_continuity" | "inherited_person_pronoun" | "demoted_not_grounded";
    primaryToken?: string;
    firstCharOfMatch?: string;
  }> = [];
  const celebrityLower = celebrity.toLowerCase();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const raw = b.block_entity ?? { type: "celebrity_default" as const, name: "" };
    const type = raw.type;
    const name = (raw.name ?? "").trim();

    // Branch 1 — celebrity_default. Normally this snaps to the project
    // celebrity. BUT a pronoun-continuation block about a SECONDARY person
    // ("She has stood beside him for decades", continuing a Camilla
    // paragraph) is emitted by Gemini as celebrity_default too — it names no
    // proper noun — and would wrongly fall to the project celebrity, draining
    // every co-lead's footage into the main subject's pool. This is the
    // "script is about William AND Camilla but everything shows William" bug.
    //
    // applySubjectContinuity already ran before us and filled this block's
    // resolved_subject with the running subject (e.g. "Camilla") for pronoun
    // blocks. So: when the PREVIOUS accepted binding was a non-celebrity
    // PERSON, and this block carries no new named entity, and its inherited
    // resolved_subject still points at that same person, treat it as a
    // pronoun-continuation and INHERIT the person binding instead of snapping
    // to the celebrity. This mirrors resolved_subject's inheritance so the
    // block_entity track (which the matcher actually uses to pick the pool)
    // stays on the right person across pronoun sentences.
    if (type === "celebrity_default") {
      const resolved = (b.resolved_subject ?? "").trim().toLowerCase();
      const prevIsSecondaryPerson =
        prevBinding != null &&
        prevBinding.type === "person" &&
        prevBinding.name.toLowerCase() !== celebrityLower;
      const continuesPrevPerson =
        prevIsSecondaryPerson &&
        resolved.length > 0 &&
        resolved === prevBinding!.name.toLowerCase();
      if (continuesPrevPerson) {
        const inherited: { type: BlockEntityType; name: string } = { type: "person", name: prevBinding!.name };
        out.push({ ...b, block_entity: inherited });
        prevBinding = inherited;
        trace.push({ blockIdx: i, text: (b.text ?? "").slice(0, 80), geminiType: type, geminiName: name, decision: "inherited_person_pronoun", primaryToken: inherited.name });
        continue;
      }
      const binding = { type: "celebrity_default" as const, name: celebrity };
      out.push({ ...b, block_entity: binding });
      prevBinding = binding;
      trace.push({ blockIdx: i, text: (b.text ?? "").slice(0, 80), geminiType: type, geminiName: name, decision: "kept_celebrity_default" });
      continue;
    }

    // Branch 2 — matchable type with empty name: demote.
    if (!name) {
      const binding = { type: "celebrity_default" as const, name: celebrity };
      out.push({ ...b, block_entity: binding });
      prevBinding = binding;
      trace.push({ blockIdx: i, text: (b.text ?? "").slice(0, 80), geminiType: type, geminiName: name, decision: "demoted_empty_name" });
      continue;
    }

    // Branch 3 — matchable type with a name. Check grounding.
    const grounded = isEntityNameGroundedInText(name, b.text ?? "");
    // Capture grounding details for trace.
    const meaningfulTokens = tokenizeForGrounding(name).filter((t) => !GROUNDING_STOPWORDS.has(t));
    const primary = meaningfulTokens.length > 0
      ? meaningfulTokens.reduce((best, cur) => (cur.length > best.length ? cur : best), meaningfulTokens[0])
      : "";
    let firstCharOfMatch = "";
    if (primary && b.text) {
      const re = new RegExp(`\\b${primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const m = b.text.match(re);
      if (m && m.index != null) firstCharOfMatch = b.text[m.index] ?? "";
    }
    if (grounded) {
      const groundedBinding: { type: BlockEntityType; name: string } = { type, name };
      out.push({ ...b, block_entity: groundedBinding });
      prevBinding = groundedBinding;
      trace.push({ blockIdx: i, text: (b.text ?? "").slice(0, 80), geminiType: type, geminiName: name, decision: "kept_grounded", primaryToken: primary, firstCharOfMatch });
      continue;
    }

    // Branch 4 — name not grounded in THIS block's text. Try continuity:
    // if Gemini's claimed binding matches the previous block's accepted
    // binding (same type AND same name), the current block is a pronoun-
    // continuation of the previous one. Keep the binding.
    if (
      prevBinding &&
      prevBinding.type === type &&
      prevBinding.name.toLowerCase() === name.toLowerCase()
    ) {
      const continuityBinding: { type: BlockEntityType; name: string } = { type, name };
      out.push({ ...b, block_entity: continuityBinding });
      prevBinding = continuityBinding;
      trace.push({ blockIdx: i, text: (b.text ?? "").slice(0, 80), geminiType: type, geminiName: name, decision: "kept_continuity", primaryToken: primary, firstCharOfMatch });
      continue;
    }

    // Branch 5 — neither grounded nor a continuation. Demote.
    const demoteBinding: { type: BlockEntityType; name: string } = { type: "celebrity_default", name: celebrity };
    out.push({ ...b, block_entity: demoteBinding });
    prevBinding = demoteBinding;
    trace.push({ blockIdx: i, text: (b.text ?? "").slice(0, 80), geminiType: type, geminiName: name, decision: "demoted_not_grounded", primaryToken: primary, firstCharOfMatch });
  }
  // Emit the full trace as one console.log entry — analyzeSegment will
  // pick this up via stdout. Only emit if at least one decision was
  // made on a matchable type (avoid noise on celebrity-only segments).
  const matchableTraces = trace.filter((t) =>
    t.decision === "kept_grounded" ||
    t.decision === "kept_continuity" ||
    t.decision === "inherited_person_pronoun" ||
    t.decision === "demoted_not_grounded" ||
    t.decision === "demoted_empty_name"
  );
  if (matchableTraces.length > 0) {
    console.log(JSON.stringify({
      msg: "analyzeSegment.block_entity_normalize",
      celebrity,
      decisions: trace,
    }));
  }
  return out;
}

// Walk every block across every segment in narration order and tally, per
// secondary person (anyone who is NOT the project celebrity), BOTH:
//   - maxRun:      longest consecutive run of blocks bound to them, and
//   - totalBlocks: total blocks bound to them across the whole script.
//
// totalBlocks is the appearance count that drives the hybrid
// secondary-character policy (see qualifiesForVideoClips): a person at or
// above SECONDARY_PERSON_VIDEO_THRESHOLD blocks earns the source-video + clip
// path; below it they get still images only. We gate on totalBlocks rather
// than maxRun so a scattered-but-dominant figure ("Simon Cowell speaks out
// about David Walliams" — half the script is Walliams, but his blocks are
// split up so no single run is long) still earns footage. maxRun is retained
// because the matcher's photo-cache sizer weighs both signals.
//
// The map key is the person's name, lower-cased so analyze/match callers
// can do case-insensitive lookups without re-implementing the matching
// each time.
export function findPersonRunsAcrossSegments(
  understandings: Array<{ blocks: BlockPlan[] }>,
  projectCelebrity: string,
): Map<string, { displayName: string; maxRun: number; totalBlocks: number }> {
  const celebrityLower = projectCelebrity.trim().toLowerCase();
  const result = new Map<string, { displayName: string; maxRun: number; totalBlocks: number }>();

  // Flatten all blocks across segments in narration order. Runs cross
  // segment boundaries when consecutive segments happen to both name the
  // same person (rare, but it can happen with a continuation paragraph
  // split by the topic-boundary splitter).
  type Marker = { name: string; lower: string };
  const flat: Marker[] = [];
  for (const u of understandings) {
    for (const b of u.blocks) {
      const be = b.block_entity;
      if (!be) { flat.push({ name: "", lower: "" }); continue; }
      if (be.type !== "person") { flat.push({ name: "", lower: "" }); continue; }
      const nm = (be.name ?? "").trim();
      const lo = nm.toLowerCase();
      if (!nm || lo === celebrityLower) { flat.push({ name: "", lower: "" }); continue; }
      flat.push({ name: nm, lower: lo });
    }
  }

  // First pass: total block count per person (footprint across the WHOLE
  // script, scattered or not). This is the new signal that catches a major
  // figure whose mentions never cluster into a 4-block run.
  const totals = new Map<string, number>();
  for (const m of flat) {
    if (!m.lower) continue;
    totals.set(m.lower, (totals.get(m.lower) ?? 0) + 1);
  }

  // Second pass: sweep the flat list counting MAX CONSECUTIVE runs.
  let i = 0;
  while (i < flat.length) {
    const cur = flat[i];
    if (!cur.lower) { i++; continue; }
    let j = i;
    while (j < flat.length && flat[j].lower === cur.lower) j++;
    const run = j - i;
    const prev = result.get(cur.lower);
    if (!prev || run > prev.maxRun) {
      result.set(cur.lower, {
        displayName: cur.name,
        maxRun: Math.max(run, prev?.maxRun ?? 0),
        totalBlocks: totals.get(cur.lower) ?? run,
      });
    }
    i = j;
  }
  return result;
}

// Appearance-count gate for the SOURCE-VIDEO / CLIP path of a secondary
// person. A secondary person earns downloaded source videos + clips only when
// they are the resolved subject of at least `threshold` narration segments
// (totalBlocks from findPersonRunsAcrossSegments). Below the threshold they
// get STILL IMAGES only — the Wikipedia / Brave / Google CSE pulls that run
// for everyone regardless of this gate.
//
// Gate on totalBlocks (footprint across the whole script), NOT maxRun: a major
// figure whose mentions are scattered (e.g. David Walliams in a "Simon Cowell
// speaks out about David Walliams" piece) never forms a long consecutive run
// but still dominates the audio and deserves footage. The threshold is the
// env knob SECONDARY_PERSON_VIDEO_THRESHOLD so it can be tuned without a code
// change; callers pass it in (this module stays env-agnostic).
//
// The main celebrity is NOT in this map (findPersonRunsAcrossSegments skips
// them) and always qualifies for video — callers gate only the secondary
// people through here. A person with no entry (never the resolved subject of
// any block) returns false: stills only.
export function qualifiesForVideoClips(
  runs: Map<string, { totalBlocks?: number }>,
  personName: string,
  threshold: number,
): boolean {
  const info = runs.get(personName.trim().toLowerCase());
  const total = info?.totalBlocks ?? 0;
  return total >= threshold;
}

// Honorific / title prefixes that Gemini emits verbatim from the script,
// causing the SAME real person to surface under two names ("Camilla" vs
// "Queen Camilla", "Charles" vs "King Charles III"). We strip these before
// comparing person names so the title-only variant collapses into the bare
// name. Order-insensitive; we strip ALL leading title tokens, not just one
// (e.g. "His Majesty King Charles" → "charles").
const HONORIFIC_PREFIXES = new Set([
  "queen", "king", "prince", "princess", "duke", "duchess", "lord", "lady",
  "sir", "dame", "dr", "doctor", "mr", "mrs", "ms", "miss", "president",
  "senator", "governor", "mayor", "judge", "captain", "general", "professor",
  "prof", "rev", "reverend", "saint", "st", "his", "her", "majesty",
  "royal", "highness", "the", "honorable", "hon",
]);

// Reduce a person name to its comparable token set: lowercase, strip
// punctuation, drop honorific prefixes and trailing regnal numerals
// ("iii", "ii"). Returns the remaining name tokens (e.g. "King Charles III"
// → ["charles"], "Queen Camilla" → ["camilla"]).
export function nameTokens(name: string): string[] {
  const raw = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Drop leading honorific tokens.
  let start = 0;
  while (start < raw.length && HONORIFIC_PREFIXES.has(raw[start])) start++;
  // Drop trailing regnal numerals (roman numerals or plain digits).
  let end = raw.length;
  const isRegnal = (t: string) => /^(?:[ivxlc]+|\d+)$/.test(t);
  while (end > start && isRegnal(raw[end - 1])) end--;
  return raw.slice(start, end);
}

// Merge person-run entries that refer to the SAME person under different
// surface forms. Two entries merge when, after stripping honorifics/titles
// and regnal numerals, one name's tokens are a (non-empty) subset of the
// other's — e.g. "Camilla" ⊂ "Queen Camilla", "Charles" ⊂ "King Charles III".
// The merged entry keeps the FULLER display name (more remaining tokens, ties
// broken by longer raw string), sums totalBlocks, and takes the max maxRun.
// This collapses the duplicate picker cards and duplicate search pools.
export function mergeDuplicatePersonRuns(
  runs: Map<string, { displayName: string; maxRun: number; totalBlocks: number }>,
): Map<string, { displayName: string; maxRun: number; totalBlocks: number }> {
  type Entry = {
    key: string;
    displayName: string;
    maxRun: number;
    totalBlocks: number;
    tokens: string[];
  };
  const entries: Entry[] = Array.from(runs.entries()).map(([key, v]) => ({
    key,
    displayName: v.displayName,
    maxRun: v.maxRun,
    totalBlocks: v.totalBlocks,
    tokens: nameTokens(v.displayName),
  }));

  const isSubset = (a: string[], b: string[]) =>
    a.length > 0 && a.every((t) => b.includes(t));

  // Union-find over entries; union when one token set is a subset of another.
  const parent = entries.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const ta = entries[a].tokens;
      const tb = entries[b].tokens;
      if (isSubset(ta, tb) || isSubset(tb, ta)) union(a, b);
    }
  }

  // Collapse each union group into one entry, keeping the fuller display name.
  const groups = new Map<number, Entry[]>();
  for (let i = 0; i < entries.length; i++) {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(entries[i]);
    groups.set(root, g);
  }

  const merged = new Map<string, { displayName: string; maxRun: number; totalBlocks: number }>();
  for (const group of groups.values()) {
    // Canonical = fuller name: most remaining tokens, then longest raw string.
    const canonical = group.reduce((best, e) => {
      if (e.tokens.length !== best.tokens.length) {
        return e.tokens.length > best.tokens.length ? e : best;
      }
      return e.displayName.length > best.displayName.length ? e : best;
    });
    merged.set(canonical.key, {
      displayName: canonical.displayName,
      maxRun: Math.max(...group.map((e) => e.maxRun)),
      totalBlocks: group.reduce((sum, e) => sum + e.totalBlocks, 0),
    });
  }
  return merged;
}

// True when two names refer to the same person under the same subset rule used
// by mergeDuplicatePersonRuns (honorific/numeral-stripped token subset, either
// direction). Used to skip the main celebrity even when a block named them with
// a title variant ("King Charles III" vs celebrity "Charles").
export function sameNamedPerson(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const subset = (x: string[], y: string[]) => x.every((t) => y.includes(t));
  return subset(ta, tb) || subset(tb, ta);
}

// Convenience predicate for callers — the exact inverse of
// qualifiesForVideoClips. Returns true when the named secondary person should
// be rendered from a still image (no clip search), false when they earned the
// source-video + clip path. MUST stay the inverse of the analyze-time gate so
// the matcher renders clips for exactly the people analyze searched clips for.
// Unknown people (no entry) default to the photo path — they were never the
// resolved subject of a block, so the matcher should never reach this for them.
export function shouldUsePhotoForSecondaryPerson(
  runs: Map<string, { totalBlocks?: number }>,
  personName: string,
  threshold: number,
): boolean {
  return !qualifiesForVideoClips(runs, personName, threshold);
}

// Split a section's text into sentences using the same regex as the
// segmenter ([^.!?]+[.!?]+(\s|$)|[^.!?]+$). Trim, drop empties.
function splitSectionIntoSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

// Normalize a span of text for inclusion comparison: lowercase, drop all
// non-alphanumeric characters, collapse whitespace. We strip punctuation
// rather than just normalising it because Gemini sometimes paraphrases
// punctuation (e.g. swaps a period for a comma when merging sentences).
function normalizeForComparison(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Build a default footage block for an uncovered sentence. Uses the
// segment's subject when known so the downstream matcher routes it to a
// person clip; falls back to the schema defaults otherwise.
function makeDefaultBlock(text: string, subject: string): BlockPlan {
  return {
    text,
    resolved_subject: subject,
    subject_type: subject ? "person" : "general",
    mentioned_entities: [],
    specific_visual_references: [],
    pronouns_detected: false,
    visual_intent: "",
    recommended_visual_type: "footage",
    visual_priority: "person_default",
    // Synthesized blocks (uncovered sentences) always fall to the celebrity
    // — they have no Gemini-typed entity to bind to. normalizeBlockEntities
    // will fill in name=projectCelebrity downstream.
    block_entity: { type: "celebrity_default", name: subject },
  };
}

// Walk every sentence in `sectionText` and confirm it appears (verbatim
// or as a substring after normalization) inside some block's text. For
// sentences with no covering block, splice a default footage block into
// the position immediately after the last block that DID cover an earlier
// sentence — preserving narration order. When Gemini's blocks happen to
// be in a different order than the section text (rare), uncovered
// sentences land at the end.
export function reconcileBlocksAgainstSection(
  sectionText: string,
  blocks: BlockPlan[],
  segmentSubject: string,
): BlockPlan[] {
  const sentences = splitSectionIntoSentences(sectionText);
  if (sentences.length === 0) return blocks;

  // Precompute normalized block texts once.
  const blockNorms = blocks.map((b) => normalizeForComparison(b.text));

  // For each section sentence, find the first block whose normalized text
  // contains the sentence's normalized form (covers exact and merged cases).
  // Track the "last covering block index" so we can insert new blocks at
  // the right position to keep narration order.
  interface Insertion { afterBlockIdx: number; block: BlockPlan; }
  const insertions: Insertion[] = [];
  let lastCoveringBlockIdx = -1;
  for (const sentence of sentences) {
    const norm = normalizeForComparison(sentence);
    if (!norm) continue;
    // Use first 10 normalized words as the needle so a Gemini-paraphrased
    // tail (e.g. trailing quote stripped) still matches its block.
    const needle = norm.split(" ").slice(0, 10).join(" ");
    let coveringIdx = -1;
    for (let i = 0; i < blockNorms.length; i++) {
      if (blockNorms[i].includes(needle)) {
        coveringIdx = i;
        break;
      }
    }
    if (coveringIdx >= 0) {
      lastCoveringBlockIdx = Math.max(lastCoveringBlockIdx, coveringIdx);
    } else {
      insertions.push({
        afterBlockIdx: lastCoveringBlockIdx,
        block: makeDefaultBlock(sentence, segmentSubject),
      });
    }
  }

  if (insertions.length === 0) return blocks;

  // Insert from highest position to lowest so earlier insertions don't
  // shift the indices of later ones.
  const out = blocks.slice();
  insertions.sort((a, b) => b.afterBlockIdx - a.afterBlockIdx);
  for (const ins of insertions) {
    out.splice(ins.afterBlockIdx + 1, 0, ins.block);
  }
  return out;
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

  // Split the segment into sentences so each one becomes its own block —
  // matches what Gemini's prompt rule "ONE BLOCK = ONE COMPLETE SENTENCE"
  // would have produced. The earlier single-mega-block fallback put the
  // entire segment text on every planner-derived block, which surfaced in
  // the editor as 30+ consecutive scenes all showing the same transcript
  // and made the audio/visual sync impossible to reason about. Sentence-
  // level blocks let the planner size each block to one sentence's spoken
  // duration so the visual changes every few seconds with the narration.
  const sentences = segment.text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)
    ?? [segment.text];
  const blocks: BlockPlan[] = sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((sentenceText) => ({
      text: sentenceText,
      resolved_subject: subject,
      subject_type: (subject ? "person" : "general") as BlockPlan["subject_type"],
      mentioned_entities: [],
      specific_visual_references: [],
      pronouns_detected: false,
      visual_intent: "",
      recommended_visual_type: "footage" as BlockPlan["recommended_visual_type"],
      visual_priority: "person_default" as BlockPlan["visual_priority"],
      block_entity: { type: "celebrity_default", name: subject } as BlockPlan["block_entity"],
    }));

  // Safety net: if sentence-splitting produced nothing (segment had no
  // terminal punctuation, e.g. a stream-of-consciousness chunk), fall back
  // to one block per the whole segment so the planner still has something.
  if (blocks.length === 0) {
    blocks.push({
      text: segment.text,
      resolved_subject: subject,
      subject_type: subject ? "person" : "general",
      mentioned_entities: [],
      specific_visual_references: [],
      pronouns_detected: false,
      visual_intent: "",
      recommended_visual_type: "footage",
      visual_priority: "person_default",
      block_entity: { type: "celebrity_default", name: subject },
    });
  }

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
    blocks,
  };
}

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

export function splitTranscriptIntoSegments(transcript: string): RawSegment[] {
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
      "recommended_visual_type": "footage | image | title_card | split_2"
    }
  ]
}

Rules:
- Use plain language in "label" — like "Looking for award show clips", not "youtube.com search 'Oscars'".
- Provide 2 to 4 searchIntents that together cover the visual story of THIS section.
- Skip the section's narration tone and writing style. Focus on what should appear on screen.
- Skip duplicates. Skip empty arrays — return [] if you have nothing.

Block-level visual rules (these matter — they drive what appears on screen):
- Split the section into 4-12 blocks. Each block is 1-3 sentences of consecutive narration.
- Choose "recommended_visual_type" per block:
  * "footage" — general narration ABOUT the celebrity/person; career, public life, story context. The viewer just needs to see the person on screen.
  * "image" — block names a SPECIFIC reference: tattoo, parent, sibling, childhood, a place, a movie/show/song title, a company, an event, a year. List the exact reference in "specific_visual_references".
  * "title_card" — block is a section heading or a strong topic shift. Rare; only if the narration explicitly opens a chapter.
  * "split_2" — block compares/relates TWO named people or two named entities (e.g. "Salma Hayek and Danny Trejo worked together"). Only when both are important visuals.
- Default to "footage" when in doubt. Footage does NOT need to perfectly match every sentence — it just needs to show the right person.
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
    }],
  };
}

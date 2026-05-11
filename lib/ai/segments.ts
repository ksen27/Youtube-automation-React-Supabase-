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

export const SegmentUnderstandingSchema = z.object({
  mainTopic: z.string().min(1),
  people: z.array(z.string()).default([]),
  places: z.array(z.string()).default([]),
  events: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  relatedKeywords: z.array(z.string()).default([]),
  searchIntents: z.array(z.object({
    label: z.string().min(1),       // human-friendly: "Searching for early life interviews"
    query: z.string().min(1),       // raw query passed to YouTube
    intentType: IntentType.default("talking_head"),
  })).min(1).max(6),
});
export type SegmentUnderstanding = z.infer<typeof SegmentUnderstandingSchema>;

export interface SegmentContext {
  // The main subject of the whole video (e.g., "Dave Kindig"). Every search
  // query for this segment is forced to include this name when set, so we
  // don't drift into generic footage for legal/news/event segments where the
  // narration mentions a place or year without re-stating the subject.
  mainSubject?: string;
  // Other proper nouns extracted from the whole script — companies, related
  // people, etc. Gemini can pick the most relevant ones for this section.
  relatedCompanies?: string[];
  relatedPeople?: string[];
}

export async function analyzeSegment(
  segment: RawSegment,
  context: SegmentContext = {},
): Promise<SegmentUnderstanding> {
  const model = getModel();
  const subject = context.mainSubject?.trim();
  const subjectBlock = subject
    ? `\nPROJECT SUBJECT: ${subject}\nThis whole video is about ${subject}. The current section may not re-state the name, but every visual we pull must still be about ${subject} or directly involve them.\n`
    : "";
  const relatedBlock = (() => {
    const parts: string[] = [];
    if (context.relatedCompanies?.length) parts.push(`Companies in this script: ${context.relatedCompanies.join(", ")}.`);
    if (context.relatedPeople?.length) parts.push(`Other people in this script: ${context.relatedPeople.join(", ")}.`);
    return parts.length ? `\n${parts.join(" ")}\n` : "";
  })();
  const subjectQueryRule = subject
    ? `- ANCHOR RULE: every "query" MUST mention "${subject}" (or a company/person from this script that is uniquely tied to ${subject}, like ${(context.relatedCompanies ?? []).slice(0, 2).join(" / ") || "their business"}). A generic query like "Utah court ruling 2016" will pull unrelated trials — instead write "${subject} lawsuit 2016" or "${(context.relatedCompanies?.[0]) ?? subject} court ruling". If you cannot anchor a query to ${subject} or one of their named entities, drop the intent.`
    : "";
  const prompt = `You are helping a video editor understand one section of a celebrity-focused voiceover.
${subjectBlock}${relatedBlock}Return STRICT JSON ONLY in this shape:
{
  "mainTopic": "short phrase, e.g. 'Margot Robbie's early career'",
  "people": ["person names mentioned"],
  "places": ["cities, countries, venues"],
  "events": ["awards, premieres, news moments"],
  "topics": ["broader themes like 'method acting', 'family life'"],
  "relatedKeywords": ["3-8 short phrases a viewer would say to describe the visuals"],
  "searchIntents": [
    { "label": "human-friendly description of what we are searching for",
      "query": "concrete YouTube search query, no quotes, max 8 words",
      "intentType": "talking_head | broll | archival" }
  ]
}

Rules:
- Use plain language in "label" — like "Looking for award show clips", not "youtube.com search 'Oscars'".
- Provide 2 to 4 searchIntents that together cover the visual story of THIS section.
- Skip the section's narration tone and writing style. Focus on what should appear on screen.
- Skip duplicates. Skip empty arrays — return [] if you have nothing.
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
    return fallbackUnderstanding(segment);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    return fallbackUnderstanding(segment);
  }
  const safe = SegmentUnderstandingSchema.safeParse(parsed);
  if (!safe.success) {
    console.error(JSON.stringify({
      msg: "analyzeSegment.schema_failed",
      raw: txt.slice(0, 400),
      issues: safe.error.flatten(),
    }));
    return fallbackUnderstanding(segment);
  }
  // Belt-and-suspenders: even with the prompt rules, Gemini occasionally slips
  // an editorial word into a query. Strip them here so YouTube never sees them.
  return {
    ...safe.data,
    searchIntents: safe.data.searchIntents.map((it) => ({
      ...it,
      query: sanitizeQuery(it.query),
    })),
  };
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

function fallbackUnderstanding(segment: RawSegment): SegmentUnderstanding {
  const firstSentence = segment.text.split(/[.!?]/, 1)[0]?.slice(0, 80) ?? "Section";
  return {
    mainTopic: firstSentence || `Part ${segment.index + 1}`,
    people: [], places: [], events: [], topics: [],
    relatedKeywords: [],
    searchIntents: [{ label: "Looking for relevant background footage", query: firstSentence, intentType: "talking_head" }],
  };
}

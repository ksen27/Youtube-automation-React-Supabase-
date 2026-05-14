import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { getEnv } from "@/lib/env";

// Gemini wrapper used by the search and match processors.
// API key: https://aistudio.google.com/app/apikey  (env GEMINI_API_KEY)

function getModel() {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const genai = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return genai.getGenerativeModel({ model: env.GEMINI_MODEL });
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

// 503 (UNAVAILABLE) and 429 (RESOURCE_EXHAUSTED) are the dominant failure
// modes during Gemini "high demand" spikes. 500 is rarer but also transient.
// Anything else (400/401/permission/quota-of-day) won't recover with retries.
export function isRetryableGeminiError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return (
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("500") ||
    /UNAVAILABLE/i.test(msg) ||
    /RESOURCE_EXHAUSTED/i.test(msg) ||
    /high demand/i.test(msg)
  );
}

// Exponential backoff with full jitter. 1s → 3s → 9s by default — total
// worst-case wait is ~13s before giving up, which is acceptable inside the
// clip job (label runs alongside upload) and the match job (one batch out
// of many, run with bounded concurrency).
export async function withGeminiRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1 || !isRetryableGeminiError(e)) throw e;
      const delay = Math.round(baseMs * Math.pow(3, i) * (0.5 + Math.random()));
      console.warn(JSON.stringify({
        msg: "gemini.retry",
        op: label,
        attempt: i + 1,
        nextDelayMs: delay,
        err: (e as Error).message?.slice(0, 200),
      }));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Concurrency limiter — caps simultaneous Gemini calls inside one process so
// we don't fan out 10+ batches against a model that's already throwing 503s.
// ---------------------------------------------------------------------------

function makeLimit(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];
  const next = () => {
    active--;
    const w = waiters.shift();
    if (w) w();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

// ---------------------------------------------------------------------------
// Truncated-JSON salvage — Gemini sometimes returns a partial response when a
// 503 hits mid-stream. We've seen `responseLength: 357` for a batch that
// should be ~3000 bytes. Try to close braces/brackets so we still get the
// completed candidates instead of dropping the whole batch.
// ---------------------------------------------------------------------------

function trySalvageTruncatedJson(raw: string): unknown | null {
  // Walk the string and remember the position where we just finished closing
  // a complete candidate object inside `candidates`. The expected nesting is:
  //
  //   { sections: [ { section_index, candidates: [ { ... } ] } ] }
  //   ^outer     ^secArr  ^secObj            ^candArr ^candObj
  //
  // A candidate object closes when we transition from depthBrace 3 → 2 while
  // depthBracket is 2. After truncating to that point, we close: candArr (]),
  // secObj (}), secArr (]), outer (}). When the truncation falls *between*
  // sections (the response cut after the inner `]}` but before the next
  // section's `{`), only the candidates we already captured will be in the
  // first section — that's still better than dropping the whole batch.
  let depthBrace = 0;
  let depthBracket = 0;
  let lastSafeEnd = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depthBrace++;
    else if (c === "}") {
      const before = depthBrace;
      depthBrace--;
      // Just closed a candidate object: was at depth 3, now at 2, inside
      // the candidates array (bracket depth 2).
      if (before === 3 && depthBracket === 2) lastSafeEnd = i;
    } else if (c === "[") depthBracket++;
    else if (c === "]") depthBracket--;
  }
  if (lastSafeEnd < 0) return null;
  const trimmed = raw.slice(0, lastSafeEnd + 1) + "]}]}";
  try { return JSON.parse(trimmed); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

export const ExtractedEntitySchema = z.object({
  type: z.enum([
    "celebrity", "related_person", "movie", "tv_show",
    "song", "company", "place", "event", "year", "age",
  ]),
  // Gemini sometimes returns numbers for year/age despite the prompt asking for strings.
  value: z.union([z.string(), z.number()]).transform((v) => String(v)).pipe(z.string().min(1)),
  confidence: z.number().min(0).max(1).default(0.8),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

const EntityListSchema = z.object({ entities: z.array(ExtractedEntitySchema) });

export async function extractEntities(transcript: string): Promise<ExtractedEntity[]> {
  if (!transcript.trim()) return [];
  const model = getModel();
  const prompt = `You are extracting structured entities from a celebrity-focused video script.
Return strict JSON ONLY in the form:
{ "entities": [ { "type": "...", "value": "...", "confidence": 0.0-1.0, "metadata": {} } ] }

Allowed types: celebrity, related_person, movie, tv_show, song, company, place, event, year, age.
- "celebrity" = the main subject(s).
- "related_person" = co-stars, family, friends, rivals.
- Years should be 4-digit strings like "1998".
- Ages should be plain numbers like "32".
- Skip duplicates. Skip generic words.
- Confidence reflects how certain you are.

SCRIPT:
"""${transcript.slice(0, 12000)}"""`;

  let txt: string;
  try {
    const res = await withGeminiRetry("extractEntities", () =>
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      })
    );
    txt = res.response.text();
  } catch (e) {
    console.error(JSON.stringify({ msg: "extractEntities.gemini_failed", err: (e as Error).message }));
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    console.error(JSON.stringify({ msg: "extractEntities.parse_failed", raw: txt.slice(0, 500) }));
    return [];
  }
  const safe = EntityListSchema.safeParse(parsed);
  if (!safe.success) {
    console.error(JSON.stringify({
      msg: "extractEntities.schema_failed",
      raw: txt.slice(0, 500),
      issues: safe.error.flatten(),
    }));
    return [];
  }
  if (safe.data.entities.length === 0) {
    console.warn(JSON.stringify({ msg: "extractEntities.empty", raw: txt.slice(0, 500) }));
  }
  // Dedup by lowercased "type:value".
  const seen = new Set<string>();
  return safe.data.entities.filter((e) => {
    const k = `${e.type}:${e.value.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Query generation
// ---------------------------------------------------------------------------

export function buildSearchQueries(entities: ExtractedEntity[]): string[] {
  const celebs = entities.filter((e) => e.type === "celebrity").map((e) => e.value);
  const people = entities.filter((e) => e.type === "related_person").map((e) => e.value);
  const movies = entities.filter((e) => e.type === "movie").map((e) => e.value);
  const shows  = entities.filter((e) => e.type === "tv_show").map((e) => e.value);
  const events = entities.filter((e) => e.type === "event").map((e) => e.value);
  const places = entities.filter((e) => e.type === "place").map((e) => e.value);

  const queries = new Set<string>();
  const main = celebs[0];
  if (main) {
    queries.add(`${main} interview`);
    queries.add(`${main} red carpet`);
    queries.add(`${main} behind the scenes`);
  }
  for (const c of celebs) queries.add(`${c} interview`);
  for (const c of celebs) for (const m of movies) queries.add(`${c} ${m}`);
  for (const c of celebs) for (const s of shows)  queries.add(`${c} ${s}`);
  for (const c of celebs) for (const p of people) queries.add(`${c} ${p}`);
  for (const c of celebs) for (const e of events) queries.add(`${c} ${e}`);
  for (const c of celebs) for (const p of places) queries.add(`${c} ${p}`);
  if (queries.size === 0 && entities.length) queries.add(entities[0].value);
  return Array.from(queries).slice(0, 12);
}

// ---------------------------------------------------------------------------
// Clip → transcript section matching
// ---------------------------------------------------------------------------

export interface ClipForMatch {
  id: string;
  source_title: string | null;
  start_time: number;
  end_time: number;
  labels?: string[];
}
export interface SectionMatch {
  section_index: number;
  clip_id: string | null;
  reason?: string;
}
export interface ScoredCandidate {
  clip_id: string;
  score: number;       // 0–100, higher = better fit for this section
  reason?: string;
}
export interface SectionScore {
  section_index: number;
  candidates: ScoredCandidate[];   // sorted desc by score, top N only
}

const MatchListSchema = z.object({
  matches: z.array(z.object({
    section_index: z.number().int().min(0),
    clip_id: z.string().nullable(),
    reason: z.string().optional(),
  })),
});

const SectionScoresSchema = z.object({
  sections: z.array(z.object({
    section_index: z.number().int().min(0),
    candidates: z.array(z.object({
      clip_id: z.string(),
      score: z.number().min(0).max(100),
      reason: z.string().optional(),
    })).default([]),
  })),
});

// ---------------------------------------------------------------------------
// Per-clip visual labeling (Gemini Vision on the thumbnail)
// ---------------------------------------------------------------------------

// Visual category buckets. "content" is everything we can use as B-roll.
// Anything else is "junk" — title cards, end screens, blank/black frames,
// pure-text overlays — and gets dropped before reaching the matcher. Drops
// here cut storage cost AND keep the scorer's signal-to-noise high.
export const VISUAL_CATEGORIES = [
  "content",
  "title_card",
  "logo",
  "subscribe_screen",
  "credits",
  "blank",
  "text_only",
] as const;
export type VisualCategory = (typeof VISUAL_CATEGORIES)[number];

const ClipLabelsSchema = z.object({
  labels: z.array(z.string().min(1)).min(1).max(8),
  primarySubject: z.string().optional().default(""),
  setting: z.string().optional().default(""),
  visualCategory: z.enum(VISUAL_CATEGORIES).default("content"),
});
export type ClipLabels = z.infer<typeof ClipLabelsSchema>;

export function isJunkCategory(c: VisualCategory): boolean {
  return c !== "content";
}

/**
 * Ask Gemini Vision to describe what's visible in a clip's thumbnail. Returns
 * 3–8 short labels that the matcher uses to align clips to script sections.
 *
 * Why thumbnail (not the clip itself):
 *   - Thumbnails are JPEGs we already produced via ffmpeg — no extra encoding.
 *   - 1 image << 5 seconds of video for cost and latency.
 *   - The thumbnail is generated 1s into the clip, which is a representative
 *     frame for nearly all of our 5-second windows.
 */
export async function labelClipFromThumbnail(
  thumbnailPath: string,
  sourceTitle: string | null,
): Promise<ClipLabels | null> {
  const env = getEnv();
  if (!env.CLIP_LABELING_ENABLED) return null;
  if (!env.GEMINI_API_KEY) return null;

  let bytes: Buffer;
  try { bytes = await fs.readFile(thumbnailPath); } catch { return null; }
  const base64 = bytes.toString("base64");
  const model = getModel();

  const prompt = `You are describing a single thumbnail frame from a celebrity-focused B-roll clip so a video editor can decide where to place it.
The clip's source video title is: "${sourceTitle ?? "unknown"}" — use this ONLY as weak context. The frame itself is the source of truth.

Return STRICT JSON ONLY in this shape:
{
  "labels": ["3 to 8 short visual descriptors, each 1–4 words"],
  "primarySubject": "the main thing in frame (a person's role, an object, a place)",
  "setting": "the environment (e.g. 'studio interview', 'red carpet', 'palace exterior', 'archival news')",
  "visualCategory": "one of: content | title_card | logo | subscribe_screen | credits | blank | text_only"
}

Rules:
- Describe what is VISIBLY in the frame. Don't guess things you can't see.
- Prefer concrete nouns: "iron palace gates", "wedding dress", "press photographers", "archival newspaper headline".
- NEVER write a person's proper name (first name, last name, full name, nickname) anywhere — not in labels, not in primarySubject, not in setting. This rule is absolute, even when the source title contains a name and you are confident the frame shows that person. Names from the title are not visual evidence; they are also frequently wrong (sources that name two related people in the title routinely show only one, and the labeler cannot tell which). The downstream pipeline gets names from the transcript, not from you.
- When a person is visible, describe them with neutral visible attributes only: apparent sex ("man", "woman"), apparent age band ("young", "middle-aged", "older"), hair ("bald", "grey hair", "long blonde hair"), facial hair ("bearded", "clean-shaven"), clothing ("blue shirt", "leather jacket"), pose ("talking head", "looking down", "holding object"). Example primarySubject: "middle-aged bearded man, talking head" — NOT "Drew Pritchard".
- "primarySubject" must describe what is actually visible: e.g. "car grille close-up", "engine compartment", "shop floor", "middle-aged woman seated", NOT the title's subject and NOT a name.
- "setting" must describe the visible environment, not the source video's overall theme. A car-detail close-up's setting is "shop interior" or "garage"; it is NOT "interview" just because the source video happens to be an interview.
- Avoid vague labels like "scene", "moment", "image", "footage".
- Skip duplicates.

How to choose visualCategory:
- "content" — any usable B-roll: people, places, action, events, objects, archival footage. DEFAULT to this when in doubt.
- "title_card" — opening title screen with the video name centered over a background. Usually the first frame of a video.
- "logo" — a channel/network logo on a plain background, or a watermark filling most of the frame.
- "subscribe_screen" — YouTube end-card "subscribe" / "more videos" / "click here" overlay, often with circular avatars or video thumbnails arranged in a grid.
- "credits" — a list of names/roles scrolling or static at the end of a video.
- "blank" — solid black, white, or near-uniform color frame; no recognizable subject.
- "text_only" — a frame whose primary content is words (a quote card, a chyron-only shot with no visible subject behind it). NOT for normal lower-third overlays where a subject is also visible.

When visualCategory is anything other than "content", labels can be a single short item like ["title card"] or ["channel logo"] — we won't use the clip.`;

  let txt: string;
  try {
    // Tighter retry budget than the default. Labeling runs on the clip-cut
    // hot path (one call per clip × dozens of clips per source); the default
    // 1s→3s→9s ladder turns a Gemini 503 spike into ~13s of dead time per
    // failing clip. We'd rather drop the label and let the clip ship without
    // one — the matcher's Tier-2 filler tolerates label-less clips.
    const res = await withGeminiRetry(
      "labelClip",
      () => model.generateContent({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: "image/jpeg", data: base64 } },
          ],
        }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
      { attempts: 2, baseMs: 400 },
    );
    txt = res.response.text();
  } catch (e) {
    console.error(JSON.stringify({ msg: "labelClip.gemini_failed", err: (e as Error).message }));
    return null;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    console.error(JSON.stringify({ msg: "labelClip.parse_failed", raw: txt.slice(0, 300) }));
    return null;
  }
  const safe = ClipLabelsSchema.safeParse(parsed);
  if (!safe.success) {
    console.error(JSON.stringify({
      msg: "labelClip.schema_failed",
      raw: txt.slice(0, 300),
      issues: safe.error.flatten(),
    }));
    return null;
  }
  // Dedup labels case-insensitively while preserving order.
  const seen = new Set<string>();
  const labels = safe.data.labels.filter((l) => {
    const k = l.toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    labels,
    primarySubject: safe.data.primarySubject,
    setting: safe.data.setting,
    visualCategory: safe.data.visualCategory,
  };
}

/**
 * Score every (section, clip) pair so the assignment step can pick the
 * highest-scoring UNUSED clip per section and break ties properly.
 *
 * Why this replaced the old "pick one" matcher:
 *   - Old prompt asked Gemini to choose ONE clip per section. When clips
 *     shared a source title and had no labels, Gemini either returned the
 *     same id repeatedly (dedup threw most away) or failed schema validation,
 *     leaving the assignment loop to fall back to insertion order — which is
 *     why every footage block ended up showing the same shot.
 *   - With Vision-extracted labels, scoring per pair lets us re-rank when a
 *     section's first choice is already used by an earlier section.
 */
// Sections per Gemini call. Down to 1 because at 3-per-batch we still saw
// finishReason: MAX_TOKENS on most batches in production logs — the model
// produced ~400-byte truncated JSON for a budget that should have fit
// comfortably. With 1 section per call, each response is small enough that
// truncation is essentially impossible. Costs more API calls but each is
// faster, and the concurrency limiter keeps wall-time reasonable.
const SECTIONS_PER_BATCH = 1;

// Hard ceiling on the model's output for a single batch. Generous so we don't
// silently truncate from our side — we'd rather know about a runaway from
// finishReason than have it look like network truncation.
const MAX_OUTPUT_TOKENS_PER_BATCH = 4096;

/**
 * Score every (section, clip) pair so the assignment step can pick the
 * highest-scoring UNUSED clip per section and break ties properly.
 *
 * Sections are batched across multiple parallel Gemini calls because asking
 * for 100+ sections in one response routinely exceeds the output token cap
 * and truncates the JSON mid-string — which fails parsing, returns [], and
 * silently degrades the matcher to insertion-order fallback.
 */
// Per-section entity hints. When a section's text mentions a celebrity, place,
// movie, song, etc., the matcher should prefer clips whose labels match that
// specific entity over generic celebrity B-roll. Phase A of entity-aware
// matching: the scorer is told which entities are in play per section.
export interface SectionEntity {
  type: string;
  value: string;
}

export async function scoreClipsForSections(
  sections: string[],
  clips: ClipForMatch[],
  topN = 3,
  sectionEntities?: SectionEntity[][],
): Promise<SectionScore[]> {
  if (clips.length === 0 || sections.length === 0) return [];

  // Build batches that each cover SECTIONS_PER_BATCH consecutive sections.
  // We send absolute section indices so merging back is trivial — Gemini is
  // told to use them verbatim in `section_index`.
  const batches: { startIndex: number; sections: string[]; entities: SectionEntity[][] }[] = [];
  for (let i = 0; i < sections.length; i += SECTIONS_PER_BATCH) {
    batches.push({
      startIndex: i,
      sections: sections.slice(i, i + SECTIONS_PER_BATCH),
      entities: (sectionEntities ?? []).slice(i, i + SECTIONS_PER_BATCH),
    });
  }

  // Cap concurrent Gemini calls. Firing 10+ batches simultaneously during a
  // "high demand" spike is exactly how every single batch ends up 503ing —
  // we reproduced that in the worker logs (10/10 batches failed in one run).
  // 3 in flight is enough to keep latency reasonable while leaving headroom
  // for the labeler/extractor to share quota.
  const limit = makeLimit(3);
  const results = await Promise.all(
    batches.map((b) => limit(() => scoreSectionBatch(b.startIndex, b.sections, clips, topN, b.entities))),
  );

  const validIds = new Set(clips.map((c) => c.id));
  const merged: SectionScore[] = [];
  for (const batch of results) {
    for (const s of batch) {
      merged.push({
        section_index: s.section_index,
        candidates: s.candidates
          .filter((c) => validIds.has(c.clip_id))
          .sort((a, b) => b.score - a.score)
          .slice(0, topN),
      });
    }
  }
  // Sort by section index so downstream lookups are deterministic.
  merged.sort((a, b) => a.section_index - b.section_index);
  return merged;
}

async function scoreSectionBatch(
  startIndex: number,
  batchSections: string[],
  clips: ClipForMatch[],
  topN: number,
  batchEntities: SectionEntity[][] = [],
): Promise<SectionScore[]> {
  const model = getModel();

  // Build the SECTIONS block. When a section has named entities, we list
  // them inline so Gemini can prefer entity-specific clips over generic
  // ones. Format: [N] (entities: place=St Paul's, event=marriage) text...
  const sectionLines = batchSections.map((s, i) => {
    const ents = batchEntities[i] ?? [];
    const entStr = ents.length
      ? ` (entities: ${ents.map((e) => `${e.type}=${e.value}`).join(", ")})`
      : "";
    return `[${startIndex + i}]${entStr} ${s.slice(0, 280)}`;
  }).join("\n");

  const prompt = `You are scoring B-roll clips against sections of a celebrity video script.
For each section, return up to ${topN} clip_ids ranked by visual fit, with a 0–100 score.

How to score:
- The labels describe what is VISIBLY in the clip's thumbnail. Weight labels heavily.
- Clip labels never contain people's proper names — by design. When a person is in frame, labels describe them by visible attributes only (e.g. "middle-aged bearded man, talking head", "young blonde woman, red carpet"). To pick a clip for a person, match those VISIBLE attributes to what you know about the person from the section text.
- source_title is shared across many clips from the same documentary — it tells you the topic of the source video, not the visual content of THIS clip. Use it only as a weak tiebreaker. NEVER use a name in source_title as evidence that a specific clip shows that person; source titles routinely name multiple people (spouses, co-hosts, co-stars) while a given clip shows only one of them — or neither.
- A clip whose labels match the section's subject (places, events, objects, or the visible attributes of a named person) is high score.
- A clip with generic labels (close-up, talking head, studio backdrop) gets a low score unless the section is itself about an interview.
- ENTITY MATCHING is the strongest signal. When a section lists "(entities: ...)" with a person, prefer clips whose visible attributes are consistent with that person. If the section is about a woman and the clip clearly shows a man (or vice versa), score it 0 — that is a wrong-person mismatch, not a near miss. For non-person entities:
    - section entity "place=St Paul's Cathedral" → clip with labels containing "cathedral", "church wedding", "St Paul's" wins over a red-carpet clip.
    - section entity "event=car crash" → clip with labels referencing wreckage, accident, ambulance wins over a studio interview.
    - section entity "company=Apple" → a clip showing the Apple logo or storefront beats a generic tech-event clip.
    - section entity "tv_show=Match Game" → a clip from that game show (or labels like "game show set", "panel buzzer") beats a generic talking-head.
- score = 0 means "wrong fit" and the clip should not be considered. Wrong-sex person matches MUST be 0.
- DO NOT include a "reason" field. We do not use it. Output only clip_id and score.

Return STRICT MINIMAL JSON in this shape:
{ "sections": [ { "section_index": 0, "candidates": [ { "clip_id": "abc", "score": 85 } ] } ] }

The "section_index" you return MUST be the absolute index from the SECTIONS list below — use the bracketed number verbatim.

SECTIONS:
${sectionLines}

CLIPS (id | labels | source_title):
${clips.map((c) => `${c.id} | ${(c.labels ?? []).join(", ")} | ${c.source_title ?? "?"}`).join("\n")}`;

  let txt: string;
  let finishReason: string | undefined;
  try {
    const res = await withGeminiRetry(`scoreClips[${startIndex}]`, () =>
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens: MAX_OUTPUT_TOKENS_PER_BATCH,
          // Disable thinking-mode for this call. gemini-2.5-flash burns
          // most of its output budget on internal reasoning tokens before
          // producing any visible JSON — that's why every batch hit
          // MAX_TOKENS at ~315 bytes regardless of how high we set the
          // output cap. We don't need chain-of-thought for "rank these
          // 100 clips by label match" — the labels already encode the
          // signal. Setting thinkingBudget: 0 returns the full output
          // budget to actual JSON.
          thinkingConfig: { thinkingBudget: 0 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
    );
    txt = res.response.text();
    finishReason = res.response.candidates?.[0]?.finishReason;
  } catch (e) {
    console.error(JSON.stringify({
      msg: "scoreClips.gemini_failed",
      batchStartIndex: startIndex,
      batchSize: batchSections.length,
      err: (e as Error).message,
    }));
    return [];
  }

  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    // Try to recover any fully-formed candidates before giving up. Truncation
    // happens when the API cuts the response mid-stream — usually MAX_TOKENS
    // (then we should lower SECTIONS_PER_BATCH) or model-side throttling
    // during 503 spikes.
    const salvaged = trySalvageTruncatedJson(txt);
    if (salvaged) {
      console.warn(JSON.stringify({
        msg: "scoreClips.parse_salvaged",
        batchStartIndex: startIndex,
        batchSize: batchSections.length,
        responseLength: txt.length,
        finishReason,
      }));
      parsed = salvaged;
    } else {
      console.error(JSON.stringify({
        msg: "scoreClips.parse_failed",
        batchStartIndex: startIndex,
        batchSize: batchSections.length,
        responseLength: txt.length,
        finishReason,
        raw: txt.slice(0, 300),
      }));
      return [];
    }
  }
  const safe = SectionScoresSchema.safeParse(parsed);
  if (!safe.success) {
    console.error(JSON.stringify({
      msg: "scoreClips.schema_failed",
      batchStartIndex: startIndex,
      raw: txt.slice(0, 300),
      issues: safe.error.flatten(),
    }));
    return [];
  }
  return safe.data.sections;
}

/** @deprecated Use {@link scoreClipsForSections} instead. */
export async function matchClipsToSections(
  sections: string[],
  clips: ClipForMatch[]
): Promise<SectionMatch[]> {
  if (clips.length === 0 || sections.length === 0) return [];
  const model = getModel();
  const prompt = `You are picking the best B-roll clip for each section of a celebrity video script.
For each section (indexed from 0), choose ONE clip_id from the list whose source title hints at relevance, or null if no clip fits.
Return STRICT JSON in the form:
{ "matches": [ { "section_index": 0, "clip_id": "abc-...", "reason": "..." } ] }

SECTIONS:
${sections.map((s, i) => `[${i}] ${s.slice(0, 240)}`).join("\n")}

CLIPS (id — source_title — labels):
${clips.map((c) => `${c.id} — ${c.source_title ?? "?"} — ${(c.labels ?? []).join(",")}`).join("\n")}`;

  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
  });
  const txt = res.response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch { return []; }
  const safe = MatchListSchema.safeParse(parsed);
  if (!safe.success) return [];
  return safe.data.matches;
}

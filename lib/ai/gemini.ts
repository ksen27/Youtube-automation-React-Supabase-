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

  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });
  const txt = res.response.text();
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

const ClipLabelsSchema = z.object({
  labels: z.array(z.string().min(1)).min(1).max(8),
  primarySubject: z.string().optional().default(""),
  setting: z.string().optional().default(""),
});
export type ClipLabels = z.infer<typeof ClipLabelsSchema>;

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
The clip's source video title is: "${sourceTitle ?? "unknown"}"

Return STRICT JSON ONLY in this shape:
{
  "labels": ["3 to 8 short visual descriptors, each 1–4 words"],
  "primarySubject": "the main thing in frame (a person's role, an object, a place)",
  "setting": "the environment (e.g. 'studio interview', 'red carpet', 'palace exterior', 'archival news')"
}

Rules:
- Describe what is VISIBLY in the frame. Don't guess things you can't see.
- Prefer concrete nouns: "iron palace gates", "wedding dress", "press photographers", "archival newspaper headline".
- If a person is recognizable from the source title, you may name them; otherwise describe their role ("woman in white dress", "elderly man at podium").
- Avoid vague labels like "scene", "moment", "image", "footage".
- Skip duplicates.`;

  let txt: string;
  try {
    const res = await model.generateContent({
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/jpeg", data: base64 } },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    });
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
  return { labels, primarySubject: safe.data.primarySubject, setting: safe.data.setting };
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
export async function scoreClipsForSections(
  sections: string[],
  clips: ClipForMatch[],
  topN = 5,
): Promise<SectionScore[]> {
  if (clips.length === 0 || sections.length === 0) return [];
  const model = getModel();
  const prompt = `You are scoring B-roll clips against sections of a celebrity video script.
For each section, return up to ${topN} clip_ids ranked by visual fit, with a 0–100 score.

How to score:
- The labels describe what is VISIBLY in the clip's thumbnail. Weight labels heavily.
- source_title is shared across many clips from the same documentary — it tells you the topic of the source video, not the visual content of THIS clip. Use it only as a weak tiebreaker.
- A clip whose labels match the section's subject (people, places, events, objects) is high score.
- A clip with generic labels (close-up, talking head, studio backdrop) gets a low score unless the section is itself about an interview.
- score = 0 means "wrong fit" and the clip should not be considered.

Return STRICT JSON in this shape:
{ "sections": [ { "section_index": 0, "candidates": [ { "clip_id": "abc", "score": 85, "reason": "..." } ] } ] }

SECTIONS:
${sections.map((s, i) => `[${i}] ${s.slice(0, 280)}`).join("\n")}

CLIPS (id | labels | source_title):
${clips.map((c) => `${c.id} | ${(c.labels ?? []).join(", ")} | ${c.source_title ?? "?"}`).join("\n")}`;

  let txt: string;
  try {
    const res = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    });
    txt = res.response.text();
  } catch (e) {
    console.error(JSON.stringify({ msg: "scoreClips.gemini_failed", err: (e as Error).message }));
    return [];
  }

  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    console.error(JSON.stringify({ msg: "scoreClips.parse_failed", raw: txt.slice(0, 300) }));
    return [];
  }
  const safe = SectionScoresSchema.safeParse(parsed);
  if (!safe.success) {
    console.error(JSON.stringify({
      msg: "scoreClips.schema_failed",
      raw: txt.slice(0, 300),
      issues: safe.error.flatten(),
    }));
    return [];
  }
  // Filter to known clip_ids (Gemini sometimes hallucinates) and sort desc.
  const validIds = new Set(clips.map((c) => c.id));
  return safe.data.sections.map((s) => ({
    section_index: s.section_index,
    candidates: s.candidates
      .filter((c) => validIds.has(c.clip_id))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN),
  }));
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

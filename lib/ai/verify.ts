// Gemini verification gate (Slice 3 of the closed-world matching refactor).
//
// Two functions, one model. Both take a candidate image URL plus a
// reference (either a Wikipedia reference image for a person, or a typed
// entity description for non-person entities) and return a tri-state
// answer: yes | no | uncertain.
//
//   verifyPersonImage(candidateUrl, referenceUrl, personName)
//     "Is the same person visible in BOTH images?"
//     Used at fetch time for any candidate that's supposed to depict a
//     specific human (person block, person clip thumbnail).
//
//   verifyEntityImage(candidateUrl, entityType, entityName)
//     "Is this candidate actually a photo/logo/poster of <entity>?"
//     Used for non-person entities — company logo, TV show artwork,
//     movie poster, song cover art, place photo.
//
// The matcher (Slice 4-6) calls these at INGESTION time, not at render
// time, so the latency cost (a Gemini call per candidate, ~1-3s each) is
// hidden in the download phase and never blocks playback. Both functions
// fail OPEN — when Gemini errors, times out, or returns garbage, the
// result is "uncertain" and the caller's policy decides what to do. We do
// NOT default to "yes" on error — that would re-introduce the bug we're
// trying to fix.
//
// This module is STANDALONE: it does not import the matcher, the
// segments planner, the search processor, or any storage. The only side
// effect of calling these functions is the Gemini API call itself. Slices
// 4-6 wire them in at the right places.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { withGeminiRetry } from "@/lib/ai/gemini";
import type { BlockEntityType } from "@/lib/ai/segments";

// Tri-state verdict. "uncertain" means "the model could not tell" — the
// caller should treat this as a soft pass (keep the candidate but mark it
// lower priority), NOT as a hard yes. See module header.
export const VerifyVerdict = z.enum(["yes", "no", "uncertain"]);
export type VerifyVerdict = z.infer<typeof VerifyVerdict>;

export interface VerifyResult {
  verdict: VerifyVerdict;
  // Free-text reason from Gemini. Useful for debugging "why was this
  // rejected" in the editor's media picker — not used as logic anywhere.
  reason: string;
  // 0..1 confidence. Logged for tuning; the matcher's gate is binary
  // (yes/no) so it doesn't read this directly.
  confidence: number;
}

const VerifyResponseSchema = z.object({
  verdict: VerifyVerdict,
  reason: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
});

function getModel() {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const genai = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return genai.getGenerativeModel({ model: env.GEMINI_MODEL });
}

// Fetch an image URL and return it as a base64-encoded payload Gemini can
// accept as inlineData. Returns null on any failure (404, timeout, non-
// image content-type). The caller treats a null candidate or reference as
// "uncertain" — we cannot verify what we cannot fetch.
async function fetchImageAsBase64(
  url: string,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "video-automation/1.0 (verify)" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/jpeg";
    const mimeType = ct.startsWith("image/") ? ct.split(";")[0].trim() : "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    // Sanity cap — Gemini accepts large images but we don't gain anything
    // by sending 20MB hero shots. 4MB is well above what a face/logo gate
    // needs and keeps the request quick.
    if (buf.length > 4 * 1024 * 1024) return null;
    return { data: buf.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

// Single Gemini call → tri-state verdict. Centralised so both verify
// functions share retry, parsing, and error-to-"uncertain" handling.
async function askGemini(
  label: string,
  prompt: string,
  images: Array<{ data: string; mimeType: string }>,
): Promise<VerifyResult> {
  if (images.length === 0) {
    return { verdict: "uncertain", reason: "no images supplied", confidence: 0 };
  }
  const model = getModel();
  let txt: string;
  try {
    const res = await withGeminiRetry(
      label,
      () => model.generateContent({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            ...images.map((img) => ({
              inlineData: { mimeType: img.mimeType, data: img.data },
            })),
          ],
        }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
      // Tighter retry than analyzeSegment — verification runs in a loop
      // across many candidates and we'd rather fail-open one candidate
      // than spend 13s retrying each Gemini hiccup.
      { attempts: 2, baseMs: 400 },
    );
    txt = res.response.text();
  } catch (e) {
    console.warn(JSON.stringify({
      msg: "verify.gemini_failed",
      op: label,
      err: (e as Error).message?.slice(0, 200),
    }));
    return { verdict: "uncertain", reason: "gemini error", confidence: 0 };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    return { verdict: "uncertain", reason: "parse error", confidence: 0 };
  }
  const safe = VerifyResponseSchema.safeParse(parsed);
  if (!safe.success) {
    console.warn(JSON.stringify({
      msg: "verify.schema_failed",
      op: label,
      raw: txt.slice(0, 200),
    }));
    return { verdict: "uncertain", reason: "schema error", confidence: 0 };
  }
  return safe.data;
}

// =========================================================================
// verifyPersonImage — face/identity match between a candidate and a
// reference image of a known person.
// =========================================================================

export interface PersonVerifyInput {
  // The image the matcher is considering for a person block (image URL).
  candidateUrl: string;
  // The known-good reference for this person (Wikipedia infobox photo).
  // Resolved via face-references.lookupReference() before calling.
  referenceUrl: string;
  // The person's name — used only inside the prompt for context. Gemini
  // returns yes/no/uncertain regardless of name spelling.
  personName: string;
}

const PERSON_VERIFY_PROMPT = (personName: string) => `You are verifying whether two images show the SAME PERSON.

Two images are attached. The FIRST image is a known reference photo of ${personName}. The SECOND image is a candidate the editor wants to use to represent ${personName} in a documentary video.

Decide:
- "yes" — the candidate clearly shows the same person as the reference. This holds whether the candidate shows that person alone OR alongside other people (group shot, interview, red carpet). Different age, hair style, or lighting is fine — judge by facial structure.
- "no" — the candidate shows a different person, OR no recognisable person at all (a logo, a map, a chart, a text graphic, a building photo). Use "no" when you are confident the candidate is not ${personName}.
- "uncertain" — pick this when in any doubt: faces are too small / blurry / from behind, or the candidate could plausibly be them but you cannot be sure. DEFAULT to "uncertain" rather than guessing "yes" — false positives are the worst outcome here.

Return STRICT JSON ONLY in this shape:
{ "verdict": "yes" | "no" | "uncertain", "reason": "short explanation", "confidence": 0.0 to 1.0 }`;

export async function verifyPersonImage(input: PersonVerifyInput): Promise<VerifyResult> {
  const [reference, candidate] = await Promise.all([
    fetchImageAsBase64(input.referenceUrl),
    fetchImageAsBase64(input.candidateUrl),
  ]);
  // Either side missing → cannot verify. Fail open as "uncertain"; caller
  // decides whether to keep or drop based on context (an unverified person
  // block should typically be dropped; an unverified non-person should keep).
  if (!reference || !candidate) {
    return {
      verdict: "uncertain",
      reason: reference ? "candidate fetch failed" : "reference fetch failed",
      confidence: 0,
    };
  }
  return askGemini(
    `verifyPersonImage[${input.personName}]`,
    PERSON_VERIFY_PROMPT(input.personName),
    [reference, candidate],
  );
}

// =========================================================================
// verifyEntityImage — does the candidate actually depict the named entity?
// Covers company logos, TV show artwork, movie posters, song cover art,
// place photos. No reference image needed — Gemini knows what these things
// look like from training data, and the question is really "is this a
// real photo/logo/poster of X, or is it stock filler / a text graphic /
// the wrong entity entirely?"
// =========================================================================

export type EntityVerifyType = Exclude<BlockEntityType, "person" | "celebrity_default">;

export interface EntityVerifyInput {
  candidateUrl: string;
  entityType: EntityVerifyType;
  entityName: string;
}

// Per-type instruction tail — what "yes" actually means for this entity
// type. Kept short and concrete so the model has a clear positive class.
function entityYesCriterion(type: EntityVerifyType, name: string): string {
  switch (type) {
    case "company":
      return `The image shows the official logo or wordmark of ${name}. A photograph of the company's product, building, or staff is NOT a yes — the gate is for logo blocks.`;
    case "tv_show":
      return `The image shows official artwork, a title card, or a recognisable promotional still for the TV show "${name}". A random photo of one cast member without show branding is uncertain, not yes.`;
    case "movie":
      return `The image shows the official theatrical poster, key art, or a clearly recognisable promotional still for the film "${name}". A photo of one actor with no film branding is uncertain, not yes.`;
    case "song":
      return `The image shows the official cover art (single sleeve, album cover containing this track, or music-video key art) for the song "${name}". A generic photo of the artist is uncertain, not yes.`;
    case "place":
      return `The image is a photograph of the actual physical location "${name}" (the building, the venue, the landmark itself). A map outline, country flag, regional symbol, or stock photo of a similar-looking place is NOT a yes.`;
  }
}

const ENTITY_VERIFY_PROMPT = (type: EntityVerifyType, name: string) =>
  `You are verifying whether the attached image is a usable visual representation of a specific named entity.

ENTITY TYPE: ${type}
ENTITY NAME: ${name}

A "yes" answer requires:
${entityYesCriterion(type, name)}

Decide:
- "yes" — the image clearly satisfies the criterion above.
- "no" — the image is one of: a text-only graphic ("WHAT IS LOGO", "TALENT"), an infographic / chart / map, a generic stock photo unrelated to the entity, a photo of a similar-but-different entity, or anything else that does NOT depict ${name} specifically. Use "no" confidently for these.
- "uncertain" — pick this when in any doubt: the image is low quality, the entity is partially visible but not the focus, or you cannot tell what the image depicts. DEFAULT to "uncertain" rather than guessing "yes".

Return STRICT JSON ONLY in this shape:
{ "verdict": "yes" | "no" | "uncertain", "reason": "short explanation", "confidence": 0.0 to 1.0 }`;

export async function verifyEntityImage(input: EntityVerifyInput): Promise<VerifyResult> {
  const candidate = await fetchImageAsBase64(input.candidateUrl);
  if (!candidate) {
    return { verdict: "uncertain", reason: "candidate fetch failed", confidence: 0 };
  }
  return askGemini(
    `verifyEntityImage[${input.entityType}/${input.entityName}]`,
    ENTITY_VERIFY_PROMPT(input.entityType, input.entityName),
    [candidate],
  );
}

// =========================================================================
// verifyImageMatchesScript — does the candidate match what the narrator is
// saying right now?
//
// Used as a LAST-LINE gate that runs even when the per-entity verifier
// (verifyPoolAsset) skips (block_entity is celebrity_default / general).
// Catches the failure mode where a literal phrase lifted from the script
// ("The Statement", "Case Closed") gets searched bare and returns an image
// that matches the WORDS but not the TOPIC — e.g. a Nazi/swastika graphic
// captioned "The Statement / Case Closed" attached to a Britain's Got
// Talent narration.
//
// Inputs: the candidate URL plus a short "topic" line (main celebrity +
// show/series if known) and the actual script text of this block. The
// model decides whether a viewer of the topic would find the image on-topic.
// =========================================================================

export interface ScriptVerifyInput {
  candidateUrl: string;
  // One-liner project context — e.g. "David Walliams (Britain's Got Talent)".
  // Helps Gemini reject same-word-different-world images.
  topic: string;
  // The actual narration text for the block this image will sit under.
  scriptText: string;
}

const SCRIPT_VERIFY_PROMPT = (topic: string, scriptText: string) =>
  `You are gating an image that a documentary editor wants to use under a specific narration line.

PROJECT TOPIC: ${topic}
NARRATION (what the viewer hears while the image is on screen):
"${scriptText}"

A "yes" answer means: a viewer who knows the project topic would find this image obviously on-topic for the narration. It does NOT need to literally depict every noun in the script — a related photo of the celebrity, the show, the venue, the supporting people, or any clear visual reference to the events being described is fine.

A "no" answer is specifically for these failure modes:
- The image matches a LITERAL PHRASE from the narration but in the wrong world entirely (e.g. a Nazi swastika graphic captioned "The Statement" for a narration about a TV-show controversy; a stock "case closed" rubber stamp for a narration about a legal review).
- The image is hate symbolism, gore, or otherwise unsafe to place under entertainment-industry narration.
- The image is clearly from a different celebrity/show/franchise than the topic.
- The image is text-only / a meme / an infographic with no documentary value.

A "uncertain" answer is for anything ambiguous — default here when in doubt, do NOT guess "yes". Uncertain images get a soft pass downstream; "yes" is for clearly on-topic.

Return STRICT JSON ONLY in this shape:
{ "verdict": "yes" | "no" | "uncertain", "reason": "short explanation", "confidence": 0.0 to 1.0 }`;

export async function verifyImageMatchesScript(input: ScriptVerifyInput): Promise<VerifyResult> {
  const candidate = await fetchImageAsBase64(input.candidateUrl);
  if (!candidate) {
    return { verdict: "uncertain", reason: "candidate fetch failed", confidence: 0 };
  }
  return askGemini(
    `verifyImageMatchesScript[${input.topic.slice(0, 40)}]`,
    SCRIPT_VERIFY_PROMPT(input.topic, input.scriptText.slice(0, 400)),
    [candidate],
  );
}

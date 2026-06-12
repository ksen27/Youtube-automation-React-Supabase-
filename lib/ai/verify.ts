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
import { wikimediaResizedUrl } from "@/lib/images/wikipedia";
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
  // True when the verdict is NOT a judgement at all — Gemini 503'd, the
  // image fetch failed, or the response didn't parse. An errored "uncertain"
  // means "nobody looked at this image", which is fundamentally different
  // from "Gemini looked and could not tell": errored results must never be
  // cached/persisted and callers should retry them later instead of treating
  // them as a rejection. This distinction is what stops a transient Gemini
  // outage from permanently rejecting a whole pool of correct images.
  errored?: boolean;
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

type FetchedImage = { data: string; mimeType: string };

// Per-process cache of successfully fetched images, keyed by URL. The matcher
// verifies a whole person-pool against ONE reference photo — without this it
// re-downloaded that identical reference URL once PER CANDIDATE (60+ times in a
// tight, concurrent loop). Wikimedia throttles/times-out that burst, the
// reference fetch returns null, and EVERY verification then returns
// "uncertain" → the matcher drops the candidates ("reference fetch failed",
// dozens of clips lost). Caching the bytes means each distinct image is pulled
// exactly once. Cap is generous; entries are a few hundred KB of base64.
const IMAGE_CACHE_MAX = 512;
const imageCache = new Map<string, FetchedImage>();
// In-flight dedup: concurrent verifications for the same person all request the
// same reference at once. Share a single download promise so the first call
// fetches and the rest await it, instead of all firing parallel requests (which
// is the burst that triggers throttling in the first place).
const inFlight = new Map<string, Promise<FetchedImage | null>>();

async function doFetchImage(url: string): Promise<FetchedImage | null> {
  // Wikimedia ORIGINAL-file URLs are often multi-MB full-resolution scans
  // that deterministically fail the size cap / 8s timeout below — rows in
  // face_references written before the roster builder stored resized URLs
  // still point at originals. Fetch a 1024px server-side rendition first;
  // fall back to the stored URL if the resize endpoint fails.
  const resized = wikimediaResizedUrl(url, 1024);
  if (resized) {
    const img = await doFetchImageOnce(resized);
    if (img) return img;
  }
  return doFetchImageOnce(url);
}

async function doFetchImageOnce(url: string): Promise<FetchedImage | null> {
  // One retry on transient failure (timeout / 429 / 5xx) with a short backoff —
  // cheap insurance against a single throttled response killing a verdict.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let res: Response;
      try {
        res = await fetch(url, {
          signal: ctrl.signal,
          // Descriptive UA per Wikimedia's API etiquette — a generic UA on a
          // burst of identical requests is exactly what gets rate-limited.
          headers: { "User-Agent": "video-automation/1.0 (image-verify; +https://github.com/video-automation)" },
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        // Retry only transient statuses; a 404 won't fix itself.
        if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        return null;
      }
      const ct = res.headers.get("content-type") || "image/jpeg";
      const mimeType = ct.startsWith("image/") ? ct.split(";")[0].trim() : "image/jpeg";
      const buf = Buffer.from(await res.arrayBuffer());
      // Sanity cap — Gemini accepts large images but we don't gain anything
      // by sending 20MB hero shots. 4MB is well above what a face/logo gate
      // needs and keeps the request quick. Logged loudly: a capped image is
      // indistinguishable from a 404 to callers ("fetch failed"), and a
      // capped REFERENCE photo deterministically fails every verification
      // for that entity (the 2026-06-12 1712/1814-errored incident).
      if (buf.length > 4 * 1024 * 1024) {
        console.warn(JSON.stringify({
          msg: "image_fetch.size_cap_rejected",
          url: url.slice(0, 200),
          bytes: buf.length,
        }));
        return null;
      }
      return { data: buf.toString("base64"), mimeType };
    } catch {
      // Network error / abort — retry once, then give up.
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 500)); continue; }
      return null;
    }
  }
  return null;
}

// Fetch an image URL and return it as a base64-encoded payload Gemini can
// accept as inlineData. Returns null on any failure (404, timeout, non-
// image content-type). The caller treats a null candidate or reference as
// "uncertain" — we cannot verify what we cannot fetch. Results are cached per
// process and concurrent calls for the same URL are de-duplicated.
async function fetchImageAsBase64(
  url: string,
): Promise<FetchedImage | null> {
  const cached = imageCache.get(url);
  if (cached) {
    // Refresh LRU position.
    imageCache.delete(url);
    imageCache.set(url, cached);
    return cached;
  }
  const pending = inFlight.get(url);
  if (pending) return pending;

  const p = doFetchImage(url).then((img) => {
    inFlight.delete(url);
    if (img) {
      imageCache.set(url, img);
      if (imageCache.size > IMAGE_CACHE_MAX) {
        const firstKey = imageCache.keys().next().value;
        if (firstKey !== undefined) imageCache.delete(firstKey);
      }
    }
    return img;
  }).catch(() => {
    inFlight.delete(url);
    return null;
  });
  inFlight.set(url, p);
  return p;
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
    return { verdict: "uncertain", reason: "gemini error", confidence: 0, errored: true };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    return { verdict: "uncertain", reason: "parse error", confidence: 0, errored: true };
  }
  const safe = VerifyResponseSchema.safeParse(parsed);
  if (!safe.success) {
    console.warn(JSON.stringify({
      msg: "verify.schema_failed",
      op: label,
      raw: txt.slice(0, 200),
    }));
    return { verdict: "uncertain", reason: "schema error", confidence: 0, errored: true };
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
    // Fetch failures are infra failures, not judgements — a Wikimedia
    // throttle burst or CDN timeout must not become a persisted rejection.
    return {
      verdict: "uncertain",
      reason: reference ? "candidate fetch failed" : "reference fetch failed",
      confidence: 0,
      errored: true,
    };
  }
  return askGemini(
    `verifyPersonImage[${input.personName}]`,
    PERSON_VERIFY_PROMPT(input.personName),
    [reference, candidate],
  );
}

// =========================================================================
// verifyPersonImageClean — identity + overlay cleanliness for a PERSON
// image, in ONE Gemini call.
//
// Person photos sourced from the web are frequently article/clickbait
// thumbnails: a real photo of the right person but stamped with a news-
// channel logo and a big headline banner ("WILLIAM & KATE'S GLAM
// COMEBACK", a "TOI" bug, etc.). The plain verifyPersonImage gate only
// answers "is this the right person?" — so those overlay-laden thumbnails
// passed straight into the image pool. This mirrors the clip-stage clean-
// frame gate (verifyClipFrameCombined) for the IMAGE pool: it returns BOTH
// the identity verdict AND an overlay verdict so the caller can reject a
// correct-person-but-dirty image. Lenient by design about tiny photo
// credits; strict about added headline/logo/caption graphics.
//
// Fails OPEN: on any error/missing image, verdict and overlay are
// "uncertain" so a Gemini hiccup doesn't gut the pool.
// =========================================================================
export interface PersonImageCleanResult extends VerifyResult {
  // "clean"  — a plain photograph with no added graphics.
  // "minor"  — only a SMALL, unobtrusive mark: a corner stock-photo watermark
  //            (iStock/Getty/AP bug), a photographer credit, a faint logo. The
  //            photo itself is otherwise a clean, full-frame shot of the person.
  //            ACCEPTABLE for B-roll — these are common on real archival photos
  //            of historical figures and rejecting them starves the pool.
  // "dirty"  — a BIG/intrusive overlay: a headline or news banner, a
  //            lower-third / caption / quote card, a collage or split-screen,
  //            a magazine/book/product cover, or large added text. REJECTED.
  // "uncertain" — cannot tell.
  overlay: "clean" | "minor" | "dirty" | "uncertain";
  overlayArtifact: string;
}

const PERSON_IMAGE_CLEAN_PROMPT = (personName: string) => `You are vetting a candidate image an editor wants to use to represent ${personName} in a documentary video.

Two images are attached. The FIRST is a known reference photo of ${personName}. The SECOND is the candidate image. Answer TWO independent questions about the SECOND image and return BOTH in one JSON object.

(1) "verdict" — is the SECOND image the SAME PERSON as the reference?
- "yes" — clearly the same person (alone or in a group). Different age/hair/lighting is fine; judge by facial structure.
- "no" — a different person, or no recognisable person at all (a logo, map, chart, text graphic, building).
- "uncertain" — any doubt (faces too small/blurry/from behind). DEFAULT to "uncertain" over a guessed "yes".

(2) "overlay" — grade how much ADDED graphics sit on the photo. Pick the ONE that fits:
- "clean" — a plain photograph of the person with no added graphics at all.
- "minor" — the photo is otherwise a clean, full-frame shot of the person, but carries ONLY a SMALL, unobtrusive mark: a corner stock-photo watermark (e.g. an iStock / Getty / AP / Shutterstock bug), a small photographer or agency credit, or a faint corner logo. The person and scene are fully visible and not obscured. This is fine to use.
- "dirty" — the image has a BIG or intrusive overlay: a headline / news banner / title bar (large caption text like "WILLIAM & KATE'S GLAM COMEBACK"); a lower-third name strip, subtitle, or quote card; a "breaking news" banner; a collage or split-screen of multiple framed photos; a magazine / book / product (t-shirt, mug) cover with title text; or any large added text laid across the photo.
- "uncertain" — you genuinely cannot tell.
Rule of thumb: judge by how much the added graphics INTERFERE. A tiny corner watermark on an otherwise-clean photo of the correct person is "minor" (acceptable). A clickbait thumbnail with a headline banner, or a collage, is "dirty".

Return STRICT JSON ONLY:
{ "verdict": "yes" | "no" | "uncertain", "overlay": "clean" | "minor" | "dirty" | "uncertain", "overlayArtifact": "short description of any overlay, else empty", "reason": "one short sentence", "confidence": 0.0 to 1.0 }`;

const PersonImageCleanSchema = z.object({
  verdict: VerifyVerdict.default("uncertain"),
  overlay: z.enum(["clean", "minor", "dirty", "uncertain"]).default("uncertain"),
  overlayArtifact: z.string().optional().default(""),
  reason: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
});

export async function verifyPersonImageClean(input: PersonVerifyInput): Promise<PersonImageCleanResult> {
  // Every fail() path here is an infra failure (fetch / 503 / parse), never a
  // judgement — mark errored so callers retry instead of rejecting + caching.
  const fail = (reason: string): PersonImageCleanResult => ({
    verdict: "uncertain", overlay: "uncertain", overlayArtifact: "", reason, confidence: 0, errored: true,
  });
  const [reference, candidate] = await Promise.all([
    fetchImageAsBase64(input.referenceUrl),
    fetchImageAsBase64(input.candidateUrl),
  ]);
  if (!reference || !candidate) {
    return fail(reference ? "candidate fetch failed" : "reference fetch failed");
  }
  const model = getModel();
  let txt: string;
  try {
    const res = await withGeminiRetry(
      `verifyPersonImageClean[${input.personName}]`,
      () => model.generateContent({
        contents: [{
          role: "user",
          parts: [
            { text: PERSON_IMAGE_CLEAN_PROMPT(input.personName) },
            { inlineData: { mimeType: reference.mimeType, data: reference.data } },
            { inlineData: { mimeType: candidate.mimeType, data: candidate.data } },
          ],
        }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
      { attempts: 2, baseMs: 400 },
    );
    txt = res.response.text();
  } catch {
    return fail("gemini error");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch { return fail("parse error"); }
  const safe = PersonImageCleanSchema.safeParse(parsed);
  if (!safe.success) return fail("schema error");
  return {
    verdict: safe.data.verdict,
    overlay: safe.data.overlay,
    overlayArtifact: safe.data.overlayArtifact,
    reason: safe.data.reason,
    confidence: safe.data.confidence,
  };
}

// =========================================================================
// verifyPersonImagesCleanBatch — verifyPersonImageClean for MANY candidates
// in ONE Gemini call.
//
// The matcher's person-photo pools verify dozens of candidates against the
// SAME reference photo. One call per candidate meant ~120 round-trips per
// person, re-uploading the identical reference image every time — that
// volume was both the dominant wall-time cost of the match step AND the
// thing that tripped Gemini's 503 "high demand" limiter. Batching sends the
// reference once plus up to PERSON_VERIFY_BATCH_MAX candidates and asks for
// one verdict per candidate, cutting calls (and 503 exposure) ~8x.
//
// Failure semantics per candidate:
//   - candidate fetch failed   → errored result for THAT candidate only;
//                                the rest still go to Gemini.
//   - Gemini call failed       → errored result for every candidate that
//                                was in the call (caller parks + retries).
//   - model omitted an index   → errored result for that candidate (never
//                                guess a verdict the model didn't give).
// Results are returned aligned 1:1 with input.candidateUrls.
// =========================================================================

export const PERSON_VERIFY_BATCH_MAX = 8;

const PersonImageCleanBatchSchema = z.object({
  results: z.array(PersonImageCleanSchema.extend({
    index: z.number().int().min(1),
  })),
});

const PERSON_IMAGE_CLEAN_BATCH_PROMPT = (personName: string, count: number) => `You are vetting ${count} candidate images an editor wants to use to represent ${personName} in a documentary video.

${count + 1} images are attached. The FIRST is a known reference photo of ${personName}. The following ${count} images are CANDIDATES, numbered 1 to ${count} in attachment order. For EACH candidate, answer TWO independent questions.

(1) "verdict" — is the candidate the SAME PERSON as the reference?
- "yes" — clearly the same person (alone or in a group). Different age/hair/lighting is fine; judge by facial structure.
- "no" — a different person, or no recognisable person at all (a logo, map, chart, text graphic, building).
- "uncertain" — any doubt (faces too small/blurry/from behind). DEFAULT to "uncertain" over a guessed "yes".

(2) "overlay" — grade how much ADDED graphics sit on the photo. Pick the ONE that fits:
- "clean" — a plain photograph of the person with no added graphics at all.
- "minor" — the photo is otherwise a clean, full-frame shot of the person, but carries ONLY a SMALL, unobtrusive mark: a corner stock-photo watermark (e.g. an iStock / Getty / AP / Shutterstock bug), a small photographer or agency credit, or a faint corner logo. The person and scene are fully visible and not obscured. This is fine to use.
- "dirty" — the image has a BIG or intrusive overlay: a headline / news banner / title bar; a lower-third name strip, subtitle, or quote card; a "breaking news" banner; a collage or split-screen of multiple framed photos; a magazine / book / product cover with title text; or any large added text laid across the photo.
- "uncertain" — you genuinely cannot tell.
Rule of thumb: judge by how much the added graphics INTERFERE. A tiny corner watermark on an otherwise-clean photo of the correct person is "minor" (acceptable). A clickbait thumbnail with a headline banner, or a collage, is "dirty".

Judge every candidate INDEPENDENTLY — do not let one candidate's verdict influence another's.

Return STRICT JSON ONLY, with EXACTLY one entry per candidate (indexes 1 to ${count}):
{ "results": [ { "index": 1, "verdict": "yes" | "no" | "uncertain", "overlay": "clean" | "minor" | "dirty" | "uncertain", "overlayArtifact": "short description of any overlay, else empty", "reason": "one short sentence", "confidence": 0.0 to 1.0 }, ... ] }`;

export interface PersonBatchVerifyInput {
  // Candidate image URLs, verified together against ONE reference. Callers
  // should chunk to PERSON_VERIFY_BATCH_MAX; longer lists are still handled
  // (single call) but accuracy degrades with very large image counts.
  candidateUrls: string[];
  referenceUrl: string;
  personName: string;
}

export async function verifyPersonImagesCleanBatch(
  input: PersonBatchVerifyInput,
): Promise<PersonImageCleanResult[]> {
  const errResult = (reason: string): PersonImageCleanResult => ({
    verdict: "uncertain", overlay: "uncertain", overlayArtifact: "", reason, confidence: 0, errored: true,
  });
  if (input.candidateUrls.length === 0) return [];

  const reference = await fetchImageAsBase64(input.referenceUrl);
  if (!reference) return input.candidateUrls.map(() => errResult("reference fetch failed"));

  const fetched = await Promise.all(input.candidateUrls.map((u) => fetchImageAsBase64(u)));
  // Candidates whose fetch failed get an errored result and are excluded
  // from the Gemini call; `sent` maps attachment order → input position.
  const results: Array<PersonImageCleanResult | null> = fetched.map((img) =>
    img ? null : errResult("candidate fetch failed"),
  );
  const sent: Array<{ inputIdx: number; img: FetchedImage }> = [];
  fetched.forEach((img, i) => { if (img) sent.push({ inputIdx: i, img }); });
  if (sent.length === 0) return results as PersonImageCleanResult[];

  const model = getModel();
  let txt: string;
  try {
    const res = await withGeminiRetry(
      `verifyPersonImageCleanBatch[${input.personName}x${sent.length}]`,
      () => model.generateContent({
        contents: [{
          role: "user",
          parts: [
            { text: PERSON_IMAGE_CLEAN_BATCH_PROMPT(input.personName, sent.length) },
            { inlineData: { mimeType: reference.mimeType, data: reference.data } },
            ...sent.map((s) => ({ inlineData: { mimeType: s.img.mimeType, data: s.img.data } })),
          ],
        }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
      // A failed batch costs up to 8 verdicts (vs 1 on the single path), so
      // it gets one more attempt than the single verify before parking.
      { attempts: 3, baseMs: 500 },
    );
    txt = res.response.text();
  } catch {
    for (const s of sent) results[s.inputIdx] = errResult("gemini error");
    return results as PersonImageCleanResult[];
  }

  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    for (const s of sent) results[s.inputIdx] = errResult("parse error");
    return results as PersonImageCleanResult[];
  }
  const safe = PersonImageCleanBatchSchema.safeParse(parsed);
  if (!safe.success) {
    console.warn(JSON.stringify({
      msg: "verify.batch_schema_failed",
      op: `verifyPersonImageCleanBatch[${input.personName}]`,
      raw: txt.slice(0, 200),
    }));
    for (const s of sent) results[s.inputIdx] = errResult("schema error");
    return results as PersonImageCleanResult[];
  }

  // Map the model's 1-based attachment indexes back to input positions.
  // Duplicate indexes: first one wins. Missing indexes: errored (retry later)
  // — never invent a verdict the model didn't actually give.
  const byIndex = new Map<number, (typeof safe.data.results)[number]>();
  for (const r of safe.data.results) {
    if (!byIndex.has(r.index)) byIndex.set(r.index, r);
  }
  sent.forEach((s, attachPos) => {
    const r = byIndex.get(attachPos + 1);
    results[s.inputIdx] = r
      ? {
          verdict: r.verdict,
          overlay: r.overlay,
          overlayArtifact: r.overlayArtifact,
          reason: r.reason,
          confidence: r.confidence,
        }
      : errResult("missing batch result");
  });
  return results as PersonImageCleanResult[];
}

// =========================================================================
// verifyImageIsPerson — is this image a single real human portrait?
//
// Content-based replacement for the old description-word-list guard. A bare
// ambiguous name ("William", "Salam") resolves on Wikipedia to a non-person
// page whose image is a tapestry, calligraphy, a map, or a logo. Rather than
// trying to enumerate every bad description string (which always misses some —
// "Arabic greeting" slipped past the word list), we look at the IMAGE itself
// and ask whether it depicts a single recognizable human. Works for ANY wrong
// page type without hardcoding. Fails OPEN ("uncertain"→accept) so a Gemini
// hiccup doesn't strip a legitimate reference.
// =========================================================================
export async function verifyImageIsPerson(imageUrl: string): Promise<VerifyResult> {
  const img = await fetchImageAsBase64(imageUrl);
  if (!img) return { verdict: "uncertain", reason: "image fetch failed", confidence: 0 };
  const prompt = `You are checking whether an image is usable as a REFERENCE PHOTO of a real person.

Return STRICT JSON ONLY: { "verdict": "yes" | "no" | "uncertain", "reason": "short", "confidence": 0.0-1.0 }

- "yes" — the image clearly shows a single real human being (a photograph or portrait of a person; a face is visible).
- "no" — the image is NOT a usable person photo: it is text / calligraphy / a word graphic, a logo or wordmark, a map or flag, a building or landscape with no person, an illustration/painting of an object, a coat of arms, a chart, or a crowd with no single clear subject.
- "uncertain" — you genuinely cannot tell.

Be strict: a graphic of a written word, a tapestry, or a logo is "no", even if it is historically associated with a name.`;
  return askGemini("verifyImageIsPerson", prompt, [img]);
}

// =========================================================================
// verifyClipFrameCombined — ONE Gemini call answering BOTH clip-quality
// questions for a single frame: (1) is the footage clean (no logo / watermark
// / text / title card)? and (2) is the target person present?
//
// This merges what used to be two separate calls per frame
// (classifyFrameCleanliness + verifyPoolAsset/verifyPersonImage), halving the
// Gemini Vision spend on the clip hot path. The frame and the person's
// reference photo are sent together; the model returns both verdicts in one
// JSON object.
//
// Fails OPEN: on any error / missing image the result is clean:"uncertain"
// and face:"uncertain" — the caller's policy (clipProcessor) decides.
// =========================================================================

export const FrameCleanVerdict = z.enum(["clean", "dirty", "uncertain"]);
export type FrameCleanVerdict = z.infer<typeof FrameCleanVerdict>;

// Face verdict for a sampled video frame. Unlike the image-pool VerifyVerdict
// this distinguishes "a DIFFERENT person is the subject" (no — the hard-drop
// signal) from "no people in the frame at all" (no_person — clean B-roll the
// clip pool keeps; the matcher's subject_present gating already steers it away
// from person-anchored blocks). Collapsing both into "no" was hard-dropping
// perfectly clean establishing shots / scenery as "wrong person".
export const FrameFaceVerdict = z.enum(["yes", "no", "no_person", "uncertain"]);
export type FrameFaceVerdict = z.infer<typeof FrameFaceVerdict>;

export interface CombinedFrameResult {
  clean: FrameCleanVerdict;
  face: FrameFaceVerdict;       // yes | no (different person) | no_person | uncertain
  cleanArtifact: string;        // short description of any overlay seen
  reason: string;
}

const CombinedFrameSchema = z.object({
  clean: FrameCleanVerdict.default("uncertain"),
  cleanArtifact: z.string().optional().default(""),
  face: FrameFaceVerdict.default("uncertain"),
  reason: z.string().optional().default(""),
});

export interface CombinedFrameInput {
  // A single sampled frame of the cut clip (uploaded thumbnail URL).
  frameUrl: string;
  // The person we want present. Optional — when absent (or no reference is
  // available) the face question is skipped and face = "uncertain".
  personName?: string;
  // The person's reference photo (Wikipedia). Required for the face check;
  // when missing, only the cleanliness question is asked.
  referenceUrl?: string | null;
}

function combinedPrompt(personName?: string): string {
  const faceBlock = personName
    ? `\n\nThe FIRST image is a known reference photo of ${personName}. The SECOND image is the video frame. For the "face" field, decide whether ${personName} (the person in the reference) is visibly present in the SECOND image:
- "yes" — the same person as the reference is clearly visible (alone or among others).
- "no" — a DIFFERENT person is clearly the subject of the frame (a recognisable face that is not the reference person).
- "no_person" — there is no recognisable person in the frame at all (scenery, a building, an object, a vehicle, a crowd with no distinct faces).
- "uncertain" — faces too small / blurry / from behind, or you cannot be sure. Default to "uncertain" over a guessed "yes" or "no".`
    : `\n\nOnly ONE image is attached (the video frame). There is no person to check, so always return "uncertain" for the "face" field.`;

  const frameRef = personName ? "the SECOND image (the video frame)" : "the attached video frame";

  return `You are a broadcast-quality gate for a documentary editor. Judge ${frameRef} on TWO independent questions and return BOTH in one JSON object.

(1) "clean" — is this clean, usable footage with NO graphic overlays?
FIRST, scan all FOUR CORNERS and the bottom edge of the frame for small persistent branding before judging the center — burned-in channel logos and site watermarks live there and are easy to overlook when the center of the frame is a face or action.
Mark "dirty" if the frame shows ANY of: a channel/network logo, brand mark, or watermark (even a SMALL corner station bug, a semi-transparent logo, or a website/URL strip such as "somesite.com" / "somesite.tv" burned into a corner or along an edge); on-screen text of ANY kind — captions, subtitles, burned-in auto-captions or "word pop" caption text (a single emphasised word like "GREAT" / "WOW" synced to speech, often centered or near the bottom), lower-third name strips, chyrons, headlines, quote cards, breaking-news banners; a title card; an end screen / subscribe / "more videos" overlay; scrolling or static credits; or a near-blank solid frame with no real subject.
IMPORTANT — only graphics ADDED ON TOP of the footage count as overlays. Text, logos, and branding that are physically PART OF THE FILMED SCENE are NOT overlays and do NOT make the frame "dirty": street or storefront signs, posters, event banners, sponsor backdrops / step-and-repeat walls at red carpets and press conferences, microphone flags, product packaging, clothing prints, vehicle decals, stage screens, or text on a phone/TV being filmed. If the text sits IN the scene (subject to the scene's perspective and lighting) rather than flat ON the image, it is part of the scene.
Mark "clean" ONLY if it is plain photographed footage with NO ADDED graphics — no corner logo, no URL/site watermark, and no caption/subtitle text laid over the frame. In-scene text per the rule above is still "clean".
Mark "uncertain" only if you genuinely cannot tell. Be strict about ADDED graphics: any burned-in logo, watermark, URL, or caption → "dirty", however small — but do NOT penalise in-scene text. When you mark dirty, name the artifact precisely in "cleanArtifact" using the most specific word — e.g. "corner channel logo", "werewolftvseries.com watermark bottom-right", "lower-third name strip", or "burned-in caption text 'GREAT'" / "subtitle" for spoken-word captions.${faceBlock}

Return STRICT JSON ONLY:
{ "clean": "clean" | "dirty" | "uncertain", "cleanArtifact": "short description of any overlay, else empty", "face": "yes" | "no" | "no_person" | "uncertain", "reason": "one short sentence" }`;
}

export async function verifyClipFrameCombined(
  input: CombinedFrameInput,
): Promise<CombinedFrameResult> {
  const fail = (reason: string): CombinedFrameResult => ({
    clean: "uncertain", face: "uncertain", cleanArtifact: "", reason,
  });

  const wantFace = !!(input.personName && input.referenceUrl);
  const [reference, candidate] = await Promise.all([
    wantFace ? fetchImageAsBase64(input.referenceUrl!) : Promise.resolve(null),
    fetchImageAsBase64(input.frameUrl),
  ]);
  if (!candidate) return fail("frame fetch failed");

  // Image order matters: when a reference exists it is FIRST (the prompt refers
  // to "FIRST image" = reference, "SECOND image" = frame). Without a reference,
  // only the frame is sent and the face question is forced "uncertain".
  const images = reference ? [reference, candidate] : [candidate];

  const model = getModel();
  let txt: string;
  try {
    const res = await withGeminiRetry(
      `verifyClipFrame[${input.personName ?? "no-person"}]`,
      () => model.generateContent({
        contents: [{
          role: "user",
          parts: [
            { text: combinedPrompt(reference ? input.personName : undefined) },
            ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
          ],
        }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
      }),
      { attempts: 2, baseMs: 400 },
    );
    txt = res.response.text();
  } catch {
    return fail("gemini error");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch { return fail("parse error"); }
  const safe = CombinedFrameSchema.safeParse(parsed);
  if (!safe.success) return fail("schema error");
  // When no reference was available, never report a positive face verdict.
  const face = reference ? safe.data.face : "uncertain";
  return {
    clean: safe.data.clean,
    face,
    cleanArtifact: safe.data.cleanArtifact,
    reason: safe.data.reason,
  };
}

// =========================================================================
// detectSourceWatermark — does a WHOLE source video carry PERSISTENT burned-in
// on-screen graphics: a logo / channel bug / site watermark, OR baked-in
// captions / subtitles that run throughout the video?
//
// Per-clip cleanliness checks are unreliable for these. For a small corner
// logo, Gemini notices the bug on some sampled frames and misses it on others
// (returning "uncertain"), slipping a branded clip past the per-clip majority
// gate. For word-by-word auto-captions (a single word like "GREAT" synced to
// speech), the TEXT CHANGES every frame — so within one short clip's 3 sampled
// frames the caption lands on maybe one of them, and the majority rule (built
// to TOLERATE a transient lower-third) keeps the clip. Both artifacts are
// burned into the WHOLE source, so we decide ONCE per source: sample frames
// spread across the whole runtime and ask whether such a graphic is present.
// A graphic on MOST sampled frames is PERSISTENT — a channel bug or baked-in
// subtitle track — not a one-off chyron, and the whole source should skip.
//
// Two artifact classes count toward the vote, tracked separately for logging:
//   - logo/watermark (a fixed brand mark)
//   - caption/subtitle (recurring on-screen speech text)
// A SINGLE transient chyron lands on ~1 of N frames spread across the video,
// so it never reaches the majority — that's the guard against discarding a
// source for occasional text. Fails CLOSED-to-keep: any error / no usable
// frames → not flagged (we don't drop a source on a Gemini hiccup).
// =========================================================================

// Artifact phrases for a persistent brand mark. Deliberately NARROW: it only
// matches words Gemini uses for burned-in marks (logo / watermark / station
// bug / a domain in a URL strip). Generic words like "brand(ing)", "url", or
// "website" are excluded — Gemini also uses those to describe things that are
// physically IN the scene (a sponsor backdrop, a mic flag, a storefront), and
// counting them here skipped whole sources that had no watermark at all.
const LOGO_WATERMARK_ARTIFACT_RE =
  /\b(logo|watermark|wordmark|station bug|channel bug|\.com|\.tv|\.net)\b/i;

// Artifact phrases for recurring on-screen speech text — burned-in captions,
// subtitles, karaoke-style word pop-ups. These read like normal "text" so we
// match the words Gemini uses to describe them. Kept separate from a one-off
// "headline" / "title" so the source-level vote is about SPOKEN-WORD captions
// that run the whole video, the thing word-by-word auto-subs produce.
const CAPTION_ARTIFACT_RE =
  /\b(caption|subtitle|closed[- ]?caption|cc\b|on[- ]?screen text|burned[- ]?in text|word pop|auto[- ]?caption|lyric)\b/i;

export interface SourceWatermarkInput {
  // Frame image URLs sampled evenly across the source (already uploaded so
  // Gemini can fetch them). 4–6 is plenty; more just costs more.
  frameUrls: string[];
}

export interface SourceWatermarkResult {
  // True when a persistent logo/watermark OR persistent caption track appears
  // on a majority of sampled frames.
  watermarked: boolean;
  // How many sampled frames were checkable, and the per-class hit counts.
  framesChecked: number;
  logoFrames: number;
  captionFrames: number;
  // Which class triggered the decision ("logo" | "caption" | ""), and a
  // representative artifact description for logging.
  reasonClass: "logo" | "caption" | "";
  artifact: string;
}

export async function detectSourceWatermark(
  input: SourceWatermarkInput,
): Promise<SourceWatermarkResult> {
  const empty: SourceWatermarkResult = {
    watermarked: false, framesChecked: 0, logoFrames: 0, captionFrames: 0,
    reasonClass: "", artifact: "",
  };
  const urls = input.frameUrls.filter((u) => typeof u === "string" && u.length > 0);
  if (urls.length === 0) return empty;

  // No reference person — we only want the cleanliness verdict here.
  const results = await Promise.all(
    urls.map((url) => verifyClipFrameCombined({ frameUrl: url }).catch(() => null)),
  );

  let framesChecked = 0;
  let logoFrames = 0;
  let captionFrames = 0;
  let logoArtifact = "";
  let captionArtifact = "";
  for (const r of results) {
    if (!r) continue;                 // fetch / gemini failure → ignore this frame
    framesChecked++;
    if (r.clean !== "dirty") continue;
    const art = r.cleanArtifact ?? "";
    if (LOGO_WATERMARK_ARTIFACT_RE.test(art)) {
      logoFrames++;
      if (!logoArtifact) logoArtifact = art;
    }
    if (CAPTION_ARTIFACT_RE.test(art)) {
      captionFrames++;
      if (!captionArtifact) captionArtifact = art;
    }
  }

  // Persistent = a strict majority of CHECKABLE frames show the same class of
  // graphic. Require at least 2 hits in a class so a single mis-read can't
  // condemn a whole source. With <2 checkable frames we can't establish
  // persistence → keep the source. Logo and caption are evaluated
  // independently; either one persisting is enough to skip the source.
  const majority = Math.ceil(framesChecked / 2);
  const logoPersistent = framesChecked >= 2 && logoFrames >= 2 && logoFrames >= majority;
  const captionPersistent = framesChecked >= 2 && captionFrames >= 2 && captionFrames >= majority;

  if (logoPersistent || captionPersistent) {
    // Prefer reporting whichever class had more hits as the trigger.
    const reasonClass: "logo" | "caption" =
      captionPersistent && captionFrames >= logoFrames ? "caption" : "logo";
    return {
      watermarked: true,
      framesChecked,
      logoFrames,
      captionFrames,
      reasonClass,
      artifact: reasonClass === "caption" ? captionArtifact : logoArtifact,
    };
  }

  return { watermarked: false, framesChecked, logoFrames, captionFrames, reasonClass: "", artifact: "" };
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

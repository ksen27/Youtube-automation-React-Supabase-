import { getEnv } from "@/lib/env";
import { fetchOrThrow, withHttpRetry, HttpError } from "@/lib/synthetic/http";

// Thin client for the Pikzels thumbnail API (https://docs.pikzels.com).
//
// We use the "create from image" endpoint (POST /v2/thumbnail/image). Per the
// documented contract it takes:
//   image_url          (required) — the BASE image to transform (HTTPS)
//   support_image_url  (optional, pkz_4 / pkz_4_5 only) — ONE reference/style
//                      image (HTTPS)
//   prompt             (optional) — instructions; MUST NOT contain a URL and
//                      cannot contain the substring "http" (API regex), max 3000
//   model, format      (required) — see enums below
//
// IMPORTANT: the endpoint accepts at most a BASE image + ONE support image — it
// does NOT accept an array of references. So a multi-reference request is
// mapped to image_url = first reference, support_image_url = second reference;
// any further references cannot be sent in a single call (caller decides).
//
// The endpoint responds synchronously with { output, request_id } where output
// is a CDN URL that expires in ~24h; the caller re-hosts it (see the route).
//
// Auth: the `X-Api-Key` header. Keys look like `pkz_...`.
const IMAGE_ENDPOINT = "/v2/thumbnail/image";

// support_image_url is only honored by pkz_4 / pkz_4_5. On pkz_2 / pkz_3 it is
// ignored, so we only send it for the supporting models.
const SUPPORT_IMAGE_MODELS = new Set(["pkz_4", "pkz_4_5"]);

// Pikzels takes one base + one support image, so at most 2 references map into
// a single generation call.
export const MAX_REFERENCES = 2;

// Pick which of a channel's sample thumbnails to use as the style/base image
// for THIS generation. Pikzels transforms the base image, so it tends to keep
// that image's POSE. Always using the same sample (samples[0]) is why every
// generation came out in the identical pose. Rotating through the samples by a
// per-channel counter (e.g. how many thumbnails already exist for the channel)
// means each new generation starts from a DIFFERENT reference pose — same
// person (all samples are the same channel/person), different action. Returns
// null when there are no samples.
export function pickStyleImage(sampleUrls: string[], rotation: number): string | null {
  const urls = sampleUrls.filter(Boolean);
  if (urls.length === 0) return null;
  const idx = ((rotation % urls.length) + urls.length) % urls.length;
  return urls[idx];
}

// Build the ordered reference array (base first, support second) for a channel
// generation, encoding the image-slot rule the client asked for. Pikzels has
// exactly two image slots; the channel style ALSO rides in the text prompt, so
// a style image is optional reinforcement:
//   0 subjects -> [styleImage]                 (base = channel style thumbnail)
//   1 subject  -> [subject, styleImage]        (base = subject, support = style)
//   2 subjects -> [subject1, subject2]         (both slots subjects; NO style
//                                               image — style is text-only)
// styleImageSent reflects whether slot 2 (or 1, when no subjects) holds a style
// image, so the prompt builder can be told to fully carry the style in text.
export function buildChannelReferenceUrls(args: {
  subjectUrls: string[];
  styleImageUrl: string | null;
}): { referenceUrls: string[]; styleImageSent: boolean } {
  const subjects = args.subjectUrls.filter(Boolean).slice(0, MAX_REFERENCES);
  const style = args.styleImageUrl?.trim() || null;

  if (subjects.length >= MAX_REFERENCES) {
    // Two subjects fill both slots — no room for a style image.
    return { referenceUrls: subjects.slice(0, MAX_REFERENCES), styleImageSent: false };
  }
  if (subjects.length === 0) {
    // No subjects: the style image becomes the base image (if we have one).
    return style
      ? { referenceUrls: [style], styleImageSent: true }
      : { referenceUrls: [], styleImageSent: false };
  }
  // One subject: subject is base, style image (if any) is the support slot.
  return style
    ? { referenceUrls: [...subjects, style], styleImageSent: true }
    : { referenceUrls: subjects, styleImageSent: false };
}

export interface PikzelsResult {
  outputUrl: string;
  requestId: string | null;
}

export function isPikzelsConfigured(): boolean {
  return Boolean(getEnv().PIKZELS_API_KEY);
}

// Turn a Pikzels failure into a SHORT, user-facing message. Their gateway
// returns a full HTML error page on 5xx; storing/showing that raw blob is
// useless in the UI. Collapse any 5xx (after retries were exhausted) to a clear
// "temporarily unavailable" line; pass a 4xx body through (it's a real,
// actionable API message like "invalid prompt"). Non-HttpErrors return as-is.
export function pikzelsErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      return `Pikzels is temporarily unavailable (HTTP ${err.status}). Please try generating again in a moment.`;
    }
    const snippet = (err.body ?? err.message).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    return `Pikzels rejected the request (HTTP ${err.status}): ${snippet}`;
  }
  return err instanceof Error ? err.message : "generation failed";
}

// Pikzels rejects any prompt containing a URL (regex ^(?!.*[Hh][Tt][Tt][Pp]).+$).
// Reject early with a clear message rather than eating an opaque 400.
export function promptContainsUrl(prompt: string): boolean {
  return /http/i.test(prompt);
}

// Generate a thumbnail from 1–2 reference image URLs + a prompt. The first
// reference becomes the base image_url; the second (if any) becomes the
// support/style image (pkz_4 / pkz_4_5 only). Throws when the API is
// unconfigured or the request fails (HttpError carries the status + response
// body so the route can surface a useful message).
export async function generateThumbnailFromReferences(args: {
  prompt: string;
  referenceUrls: string[];
}): Promise<PikzelsResult> {
  const env = getEnv();
  const apiKey = env.PIKZELS_API_KEY;
  if (!apiKey) {
    throw new Error("PIKZELS_API_KEY is not set");
  }
  if (promptContainsUrl(args.prompt)) {
    throw new Error('prompt cannot contain a URL (the substring "http")');
  }

  const refs = args.referenceUrls.filter(Boolean).slice(0, MAX_REFERENCES);
  if (refs.length === 0) {
    throw new Error("at least one reference image is required");
  }

  const body: Record<string, unknown> = {
    prompt: args.prompt,
    model: env.PIKZELS_MODEL,
    format: env.PIKZELS_FORMAT,
    image_url: refs[0],
  };
  // Second reference -> support/style image, only for models that honor it.
  if (refs[1] && SUPPORT_IMAGE_MODELS.has(env.PIKZELS_MODEL)) {
    body.support_image_url = refs[1];
  }

  // Pikzels' gateway intermittently returns a 502/503 HTML error page (backend
  // overloaded, deploying, or a heavy render timing out at their edge) — a
  // TRANSIENT upstream failure, not a bad request. Without a retry a single 502
  // surfaced straight to the user on generate/regenerate. withHttpRetry rides
  // out 5xx/429/network errors with backoff (a 4xx like a bad prompt still fails
  // fast), matching how every other provider in the app calls its API.
  const res = await withHttpRetry(
    "pikzels.generate",
    () =>
      fetchOrThrow(`${env.PIKZELS_BASE_URL}${IMAGE_ENDPOINT}`, {
        method: "POST",
        headers: {
          "X-Api-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        timeoutMs: env.PIKZELS_TIMEOUT_SECONDS * 1000,
      }),
    { attempts: 3, baseMs: 1500 },
  );

  const json = (await res.json()) as { output?: unknown; request_id?: unknown };
  const outputUrl = typeof json.output === "string" ? json.output : null;
  if (!outputUrl) {
    throw new Error(`Pikzels response missing "output" URL: ${JSON.stringify(json).slice(0, 200)}`);
  }

  return {
    outputUrl,
    requestId: typeof json.request_id === "string" ? json.request_id : null,
  };
}

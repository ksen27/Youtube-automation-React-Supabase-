import { getEnv } from "@/lib/env";
import { fetchOrThrow, withHttpRetry } from "@/lib/synthetic/http";
import { withStylePrompt } from "@/lib/synthetic/constants";

// 69labs provider: TTS voiceover + nano-banana image generation.
//
// 69labs is configured via SIXTYNINE_LABS_* env. Both TTS and image generation
// are ASYNC JOB APIs on 69labs.vip: submit -> poll status -> download. The
// request/response shapes below follow 69labs' documented REST contract. If the
// live API differs, only the submit / poll / download blocks here need
// adjusting — every caller goes through generateVoice() / generateImage() and
// is insulated from the wire format.
//
// Images get the mandatory STYLE_PROMPT appended (withStylePrompt). The
// image-to-video and avatar steps live in separate provider modules.

// Process-wide gate on concurrent image generations. The image_gen,
// image_to_video, and avatar/split_2 lanes each call generateImage on their own
// BullMQ concurrency, so their combined in-flight count can blow past 69labs'
// real per-account limit and earn a 403 / a 503 cooldown. 69labs allows only
// 1–4 concurrent generations DEPENDING ON SUBSCRIPTION TIER, and exceeding the
// tier ceiling triggers cooldowns — see SIXTYNINE_IMAGE_CONCURRENCY (default 3).
// This semaphore caps the TOTAL in-flight image generations for THIS worker
// process below that limit; excess callers await a freed slot (FIFO). Scope is
// per-process — correct here because the burst that triggered the 403 came from
// one worker running all three lanes at once. With multiple worker machines the
// cap is per-machine, so the cluster total is limit × machines: keep ONE image
// worker (or size the cap so machines × cap stays within your tier's ceiling).
let imageSlotsInUse = 0;
const imageWaiters: Array<() => void> = [];

async function acquireImageSlot(limit: number): Promise<void> {
  if (imageSlotsInUse < limit) {
    imageSlotsInUse++;
    return;
  }
  await new Promise<void>((resolve) => imageWaiters.push(resolve));
  imageSlotsInUse++;
}

function releaseImageSlot(): void {
  imageSlotsInUse--;
  const next = imageWaiters.shift();
  if (next) next();
}

function cfg() {
  const env = getEnv();
  if (!env.SIXTYNINE_LABS_API_KEY) {
    throw new Error("SIXTYNINE_LABS_API_KEY not configured (synthetic engine)");
  }
  return {
    key: env.SIXTYNINE_LABS_API_KEY,
    base: env.SIXTYNINE_LABS_BASE_URL.replace(/\/$/, ""),
    ttsProvider: env.SIXTYNINE_LABS_TTS_PROVIDER,
    ttsModel: env.SIXTYNINE_LABS_TTS_MODEL,
    ttsPollTimeoutMs: env.SIXTYNINE_LABS_TTS_POLL_TIMEOUT_SECONDS * 1000,
    imageModel: env.SIXTYNINE_LABS_IMAGE_MODEL,
    imageResolution: env.SIXTYNINE_LABS_IMAGE_RESOLUTION,
    imagePollTimeoutMs: env.SIXTYNINE_LABS_IMAGE_POLL_TIMEOUT_SECONDS * 1000,
    defaultVoice: env.SIXTYNINE_LABS_DEFAULT_VOICE,
  };
}

export function isSixtyNineConfigured(): boolean {
  return Boolean(getEnv().SIXTYNINE_LABS_API_KEY);
}

export interface GenerateVoiceInput {
  text: string;
  voiceId?: string;     // 69labs voiceId; falls back to SIXTYNINE_LABS_DEFAULT_VOICE
  format?: "mp3";       // master_voiceover.mp3 per spec
}

export interface GenerateVoiceResult {
  audio: Buffer;
  contentType: string;
  chars: number;        // billing dimension for cost tracking
}

// 69labs TTS is an ASYNC JOB API (not a synchronous audio endpoint):
//   1. POST /api/v1/tts/generate          -> { id, status: "PENDING", queuePosition }
//   2. GET  /api/v1/tts/status/:jobId     -> PENDING|PROCESSING|FINALIZING|
//                                            COMPLETED|FAILED|CANCELLED|CENSORED
//   3. GET  /api/v1/tts/download/:jobId   -> the mp3 bytes (410 GONE if expired)
// We submit, poll to COMPLETED, then download. CENSORED/FAILED/CANCELLED are
// terminal errors surfaced to the caller (the job processor logs + retries).
type TtsStatus =
  | "PENDING" | "PROCESSING" | "FINALIZING"
  | "COMPLETED" | "FAILED" | "CANCELLED" | "CENSORED";

interface TtsStatusResponse {
  id: string;
  status: TtsStatus;
  chunksTotal?: number;
  chunksCompleted?: number;
  blockedChunks?: Array<{ index: number; text: string }>;
}

/** Generate a voiceover MP3 from transcript text via the 69labs job API. */
export async function generateVoice(input: GenerateVoiceInput): Promise<GenerateVoiceResult> {
  const c = cfg();
  const text = input.text.trim();
  if (!text) throw new Error("generateVoice: empty text");

  const authJson = { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" };
  const authOnly = { Authorization: `Bearer ${c.key}` };

  // 1) Submit the job.
  const submit = await withHttpRetry("69labs.tts.submit", () =>
    fetchOrThrow(`${c.base}/api/v1/tts/generate`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({
        text,
        voiceId: input.voiceId || c.defaultVoice,
        voiceProvider: c.ttsProvider,
        modelId: c.ttsModel,
      }),
      timeoutMs: 60_000,
    }),
  );
  const { id: jobId } = (await submit.json()) as { id: string; status: TtsStatus };
  if (!jobId) throw new Error("69labs tts: submit returned no job id");

  // 2) Poll status until COMPLETED (or a terminal failure / timeout).
  const deadline = Date.now() + c.ttsPollTimeoutMs;
  while (Date.now() < deadline) {
    const statusRes = await fetchOrThrow(`${c.base}/api/v1/tts/status/${jobId}`, {
      headers: authOnly,
      timeoutMs: 30_000,
    });
    const st = (await statusRes.json()) as TtsStatusResponse;
    if (st.status === "COMPLETED") break;
    if (st.status === "FAILED" || st.status === "CANCELLED") {
      throw new Error(`69labs tts: job ${st.status} (job ${jobId})`);
    }
    if (st.status === "CENSORED") {
      // Content moderation blocked one or more chunks. We surface this as a
      // hard error rather than auto-rewriting — the narration should be edited.
      const blocked = (st.blockedChunks ?? []).map((b) => b.index).join(",");
      throw new Error(`69labs tts: CENSORED (blocked chunks: ${blocked || "?"}) — edit the script and retry`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (Date.now() >= deadline) throw new Error(`69labs tts: poll timed out (job ${jobId})`);

  // 3) Download the finished mp3.
  const dl = await withHttpRetry("69labs.tts.download", () =>
    fetchOrThrow(`${c.base}/api/v1/tts/download/${jobId}`, {
      headers: authOnly,
      timeoutMs: 120_000,
    }),
  );
  const arrayBuf = await dl.arrayBuffer();
  return {
    audio: Buffer.from(arrayBuf),
    contentType: dl.headers.get("content-type") || "audio/mpeg",
    chars: text.length,
  };
}

// NOTE: 69labs has no documented voice-catalog endpoint — a voice is referenced
// by a specific voiceId the user supplies (e.g. Gr7mLjPA3HhuWxZidxPW), so there
// is no listVoices() here. The intake screen takes the voiceId as text input.

export interface GenerateImageResult {
  image: Buffer;
  contentType: string;
  provider: "sixtynine_image";
}

// 69labs image generation is an ASYNC JOB API (same lifecycle as TTS):
//   1. POST /api/v1/images/generate       -> { id, queuePosition }
//   2. GET  /api/v1/images/status/:jobId  -> PENDING|PROCESSING|...|COMPLETED|
//                                            FAILED|CANCELLED|CENSORED
//   3. GET  /api/v1/images/download/:jobId -> 302 redirect to a presigned R2
//                                             URL with the image bytes
// We submit, poll to COMPLETED, then download (fetch follows the 302 by default).
type ImageStatus = TtsStatus;

interface ImageStatusResponse {
  id: string;
  status: ImageStatus;
}

// Internal: one nano-banana attempt. Returns the image bytes + content type.
async function generateNanoBananaImage(prompt: string): Promise<{ image: Buffer; contentType: string }> {
  const c = cfg();
  const authJson = { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" };
  const authOnly = { Authorization: `Bearer ${c.key}` };

  // 1) Submit the job. 16:9 to match the synthetic canvas; the renderer handles
  // any cropping/letterboxing, so we request a wide aspect ratio.
  // Extra retry budget on submit: a 403 "concurrent limit reached" needs to
  // wait for OTHER in-flight generations to finish, which can take longer than
  // a normal transient blip. 5 attempts with a 2s base gives ~2+6+18+54s of
  // backoff — enough for a burst to drain — before giving up on the segment.
  const submit = await withHttpRetry("69labs.image.submit", () =>
    fetchOrThrow(`${c.base}/api/v1/images/generate`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({
        prompt,
        model: c.imageModel,
        aspectRatio: "16:9",
        // Request a higher resolution (1K/2K/4K, Nano Banana Pro) so stills are
        // sharp at the 1080p render. Omitted when the env value is empty so the
        // provider default applies. Field name per 69labs' generate contract.
        ...(c.imageResolution ? { resolution: c.imageResolution } : {}),
      }),
      timeoutMs: 60_000,
    }),
    { attempts: 5, baseMs: 2000 },
  );
  const { id: jobId } = (await submit.json()) as { id: string; queuePosition?: number };
  if (!jobId) throw new Error("69labs image: submit returned no job id");

  // 2) Poll status until COMPLETED (or a terminal failure / timeout).
  const deadline = Date.now() + c.imagePollTimeoutMs;
  while (Date.now() < deadline) {
    const statusRes = await fetchOrThrow(`${c.base}/api/v1/images/status/${jobId}`, {
      headers: authOnly,
      timeoutMs: 30_000,
    });
    const st = (await statusRes.json()) as ImageStatusResponse;
    if (st.status === "COMPLETED") break;
    if (st.status === "FAILED" || st.status === "CANCELLED") {
      throw new Error(`69labs image: job ${st.status} (job ${jobId})`);
    }
    if (st.status === "CENSORED") {
      throw new Error(`69labs image: CENSORED (job ${jobId}) — edit the prompt and retry`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (Date.now() >= deadline) throw new Error(`69labs image: poll timed out (job ${jobId})`);

  // 3) Download the finished image. The endpoint returns a 302 redirect to a
  // presigned R2 URL; fetch follows redirects by default.
  const dl = await withHttpRetry("69labs.image.download", () =>
    fetchOrThrow(`${c.base}/api/v1/images/download/${jobId}`, {
      headers: authOnly,
      timeoutMs: 120_000,
    }),
  );
  return {
    image: Buffer.from(await dl.arrayBuffer()),
    contentType: dl.headers.get("content-type") || "image/png",
  };
}

/**
 * Generate an image from a base prompt via 69labs (nano-banana). The mandatory
 * STYLE_PROMPT is appended here so every caller gets the consistent look.
 *
 * 69labs is the ONLY image provider — there is no cross-provider fallback. Safe
 * multi-image generation comes from two mechanisms, NOT a fallback:
 *   1. The global image slot below caps total in-flight 69labs jobs under the
 *      provider's per-tier concurrent limit (1–4 by subscription;
 *      SIXTYNINE_IMAGE_CONCURRENCY default 3), so a burst of segments queues
 *      instead of earning a 403 / a 503 cooldown.
 *   2. generateNanoBananaImage's withHttpRetry rides out transient 503 "service
 *      unavailable" / 403 "concurrent limit" spikes with exponential backoff.
 * When 69labs is genuinely down past the retry budget, the call throws — the
 * caller (image processor) lets BullMQ retry the whole job, and the segment can
 * be re-run from the UI once 69labs recovers. The chosen provider is returned
 * for cost attribution (always "sixtynine_image").
 */
export async function generateImage(basePrompt: string): Promise<GenerateImageResult> {
  const prompt = withStylePrompt(basePrompt);
  // Hold a global image slot for the whole submit→poll→download so total
  // in-flight 69labs image work stays under the provider's concurrent cap.
  await acquireImageSlot(getEnv().SIXTYNINE_IMAGE_CONCURRENCY);
  try {
    const { image, contentType } = await generateNanoBananaImage(prompt);
    return { image, contentType, provider: "sixtynine_image" };
  } finally {
    releaseImageSlot();
  }
}

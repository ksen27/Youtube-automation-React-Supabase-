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
// per-account limit (7) and earn a 403. This semaphore caps the TOTAL in-flight
// image generations for THIS worker process below that limit; excess callers
// await a freed slot (FIFO). Scope is per-process — correct here because the
// burst that triggered the 403 came from one worker running all three lanes at
// once. With multiple worker machines the cap is per-machine; size accordingly.
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
  provider: "sixtynine_image" | "flux_image";
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

// Internal: Flux fallback. Black Forest Labs returns a polling task; we fetch
// the result image once ready. Kept minimal — only invoked when nano-banana
// fails outright.
async function generateFluxImage(prompt: string): Promise<Buffer> {
  const env = getEnv();
  if (!env.FLUX_API_KEY) throw new Error("FLUX_API_KEY not configured (image fallback)");
  const base = env.FLUX_BASE_URL.replace(/\/$/, "");

  const submit = await withHttpRetry("flux.submit", () =>
    fetchOrThrow(`${base}/${env.FLUX_MODEL}`, {
      method: "POST",
      headers: { "x-key": env.FLUX_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, width: 1280, height: 720 }),
      timeoutMs: 60_000,
    }),
  );
  const { id, polling_url } = (await submit.json()) as { id: string; polling_url?: string };
  const pollUrl = polling_url ?? `${base}/get_result?id=${id}`;

  // Poll up to ~2 min for the result.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const poll = await fetchOrThrow(pollUrl, {
      headers: { "x-key": env.FLUX_API_KEY! },
      timeoutMs: 30_000,
    });
    const body = (await poll.json()) as { status?: string; result?: { sample?: string } };
    if (body.status === "Ready" && body.result?.sample) {
      const img = await fetchOrThrow(body.result.sample, { timeoutMs: 60_000 });
      return Buffer.from(await img.arrayBuffer());
    }
    if (body.status === "Error" || body.status === "Failed") {
      throw new Error(`flux: generation ${body.status}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("flux: timed out waiting for result");
}

/**
 * Generate an image from a base prompt. The mandatory STYLE_PROMPT is appended
 * here so every caller gets the consistent look. nano-banana is primary; on
 * failure we fall back to Flux (when configured). The chosen provider is
 * returned for cost attribution.
 */
export async function generateImage(basePrompt: string): Promise<GenerateImageResult> {
  const prompt = withStylePrompt(basePrompt);
  // Hold a global image slot for the whole nano-banana submit→poll→download so
  // total in-flight 69labs image work stays under the provider's concurrent cap.
  // The Flux fallback is a different provider, so it runs OUTSIDE the slot.
  await acquireImageSlot(getEnv().SIXTYNINE_IMAGE_CONCURRENCY);
  try {
    const { image, contentType } = await generateNanoBananaImage(prompt);
    return { image, contentType, provider: "sixtynine_image" };
  } catch (primaryErr) {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({
      msg: "synthetic.image.fallback_to_flux",
      err: (primaryErr as Error).message?.slice(0, 200),
    }));
    if (!getEnv().FLUX_API_KEY) throw primaryErr; // no fallback configured
    const image = await generateFluxImage(prompt);
    return { image, contentType: "image/jpeg", provider: "flux_image" };
  } finally {
    releaseImageSlot();
  }
}

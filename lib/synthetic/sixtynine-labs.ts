import { getEnv } from "@/lib/env";
import { fetchOrThrow, withHttpRetry } from "@/lib/synthetic/http";
import { withStylePrompt } from "@/lib/synthetic/constants";

// 69labs provider: TTS voiceover + nano-banana image generation.
//
// 69labs is configured via SIXTYNINE_LABS_* env. The request/response shapes
// below follow 69labs' documented REST contract (OpenAI-style audio + image
// endpoints). If the live API differs, only the buildBody / parseResponse
// blocks here need adjusting — every caller goes through generateVoice() /
// generateImage() and is insulated from the wire format.
//
// Images get the mandatory STYLE_PROMPT appended (withStylePrompt). The
// image-to-video and avatar steps live in separate provider modules.

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

// Internal: one nano-banana attempt. Returns a JPEG/PNG buffer.
async function generateNanoBananaImage(prompt: string): Promise<Buffer> {
  const c = cfg();
  const res = await withHttpRetry("69labs.image", () =>
    fetchOrThrow(`${c.base}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: c.imageModel,
        prompt,
        // 16:9 still to match the synthetic canvas; provider crops/letterboxes
        // are handled by the renderer, so request a wide source.
        size: "1280x720",
        n: 1,
        response_format: "b64_json",
      }),
      timeoutMs: 120_000,
    }),
  );
  const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = json.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, "base64");
  if (first?.url) {
    const img = await withHttpRetry("69labs.image.fetch", () =>
      fetchOrThrow(first.url!, { timeoutMs: 60_000 }),
    );
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error("69labs image: empty response");
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
  try {
    const image = await generateNanoBananaImage(prompt);
    return { image, contentType: "image/jpeg", provider: "sixtynine_image" };
  } catch (primaryErr) {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({
      msg: "synthetic.image.fallback_to_flux",
      err: (primaryErr as Error).message?.slice(0, 200),
    }));
    if (!getEnv().FLUX_API_KEY) throw primaryErr; // no fallback configured
    const image = await generateFluxImage(prompt);
    return { image, contentType: "image/jpeg", provider: "flux_image" };
  }
}

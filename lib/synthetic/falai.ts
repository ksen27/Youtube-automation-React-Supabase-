import { getEnv } from "@/lib/env";
import { fetchOrThrow, withHttpRetry } from "@/lib/synthetic/http";
import { generateLtxVideo, isLtxConfigured } from "@/lib/synthetic/ltx";

// fal.ai image-to-video provider. Generates animated clips FROM a still image
// (the nano-banana output for an ai_clip block), WITHOUT audio — the voiceover
// comes from the master track at render time.
//
// Priority per spec: Veo 3 Fast primary, Kling fallback. fal.ai's queue API is
// submit -> poll status -> fetch result. We expose generateVeoVideo() and
// generateKlingVideo() separately (so the processor can decide fallback
// policy + cost attribution) plus generateClipWithFallback() which chains them.

function cfg() {
  const env = getEnv();
  if (!env.FAL_AI_API_KEY) throw new Error("FAL_AI_API_KEY not configured (synthetic engine)");
  return {
    key: env.FAL_AI_API_KEY,
    base: env.FAL_AI_BASE_URL.replace(/\/$/, ""),
    veoModel: env.FAL_AI_VEO_MODEL,
    klingModel: env.FAL_AI_KLING_MODEL,
    pollTimeoutMs: env.FAL_AI_POLL_TIMEOUT_SECONDS * 1000,
  };
}

export function isFalConfigured(): boolean {
  return Boolean(getEnv().FAL_AI_API_KEY);
}

export interface GenerateClipInput {
  imageUrl: string;            // public R2 URL of the source still
  prompt: string;              // animation prompt (camera motion, action)
  durationSeconds?: number;    // requested clip length; provider may clamp
}

export interface GenerateClipResult {
  video: Buffer;
  contentType: string;
  provider: "ltx2" | "fal_veo3_fast" | "fal_kling";
  seconds: number;             // billing dimension
}

// Submit a job to a fal.ai model and poll until the result video is ready.
async function runFalModel(
  model: string,
  payload: Record<string, unknown>,
  provider: GenerateClipResult["provider"],
  seconds: number,
): Promise<GenerateClipResult> {
  const c = cfg();
  const auth = { Authorization: `Key ${c.key}` };

  // 1) Submit -> returns a request id + status/response URLs.
  const submit = await withHttpRetry(`fal.submit.${provider}`, () =>
    fetchOrThrow(`${c.base}/${model}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 60_000,
    }),
  );
  const sub = (await submit.json()) as {
    request_id: string;
    status_url?: string;
    response_url?: string;
  };
  const statusUrl = sub.status_url ?? `${c.base}/${model}/requests/${sub.request_id}/status`;
  const responseUrl = sub.response_url ?? `${c.base}/${model}/requests/${sub.request_id}`;

  // 2) Poll status until COMPLETED / failure / timeout.
  const deadline = Date.now() + c.pollTimeoutMs;
  while (Date.now() < deadline) {
    const statusRes = await fetchOrThrow(statusUrl, { headers: auth, timeoutMs: 30_000 });
    const st = (await statusRes.json()) as { status?: string };
    if (st.status === "COMPLETED") break;
    if (st.status === "FAILED" || st.status === "ERROR") {
      throw new Error(`fal ${provider}: job ${st.status}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (Date.now() >= deadline) throw new Error(`fal ${provider}: poll timed out`);

  // 3) Fetch the result payload and download the video bytes.
  const resultRes = await fetchOrThrow(responseUrl, { headers: auth, timeoutMs: 30_000 });
  const result = (await resultRes.json()) as {
    video?: { url?: string };
    videos?: Array<{ url?: string }>;
  };
  const videoUrl = result.video?.url ?? result.videos?.[0]?.url;
  if (!videoUrl) throw new Error(`fal ${provider}: no video url in result`);

  const dl = await withHttpRetry(`fal.download.${provider}`, () =>
    fetchOrThrow(videoUrl, { timeoutMs: 120_000 }),
  );
  return {
    video: Buffer.from(await dl.arrayBuffer()),
    contentType: dl.headers.get("content-type") || "video/mp4",
    provider,
    seconds,
  };
}

/** Veo 3 Fast image-to-video (no audio). Primary clip provider. */
export async function generateVeoVideo(input: GenerateClipInput): Promise<GenerateClipResult> {
  const c = cfg();
  const seconds = input.durationSeconds ?? 5;
  return runFalModel(
    c.veoModel,
    {
      image_url: input.imageUrl,
      prompt: input.prompt,
      duration: `${Math.round(seconds)}s`,
      generate_audio: false, // voiceover comes from the master track
    },
    "fal_veo3_fast",
    seconds,
  );
}

/** Kling image-to-video (no audio). Fallback when Veo fails. */
export async function generateKlingVideo(input: GenerateClipInput): Promise<GenerateClipResult> {
  const c = cfg();
  const seconds = input.durationSeconds ?? 5;
  return runFalModel(
    c.klingModel,
    {
      image_url: input.imageUrl,
      prompt: input.prompt,
      duration: Math.round(seconds) <= 5 ? "5" : "10", // Kling bills in 5/10s tiers
    },
    "fal_kling",
    seconds,
  );
}

/**
 * Generate an animated clip via LTX-2 ONLY (per client direction: ai_clip must
 * be real AI video, no still degrade and no fal.ai Veo/Kling fallback). LTX is
 * the sole provider, so when it fails we surface its actual error to the caller
 * — the failure reason must be visible, not masked behind a fallback chain.
 * Throws if LTX is unconfigured or its job fails; the caller logs the reason.
 *
 * NOTE: generateVeoVideo / generateKlingVideo remain exported for any other
 * caller, but are intentionally NOT used here.
 */
export async function generateClipWithFallback(
  input: GenerateClipInput,
): Promise<GenerateClipResult> {
  if (!isLtxConfigured()) {
    throw new Error("ai_clip: LTX_API_KEY not configured — LTX is the only clip provider");
  }
  // No try/catch: let the real LTX error propagate so the processor logs the
  // genuine failure reason (LTX job error / poll timeout / bad image url).
  return generateLtxVideo(input);
}

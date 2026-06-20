import { getEnv } from "@/lib/env";
import { fetchOrThrow, withHttpRetry } from "@/lib/synthetic/http";
import type { GenerateClipInput, GenerateClipResult } from "@/lib/synthetic/falai";

// LTX-2 (api.ltx.video) image-to-video provider. PRIMARY clip provider for the
// synthetic engine's ai_clip blocks (fal.ai Veo/Kling is the fallback chain —
// see generateClipWithFallback in falai.ts). Animates a still image (the
// nano-banana output) into a short motion clip WITHOUT audio — the voiceover is
// the master track, and the renderer strips clip audio anyway (keepAudio:false).
//
// LTX-2's async job lifecycle (matches fal.ai / 69labs):
//   1. POST /v2/image-to-video         -> { id, created_at }
//   2. GET  /v2/image-to-video/{id}    -> status pending|processing|completed|failed
//   3. on completed: download result.video_url
//
// Duration is a DISCRETE tier, not arbitrary. At 1080p/25fps LTX-2 accepts
// 6/8/10/12/14/16/18/20s (max 20s). We request 1920x1080 (16:9 — LTX's only
// supported aspect) and snap each requested duration to the nearest allowed
// tier, clamped to LTX_MAX_DURATION. The planner caps blocks at ~8s, so in
// practice we land on 6 or 8.

// Allowed duration tiers at 1080p/25fps. We pick the nearest tier <= the
// configured max so a requested 7s lands on 6 or 8, never an unsupported value.
export const LTX_DURATION_TIERS = [6, 8, 10, 12, 14, 16, 18, 20];

function cfg() {
  const env = getEnv();
  if (!env.LTX_API_KEY) throw new Error("LTX_API_KEY not configured (synthetic engine)");
  return {
    key: env.LTX_API_KEY,
    base: env.LTX_BASE_URL.replace(/\/$/, ""),
    model: env.LTX_MODEL,
    resolution: env.LTX_RESOLUTION,
    maxDuration: env.LTX_MAX_DURATION,
    pollTimeoutMs: env.LTX_POLL_TIMEOUT_SECONDS * 1000,
  };
}

export function isLtxConfigured(): boolean {
  return Boolean(getEnv().LTX_API_KEY);
}

// Snap an arbitrary requested duration (seconds) to the nearest LTX tier that
// does not exceed maxDuration. Tiers start at 6s, so anything shorter rounds up
// to the 6s floor.
export function snapDuration(requested: number, maxDuration: number): number {
  const allowed = LTX_DURATION_TIERS.filter((t) => t <= maxDuration);
  const tiers = allowed.length > 0 ? allowed : [LTX_DURATION_TIERS[0]];
  let best = tiers[0];
  let bestDist = Math.abs(requested - best);
  for (const t of tiers) {
    const d = Math.abs(requested - t);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/**
 * LTX-2 image-to-video (no audio). Primary clip provider; on failure the caller
 * (generateClipWithFallback) falls through to fal.ai Veo, then Kling.
 */
export async function generateLtxVideo(input: GenerateClipInput): Promise<GenerateClipResult> {
  const c = cfg();
  const auth = { Authorization: `Bearer ${c.key}` };
  const requested = input.durationSeconds ?? 6;
  const duration = snapDuration(requested, c.maxDuration);

  // 1) Submit the job. image_uri is the public R2 still URL; LTX accepts any
  // publicly reachable URL here (no separate upload step needed).
  const submit = await withHttpRetry("ltx.submit", () =>
    fetchOrThrow(`${c.base}/v2/image-to-video`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        image_uri: input.imageUrl,
        prompt: input.prompt,
        model: c.model,
        duration,
        resolution: c.resolution,
      }),
      timeoutMs: 60_000,
    }),
  );
  const { id: jobId } = (await submit.json()) as { id: string; created_at?: string };
  if (!jobId) throw new Error("ltx: submit returned no job id");

  // 2) Poll status every 5s (per docs) until completed / failed / timeout.
  const deadline = Date.now() + c.pollTimeoutMs;
  let result: { video_url?: string } | undefined;
  while (Date.now() < deadline) {
    const statusRes = await fetchOrThrow(`${c.base}/v2/image-to-video/${jobId}`, {
      headers: auth,
      timeoutMs: 30_000,
    });
    const st = (await statusRes.json()) as {
      status?: string;
      result?: { video_url?: string };
      error?: string;
    };
    if (st.status === "completed") {
      result = st.result;
      break;
    }
    if (st.status === "failed") {
      throw new Error(`ltx: job failed${st.error ? ` :: ${st.error}` : ""} (job ${jobId})`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!result) throw new Error(`ltx: poll timed out (job ${jobId})`);

  const videoUrl = result.video_url;
  if (!videoUrl) throw new Error(`ltx: no result.video_url in completed job ${jobId}`);

  // 3) Download the finished mp4.
  const dl = await withHttpRetry("ltx.download", () =>
    fetchOrThrow(videoUrl, { timeoutMs: 120_000 }),
  );
  return {
    video: Buffer.from(await dl.arrayBuffer()),
    contentType: dl.headers.get("content-type") || "video/mp4",
    provider: "ltx2",
    seconds: duration,
  };
}

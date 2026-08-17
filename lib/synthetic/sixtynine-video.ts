import { getEnv } from "@/lib/env";
import { fetchOrThrow, withHttpRetry, isAuthForbidden } from "@/lib/synthetic/http";
import type { GenerateClipInput, GenerateClipResult } from "@/lib/synthetic/falai";

// 69labs VIDEO lane — Veo 3.1 Lite image-to-video. The SECONDARY clip engine:
// LTX-2 carries ~25% of a video and this carries ~5% (client direction
// 2026-08-17), so a handful of blocks per video render here.
//
// Same async job lifecycle as the tts/images lanes, on the same api key:
//   1. POST /api/v1/videos/generate       -> 201 { id, queuePosition }
//   2. GET  /api/v1/videos/status/:jobId  -> PENDING|PROCESSING|...|COMPLETED|
//                                            FAILED|CANCELLED|CENSORED
//   3. GET  /api/v1/videos/download/:jobId -> the mp4 bytes
//
// The wire contract was established live on 2026-08-17 (scripts/probe-69labs-
// video.ts + probe-69labs-video-submit.ts) because 69labs publishes no docs for
// this lane. Two findings that are NOT guessable and must not be "tidied up":
//   - The submit body is { model, prompt, imageUrls: [...], aspectRatio }.
//     `imageUrl` (singular) is NOT the field name.
//   - Veo 3.1 Lite REJECTS a `mode` field outright:
//       400 {"error":"Veo 3.1 Lite does not support mode selection"}
//     even though GET /videos/models advertises defaults.mode = "keyframes" for
//     it. The advertised default is informational; sending it back fails.
//
// Billing is CREDITS, not seconds: veo-video costs 1 credit per generation
// against a daily allowance (300/day, 24k/month as of 2026-08-17), so clip
// LENGTH is free but clip COUNT is not — the opposite of LTX's per-second bill.

function cfg() {
  const env = getEnv();
  if (!env.SIXTYNINE_LABS_API_KEY) {
    throw new Error("SIXTYNINE_LABS_API_KEY not configured (veo clip lane)");
  }
  return {
    base: env.SIXTYNINE_LABS_BASE_URL.replace(/\/$/, ""),
    model: env.SIXTYNINE_LABS_VIDEO_MODEL,
    pollTimeoutMs: env.SIXTYNINE_LABS_VIDEO_POLL_TIMEOUT_SECONDS * 1000,
  };
}

export function isVeoConfigured(): boolean {
  const env = getEnv();
  return env.SYNTHETIC_VEO_ENABLED && Boolean(env.SIXTYNINE_LABS_API_KEY);
}

/** The video model the veo lane will request. Logged so the job line proves it. */
export function veoModel(): string {
  return getEnv().SIXTYNINE_LABS_VIDEO_MODEL;
}

type VideoStatus =
  | "PENDING" | "PROCESSING" | "FINALIZING"
  | "COMPLETED" | "FAILED" | "CANCELLED" | "CENSORED";

interface VideoStatusResponse {
  id: string;
  status: VideoStatus;
  queuePosition?: number;
  // 69labs is inconsistent about which field carries a failure reason (images
  // use userMessage, tts sometimes error/message), so read all three — a bare
  // "job FAILED" with the reason discarded is undebuggable.
  userMessage?: string;
  error?: string;
  message?: string;
}

function failureReason(st: VideoStatusResponse): string {
  return (st.userMessage || st.error || st.message || "").trim();
}

/**
 * A PERMANENT veo failure that retrying cannot fix — the account is out of
 * video credits or over its daily/monthly allowance. Mirrors
 * isLtxPermanentFailure: the caller fails the segment fast instead of burning
 * its retry budget (and a fresh still per attempt) on a clip that cannot succeed.
 */
export function isVeoPermanentFailure(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err ?? "");
  return /insufficient credit|out of credits|credit limit|quota|allowance|payment required|billing/i.test(msg);
}

/** A content-policy refusal. Terminal — the prompt has to change, not the vendor. */
export function isVeoCensored(err: unknown): boolean {
  return /CENSORED|safety check|blocked by|content polic|moderation/i.test(
    (err as Error)?.message ?? "",
  );
}

/**
 * Generate an action clip via 69labs Veo 3.1 Lite (image-to-video, no audio —
 * the voiceover is the master track and the renderer strips clip audio anyway).
 *
 * The source still is passed as a PUBLIC url (our R2 copy, already low-fi
 * degraded), which is what keeps a veo clip looking like the rest of the video
 * instead of arriving with Veo's native glossy grade.
 *
 * Throws on any failure so the caller logs the genuine reason; there is no
 * cross-provider fallback here (falling back to LTX would silently change the
 * engine the plan deliberately chose for this block).
 */
export async function generateVeoClip(input: GenerateClipInput): Promise<GenerateClipResult> {
  const c = cfg();
  const key = (getEnv().SIXTYNINE_LABS_API_KEY || "").trim();
  const authJson = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const authOnly = { Authorization: `Bearer ${key}` };
  // Veo Lite exposes no duration control (durationCosts null, no durations[] in
  // the model catalogue) and returns ~8s. We report that as the billed length
  // for cost/telemetry; the renderer trims to the block's spoken window.
  const seconds = input.durationSeconds ?? 8;

  // 1) Submit. NOTE: no `mode` field — Veo Lite 400s on it (see header).
  const submit = await withHttpRetry("69labs.video.submit", () =>
    fetchOrThrow(`${c.base}/api/v1/videos/generate`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({
        model: c.model,
        prompt: input.prompt,
        imageUrls: [input.imageUrl],
        aspectRatio: "16:9",
      }),
      timeoutMs: 60_000,
    }),
    { attempts: 2, baseMs: 1000 },
  );
  const parsed = (await submit.json()) as { id?: string; queuePosition?: number };
  const jobId = parsed.id;
  if (!jobId) throw new Error("69labs video: submit returned no job id");

  // 2) Poll to COMPLETED. 5s cadence, matching the image lane — these renders
  // take minutes, so a tighter tick only spends rate budget.
  const deadline = Date.now() + c.pollTimeoutMs;
  while (Date.now() < deadline) {
    const statusRes = await withHttpRetry("69labs.video.status", () =>
      fetchOrThrow(`${c.base}/api/v1/videos/status/${jobId}`, {
        headers: authOnly,
        timeoutMs: 30_000,
      }),
      { attempts: 3, baseMs: 1000 },
    );
    const st = (await statusRes.json()) as VideoStatusResponse;
    if (st.status === "COMPLETED") break;
    if (st.status === "CENSORED") {
      throw new Error(`69labs video: CENSORED (job ${jobId}) — edit the prompt and retry`);
    }
    if (st.status === "FAILED" || st.status === "CANCELLED") {
      const reason = failureReason(st);
      // A moderation refusal can arrive as FAILED with the reason only in
      // userMessage (the images lane has the same quirk) — re-label it so the
      // caller treats it as terminal instead of retrying into the same refusal.
      if (/safety check|blocked by|restricted content|content polic/i.test(reason)) {
        throw new Error(`69labs video: CENSORED (job ${jobId}) — ${reason}`);
      }
      throw new Error(
        `69labs video: job ${st.status} (job ${jobId})${reason ? ` — ${reason}` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (Date.now() >= deadline) throw new Error(`69labs video: poll timed out (job ${jobId})`);

  // 3) Download the finished mp4.
  const dl = await withHttpRetry("69labs.video.download", () =>
    fetchOrThrow(`${c.base}/api/v1/videos/download/${jobId}`, {
      headers: authOnly,
      timeoutMs: 180_000,
    }),
  );
  return {
    video: Buffer.from(await dl.arrayBuffer()),
    contentType: dl.headers.get("content-type") || "video/mp4",
    provider: "sixtynine_veo",
    seconds,
  };
}

// Re-exported so the processor can treat a dead 69labs key the same way the LTX
// lane treats a dead LTX account (fail fast rather than retry).
export { isAuthForbidden };

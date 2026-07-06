import { getEnv } from "@/lib/env";
import { fetchOrThrow, withHttpRetry, HttpError } from "@/lib/synthetic/http";
import { uploadBuffer } from "@/lib/storage";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { HeygenError } from "@/lib/synthetic/heygen-errors";
import type { GenerateAvatarInput, GenerateAvatarResult } from "@/lib/synthetic/heygen";

// OFFICIAL HeyGen API fallback for avatar generation.
//
// This is the LAST-RESORT path: generateAvatar() drives the HeyGen web app via a
// headless browser (cheaper interactive-plan renders), and ONLY when its whole
// account pool fails to produce a clip does it call generateAvatarViaApi() here.
// The API bills API credits (more expensive — see cost.ts heygen_api), so this
// never runs on the happy path; it exists so a clip that would otherwise HARD-FAIL
// still gets produced. Gated by HEYGEN_API_FALLBACK + HEYGEN_API_KEY (see env.ts).
//
// Flow (HeyGen API v3, verified 2026-07):
//   1. POST /v3/assets (multipart)  -> upload the project PHOTO      -> asset_id
//   2. POST /v3/assets (multipart)  -> upload the sliced 69labs AUDIO -> asset_id
//   3. POST /v3/videos              -> talking-photo video driven by the audio
//                                      asset, at the block's aspect ratio -> video_id
//   4. GET  /v3/videos/{video_id}   -> poll until "completed" -> download video_url
//   5. upload the mp4 to R2 and return its public URL (same shape the browser path
//      returns, so callers are agnostic to which path produced the clip).
//
// SCOPE: talking-photo (Avatar IV equivalent) only — covers full-frame avatars and
// split_2 left-halves. Avatar III's "Create new shots" flow has a different API
// surface; generateAvatar() does NOT route avatar_iii here (it logs and skips).
// REQUIRES the sliced audio: like the browser path, we never speak HeyGen's own
// TTS (wrong audio is unusable), so a missing audio slice means no API fallback.

const AUTH_HEADER = "x-api-key";

interface UploadAssetResponse {
  data?: { asset_id?: string; url?: string; mime_type?: string };
  asset_id?: string; // some responses put it at the top level — tolerate both
}

interface CreateVideoResponse {
  data?: { video_id?: string };
  video_id?: string;
  error?: unknown;
}

interface VideoStatusResponse {
  data?: {
    status?: string; // "pending" | "processing" | "completed" | "failed"
    video_url?: string;
    duration?: number;
    error?: { message?: string } | string | null;
  };
}

function apiKeyOrThrow(): string {
  const key = getEnv().HEYGEN_API_KEY;
  if (!key) {
    throw new HeygenError(
      "unknown",
      "heygen-api: HEYGEN_API_KEY not set — API fallback is unavailable",
    );
  }
  return key;
}

// True when the API fallback is BOTH enabled and configured. generateAvatar()
// checks this before attempting the fallback so an unset key/flag is a silent
// no-op (the original pool-exhausted error just propagates).
export function heygenApiFallbackEnabled(): boolean {
  const e = getEnv();
  return e.HEYGEN_API_FALLBACK && !!e.HEYGEN_API_KEY;
}

// Upload a file buffer to /v3/assets and return its asset_id. HeyGen uses the
// SAME endpoint for images and audio; the mime type tells it apart.
async function uploadAsset(
  buf: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  const e = getEnv();
  const url = `${e.HEYGEN_API_BASE_URL}/v3/assets`;
  const form = new FormData();
  // Node's FormData accepts a Blob; wrap the buffer so the multipart part carries
  // the right content-type and filename.
  // Wrap as a fresh Uint8Array — a Node Buffer isn't a valid BlobPart under the
  // lib.dom typings (its backing ArrayBufferLike may be a SharedArrayBuffer). The
  // copy is cheap and the bytes are identical.
  form.append("file", new Blob([new Uint8Array(buf)], { type: contentType }), filename);

  const res = await withHttpRetry("heygen-api.upload_asset", () =>
    fetchOrThrow(url, {
      method: "POST",
      headers: { [AUTH_HEADER]: apiKeyOrThrow() }, // do NOT set Content-Type — fetch sets the multipart boundary
      body: form,
      timeoutMs: 120_000,
    }),
  );
  const json = (await res.json().catch(() => ({}))) as UploadAssetResponse;
  const assetId = json.data?.asset_id ?? json.asset_id;
  if (!assetId) {
    throw new HeygenError("unknown", `heygen-api: asset upload returned no asset_id (${filename})`);
  }
  return assetId;
}

// Kick off a talking-photo render driven by the uploaded audio asset. Returns the
// video_id to poll.
async function createTalkingPhotoVideo(
  photoAssetId: string,
  // The voiceover, supplied EITHER as a public URL (preferred — no upload) OR as
  // an uploaded asset id. Exactly one is set. Both map to the top-level audio
  // field HeyGen expects (audio_url / audio_asset_id), which is mutually exclusive
  // with a script — so lip-sync is always driven by OUR audio, never HeyGen TTS.
  audio: { url: string } | { assetId: string },
  aspectRatio: "landscape" | "portrait",
  title: string,
): Promise<string> {
  const e = getEnv();
  const url = `${e.HEYGEN_API_BASE_URL}/v3/videos`;
  const body = {
    type: "image", // talking-photo from an uploaded image asset
    title: title.slice(0, 120),
    image: { type: "asset_id", asset_id: photoAssetId },
    // Drive lip-sync with OUR audio (the sliced 69labs voiceover).
    ...("url" in audio ? { audio_url: audio.url } : { audio_asset_id: audio.assetId }),
    aspect_ratio: aspectRatio === "portrait" ? "9:16" : "16:9",
    resolution: e.HEYGEN_API_RESOLUTION,
  };
  const res = await withHttpRetry("heygen-api.create_video", () =>
    fetchOrThrow(url, {
      method: "POST",
      headers: { [AUTH_HEADER]: apiKeyOrThrow(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    }),
  );
  const json = (await res.json().catch(() => ({}))) as CreateVideoResponse;
  const videoId = json.data?.video_id ?? json.video_id;
  if (!videoId) {
    throw new HeygenError("unknown", "heygen-api: create video returned no video_id");
  }
  return videoId;
}

// Poll the video status until it completes (or fails / times out), then return
// its signed download URL. Bounded by HEYGEN_API_RENDER_TIMEOUT_SECONDS.
async function awaitRenderedUrl(videoId: string): Promise<{ url: string; seconds: number }> {
  const e = getEnv();
  const statusUrl = `${e.HEYGEN_API_BASE_URL}/v3/videos/${videoId}`;
  const deadline = Date.now() + e.HEYGEN_API_RENDER_TIMEOUT_SECONDS * 1000;
  const pollMs = 5_000;

  while (Date.now() < deadline) {
    // A transient 5xx/network blip on ONE poll shouldn't abort the whole render —
    // swallow it and re-poll on the next tick (withHttpRetry handles short bursts).
    let json: VideoStatusResponse = {};
    try {
      const res = await withHttpRetry("heygen-api.video_status", () =>
        fetchOrThrow(statusUrl, {
          method: "GET",
          headers: { [AUTH_HEADER]: apiKeyOrThrow() },
          timeoutMs: 30_000,
        }),
      );
      json = (await res.json().catch(() => ({}))) as VideoStatusResponse;
    } catch (err) {
      // A permanent 4xx (bad id / revoked key) is not worth polling out.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw new HeygenError("unknown", `heygen-api: status check failed — ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    const status = (json.data?.status ?? "").toLowerCase();
    if (status === "completed" || status === "success") {
      const url = json.data?.video_url;
      if (!url) {
        throw new HeygenError("unknown", "heygen-api: render completed but no video_url was returned");
      }
      return { url, seconds: Number(json.data?.duration ?? 0) || 0 };
    }
    if (status === "failed" || status === "error") {
      const errObj = json.data?.error;
      const detail =
        typeof errObj === "string" ? errObj : errObj?.message ? errObj.message : "unknown";
      throw new HeygenError("unknown", `heygen-api: render failed on HeyGen side — ${detail}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new HeygenError("unknown", "heygen-api: render did not complete within the API render budget");
}

/**
 * Generate an avatar clip via the OFFICIAL HeyGen API (fallback path). Uploads the
 * project photo + the sliced 69labs audio as assets, creates a talking-photo video
 * driven by that audio at the block's aspect ratio, polls to completion, downloads
 * the mp4, and re-hosts it to R2. Returns the SAME GenerateAvatarResult shape the
 * browser path returns so callers are agnostic. accountId is reported as
 * "heygen-api" for auditing (it is not a pool account).
 *
 * Throws a HeygenError on any failure — the caller (generateAvatar) has already
 * exhausted the browser pool, so a throw here means the clip genuinely couldn't be
 * produced and the processor degrades as before.
 */
export async function generateAvatarViaApi(
  input: GenerateAvatarInput,
  imageBytes: Buffer,
): Promise<GenerateAvatarResult> {
  const t0 = Date.now();
  // Guard: this path requires the sliced audio (a public URL or a local file) —
  // we never speak HeyGen TTS.
  if (!input.audioUrl && !input.audioFilePath) {
    throw new HeygenError(
      "unknown",
      "heygen-api: fallback requires the sliced audio (audioUrl or audioFilePath) — no script/TTS fallback",
    );
  }

  await logProviderCall({
    projectId: input.projectId,
    jobId: input.jobId,
    segmentId: input.segmentId,
    provider: "heygen_api",
    phase: "request",
    extra: { note: "browser pool exhausted — attempting API fallback" },
  });

  // 1) Upload the PHOTO asset (always needed — it's passed as bytes).
  const photoAssetId = await uploadAsset(imageBytes, `${input.segmentId}_photo.jpg`, "image/jpeg");

  // 2) AUDIO: prefer the R2 public URL (no upload) when we have it; otherwise
  // upload the local slice as an asset. Both paths drive lip-sync identically.
  let audioInput: { url: string } | { assetId: string };
  if (input.audioUrl) {
    audioInput = { url: input.audioUrl };
  } else {
    const { promises: fs } = await import("node:fs");
    // Guarded above: when audioUrl is absent, audioFilePath is present.
    const audioBytes = await fs.readFile(input.audioFilePath as string);
    const audioAssetId = await uploadAsset(audioBytes, `${input.segmentId}_audio.mp3`, "audio/mpeg");
    audioInput = { assetId: audioAssetId };
  }

  // 3) Create the talking-photo video driven by the audio.
  const aspect = input.aspectRatio ?? "landscape";
  const videoId = await createTalkingPhotoVideo(
    photoAssetId,
    audioInput,
    aspect,
    `synthetic ${input.projectId} ${input.segmentId}`,
  );

  // 4) Poll to completion + get the signed URL.
  const { url, seconds } = await awaitRenderedUrl(videoId);

  // 5) Download the finished mp4 and re-host to R2 (the signed HeyGen URL expires;
  // the DB row must point at a permanent asset). Version the key with the render's
  // creation time so a regenerate never serves a stale cached copy.
  const dl = await withHttpRetry("heygen-api.download", () =>
    fetchOrThrow(url, { timeoutMs: 120_000 }),
  );
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length < 1024) {
    throw new HeygenError("unknown", "heygen-api: downloaded render was empty/too small");
  }
  const key = r2Keys.avatarVideo(input.projectId, input.segmentId, `api_${videoId}`);
  const up = await uploadBuffer(buf, key, "video/mp4");

  // Billing/audit: bill on the audio slice length (the render length) when the API
  // didn't report a duration.
  const billedSeconds = seconds > 0 ? seconds : input.audioDurationSeconds ?? 0;
  await logProviderCall({
    projectId: input.projectId,
    jobId: input.jobId,
    segmentId: input.segmentId,
    provider: "heygen_api",
    phase: "response",
    durationMs: Date.now() - t0,
    cost: { provider: "heygen_api", seconds: billedSeconds },
    extra: { videoId, aspect, resolution: getEnv().HEYGEN_API_RESOLUTION },
  });

  return { videoUrl: up.publicUrl, accountId: "heygen-api", seconds: billedSeconds };
}

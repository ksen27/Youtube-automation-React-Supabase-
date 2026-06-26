import path from "node:path";
import { promises as fs } from "node:fs";
import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, logJob } from "@/lib/jobs/db";
import type { AvatarJobData } from "@/lib/jobs/queue";
import { fetchOrThrow, withHttpRetry } from "@/lib/synthetic/http";
import { uploadBuffer, uploadFile, downloadToFile, headObject, ensureTmp, safeUnlink } from "@/lib/storage";
import { generateAvatar } from "@/lib/synthetic/heygen";
import { beginRender, endRender } from "@/lib/synthetic/heygen-session";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { degradeImageLowFi } from "@/lib/synthetic/degrade";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { cutAudio, cropImageToPortrait } from "@/lib/media/ffmpeg";
import { finishSegment, maybeFinalizeSynthetic } from "@/worker/processors/synthetic/_shared";
import { classOf, userFacingMessage } from "@/lib/synthetic/heygen-errors";
import type { JobAttemptInfo } from "@/worker/index";

// An avatar part is capped at 1 minute by the content rules (well under HeyGen
// Pro's 5-min/video limit). We don't split here — by agreement a part never
// exceeds this — but we LOG when a slice runs long so a content-rule violation
// is visible instead of silently producing an over-length HeyGen upload.
const AVATAR_AUDIO_MAX_SECONDS = 60;

// Slice this avatar part's spoken window out of the project's master voiceover
// and stage it as a local MP3 for upload to HeyGen. HeyGen lip-syncs the avatar
// to this audio, so the rendered video length equals the slice length — which
// is exactly the avatar/voiceover duration match we want. Returns the staged
// path + slice duration, or null when no voiceover / no valid window is
// available (caller then degrades to the legacy script-text path).
async function stageAvatarAudio(
  projectId: string,
  segmentId: string,
  voiceoverUrl: string | null,
  startTime: number | string | null,
  endTime: number | string | null,
): Promise<{ path: string; durationSeconds: number } | null> {
  if (!voiceoverUrl) return null;
  // Supabase can return `numeric` columns as either JS numbers or strings, so
  // coerce + validate finiteness here rather than relying on typeof.
  const start = startTime === null ? NaN : Math.max(0, Number(startTime));
  const end = endTime === null ? NaN : Number(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const durationSeconds = end - start;
  if (durationSeconds <= 0.1) return null;

  const tmp = await ensureTmp(`avatar-audio/${projectId}`);
  const masterPath = path.join(tmp, `${segmentId}_master.mp3`);
  const slicePath = path.join(tmp, `${segmentId}.mp3`);

  // Cache key: the slice is fully determined by the segment's spoken WINDOW, so
  // keying on start/end (ms) lets a REGENERATE reuse the prior slice instead of
  // re-downloading the whole master voiceover and re-cutting every time. A
  // timing edit changes the key, so a stale slice is never reused.
  const startMs = Math.round(start * 1000);
  const endMs = Math.round(end * 1000);
  const cacheKey = r2Keys.avatarAudioSlice(projectId, segmentId, startMs, endMs);

  // Cache hit: download the cached slice and skip the master fetch + ffmpeg cut.
  const cached = await headObject(cacheKey).catch(() => null);
  if (cached && cached.size > 0) {
    try {
      await downloadToFile(cacheKey, slicePath);
      return { path: slicePath, durationSeconds };
    } catch {
      // Cache fetch failed for some reason — fall through and rebuild the slice.
    }
  }

  // Cache miss: fetch the full master voiceover once, cut the part window out of
  // it, then cache the slice for future regenerates.
  const res = await withHttpRetry("avatar.voiceover_fetch", () =>
    fetchOrThrow(voiceoverUrl, { timeoutMs: 120_000 }),
  );
  await fs.writeFile(masterPath, Buffer.from(await res.arrayBuffer()));
  try {
    await cutAudio({
      inputPath: masterPath,
      outputPath: slicePath,
      startSeconds: start,
      durationSeconds,
      format: "mp3", // HeyGen's Upload Audio modal accepts MP3/WAV; .mp3 needs mp3 codec
    });
  } finally {
    await safeUnlink(masterPath);
  }
  // Best-effort cache write — a failure here just means the next regenerate
  // re-cuts; never fail the avatar job over the cache.
  await uploadFile(slicePath, cacheKey, "audio/mpeg").catch(() => {});
  return { path: slicePath, durationSeconds };
}

// 'avatar' and 'split_2' avatar-half generation via HeyGen Playwright
// automation. The avatar is generated from the project's uploaded avatar image,
// driven by the segment's narration. For split_2 the still half is produced by
// the image-gen processor; THIS processor produces the talking-head video that
// is composited on the left at render time — so both 'avatar' and the
// avatar-bearing 'split_2' segments route here.
//
// Account rotation, cookie sessions, proxy support, screenshots, and failure
// detection all live in generateAvatar(); this processor handles the DB/job
// lifecycle and the final-attempt degrade.
// Generate (or re-generate) a split_2 block's RIGHT-half still and persist it.
// finishSegment archives the prior right_image_url into asset_history first.
async function generateSplitRightImage(
  projectId: string, mediaJobId: string, segmentId: string,
  seg: { image_prompt: string | null; metadata: unknown },
): Promise<void> {
  const t0 = Date.now();
  // Right-half still prompt. NEVER fall back to seg.script (the spoken
  // narration); use the per-block scene, else the video's recurring world
  // (base_prompt), so the illustrative half stays on-topic.
  const basePrompt = ((seg.metadata as { base_prompt?: string } | null)?.base_prompt ?? "").trim();
  const prompt = (seg.image_prompt?.trim() || basePrompt).trim();
  if (!prompt) throw new Error(`avatar: split_2 segment ${segmentId} has no usable image prompt`);
  await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: "sixtynine_image", phase: "request" });
  const img = await generateImage(prompt);
  await logProviderCall({
    projectId, jobId: mediaJobId, segmentId, provider: img.provider, phase: "response",
    durationMs: Date.now() - t0, cost: { provider: img.provider, images: 1 },
  });
  // Low-fi degrade the illustrative half so it matches the real-footage look.
  const deg = await degradeImageLowFi(img.image);
  const up = await uploadBuffer(
    deg.image,
    r2Keys.segmentRightImage(projectId, segmentId, Date.now()),
    deg.degraded ? deg.contentType : img.contentType,
  );
  await finishSegment(segmentId, { right_image_url: up.publicUrl });
}

export async function processAvatarJob(data: AvatarJobData, attempt?: JobAttemptInfo): Promise<void> {
  const { projectId, mediaJobId, segmentId, imageOnly } = data;
  const sb = getServerSupabase();
  const isFinalAttempt = (attempt?.attemptsMade ?? 1) >= (attempt?.attemptsAllowed ?? 1);

  await setMediaJob(mediaJobId, { status: "running", progress: 10, metadata: { segmentId } });

  const [{ data: seg, error: segErr }, { data: project, error: projErr }] = await Promise.all([
    sb
      .from("synthetic_segments")
      .select("id, block_type, script, image_prompt, right_image_url, start_time, end_time, metadata")
      .eq("id", segmentId)
      .single(),
    sb.from("projects").select("avatar_image_url, voiceover_url").eq("id", projectId).single(),
  ]);
  if (segErr || !seg) throw new Error(`avatar: segment ${segmentId} not found`);

  // IMAGE-ONLY regenerate (split_2): re-create ONLY the right-half still and KEEP
  // the existing avatar video — no HeyGen re-render. Used by "Regenerate image"
  // and the bulk "images" scope. For a non-split_2 block there is no image to
  // regenerate here, so we just mark it ready (its avatar video is untouched).
  if (imageOnly) {
    try {
      if (seg.block_type === "split_2") {
        await generateSplitRightImage(projectId, mediaJobId, segmentId, seg);
      }
      await finishSegment(segmentId, { status: "ready", error: null });
      await setMediaJob(mediaJobId, { status: "completed", progress: 100 });
    } catch (err) {
      await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.avatar.image_only_failed", {
        err: (err as Error).message?.slice(0, 200), isFinalAttempt,
      });
      if (isFinalAttempt) {
        await finishSegment(segmentId, { status: "failed", error: userFacingMessage(err) });
        await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: userFacingMessage(err) });
        await maybeFinalizeSynthetic(projectId);
        return;
      }
      throw err;
    }
    await maybeFinalizeSynthetic(projectId);
    return;
  }

  if (projErr || !project?.avatar_image_url) {
    throw new Error(`avatar: project ${projectId} has no avatar_image_url`);
  }

  // For split_2 blocks, generate the RIGHT-half still first (idempotent: reused
  // on retry once present). The avatar video becomes the LEFT half, composited
  // at render time by buildSplitScreenAvatarVideo.
  if (seg.block_type === "split_2" && !seg.right_image_url) {
    await generateSplitRightImage(projectId, mediaJobId, segmentId, seg);
    await setMediaJob(mediaJobId, { progress: 25 });
  }

  // Fetch the uploaded avatar image bytes to feed into the HeyGen upload step.
  const imgRes = await withHttpRetry("avatar.image_fetch", () =>
    fetchOrThrow(project.avatar_image_url as string, { timeoutMs: 60_000 }),
  );
  let imageBytes: Buffer<ArrayBuffer> = Buffer.from(await imgRes.arrayBuffer());

  // split_2 avatars go into a 9:16 PORTRAIT canvas. A LANDSCAPE source photo
  // makes HeyGen pad top/bottom with white (baked-in letterbox bars). Pre-crop
  // the source to 9:16 so the rendered avatar fills the frame edge-to-edge.
  // Best-effort: on any crop failure, fall back to the raw bytes (the render's
  // letterbox-strip still cleans up residual bars).
  if (seg.block_type === "split_2") {
    try {
      imageBytes = await cropImageToPortrait(imageBytes);
    } catch (e) {
      await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.avatar.portrait_crop_failed", {
        err: (e as Error).message?.slice(0, 200),
      });
    }
  }

  await setMediaJob(mediaJobId, { progress: 30 });

  // Slice this avatar part's audio from the master voiceover so HeyGen lip-syncs
  // to the exact 69labs audio (rendered length == audio length). On any failure
  // we degrade to the legacy script-text path rather than failing the render.
  let audio: { path: string; durationSeconds: number } | null = null;
  try {
    audio = await stageAvatarAudio(
      projectId,
      segmentId,
      (project as { voiceover_url?: string | null }).voiceover_url ?? null,
      seg.start_time as number | string | null,
      seg.end_time as number | string | null,
    );
    if (audio && audio.durationSeconds > AVATAR_AUDIO_MAX_SECONDS) {
      await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.avatar.audio_over_length", {
        durationSeconds: Math.round(audio.durationSeconds * 100) / 100,
        capSeconds: AVATAR_AUDIO_MAX_SECONDS,
      });
    }
  } catch (e) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.avatar.audio_slice_failed", {
      err: (e as Error).message?.slice(0, 200),
    });
    audio = null;
  }

  try {
    // Mark a render in flight so the keep-alive sweep won't open a second
    // concurrent HeyGen browser on top of it (the Cloudflare page-wipe trigger).
    // Wrapped in try/finally so the flag clears on success AND failure.
    beginRender();
    let result;
    try {
      result = await generateAvatar(
        {
          projectId,
          segmentId,
          jobId: mediaJobId,
          avatarImageUrl: project.avatar_image_url as string,
          script: seg.script ?? "",
          audioFilePath: audio?.path,
          audioDurationSeconds: audio?.durationSeconds,
          // split_2 avatars fill a tall LEFT half-cell (640×720) at render, so
          // generate them 9:16 portrait; full-frame avatars use 16:9 landscape.
          aspectRatio: seg.block_type === "split_2" ? "portrait" : "landscape",
        },
        imageBytes,
      );
    } finally {
      endRender();
    }
    // For split_2 the avatar is the LEFT video; the right still is set by the
    // image-gen processor. video_url holds the avatar mp4 either way.
    // Clear any error left by a prior attempt or a premature stall-sweep — a
    // slow-but-alive HeyGen render can complete AFTER the sweeper wrote a
    // "stalled" error, and without clearing it the row would show 'ready' with a
    // stale red error simultaneously.
    await finishSegment(segmentId, { status: "ready", video_url: result.videoUrl, provider: "heygen", error: null });
    await setMediaJob(mediaJobId, {
      status: "completed",
      progress: 100,
      metadata: { accountId: result.accountId, seconds: result.seconds },
    });
  } catch (err) {
    // Raw error → logs only (the admin diagnoses from here + heygen_accounts).
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.avatar.failed", {
      err: (err as Error).message?.slice(0, 200),
      klass: classOf(err),
      isFinalAttempt,
    });
    if (isFinalAttempt) {
      // User-visible fields get a plain-language message — never the raw error
      // (which could say "re-auth with `npm run …`", meaningless to an end user).
      const friendly = userFacingMessage(err);
      await finishSegment(segmentId, { status: "failed", error: friendly });
      await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: friendly });
      await maybeFinalizeSynthetic(projectId);
      return;
    }
    throw err;
  } finally {
    // Clean up the staged audio slice (best-effort; ignored if absent).
    if (audio?.path) await safeUnlink(audio.path);
  }

  await maybeFinalizeSynthetic(projectId);
}

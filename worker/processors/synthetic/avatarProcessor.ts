import path from "node:path";
import { promises as fs } from "node:fs";
import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, logJob } from "@/lib/jobs/db";
import type { AvatarJobData } from "@/lib/jobs/queue";
import { fetchOrThrow, withHttpRetry } from "@/lib/synthetic/http";
import { uploadBuffer, uploadFile, downloadToFile, headObject, ensureTmp, safeUnlink, publicUrlForKey } from "@/lib/storage";
import { generateAvatar } from "@/lib/synthetic/heygen";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { degradeImageLowFi } from "@/lib/synthetic/degrade";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { findReusableAsset, indexGeneratedAsset } from "@/lib/synthetic/asset-library";
import { cutAudio, cropImageToPortrait } from "@/lib/media/ffmpeg";
import { finishSegment, maybeFinalizeSynthetic, withSegmentHeartbeat } from "@/worker/processors/synthetic/_shared";
import { classOf, userFacingMessage, isPoolBusyError } from "@/lib/synthetic/heygen-errors";
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
): Promise<{ path: string; durationSeconds: number; url: string | null } | null> {
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
      // The slice is already in R2 at cacheKey — its public URL lets the API
      // fallback pass audio_url instead of re-uploading the bytes.
      return { path: slicePath, durationSeconds, url: publicUrlForKey(cacheKey) };
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
  // re-cuts; never fail the avatar job over the cache. Track success so we only
  // hand back a public URL when the slice actually landed in R2 (the API fallback
  // needs HeyGen to be able to fetch it; if the upload failed it uploads the local
  // bytes instead).
  const cached2 = await uploadFile(slicePath, cacheKey, "audio/mpeg")
    .then(() => true)
    .catch(() => false);
  return { path: slicePath, durationSeconds, url: cached2 ? publicUrlForKey(cacheKey) : null };
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
  // ASSET LIBRARY (migration 0030): reuse a matching prior still for the right
  // half instead of generating (urls already used in this project excluded).
  // Disabled/miss/error falls through to the normal 69labs call.
  const reuse = await findReusableAsset({ prompt, assetType: "image", projectId });
  if (reuse) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.avatar.right_image_reused", {
      via: reuse.via,
      similarity: Number(reuse.similarity.toFixed(4)),
      assetId: reuse.id,
    });
    await finishSegment(segmentId, { right_image_url: reuse.assetUrl });
    return;
  }
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
  // Index the fresh right-half still into the cross-project asset library
  // (best-effort; no-op when ASSET_LIBRARY_ENABLED is off).
  await indexGeneratedAsset({
    prompt,
    assetType: "image",
    assetUrl: up.publicUrl,
    provider: img.provider,
    projectId,
    segmentId,
  });
}

export async function processAvatarJob(data: AvatarJobData, attempt?: JobAttemptInfo): Promise<void> {
  const { projectId, mediaJobId, segmentId, imageOnly } = data;
  const sb = getServerSupabase();
  const isFinalAttempt = (attempt?.attemptsMade ?? 1) >= (attempt?.attemptsAllowed ?? 1);

  await setMediaJob(mediaJobId, { status: "running", progress: 10, metadata: { segmentId } });

  const [{ data: seg, error: segErr }, { data: project, error: projErr }] = await Promise.all([
    sb
      .from("synthetic_segments")
      .select("id, block_type, avatar_model, status, script, image_prompt, right_image_url, video_url, start_time, end_time, metadata")
      .eq("id", segmentId)
      .single(),
    sb.from("projects").select("avatar_image_url, voiceover_url, heygen_avatar_name").eq("id", projectId).single(),
  ]);
  if (segErr || !seg) throw new Error(`avatar: segment ${segmentId} not found`);

  // STALE-JOB GUARD. Duplicate avatar jobs reach this processor two ways, and
  // BOTH redundantly re-render a segment that already succeeded (wasted HeyGen
  // time + cost, and the worker looks "stuck generating" long after the project
  // is done):
  //   (a) DIFFERENT job id — a stall-sweep/regenerate re-dispatched the segment
  //       under a NEW mediaJobId; the OLD job is still sitting in BullMQ and gets
  //       drained later. metadata.mediaJobId points at the CURRENT job, so this
  //       job's id differs from it.
  //   (b) SAME job id — a single long render (e.g. a wrong-orientation retry that
  //       stacked two ~11-min HeyGen renders) outran the BullMQ lockDuration, so
  //       BullMQ judged the job "stalled" and RE-DELIVERED the very same job id.
  //       Here metadata.mediaJobId === mediaJobId, so the (a) check alone misses
  //       it and we re-rendered an already-ready avatar — the observed
  //       never-clearing spinner.
  // So the real signal is simpler than id comparison: if the segment is already
  // 'ready' WITH a rendered video_url and this isn't an image-only regen, the
  // work is done — no-op regardless of which id re-delivered us. (imageOnly regen
  // always has work to do, so it's exempt; a genuine full regenerate resets the
  // segment OFF 'ready' before re-dispatch, so this never skips real work.)
  const currentJobId = ((seg.metadata ?? {}) as Record<string, unknown>).mediaJobId as string | undefined;
  const alreadyRendered = seg.status === "ready" && !!seg.video_url;
  if (!imageOnly && alreadyRendered) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.avatar.stale_job_skipped", {
      segmentStatus: seg.status,
      currentJobId,
      redelivery: currentJobId === mediaJobId, // (b): same-id stalled re-delivery
    });
    await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { skipped: "already_rendered" } });
    // Still drain the project. If THIS skipped re-delivery is the LAST segment
    // (its real render finished, but BullMQ re-delivered the job — case b — or a
    // duplicate job trailed it), the original delivery may have been killed as
    // "stalled" before reaching the finalize at the end of this function. Without
    // finalizing here the project would sit in generating_* forever with every
    // segment ready and no Render button. maybeFinalizeSynthetic is idempotent and
    // no-ops if another finalize already advanced the project past review.
    await maybeFinalizeSynthetic(projectId);
    return;
  }

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
  let audio: { path: string; durationSeconds: number; url: string | null } | null = null;
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

  // NO AUDIO SLICE → Avatar III can't render (it lip-syncs to the slice; there is
  // NO script-text fallback for Avatar III — generateAvatar throws hard). This
  // happens when the block's spoken window is empty/degenerate, e.g. a planner
  // gave a split_2 start_time == end_time (zero-length), so stageAvatarAudio
  // returns null. Rather than burning all 5 accounts on a render that can never
  // succeed, degrade gracefully:
  //   - split_2: it already has (or can make) a right-half still — drop the
  //     avatar half and render it as an IMAGE-only block (the still fills frame).
  //   - full avatar: there is no still to fall back to, so fail with a clear,
  //     actionable message instead of the opaque "failed across 5 accounts".
  if (!audio) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.avatar.no_audio_degrade", {
      blockType: seg.block_type,
      startTime: seg.start_time,
      endTime: seg.end_time,
    });
    if (seg.block_type === "split_2") {
      // Ensure the illustrative still exists (idempotent — reused if already made),
      // then convert the block to an image so the render uses the still full-frame
      // and never expects an avatar video_url for this segment.
      if (!seg.right_image_url) {
        await generateSplitRightImage(projectId, mediaJobId, segmentId, seg);
      }
      await sb.from("synthetic_segments")
        .update({ block_type: "image", animation_prompt: null })
        .eq("id", segmentId);
      // Promote the right-half still to the block's primary image so the image
      // renderer has an image_url to show (right_image_url is a split-only field).
      const { data: fresh } = await sb.from("synthetic_segments")
        .select("right_image_url, image_url").eq("id", segmentId).single();
      const still = fresh?.image_url ?? fresh?.right_image_url ?? null;
      await finishSegment(segmentId, { status: "ready", image_url: still, video_url: null, provider: "sixtynine_image", error: null });
      await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { degraded: "no_audio_split2_to_image" } });
      await maybeFinalizeSynthetic(projectId);
      return;
    }
    // Full avatar block with no audio window — nothing to fall back to.
    const msg = "This avatar block has an empty spoken window (no audio to lip-sync). Re-plan to fix the block timing, then regenerate.";
    await finishSegment(segmentId, { status: "failed", error: msg });
    await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: msg });
    await maybeFinalizeSynthetic(projectId);
    return;
  }

  try {
    // Heartbeat the segment's updated_at across the multi-minute HeyGen render
    // so the stall sweeper can't false-fail an avatar that is alive and
    // rendering (the race the finishSegment error-clear below only papered over).
    // NOTE: the "render in flight" marker that keeps the keep-alive sweep off a
    // busy account now lives INSIDE generateAvatar (beginRender/endRender), keyed
    // by the account it actually claims — the processor can't know that account
    // id ahead of the claim.
    const result = await withSegmentHeartbeat(segmentId, () =>
      generateAvatar(
        {
          projectId,
          segmentId,
          jobId: mediaJobId,
          avatarImageUrl: project.avatar_image_url as string,
          script: seg.script ?? "",
          audioFilePath: audio?.path,
          audioUrl: audio?.url ?? undefined,
          audioDurationSeconds: audio?.durationSeconds,
          // split_2 avatars fill a tall LEFT half-cell (640×720) at render, so
          // generate them 9:16 portrait; full-frame avatars use 16:9 landscape.
          aspectRatio: seg.block_type === "split_2" ? "portrait" : "landscape",
          // Client 2026-07-09: EVERY avatar part renders with Avatar III, including
          // split_2. The doc-highlight color (red or orange) only marks a run as an
          // avatar part now — it no longer picks the model (see doc-marks). split_2
          // is a GEMINI layout choice with no colored mark, so its avatar_model is
          // null; we force it to Avatar III here. On the Avatar Shots page split_2
          // keeps HeyGen's 9:16 PORTRAIT default (aspectRatio "portrait" below, which
          // driveAvatarIIIComposer leaves untouched); full-frame parts flip to 16:9.
          avatarModel: "avatar_iii",
          // Avatar III finds its saved avatar on HeyGen by this user-entered name.
          heygenAvatarName:
            (project as { heygen_avatar_name?: string | null }).heygen_avatar_name ?? null,
          // Set by the worker after this clip waited for a free account past the
          // threshold (pool contention) — render via the API, skipping the pool.
          forceApi: data.forceApi ?? false,
        },
        imageBytes,
      ),
    );
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
      // faceCheck (Avatar III) records which look key this render committed, so the
      // wrong-avatar-face bug is diagnosable from the DB (not ephemeral worker logs):
      // compare the committed key against the project's real avatar to tell
      // selection-side contamination from retrieval-side. null on the Avatar IV path.
      metadata: { accountId: result.accountId, seconds: result.seconds, faceCheck: result.faceCheck ?? null },
    });
  } catch (err) {
    // POOL CONTENTION (client 2026-07-07): every account is busy rendering another
    // clip — this clip did NOT fail. Re-throw so the worker wrapper (handlePoolBusy)
    // RE-DELAYS the job to WAIT for a free account (then switches to the API past
    // the threshold). Must happen BEFORE the failed-segment writes below, or the
    // clip would be marked failed instead of waiting. The staged audio is still
    // cleaned up by the finally; the next wait-run re-stages it.
    if (isPoolBusyError(err)) throw err;
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

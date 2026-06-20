import path from "node:path";
import { promises as fs } from "node:fs";
import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, logJob } from "@/lib/jobs/db";
import type { AvatarJobData } from "@/lib/jobs/queue";
import { fetchOrThrow, withHttpRetry } from "@/lib/synthetic/http";
import { uploadBuffer, ensureTmp, safeUnlink } from "@/lib/storage";
import { generateAvatar } from "@/lib/synthetic/heygen";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { cutAudio } from "@/lib/media/ffmpeg";
import { finishSegment, maybeFinalizeSynthetic } from "@/worker/processors/synthetic/_shared";
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

  // Fetch the full master voiceover once, then cut the part window out of it.
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
export async function processAvatarJob(data: AvatarJobData, attempt?: JobAttemptInfo): Promise<void> {
  const { projectId, mediaJobId, segmentId } = data;
  const sb = getServerSupabase();
  const isFinalAttempt = (attempt?.attemptsMade ?? 1) >= (attempt?.attemptsAllowed ?? 1);

  await setMediaJob(mediaJobId, { status: "running", progress: 10, metadata: { segmentId } });

  const [{ data: seg, error: segErr }, { data: project, error: projErr }] = await Promise.all([
    sb
      .from("synthetic_segments")
      .select("id, block_type, script, image_prompt, right_image_url, start_time, end_time")
      .eq("id", segmentId)
      .single(),
    sb.from("projects").select("avatar_image_url, voiceover_url").eq("id", projectId).single(),
  ]);
  if (segErr || !seg) throw new Error(`avatar: segment ${segmentId} not found`);
  if (projErr || !project?.avatar_image_url) {
    throw new Error(`avatar: project ${projectId} has no avatar_image_url`);
  }

  // For split_2 blocks, generate the RIGHT-half still first (idempotent: reused
  // on retry once present). The avatar video becomes the LEFT half, composited
  // at render time by buildSplitScreenAvatarVideo.
  if (seg.block_type === "split_2" && !seg.right_image_url) {
    const t0 = Date.now();
    const prompt = (seg.image_prompt ?? seg.script ?? "a relevant scene").trim();
    await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: "sixtynine_image", phase: "request" });
    const img = await generateImage(prompt);
    await logProviderCall({
      projectId, jobId: mediaJobId, segmentId, provider: img.provider, phase: "response",
      durationMs: Date.now() - t0, cost: { provider: img.provider, images: 1 },
    });
    const up = await uploadBuffer(img.image, r2Keys.segmentRightImage(projectId, segmentId), img.contentType);
    await finishSegment(segmentId, { right_image_url: up.publicUrl });
    await setMediaJob(mediaJobId, { progress: 25 });
  }

  // Fetch the uploaded avatar image bytes to feed into the HeyGen upload step.
  const imgRes = await withHttpRetry("avatar.image_fetch", () =>
    fetchOrThrow(project.avatar_image_url as string, { timeoutMs: 60_000 }),
  );
  const imageBytes = Buffer.from(await imgRes.arrayBuffer());

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
    const result = await generateAvatar(
      {
        projectId,
        segmentId,
        jobId: mediaJobId,
        avatarImageUrl: project.avatar_image_url as string,
        script: seg.script ?? "",
        audioFilePath: audio?.path,
        audioDurationSeconds: audio?.durationSeconds,
      },
      imageBytes,
    );
    // For split_2 the avatar is the LEFT video; the right still is set by the
    // image-gen processor. video_url holds the avatar mp4 either way.
    await finishSegment(segmentId, { status: "ready", video_url: result.videoUrl, provider: "heygen" });
    await setMediaJob(mediaJobId, {
      status: "completed",
      progress: 100,
      metadata: { accountId: result.accountId, seconds: result.seconds },
    });
  } catch (err) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.avatar.failed", {
      err: (err as Error).message?.slice(0, 200),
      isFinalAttempt,
    });
    if (isFinalAttempt) {
      await finishSegment(segmentId, { status: "failed", error: (err as Error).message?.slice(0, 300) });
      await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: (err as Error).message });
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

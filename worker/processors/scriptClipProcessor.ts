import path from "node:path";
import { promises as fs } from "node:fs";
import type { ScriptClipJobData } from "@/lib/jobs/queue";
import { logJob, setMediaJob } from "@/lib/jobs/db";
import { getServerSupabase } from "@/lib/supabase/server";
import { downloadYoutubeAudio, downloadYoutubeVideo } from "@/lib/media/ytdlp";
import { cutAudio, cutClip, normalizeClip } from "@/lib/media/ffmpeg";
import { ensureTmp, safeUnlink, uploadFile } from "@/lib/storage";
import { extractYoutubeVideoId } from "@/lib/youtube/url";
import type { JobAttemptInfo } from "../index";

// Pre-download one script-doc marker. Runs at ingest time (right after the
// user pastes the Google Doc) so the intake screen can show per-clip status
// before the user kicks off generate/render. The render processor reads
// clip_storage_url back instead of re-running yt-dlp, which makes renders
// dramatically faster AND lets the user see WHICH clip is broken if proxy
// rotation can't bypass the bot challenge.
//
// Idempotent: re-running on a marker that's already 'ready' just re-uploads
// — never re-downloads from YouTube. The retry endpoint exploits this.

export async function processScriptClipJob(
  data: ScriptClipJobData,
  attempt?: JobAttemptInfo,
): Promise<void> {
  const sb = getServerSupabase();
  const { projectId, mediaJobId, markerId } = data;
  const attemptsMade = attempt?.attemptsMade ?? 1;
  const attemptsAllowed = attempt?.attemptsAllowed ?? 1;
  const isFinalAttempt = attemptsMade >= attemptsAllowed;

  await setMediaJob(mediaJobId, {
    status: "running",
    progress: 5,
    metadata: { markerId, attemptsMade, attemptsAllowed },
  });

  // 1) Load the marker row. It must exist (the script-doc API created it
  // before enqueueing); a missing row means the user re-ingested the doc
  // and the previous job is now stale — bail without touching anything.
  const { data: marker, error: markerErr } = await sb
    .from("project_script_markers")
    .select("id, project_id, kind, text, ordinal, youtube_url, start_seconds, end_seconds, download_status, clip_storage_url, audio_storage_url")
    .eq("id", markerId)
    .maybeSingle();
  if (markerErr) throw new Error(`load marker: ${markerErr.message}`);
  if (!marker) {
    await setMediaJob(mediaJobId, {
      status: "completed",
      progress: 100,
      metadata: { markerId, skipped: "marker_not_found" },
    });
    return;
  }
  if (marker.project_id !== projectId) {
    throw new Error(`marker ${markerId} belongs to a different project`);
  }
  const url = (marker.youtube_url as string | null | undefined)?.trim();
  if (!url) {
    await markFailed(sb, markerId, "marker has no youtube_url");
    await setMediaJob(mediaJobId, {
      status: "completed",
      progress: 100,
      metadata: { markerId, skipped: "no_url" },
    });
    return;
  }
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) {
    await markFailed(sb, markerId, `unable to parse YouTube id from ${url.slice(0, 80)}`);
    await setMediaJob(mediaJobId, {
      status: "completed",
      progress: 100,
      metadata: { markerId, skipped: "bad_url" },
    });
    return;
  }

  const start = marker.start_seconds != null ? Number(marker.start_seconds) : 0;
  const end = marker.end_seconds != null ? Number(marker.end_seconds) : start + 8;
  const duration = Math.max(1, end - start);
  // intro_card markers carry their source audio too because the renderer
  // mixes that audio under the voiceover during the pre-roll. title_card
  // and title_card_clip clips reuse the voiceover audio (they're mid-script
  // illustrations, not standalone moments), so we save the AAC download.
  const needsAudio = marker.kind === "intro_card";

  // 2) Flip the row to 'downloading' so the UI shows progress. Clear any
  // stale error from a previous run. The download_updated_at update is
  // used by the UI to spot stuck rows.
  await setMarkerStatus(sb, markerId, "downloading", null);
  await setMediaJob(mediaJobId, { progress: 15 });

  const tmp = await ensureTmp(`script_clip/${markerId}`);
  let videoTmp: string | undefined;
  let audioTmp: string | undefined;
  let trimmedTmp: string | undefined;
  let normalizedTmp: string | undefined;
  let audioCutTmp: string | undefined;

  try {
    // 3) Download. downloadYoutubeVideo + downloadYoutubeAudio already
    // do proxy rotation on bot-challenge errors, so we get the same
    // protection the source-pool downloads have.
    const dlPromises: Array<Promise<{ outputPath: string }>> = [
      downloadYoutubeVideo({ url, outputDir: tmp, videoId }),
    ];
    if (needsAudio) {
      dlPromises.push(downloadYoutubeAudio({
        url, outputDir: tmp, videoId: `${videoId}_audio`,
      }));
    }
    const [videoDl, audioDl] = await Promise.all(dlPromises);
    videoTmp = videoDl.outputPath;
    if (audioDl) audioTmp = audioDl.outputPath;
    await setMediaJob(mediaJobId, { progress: 55 });

    // 4) Cut + normalize video to the canonical render shape (1280x720@30)
    // so the final concat can stream-copy it. The renderer's forced-clip
    // branch used to do this work on the hot path — moving it here means
    // a render with 5 doc clips doesn't pay for 5 yt-dlp downloads in
    // serial during the final pipeline.
    trimmedTmp = path.join(tmp, "trim.mp4");
    await cutClip({
      inputPath: videoTmp,
      outputPath: trimmedTmp,
      startSeconds: start,
      durationSeconds: duration,
      keepAudio: true,
    });
    normalizedTmp = path.join(tmp, "norm.mp4");
    await normalizeClip({
      inputPath: trimmedTmp,
      outputPath: normalizedTmp,
      width: 1280, height: 720, fps: 30,
      keepAudio: true,
      // Pin to the requested window length. cutClip above stream-copies
      // (-c:v copy), which can only cut on keyframe boundaries, so an 8s
      // request on YouTube footage (4-10s GOPs) overshoots to ~12s. Without
      // this pin the overshoot survives the normalize re-encode and the stored
      // intro clip is longer than asked (the "8s intro plays for 12s" bug).
      pinDurationSeconds: duration,
    });
    await setMediaJob(mediaJobId, { progress: 75 });

    // 5) Cut audio for intros only.
    let audioUploadUrl: string | null = null;
    if (needsAudio && audioTmp) {
      audioCutTmp = path.join(tmp, "audio.m4a");
      await cutAudio({
        inputPath: audioTmp,
        outputPath: audioCutTmp,
        startSeconds: start,
        durationSeconds: duration,
      });
      const audioDest = `projects/${projectId}/script_clips/${markerId}_${Date.now()}.m4a`;
      const audioUp = await uploadFile(audioCutTmp, audioDest, "audio/mp4");
      audioUploadUrl = audioUp.publicUrl;
    }

    // 6) Upload normalized clip.
    const clipDest = `projects/${projectId}/script_clips/${markerId}_${Date.now()}.mp4`;
    const clipUp = await uploadFile(normalizedTmp, clipDest, "video/mp4");
    await setMediaJob(mediaJobId, { progress: 95 });

    // 7) Mark ready. The two URLs are what the renderer reads on the hot
    // path; download_status drives the UI badge.
    const { error: updErr } = await sb
      .from("project_script_markers")
      .update({
        download_status: "ready",
        download_error: null,
        clip_storage_url: clipUp.publicUrl,
        audio_storage_url: audioUploadUrl,
        download_updated_at: new Date().toISOString(),
      })
      .eq("id", markerId);
    if (updErr) throw new Error(`mark ready: ${updErr.message}`);

    await logJob({ projectId, jobId: mediaJobId }, "script_clip.ready", {
      markerId,
      kind: marker.kind,
      ordinal: marker.ordinal,
      videoId,
      startSeconds: start,
      endSeconds: end,
      clipStorageUrl: clipUp.publicUrl,
      audioStorageUrl: audioUploadUrl,
    });

    await setMediaJob(mediaJobId, {
      status: "completed",
      progress: 100,
      metadata: {
        markerId,
        kind: marker.kind,
        clipStorageUrl: clipUp.publicUrl,
        audioStorageUrl: audioUploadUrl,
      },
    });
  } catch (e) {
    const message = (e as Error).message || "unknown error";
    await logJob({ projectId, jobId: mediaJobId }, "script_clip.failed", {
      markerId,
      kind: marker.kind,
      ordinal: marker.ordinal,
      attemptsMade,
      attemptsAllowed,
      err: message,
    });
    // Only flip the marker to 'failed' on the final BullMQ attempt — for
    // earlier attempts the row stays at 'downloading' so the UI doesn't
    // flash a misleading failure between retries.
    if (isFinalAttempt) {
      await markFailed(sb, markerId, message);
    }
    await setMediaJob(mediaJobId, {
      status: "failed",
      error: message,
      metadata: { markerId, attemptsMade, attemptsAllowed },
    });
    throw e;
  } finally {
    // Best-effort cleanup. Failures here are silent — leftover tmp files
    // get garbage-collected by the worker disk lifecycle.
    if (videoTmp) await safeUnlink(videoTmp);
    if (audioTmp) await safeUnlink(audioTmp);
    if (trimmedTmp) await safeUnlink(trimmedTmp);
    if (normalizedTmp) await safeUnlink(normalizedTmp);
    if (audioCutTmp) await safeUnlink(audioCutTmp);
    try { await fs.rmdir(tmp); } catch { /* ignore */ }
  }
}

async function setMarkerStatus(
  sb: ReturnType<typeof getServerSupabase>,
  markerId: string,
  status: "pending" | "downloading" | "ready" | "failed",
  error: string | null,
): Promise<void> {
  const { error: updErr } = await sb
    .from("project_script_markers")
    .update({
      download_status: status,
      download_error: error,
      download_updated_at: new Date().toISOString(),
    })
    .eq("id", markerId);
  if (updErr) throw new Error(`update marker status: ${updErr.message}`);
}

async function markFailed(
  sb: ReturnType<typeof getServerSupabase>,
  markerId: string,
  message: string,
): Promise<void> {
  await setMarkerStatus(sb, markerId, "failed", message.slice(0, 500));
}

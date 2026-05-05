import path from "node:path";
import type { ClipJobData } from "@/lib/jobs/queue";
import { logJob, setMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { getServerSupabase } from "@/lib/supabase/server";
import { maybeEnqueueMatch } from "./_shared";
import { cutClip, generateThumbnail } from "@/lib/media/ffmpeg";
import { ensureTmp, safeUnlink, uploadFile } from "@/lib/storage";
import { CLIP_DURATION_SECONDS, computeProjectClipCap, getEnv } from "@/lib/env";
import { labelClipFromThumbnail } from "@/lib/ai/gemini";

export async function processClipJob(data: ClipJobData): Promise<void> {
  const env = getEnv();
  const sb = getServerSupabase();
  const { projectId, mediaJobId, videoSourceId } = data;

  await setMediaJob(mediaJobId, { status: "running", progress: 5 });
  await setProjectStatus(projectId, "clipping");

  const { data: vs, error: vsErr } = await sb
    .from("video_sources").select("*").eq("id", videoSourceId).single();
  if (vsErr || !vs) throw new Error(`video_source missing: ${vsErr?.message}`);
  if (!vs.local_path) throw new Error("video_source has no local_path");
  if (!vs.duration_seconds || vs.duration_seconds <= 0) throw new Error("video_source has no duration");

  // Project clip cap is sized to the voiceover so the matcher has enough
  // footage candidates per timeline block without overshooting on storage.
  const { data: project } = await sb
    .from("projects").select("voiceover_duration_seconds").eq("id", projectId).single();
  const projectCap = computeProjectClipCap(project?.voiceover_duration_seconds ?? null);

  // Divide the project cap evenly across all sources so every downloaded
  // source contributes clips, instead of the first few hogging the budget.
  // Floor the source count to MAX_VIDEOS_PER_PROJECT so the very first clip
  // job (when only its own source row exists) doesn't grab the whole budget.
  const { count: sourceCountRaw } = await sb
    .from("video_sources").select("id", { count: "exact", head: true }).eq("project_id", projectId);
  const sourceCount = Math.max(env.MAX_VIDEOS_PER_PROJECT, sourceCountRaw ?? 1);
  const perSourceCap = Math.max(1, Math.ceil(projectCap / sourceCount));

  const { count: existingCount } = await sb
    .from("video_clips").select("id", { count: "exact", head: true }).eq("project_id", projectId);
  const projectRemaining = projectCap - (existingCount ?? 0);
  if (projectRemaining <= 0) {
    // Mark source as fully handled — otherwise it stays stuck at 'downloaded'
    // and looks like in-flight work to anything checking pipeline state.
    await sb.from("video_sources").update({ status: "clipped" }).eq("id", videoSourceId);
    await setMediaJob(mediaJobId, {
      status: "completed", progress: 100,
      metadata: { skipped: "project clip cap reached", projectCap, existingCount },
    });
    await maybeEnqueueMatch(projectId);
    return;
  }

  // Per-source cap, bounded by what the project still has budget for and
  // by the per-video ceiling.
  const targetCount = Math.min(env.MAX_CLIPS_PER_VIDEO, perSourceCap, projectRemaining);
  const timestamps = pickClipTimestamps(vs.duration_seconds, targetCount);

  await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
    "clip.plan", {
      count: timestamps.length,
      duration: vs.duration_seconds,
      projectCap,
      perSourceCap,
      sourceCount,
      existingCount,
    });

  const clipsTmp = await ensureTmp(`clips/${vs.youtube_video_id}`);
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < timestamps.length; i++) {
    const start = timestamps[i];
    const dur = CLIP_DURATION_SECONDS;
    const idx = String(i).padStart(3, "0");
    const clipLocal = path.join(clipsTmp, `${vs.youtube_video_id}_${idx}.mp4`);
    const thumbLocal = path.join(clipsTmp, `${vs.youtube_video_id}_${idx}.jpg`);

    try {
      await cutClip({ inputPath: vs.local_path, outputPath: clipLocal, startSeconds: start, durationSeconds: dur });
      await generateThumbnail({ inputPath: vs.local_path, outputPath: thumbLocal, atSeconds: start + 1 });

      const clipDest  = `projects/${projectId}/clips/${vs.youtube_video_id}_${idx}.mp4`;
      const thumbDest = `projects/${projectId}/clips/${vs.youtube_video_id}_${idx}.jpg`;
      // Run the upload and the Vision-labeling call concurrently — they're
      // independent and the labeler only needs the local thumbnail file.
      const [clipUp, thumbUp, visionLabels] = await Promise.all([
        uploadFile(clipLocal, clipDest, "video/mp4"),
        uploadFile(thumbLocal, thumbDest, "image/jpeg"),
        labelClipFromThumbnail(thumbLocal, vs.title ?? null).catch((e) => {
          // Labeling is best-effort. Log and continue with empty labels so
          // a transient Gemini failure doesn't fail the whole clip job.
          void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
            "clip.label.failed", { start, err: (e as Error).message });
          return null;
        }),
      ]);

      // Fold primarySubject + setting into the labels list — the matcher
       // only reads `labels`, and these two are the most useful descriptors.
      const labelSet = new Set<string>();
      if (visionLabels) {
        for (const l of visionLabels.labels) labelSet.add(l);
        if (visionLabels.primarySubject) labelSet.add(`subject: ${visionLabels.primarySubject}`);
        if (visionLabels.setting) labelSet.add(`setting: ${visionLabels.setting}`);
      }
      const labels = Array.from(labelSet);
      await sb.from("video_clips").insert({
        project_id: projectId,
        video_source_id: videoSourceId,
        start_time: start,
        end_time: start + dur,
        duration: dur,
        clip_url: clipUp.publicUrl,
        thumbnail_url: thumbUp.publicUrl,
        relevance_score: 0,
        labels,
        status: "ready",
      });
      succeeded++;
    } catch (e) {
      failed++;
      await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
        "clip.failed", { start, err: (e as Error).message });
    } finally {
      await safeUnlink(clipLocal);
      await safeUnlink(thumbLocal);
      await setMediaJob(mediaJobId, {
        progress: 5 + Math.floor(((i + 1) / timestamps.length) * 90),
      });
    }
  }

  if (succeeded === 0 && failed > 0) {
    await sb.from("video_sources").update({ status: "failed", error: "all clip cuts failed" }).eq("id", videoSourceId);
    await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: "all clips failed", metadata: { failed } });
    await maybeEnqueueMatch(projectId);
    return;
  }

  await sb.from("video_sources").update({ status: "clipped" }).eq("id", videoSourceId);
  await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { succeeded, failed } });

  await maybeEnqueueMatch(projectId);
}

// Sample evenly across the video, skipping the first 10 seconds (intros).
// MVP heuristic — keep it deterministic so users can re-run reliably.
export function pickClipTimestamps(duration: number, count: number): number[] {
  if (count <= 0) return [];
  const start = Math.min(10, duration - CLIP_DURATION_SECONDS - 1);
  const end = duration - CLIP_DURATION_SECONDS - 1;
  if (end <= start) return [Math.max(0, duration / 2 - CLIP_DURATION_SECONDS / 2)];
  if (count === 1) return [Math.floor((start + end) / 2)];
  const step = (end - start) / (count - 1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.max(0, Math.round((start + step * i) * 100) / 100));
  }
  return out;
}


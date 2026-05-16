import path from "node:path";
import type { ClipJobData } from "@/lib/jobs/queue";
import { logJob, setMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { getServerSupabase } from "@/lib/supabase/server";
import { maybeEnqueueMatch } from "./_shared";
import { cutClip, generateThumbnail } from "@/lib/media/ffmpeg";
import { detectSceneTimestamps, pickFromScenes } from "@/lib/media/scenes";
import { downloadToFile, ensureTmp, removeFiles, safeUnlink, uploadFile } from "@/lib/storage";
import { CLIP_DURATION_SECONDS, computeProjectClipCap, getEnv } from "@/lib/env";
import { labelClipFromThumbnail, isJunkCategory } from "@/lib/ai/gemini";

export async function processClipJob(data: ClipJobData): Promise<void> {
  const env = getEnv();
  const sb = getServerSupabase();
  const { projectId, mediaJobId, videoSourceId } = data;

  await setMediaJob(mediaJobId, { status: "running", progress: 5 });
  await setProjectStatus(projectId, "clipping");

  const { data: vs, error: vsErr } = await sb
    .from("video_sources").select("*").eq("id", videoSourceId).single();
  if (vsErr || !vs) throw new Error(`video_source missing: ${vsErr?.message}`);
  if (!vs.duration_seconds || vs.duration_seconds <= 0) throw new Error("video_source has no duration");

  // The R2 key for the source MP4. The clip worker may run on a different
  // machine than the download worker, so we cannot rely on local_path —
  // metadata.storage_path is the cross-machine handle. We resolve it now so
  // we fail fast if the upstream download skipped the upload.
  const sourceMeta = (vs.metadata as Record<string, unknown> | null) ?? {};
  const sourceStoragePath = sourceMeta.storage_path as string | undefined;
  if (!sourceStoragePath) throw new Error("video_source has no metadata.storage_path — re-download required");

  // Phase B: pull the source-intent provenance forward into every clip so
  // the matcher's deterministic +50 person-first bonus has a clip-level
  // signal to score against. We encode the trio as prefixed label tokens
  // (no schema migration required — video_clips.labels is already jsonb).
  // The matcher tokenises labels for the existing filler scorer, so
  // these tokens are harmless additions there too.
  const provenanceLabels: string[] = [];
  if (typeof sourceMeta.matched_query === "string" && sourceMeta.matched_query) {
    provenanceLabels.push(`matched_query: ${sourceMeta.matched_query}`);
  }
  if (typeof sourceMeta.intended_subject === "string" && sourceMeta.intended_subject) {
    provenanceLabels.push(`intended_subject: ${sourceMeta.intended_subject}`);
  }
  if (typeof sourceMeta.source_intent === "string" && sourceMeta.source_intent) {
    provenanceLabels.push(`source_intent: ${sourceMeta.source_intent}`);
  }

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
      metadata: {
        videoSourceId,
        skipped_reason: "project_clip_cap_reached",
        skipped: "project clip cap reached",
        projectCap,
        existingCount,
      },
    });
    await maybeEnqueueMatch(projectId);
    return;
  }

  // Per-source cap, bounded by what the project still has budget for and
  // by the per-video ceiling.
  const targetCount = Math.min(env.MAX_CLIPS_PER_VIDEO, perSourceCap, projectRemaining);

  // Cap targetCount at what the source can physically yield as
  // non-overlapping windows. Without this, short sources (e.g. 20s)
  // got asked for 11 clips and `pickClipTimestamps` jammed them into
  // an overlapping mess that wasted the project budget on duplicates.
  const usableSeconds = Math.max(0, vs.duration_seconds - 10 - CLIP_DURATION_SECONDS - 1);
  const minStride = CLIP_DURATION_SECONDS;
  const physicalMax = Math.max(1, Math.floor(usableSeconds / minStride) + 1);
  const cappedCount = Math.min(targetCount, physicalMax);

  // Pull the source MP4 from R2 to local tmp. Done lazily — only once we know
  // the cap hasn't already been reached, so a no-op clip job doesn't pay for
  // the download. Cleaned up in the finally below.
  const sourceTmp = await ensureTmp(`source/${vs.youtube_video_id}`);
  const sourceLocal = path.join(sourceTmp, `${vs.youtube_video_id}.mp4`);
  await downloadToFile(sourceStoragePath, sourceLocal);

  try {

  // Try scene-detection first — cuts at visual boundaries beat blind
  // uniform sampling (no half-shots, cleaner thumbnails). Fall back to
  // the uniform sampler if scene-detect returns too few candidates or
  // fails outright (older codecs, encoded-only streams, etc).
  let timestamps: number[] = [];
  let timestampSource: "scene_detect" | "uniform" | "scene_detect_then_uniform" = "uniform";
  let sceneCount = 0;
  try {
    const scenes = await detectSceneTimestamps({ inputPath: sourceLocal });
    sceneCount = scenes.length;
    const fromScenes = pickFromScenes({
      scenes,
      duration: vs.duration_seconds,
      targetCount: cappedCount,
      clipDurationSeconds: CLIP_DURATION_SECONDS,
      minGapSeconds: 20,
      skipLeadSeconds: 10,
    });
    if (fromScenes.length >= cappedCount) {
      timestamps = fromScenes;
      timestampSource = "scene_detect";
    } else if (fromScenes.length > 0) {
      // Scene-detect found *some* boundaries but not enough. Pad with
      // uniform samples that don't collide with the scene picks.
      const uniform = pickClipTimestamps(vs.duration_seconds, cappedCount);
      const merged = mergeWithMinGap([...fromScenes, ...uniform], minStride, cappedCount);
      timestamps = merged;
      timestampSource = "scene_detect_then_uniform";
    } else {
      timestamps = pickClipTimestamps(vs.duration_seconds, cappedCount);
      timestampSource = "uniform";
    }
  } catch (e) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
      "clip.scene_detect.failed", { err: (e as Error).message });
    timestamps = pickClipTimestamps(vs.duration_seconds, cappedCount);
    timestampSource = "uniform";
  }

  // Reserve a head-of-source window (t=0) as a dedicated intro candidate.
  // The general-purpose timestamps above all skip the first 10 s to avoid
  // channel bumpers, which means the matcher's intro selector has nothing
  // from the actual opening shot to choose from — so the rendered intro
  // ended up being a mid-source clip with a narrator's voice instead of
  // the celebrity's. We prepend index 0 here, dedup against any general
  // timestamp that happens to also fall at 0, and tag the resulting clip
  // so the matcher can prefer it.
  const INTRO_CANDIDATE_LABEL = "intro_candidate";
  const introHeadStart = 0;
  const introTimestampIndex = (() => {
    if (vs.duration_seconds < CLIP_DURATION_SECONDS + 1) return -1;
    if (timestamps.some((t) => Math.abs(t - introHeadStart) < 0.5)) return -1;
    timestamps.unshift(introHeadStart);
    return 0;
  })();

  await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
    "clip.plan", {
      count: timestamps.length,
      requested: targetCount,
      cappedCount,
      duration: vs.duration_seconds,
      projectCap,
      perSourceCap,
      sourceCount,
      existingCount,
      timestampSource,
      sceneCount,
      introHeadAdded: introTimestampIndex >= 0,
    });

  const clipsTmp = await ensureTmp(`clips/${vs.youtube_video_id}`);
  let succeeded = 0;
  let failed = 0;
  let droppedJunk = 0;
  let processed = 0;
  const junkCategoryCounts: Record<string, number> = {};

  // Pin the source on the job up front so the UI can attribute "currently
  // clipping" to a video name even before the first iteration finishes.
  await setMediaJob(mediaJobId, {
    metadata: { videoSourceId, totalClips: timestamps.length },
  });

  // Per-clip pipeline. Each invocation is independent — runs cut + thumbnail
  // + label + upload for one timestamp. Multiple invocations run concurrently
  // (CLIP_PIPELINE_CONCURRENCY) to overlap ffmpeg / Gemini / storage I/O. The
  // labeler runs in parallel with upload so the slow Gemini call doesn't
  // block the upload from starting; if the labeler decides the frame is junk
  // we delete the just-uploaded objects (cheap, rare).
  async function processOne(i: number, start: number): Promise<void> {
    const isIntroHead = i === introTimestampIndex;
    const dur = CLIP_DURATION_SECONDS;
    const idx = String(i).padStart(3, "0");
    const clipLocal = path.join(clipsTmp, `${vs.youtube_video_id}_${idx}.mp4`);
    const thumbLocal = path.join(clipsTmp, `${vs.youtube_video_id}_${idx}.jpg`);
    const clipDest  = `projects/${projectId}/clips/${vs.youtube_video_id}_${idx}.mp4`;
    const thumbDest = `projects/${projectId}/clips/${vs.youtube_video_id}_${idx}.jpg`;

    try {
      // ffmpeg cut + thumbnail in parallel — both read the same source file
      // (input-side seek, no decoding overlap), and on a typical machine the
      // pair finishes faster than running them serially.
      await Promise.all([
        cutClip({ inputPath: sourceLocal, outputPath: clipLocal, startSeconds: start, durationSeconds: dur }),
        generateThumbnail({ inputPath: sourceLocal, outputPath: thumbLocal, atSeconds: start + 1 }),
      ]);

      // Kick off labeling and upload in parallel. Labeling is the slow leg
      // (Gemini Vision, retries on 503); upload is bandwidth-bound. They
      // share no state — once both files exist on disk, both are safe to
      // start. Labeling failures degrade gracefully to null.
      const labelPromise = labelClipFromThumbnail(thumbLocal, vs.title ?? null).catch((e) => {
        void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
          "clip.label.failed", { start, err: (e as Error).message });
        return null;
      });
      const uploadPromise = Promise.all([
        uploadFile(clipLocal, clipDest, "video/mp4"),
        uploadFile(thumbLocal, thumbDest, "image/jpeg"),
      ]);

      const [visionLabels, [clipUp, thumbUp]] = await Promise.all([labelPromise, uploadPromise]);

      if (visionLabels && isJunkCategory(visionLabels.visualCategory) && !isIntroHead) {
        droppedJunk++;
        junkCategoryCounts[visionLabels.visualCategory] =
          (junkCategoryCounts[visionLabels.visualCategory] ?? 0) + 1;
        await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
          "clip.dropped.junk", {
            start,
            visualCategory: visionLabels.visualCategory,
            primarySubject: visionLabels.primarySubject,
          });
        // The clip and thumbnail were uploaded in parallel with labeling;
        // now that we know it's junk, remove the storage objects so we
        // don't pay to keep frames the matcher will never use.
        await removeFiles([clipDest, thumbDest]);
        return;
      }

      // Fold primarySubject + setting into the labels list — the matcher
      // only reads `labels`, and these two are the most useful descriptors.
      const labelSet = new Set<string>();
      if (visionLabels) {
        for (const l of visionLabels.labels) labelSet.add(l);
        if (visionLabels.primarySubject) labelSet.add(`subject: ${visionLabels.primarySubject}`);
        if (visionLabels.setting) labelSet.add(`setting: ${visionLabels.setting}`);
      }
      if (isIntroHead) labelSet.add(INTRO_CANDIDATE_LABEL);
      // Phase B provenance — same for every clip from this source.
      for (const p of provenanceLabels) labelSet.add(p);
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
      processed++;
      await setMediaJob(mediaJobId, {
        progress: 5 + Math.floor((processed / timestamps.length) * 90),
        metadata: {
          videoSourceId,
          totalClips: timestamps.length,
          currentClip: { index: processed, total: timestamps.length, startSeconds: start },
        },
      });
    }
  }

  // Lane-based concurrency: each lane pulls the next index off a shared
  // cursor, so a slow clip on one lane doesn't hold up the others. This
  // is the dominant speedup — under serial execution the slowest step
  // (usually labeling on a 503 spike) gates everything.
  const concurrency = Math.max(1, Math.min(env.CLIP_PIPELINE_CONCURRENCY, timestamps.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= timestamps.length) return;
        await processOne(i, timestamps[i]);
      }
    }),
  );

  if (succeeded === 0 && failed > 0) {
    await sb.from("video_sources").update({ status: "failed", error: "all clip cuts failed" }).eq("id", videoSourceId);
    await setMediaJob(mediaJobId, {
      status: "failed", progress: 100, error: "all clips failed",
      metadata: {
        videoSourceId,
        totalClips: timestamps.length,
        succeeded,
        failed,
        droppedJunk,
        junkCategoryCounts,
      },
    });
    await maybeEnqueueMatch(projectId);
    return;
  }

  await sb.from("video_sources").update({ status: "clipped" }).eq("id", videoSourceId);
  await setMediaJob(mediaJobId, {
    status: "completed", progress: 100,
    metadata: {
      videoSourceId,
      totalClips: timestamps.length,
      succeeded,
      failed,
      droppedJunk,
      junkCategoryCounts,
    },
  });
  // Per-source summary so we can monitor the junk-filter rate across runs.
  // High droppedJunk on one source = noisy YouTube upload; high droppedJunk
  // across many sources = the labeler is over-classifying as junk.
  await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
    "clip.summary", {
      attempted: timestamps.length,
      succeeded,
      failed,
      droppedJunk,
      junkCategoryCounts,
    });

  await maybeEnqueueMatch(projectId);

  } finally {
    // Source MP4 only lives on disk for the duration of this clip job.
    // Drop it whether we succeeded, failed, or threw — the worker's tmp
    // dir is not a cache.
    await safeUnlink(sourceLocal);
  }
}

// Sample evenly across the video, skipping the first 10 seconds (intros).
// Used as the last-resort fallback when scene detection fails or yields too
// few candidates.
//
// Enforces a minimum stride of CLIP_DURATION_SECONDS so consecutive 5-s
// clips never overlap. If `count` is too high to fit non-overlapping
// windows in the usable range, we silently cap it — better to return
// 4 clean clips than 11 overlapping near-duplicates.
export function pickClipTimestamps(duration: number, count: number): number[] {
  if (count <= 0) return [];
  const start = Math.min(10, duration - CLIP_DURATION_SECONDS - 1);
  const end = duration - CLIP_DURATION_SECONDS - 1;
  if (end <= start) return [Math.max(0, duration / 2 - CLIP_DURATION_SECONDS / 2)];
  // Cap count so step >= CLIP_DURATION_SECONDS — no overlapping windows.
  const span = end - start;
  const maxNonOverlapping = Math.max(1, Math.floor(span / CLIP_DURATION_SECONDS) + 1);
  const n = Math.min(count, maxNonOverlapping);
  if (n === 1) return [Math.floor((start + end) / 2)];
  const step = span / (n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.max(0, Math.round((start + step * i) * 100) / 100));
  }
  return out;
}

// Merge two timestamp lists into a sorted, dedup'd, gap-respecting list.
// Used when scene-detect returned partial coverage and we want to fill in
// the gaps with uniform-sampled timestamps without colliding with the
// scene picks.
export function mergeWithMinGap(timestamps: number[], minGap: number, max: number): number[] {
  const sorted = Array.from(new Set(timestamps)).sort((a, b) => a - b);
  const out: number[] = [];
  let last = -Infinity;
  for (const t of sorted) {
    if (t - last >= minGap) {
      out.push(t);
      last = t;
      if (out.length >= max) break;
    }
  }
  return out;
}


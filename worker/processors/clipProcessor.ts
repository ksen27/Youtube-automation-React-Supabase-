import path from "node:path";
import type { ClipJobData } from "@/lib/jobs/queue";
import { logJob, setMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { getServerSupabase } from "@/lib/supabase/server";
import { maybeEnqueueMatch } from "./_shared";
import { cutClip, generateThumbnail } from "@/lib/media/ffmpeg";
import { detectSceneTimestamps, pickFromScenes, type SceneClipWindow } from "@/lib/media/scenes";
import { downloadToFile, ensureTmp, removeFiles, safeUnlink, uploadFile } from "@/lib/storage";
import {
  CLIP_DURATION_DEFAULT_SECONDS,
  CLIP_DURATION_MAX_SECONDS,
  CLIP_DURATION_MIN_SECONDS,
  computeProjectClipCap,
  getEnv,
} from "@/lib/env";
import { labelClipFromThumbnail, isJunkCategory } from "@/lib/ai/gemini";
import { verifyClipFrameCombined, detectSourceWatermark } from "@/lib/ai/verify";
import { lookupReference } from "@/lib/ai/face-references";

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
    .from("projects").select("voiceover_duration_seconds, intro_source_youtube_url").eq("id", projectId).single();
  const projectCap = computeProjectClipCap(project?.voiceover_duration_seconds ?? null);

  // Load the project's main celebrity once. Used by the per-clip face-
  // verification pass below to check each cut's thumbnail against the
  // Wikipedia reference photo. Without it, a 9-minute source whose video
  // thumbnail shows the celebrity passes analyze but produces cuts that
  // only contain the co-host — the failure the user reported on blocks
  // 31/32/34 (Walliams apology blocks filled with Cowell footage).
  let mainCelebrityForVerify: string | null = null;
  // Reference photo for the celebrity, resolved ONCE per clip job. The
  // combined per-frame check needs it to answer "is the celebrity present".
  // Null when face-verify is off, no celebrity, or no reference resolved.
  let celebrityReferenceUrl: string | null = null;
  if (env.CLIP_FACE_VERIFY_ENABLED) {
    const { data: entRows } = await sb
      .from("project_entities")
      .select("value, confidence")
      .eq("project_id", projectId)
      .eq("type", "celebrity")
      .order("confidence", { ascending: false })
      .limit(1);
    const top = (entRows ?? [])[0];
    mainCelebrityForVerify = top?.value ? String(top.value).trim() : null;

    // PER-SOURCE PERSON OVERRIDE. The pipeline now builds a separate source pool
    // PER person (the celebrity AND each heavily-featured secondary like David
    // Walliams). A clip cut from a David Walliams source must be face-checked
    // against DAVID WALLIAMS, not the project celebrity — otherwise a Walliams
    // clip that shows only a child (Walliams off-frame) is asked "is Simon
    // Cowell here?", the answer is merely "uncertain" (not a confident "no"),
    // and the off-target clip ships. We resolve the person this source was
    // discovered under via youtube_search_results.metadata.entity_value and,
    // when it's a real person with a reference photo, verify against THEM.
    // Falls back to the project celebrity when the source isn't person-specific.
    const { data: srcRow } = await sb
      .from("youtube_search_results")
      .select("metadata")
      .eq("project_id", projectId)
      .eq("youtube_video_id", vs.youtube_video_id)
      .limit(1)
      .maybeSingle();
    const srcMeta = (srcRow?.metadata as Record<string, unknown> | null) ?? {};
    const srcEntityValue =
      typeof srcMeta.entity_value === "string" ? srcMeta.entity_value.trim() : "";
    const srcEntityType =
      typeof srcMeta.entity_type === "string" ? srcMeta.entity_type : "";
    const isPersonSource =
      srcEntityValue &&
      (srcEntityType === "celebrity" || srcEntityType === "related_person" || srcEntityType === "person");
    if (isPersonSource && srcEntityValue.toLowerCase() !== (mainCelebrityForVerify ?? "").toLowerCase()) {
      // This source belongs to a specific (secondary) person — verify against them.
      mainCelebrityForVerify = srcEntityValue;
    }

    if (mainCelebrityForVerify) {
      const ref = await lookupReference(projectId, "person", mainCelebrityForVerify).catch(() => null);
      celebrityReferenceUrl = ref?.reference_url ?? null;
    }
  }
  // When the user supplied an explicit intro URL + timestamp, the renderer
  // cuts the intro directly from that source and ignores anything tagged
  // intro_candidate in the matched pool. Skipping the t=0 candidate here
  // saves one Gemini vision call per source and stops the matcher from
  // having to score a candidate it will never use.
  const userIntroProvided = !!(project?.intro_source_youtube_url as string | null | undefined)?.trim();

  // Per-source clip quota.
  //
  // Two signals drive the quota:
  //   1. Voiceover duration — `projectCap` is already computed from this
  //      via computeProjectClipCap (footageBlocks × oversampling). Longer
  //      narration → larger project budget.
  //   2. Number of selected sources — divide the project budget by the
  //      source count so every selected source gets a guaranteed share.
  //
  // The previous version used a project-wide ledger: whichever clip jobs
  // ran first consumed the project cap, and the last source could land
  // with zero clips because earlier jobs ate everything ("project clip
  // budget already met" skip). That defeated the purpose of letting the
  // user pick multiple sources for variety — a 7th selected source could
  // contribute nothing.
  //
  // New rule: each source's quota is computed UP FRONT from the source
  // count, and a source is only skipped when ITS OWN quota is already
  // filled (e.g. on re-runs). The project may end up slightly over the
  // soft cap when ceil-divided quotas don't add up exactly to projectCap,
  // which is fine — projectCap is sized via oversampling so a few extra
  // clips just give the matcher more candidates.
  const { count: sourceCountRaw } = await sb
    .from("video_sources").select("id", { count: "exact", head: true }).eq("project_id", projectId);
  // Floor the source count to MAX_VIDEOS_PER_PROJECT so the very first
  // clip job (when only its own source row exists) doesn't grab the
  // whole budget — preserves the pre-existing safety guard.
  const sourceCount = Math.max(env.MAX_VIDEOS_PER_PROJECT, sourceCountRaw ?? 1);
  const perSourceQuota = Math.max(1, Math.ceil(projectCap / sourceCount));

  // Count clips THIS source has already produced FOR THIS PROJECT (not
  // the whole project, not cross-project). A source is skipped ONLY
  // when it has already met its own quota — that happens on retry /
  // re-run, never on first pass.
  //
  // The video_sources row is upsert-by-youtube_video_id (see
  // downloadProcessor), so the same row is reused across projects that
  // pick the same YouTube URL. Without scoping by project_id, this
  // count would include video_clips left over from prior projects that
  // used the same source — sources that have never produced a single
  // clip for THIS project would skip with "source quota already met".
  const { count: existingForThisSource } = await sb
    .from("video_clips").select("id", { count: "exact", head: true })
    .eq("video_source_id", videoSourceId)
    .eq("project_id", projectId);
  const remainingForThisSource = perSourceQuota - (existingForThisSource ?? 0);
  if (remainingForThisSource <= 0) {
    // This source already produced its quota — typical on a retry. Mark
    // it clipped and move on.
    await sb.from("video_sources").update({ status: "clipped" }).eq("id", videoSourceId);
    await setMediaJob(mediaJobId, {
      status: "completed", progress: 100,
      metadata: {
        videoSourceId,
        skipped_reason: "source_quota_already_met",
        skipped: "source quota already met",
        perSourceQuota,
        existingForThisSource,
      },
    });
    await maybeEnqueueMatch(projectId);
    return;
  }

  // Per-source target, bounded by what THIS source still owes us and by
  // the per-video ceiling. We deliberately do NOT bound by remaining
  // project budget here — that's what caused the "7th source skipped to
  // zero" behaviour. Every source is guaranteed its quota slice.
  const targetCount = Math.min(env.MAX_CLIPS_PER_VIDEO, remainingForThisSource);

  // Cap targetCount at what the source can physically yield as
  // non-overlapping windows. Without this, short sources (e.g. 20s)
  // got asked for 11 clips and `pickClipTimestamps` jammed them into
  // an overlapping mess that wasted the project budget on duplicates.
  // We size the stride against MIN clip duration since scene-snapped
  // clips can be as short as MIN — using DEFAULT here would under-cap
  // on fast-cut sources.
  const usableSeconds = Math.max(0, vs.duration_seconds - 10 - CLIP_DURATION_MIN_SECONDS - 1);
  const minStride = CLIP_DURATION_MIN_SECONDS;
  const physicalMax = Math.max(1, Math.floor(usableSeconds / minStride) + 1);
  // `cappedCount` is how many SURVIVING clips we want from this source.
  const cappedCount = Math.min(targetCount, physicalMax);
  // Backfill reserve. We size the CANDIDATE pool so clips lost to ffmpeg
  // failure / dirty-footage / wrong-person / junk drops can be replaced,
  // keeping the surviving count near `cappedCount` — WITHOUT cutting the
  // whole source.
  //
  // History: a previous version set poolCount = physicalMax (the source's
  // FULL non-overlapping window set) so that very high-drop sources could
  // keep trying alternative windows until the target survived. That had two
  // bad side effects the user reported:
  //   1. On long sources physicalMax is huge (a 25-min source at a 5 s MIN
  //      stride ≈ 300 windows). totalClips on the job metadata showed that
  //      enormous number ("ready clips count is very large"), and the lane
  //      loop ground through hundreds of windows — each costing an ffmpeg
  //      cut + thumbnail + up to 4 Gemini Vision calls — so the clip step
  //      crawled even when the source was perfectly usable.
  //   2. Because every loss triggered another reserve window, a source whose
  //      gates were merely a bit strict attempted far more windows than it
  //      ever needed.
  //
  // New rule: the pool is the target plus a BOUNDED reserve. We take the
  // larger of the proportional reserve (cappedCount × (1 + buffer)) and a
  // small absolute floor, then cap it at CLIP_MAX_POOL_FACTOR × cappedCount
  // and at physicalMax. This still absorbs a normal drop rate (the lanes
  // early-stop at `succeeded >= cappedCount`, so clean sources never cut the
  // full reserve) but stops a long source from exploding into hundreds of
  // candidate windows.
  const reserveTarget = Math.max(
    cappedCount + 2,
    Math.ceil(cappedCount * (1 + env.CLIP_BACKFILL_BUFFER_FACTOR)),
  );
  const poolCount = Math.min(
    physicalMax,
    Math.ceil(cappedCount * env.CLIP_MAX_POOL_FACTOR),
    reserveTarget,
  );

  // Pull the source MP4 from R2 to local tmp. Done lazily — only once we know
  // the cap hasn't already been reached, so a no-op clip job doesn't pay for
  // the download. Cleaned up in the finally below.
  const sourceTmp = await ensureTmp(`source/${vs.youtube_video_id}`);
  const sourceLocal = path.join(sourceTmp, `${vs.youtube_video_id}.mp4`);
  await downloadToFile(sourceStoragePath, sourceLocal);

  try {

  // ---- WHOLE-SOURCE WATERMARK / CAPTION GATE ---------------------------
  // Decide ONCE per source whether the entire video carries persistent
  // burned-in graphics: a logo / channel bug / site watermark (e.g. a
  // "HOLLYWOOD SECRETS" corner logo, a "werewolftvseries.com" URL strip), OR
  // a baked-in caption / subtitle track (word-by-word "GREAT"-style pop-ups
  // synced to speech). Both run for the WHOLE video, so the per-clip
  // cleanliness gate is the wrong tool — it samples only 3 frames of a short
  // clip, and (a) Gemini routinely misses a small corner logo on some of
  // them, while (b) word-by-word captions show DIFFERENT text each frame so
  // they read as a transient lower-third the majority rule deliberately
  // keeps. Here we sample frames spread across the WHOLE runtime; a graphic
  // present on most of them is persistent, and we SKIP the entire source
  // (per the "skip the whole source" decision) rather than cut clips from it.
  //
  // Gated behind CLIP_CLEAN_FOOTAGE_ENABLED (same toggle as the per-clip
  // clean gate — this is the source-level half of the same feature).
  if (env.CLIP_CLEAN_FOOTAGE_ENABLED) {
    const SAMPLE_FRAMES = 5;
    // Sample inside [10s, duration-2s] to skip intro title cards and end
    // screens, which would otherwise bias the vote toward "branded".
    const lead = 10;
    const tail = 2;
    const span = Math.max(0, (vs.duration_seconds - tail) - lead);
    const wmFrameDests: string[] = [];
    const wmFrameUrls: string[] = [];
    if (span > 0) {
      for (let i = 0; i < SAMPLE_FRAMES; i++) {
        // Evenly spaced across the usable span (midpoints of N buckets).
        const at = lead + Math.round((span * (i + 0.5)) / SAMPLE_FRAMES);
        const localPath = path.join(sourceTmp, `${vs.youtube_video_id}_wm_${i}.jpg`);
        const dest = `projects/${projectId}/clips/${vs.youtube_video_id}_wm_${i}.jpg`;
        try {
          await generateThumbnail({ inputPath: sourceLocal, outputPath: localPath, atSeconds: at });
          const up = await uploadFile(localPath, dest, "image/jpeg");
          wmFrameDests.push(dest);
          wmFrameUrls.push(up.publicUrl);
        } catch (e) {
          void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
            "clip.source_watermark.frame_failed", { at, err: (e as Error).message?.slice(0, 120) });
        } finally {
          await safeUnlink(localPath);
        }
      }
    }

    if (wmFrameUrls.length > 0) {
      const wm = await detectSourceWatermark({ frameUrls: wmFrameUrls });
      await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
        "clip.source_watermark.checked", {
          framesChecked: wm.framesChecked,
          logoFrames: wm.logoFrames,
          captionFrames: wm.captionFrames,
          watermarked: wm.watermarked,
          reasonClass: wm.reasonClass,
          artifact: wm.artifact,
        });
      // The sampled frames were uploaded only for this check — remove them
      // whether or not we skip, so we don't pay to keep them in storage.
      if (wmFrameDests.length > 0) await removeFiles(wmFrameDests);

      if (wm.watermarked) {
        // Whole source carries a persistent burned-in logo/watermark OR a
        // baked-in caption track — skip it. Cut no clips. The source is
        // marked clipped (not failed) so the run proceeds with the other
        // sources; matching will fill the timeline from clean footage.
        const what = wm.reasonClass === "caption"
          ? "burned-in captions"
          : "logo/watermark";
        await sb.from("video_sources").update({ status: "clipped" }).eq("id", videoSourceId);
        await setMediaJob(mediaJobId, {
          status: "completed", progress: 100,
          metadata: {
            videoSourceId,
            skipped_reason: wm.reasonClass === "caption"
              ? "source_captioned"
              : "source_watermarked",
            skipped: `whole source has ${what} (${wm.artifact || "on majority of frames"})`,
            framesChecked: wm.framesChecked,
            logoFrames: wm.logoFrames,
            captionFrames: wm.captionFrames,
          },
        });
        await maybeEnqueueMatch(projectId);
        return;
      }
    }
  }

  // Try scene-detection first — cuts at visual boundaries beat blind
  // uniform sampling (no half-shots, cleaner thumbnails). Fall back to
  // the uniform sampler if scene-detect returns too few candidates or
  // fails outright (older codecs, encoded-only streams, etc).
  //
  // Windows carry both start and duration so the clip can end on the
  // next scene boundary instead of bleeding into the following shot.
  let windows: SceneClipWindow[] = [];
  let timestampSource: "scene_detect" | "uniform" | "scene_detect_then_uniform" = "uniform";
  let sceneCount = 0;
  try {
    const scenes = await detectSceneTimestamps({ inputPath: sourceLocal });
    sceneCount = scenes.length;
    // Generate `poolCount` (target + reserve) candidate windows, not just the
    // target — the surplus is the backfill reserve consumed below when clips
    // fail or are dropped.
    const fromScenes = pickFromScenes({
      scenes,
      duration: vs.duration_seconds,
      targetCount: poolCount,
      minDuration: CLIP_DURATION_MIN_SECONDS,
      maxDuration: CLIP_DURATION_MAX_SECONDS,
      minGapSeconds: 20,
      skipLeadSeconds: 10,
    });
    if (fromScenes.length >= poolCount) {
      windows = fromScenes;
      timestampSource = "scene_detect";
    } else if (fromScenes.length > 0) {
      // Scene-detect found *some* boundaries but not enough. Pad with
      // uniform samples (default duration) that don't collide with the
      // scene picks.
      const uniform = pickClipTimestamps(vs.duration_seconds, poolCount)
        .map((t) => ({ start: t, duration: CLIP_DURATION_DEFAULT_SECONDS }));
      windows = mergeWithMinGap([...fromScenes, ...uniform], minStride, poolCount);
      timestampSource = "scene_detect_then_uniform";
    } else {
      windows = pickClipTimestamps(vs.duration_seconds, poolCount)
        .map((t) => ({ start: t, duration: CLIP_DURATION_DEFAULT_SECONDS }));
      timestampSource = "uniform";
    }
  } catch (e) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
      "clip.scene_detect.failed", { err: (e as Error).message });
    windows = pickClipTimestamps(vs.duration_seconds, poolCount)
      .map((t) => ({ start: t, duration: CLIP_DURATION_DEFAULT_SECONDS }));
    timestampSource = "uniform";
  }

  // Reserve a head-of-source window as a dedicated intro candidate.
  // The general-purpose timestamps above all skip the first 10 s to avoid
  // channel bumpers, which means the matcher's intro selector has nothing
  // from the actual opening shot to choose from — so the rendered intro
  // ended up being a mid-source clip with a narrator's voice instead of
  // the celebrity's. We prepend this window here, dedup against any general
  // timestamp that happens to fall nearby, and tag the resulting clip so the
  // matcher can prefer it.
  //
  // We do NOT start this window at t=0. Many of these sources open with a
  // full-screen DISCLAIMER / "viewer discretion" card that runs ~10-15 s
  // before the first real shot; a t=0 intro window cut straight from that
  // card put the disclaimer in the 0:00–0:06 intro slot (and, when the
  // clean gate missed the textured card, leaked it into scene footage too).
  // Starting the intro head a bit later lands it past the disclaimer on the
  // actual opening footage, while still being early enough to be a genuine
  // "opening shot" with the celebrity's intro audio. Clamped for short
  // sources so the window never runs past the end.
  const INTRO_CANDIDATE_LABEL = "intro_candidate";
  // Marks a clip that may serve as the intro (audio shot) but must NEVER be
  // reused as regular scene footage — e.g. a disclaimer / text card that
  // failed the clean-footage gate. The matcher excludes these from the scene
  // pool. See dropForDirty handling for intro-head clips below.
  const NOT_SCENE_ELIGIBLE_LABEL = "not_scene_eligible";
  // Offset past the opening disclaimer/bumper. 12 s clears the typical
  // disclaimer card; on a source too short to host a clip at 12 s we fall
  // back to the latest start that still fits a full default-length clip
  // (and t=0 if even that doesn't fit — a source that short has no room for
  // a disclaimer anyway).
  const INTRO_HEAD_PREFERRED_OFFSET = 12;
  const introHeadLatestFit = Math.max(
    0,
    vs.duration_seconds - CLIP_DURATION_DEFAULT_SECONDS - 1,
  );
  const introHeadStart = Math.min(INTRO_HEAD_PREFERRED_OFFSET, introHeadLatestFit);
  const introTimestampIndex = (() => {
    if (userIntroProvided) return -1;
    if (vs.duration_seconds < CLIP_DURATION_MIN_SECONDS + 1) return -1;
    if (windows.some((w) => Math.abs(w.start - introHeadStart) < 0.5)) return -1;
    windows.unshift({ start: introHeadStart, duration: CLIP_DURATION_DEFAULT_SECONDS });
    return 0;
  })();

  await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
    "clip.plan", {
      count: windows.length,
      requested: targetCount,
      cappedCount,
      poolCount,
      duration: vs.duration_seconds,
      projectCap,
      perSourceQuota,
      sourceCount,
      existingForThisSource,
      timestampSource,
      sceneCount,
      introHeadAdded: introTimestampIndex >= 0,
      avgClipDuration: windows.length
        ? Math.round((windows.reduce((s, w) => s + w.duration, 0) / windows.length) * 100) / 100
        : 0,
    });

  const clipsTmp = await ensureTmp(`clips/${vs.youtube_video_id}`);
  let succeeded = 0;
  let failed = 0;
  let droppedJunk = 0;
  // Reason-split drop counters (droppedJunk is the sum). These let the
  // clip.summary log show WHICH gate is costing the most clips on a source:
  //   droppedLabelJunk → the Vision labeler tagged the frame a junk category
  //   droppedDirty     → clean-footage gate (logo / watermark / on-screen text)
  //   droppedWrongPerson → face gate (confirmed not the target person)
  // A source ending short with high droppedDirty/droppedWrongPerson is the
  // signal that the quality gates — not the source length — capped the yield.
  let droppedLabelJunk = 0;
  let droppedDirty = 0;
  let droppedWrongPerson = 0;
  let processed = 0;
  const junkCategoryCounts: Record<string, number> = {};

  // Pin the source on the job up front so the UI can attribute "currently
  // clipping" to a video name even before the first iteration finishes.
  await setMediaJob(mediaJobId, {
    metadata: { videoSourceId, totalClips: windows.length },
  });

  // Per-clip pipeline. Each invocation is independent — runs cut + thumbnail
  // + label + upload for one timestamp. Multiple invocations run concurrently
  // (CLIP_PIPELINE_CONCURRENCY) to overlap ffmpeg / Gemini / storage I/O. The
  // labeler runs in parallel with upload so the slow Gemini call doesn't
  // block the upload from starting; if the labeler decides the frame is junk
  // we delete the just-uploaded objects (cheap, rare).
  async function processOne(i: number, window: SceneClipWindow): Promise<void> {
    const isIntroHead = i === introTimestampIndex;
    const start = window.start;
    const dur = window.duration;
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
        droppedLabelJunk++;
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
      // `subject_present:` is the gating signal for the matcher's +50
      // person-first bonus: only clips where the labeler said "yes the
      // title's person is visible" win person-anchored blocks.
      const labelSet = new Set<string>();
      if (visionLabels) {
        for (const l of visionLabels.labels) labelSet.add(l);
        if (visionLabels.primarySubject) labelSet.add(`subject: ${visionLabels.primarySubject}`);
        if (visionLabels.setting) labelSet.add(`setting: ${visionLabels.setting}`);
        labelSet.add(`subject_present: ${visionLabels.subjectPresent}`);
      }
      if (isIntroHead) labelSet.add(INTRO_CANDIDATE_LABEL);
      // Phase B provenance — same for every clip from this source.
      for (const p of provenanceLabels) labelSet.add(p);

      // COMBINED per-frame quality gate — ONE Gemini call per frame answering
      // BOTH questions: (1) is the footage clean (no logo/watermark/text/title
      // card)? and (2) is the main celebrity present? This merges what were two
      // separate passes (clean-footage + face-verify), halving Gemini Vision
      // spend on the clip hot path (3 calls instead of 6 for a 3-frame clip).
      //
      // We sample start/mid/end of the cut clip ONCE, run the combined check on
      // each, then apply two gates:
      //   - CLEAN (majority): yes/no aggregated across frames. A majority
      //     "dirty" (2+ of 3) → hard drop. A single transient dirty frame (a
      //     brief lower-third, a momentary station bug) no longer disqualifies
      //     an otherwise-clean clip — that any-frame rule was dropping most
      //     usable clips on perfectly good sources.
      //   - FACE (majority): yes/no/uncertain aggregated across frames. A
      //     majority "no" → hard drop (confirmed wrong person). Otherwise the
      //     face_verify label feeds the matcher's person-first bonus.
      //
      // The intro candidate is exempt (its own dedicated verifier in the matcher).
      let dropForNoPerson = false;   // majority "no" → wrong person
      let dropForDirty = false;      // any frame dirty → unclean footage
      // The clean-footage gate runs on the intro-head clip TOO. Many YouTube
      // sources open at t=0 with a "DISCLAIMER / for entertainment purposes"
      // text card; that frame was previously exempt from every gate (because
      // intro-head clips skip face/junk checks — the labeler often misses the
      // celebrity in frame 1) and so the disclaimer card leaked into the pool
      // and got reused as scene footage. We still cut the intro clip even when
      // dirty (its AUDIO is the celebrity's intro voice, which is the point),
      // but a dirty intro frame is BARRED from scene reuse (see scene-eligible
      // tagging below). Only the FACE gate stays exempt for intro-head clips.
      const runClean = env.CLIP_CLEAN_FOOTAGE_ENABLED;
      const runFace = env.CLIP_FACE_VERIFY_ENABLED && !!mainCelebrityForVerify && !isIntroHead;
      if (runClean || runFace) {
        const midSec = start + Math.max(1, Math.floor(dur / 2));
        const endSec = start + Math.max(1, Math.floor(dur) - 1);
        const thumbMidLocal = path.join(clipsTmp, `${vs.youtube_video_id}_${idx}_mid.jpg`);
        const thumbEndLocal = path.join(clipsTmp, `${vs.youtube_video_id}_${idx}_end.jpg`);
        const thumbMidDest = `projects/${projectId}/clips/${vs.youtube_video_id}_${idx}_mid.jpg`;
        const thumbEndDest = `projects/${projectId}/clips/${vs.youtube_video_id}_${idx}_end.jpg`;
        const tempDeleteList: string[] = [];
        const faceVerdicts: Array<"yes" | "no" | "uncertain"> = [];
        const cleanVerdicts: Array<"clean" | "dirty" | "uncertain"> = [];
        const cleanArtifacts: string[] = [];
        const frameReasons: string[] = [];

        // Run the combined check on one frame. Only the face question is asked
        // when we have a reference (runFace + celebrityReferenceUrl); otherwise
        // it returns face="uncertain" and we just get the clean verdict.
        async function checkFrame(url: string, label: string): Promise<void> {
          try {
            const r = await verifyClipFrameCombined({
              frameUrl: url,
              personName: runFace ? mainCelebrityForVerify! : undefined,
              referenceUrl: runFace ? celebrityReferenceUrl : null,
            });
            cleanVerdicts.push(r.clean);
            cleanArtifacts.push(r.cleanArtifact ?? "");
            faceVerdicts.push(r.face);
            frameReasons.push(`${label}=clean:${r.clean}/face:${r.face}`);
          } catch (e) {
            cleanVerdicts.push("uncertain");
            cleanArtifacts.push("");
            faceVerdicts.push("uncertain");
            void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
              "clip.frame_check.failed", { start, frame: label, err: (e as Error).message?.slice(0, 120) });
          }
        }

        try {
          // Start frame (already uploaded as thumbUp).
          await checkFrame(thumbUp.publicUrl, "start");
          // Mid frame.
          if (midSec > start + 1) {
            try {
              await generateThumbnail({ inputPath: sourceLocal, outputPath: thumbMidLocal, atSeconds: midSec });
              const midUp = await uploadFile(thumbMidLocal, thumbMidDest, "image/jpeg");
              tempDeleteList.push(thumbMidDest);
              await checkFrame(midUp.publicUrl, "mid");
            } catch (e) {
              void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
                "clip.frame_check.mid_failed", { start, err: (e as Error).message?.slice(0, 120) });
            } finally {
              await safeUnlink(thumbMidLocal);
            }
          }
          // End frame.
          if (endSec > midSec + 1 && endSec < start + dur) {
            try {
              await generateThumbnail({ inputPath: sourceLocal, outputPath: thumbEndLocal, atSeconds: endSec });
              const endUp = await uploadFile(thumbEndLocal, thumbEndDest, "image/jpeg");
              tempDeleteList.push(thumbEndDest);
              await checkFrame(endUp.publicUrl, "end");
            } catch (e) {
              void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
                "clip.frame_check.end_failed", { start, err: (e as Error).message?.slice(0, 120) });
            } finally {
              await safeUnlink(thumbEndLocal);
            }
          }

          // CLEAN gate — MAJORITY rule (was: any single dirty frame). A clip
          // is only dropped as dirty when 2+ of the sampled frames are dirty.
          // The old any-frame rule killed usable clips on a single transient
          // overlay frame (a brief lower-third, a momentary station bug on the
          // start frame, a flash of on-screen text), which is the bulk of the
          // "most clips failed but the video is usable" drops the user saw.
          // Requiring a majority keeps clips whose footage is clean for most
          // of their duration while still rejecting clips that are dirty
          // throughout. Matches the face gate's majority semantics below.
          if (runClean) {
            const dirtyCount = cleanVerdicts.filter((v) => v === "dirty").length;
            const cleanTotal = cleanVerdicts.length;
            if (cleanTotal > 0 && dirtyCount >= Math.ceil(cleanTotal / 2)) {
              dropForDirty = true;
            }
            // Full-screen TEXT-CARD override — bypasses the majority rule.
            //
            // The majority rule protects clips that are clean for most of
            // their duration from a single transient overlay frame (a brief
            // lower-third, a momentary station bug). But a DISCLAIMER / title /
            // text card is static full-screen text for the WHOLE clip — it is
            // never "clean for most of its duration". Two ways it slips past
            // the majority rule today:
            //   - Short clips (≤1-2s) sample only ONE frame, and if Gemini
            //     reads that frame as clean:"uncertain" (it fails open) the
            //     dirtyCount is 0 → not dropped. This is the "He showed up."
            //     block-69 leak: a 1s disclaimer card became scene footage.
            //   - A clip whose dirty frames don't reach the majority threshold.
            // When ANY sampled frame is flagged dirty AND its artifact reads as
            // full-screen text (not a corner bug / transient strip), the clip
            // is a text card throughout → hard-drop regardless of the count.
            const FULLSCREEN_TEXT_RE =
              /\b(disclaimer|viewer discretion|discretion advised|title card|text card|full[- ]?screen text|text screen|text overlay|legal notice|for entertainment purposes|warning screen|notice screen|end screen|credits)\b/i;
            const hasTextCardFrame = cleanVerdicts.some(
              (v, i) => v === "dirty" && FULLSCREEN_TEXT_RE.test(cleanArtifacts[i] ?? ""),
            );
            if (hasTextCardFrame) {
              dropForDirty = true;
            }

            // PERSISTENT LOGO / WATERMARK override — also bypasses the
            // majority rule, on a different signal than the text-card case.
            //
            // A burned-in channel logo or site watermark (e.g. a "HOLLYWOOD
            // SECRETS" corner bug, a "werewolftvseries.com" URL strip) sits in
            // the SAME corner on EVERY frame of the clip — it is never
            // transient. But because it is small, Gemini Vision often only
            // notices it on one of the three sampled frames and returns
            // clean:"uncertain" (fail-open) on the others. That yields
            // dirty=1 / uncertain=2, which never reaches the 2-of-3 majority,
            // so the watermarked clip leaks into scene footage.
            //
            // The discriminator vs. a genuinely-transient lower-third is the
            // presence of a CONFIDENTLY CLEAN frame: a real shot with a brief
            // overlay has clean frames elsewhere; a clip stamped with a
            // persistent logo has none. So: if ANY frame is dirty with a
            // logo/watermark artifact AND NO frame came back "clean", treat
            // the bug as persistent and drop. (When a clean frame exists we
            // fall back to the majority rule — a true transient overlay.)
            const LOGO_WATERMARK_RE =
              /\b(logo|watermark|wordmark|station bug|channel bug|brand(?:ing|ed)?|url|website|\.com|\.tv|\.net)\b/i;
            const anyConfidentlyClean = cleanVerdicts.some((v) => v === "clean");
            const hasLogoFrame = cleanVerdicts.some(
              (v, i) => v === "dirty" && LOGO_WATERMARK_RE.test(cleanArtifacts[i] ?? ""),
            );
            if (hasLogoFrame && !anyConfidentlyClean) {
              dropForDirty = true;
            }
          }

          // FACE gate — majority rule (same as before). 2+ "no" of 3 → drop.
          if (runFace) {
            const yesCount = faceVerdicts.filter((v) => v === "yes").length;
            const noCount = faceVerdicts.filter((v) => v === "no").length;
            const total = faceVerdicts.length;
            const majority = Math.ceil(total / 2);
            const overall: "yes" | "no" | "uncertain" =
              total === 0 ? "uncertain" :
              yesCount >= majority ? "yes" :
              noCount >= majority ? "no" :
              "uncertain";
            labelSet.add(`face_verify: ${overall}`);
            if (overall === "no") dropForNoPerson = true;
          }

          await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
            "clip.frame_check.done", {
              start, frames: frameReasons.join(","),
              clean: cleanVerdicts.join(","), face: faceVerdicts.join(","),
            });
        } catch (e) {
          void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
            "clip.frame_check.error", { start, err: (e as Error).message?.slice(0, 120) });
        } finally {
          if (tempDeleteList.length > 0) await removeFiles(tempDeleteList);
        }
      }

      // Unclean footage (logo/watermark/text on any frame).
      // Normal clips are HARD-DROPPED. The intro-head clip is the exception:
      // we keep it (its audio is the celebrity's intro voice — the reason the
      // intro clip exists), but we tag it NOT_SCENE_ELIGIBLE so the matcher
      // never reuses a dirty intro frame (e.g. a t=0 disclaimer card) as
      // regular scene footage. If a clean opening shot exists elsewhere the
      // intro selector still prefers it.
      if (dropForDirty && !isIntroHead) {
        droppedJunk++;
        droppedDirty++;
        junkCategoryCounts["dirty_overlay"] = (junkCategoryCounts["dirty_overlay"] ?? 0) + 1;
        await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
          "clip.dropped.dirty", { start });
        await removeFiles([clipDest, thumbDest]);
        return;
      }
      if (dropForDirty && isIntroHead) {
        labelSet.add(NOT_SCENE_ELIGIBLE_LABEL);
        await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
          "clip.intro_head.dirty_kept", { start });
      }

      // Hard drop for confirmed wrong-person clips. The main character is
      // absent from this clip, so it must not enter the pool (otherwise the
      // matcher could place it as filler in a block about that character).
      if (dropForNoPerson) {
        droppedJunk++;
        droppedWrongPerson++;
        junkCategoryCounts["wrong_person"] = (junkCategoryCounts["wrong_person"] ?? 0) + 1;
        await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
          "clip.dropped.wrong_person", { start, person: mainCelebrityForVerify });
        await removeFiles([clipDest, thumbDest]);
        return;
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
      processed++;
      await setMediaJob(mediaJobId, {
        progress: 5 + Math.floor((processed / windows.length) * 90),
        metadata: {
          videoSourceId,
          totalClips: windows.length,
          currentClip: { index: processed, total: windows.length, startSeconds: start },
        },
      });
    }
  }

  // Lane-based concurrency: each lane pulls the next index off a shared
  // cursor, so a slow clip on one lane doesn't hold up the others. This
  // is the dominant speedup — under serial execution the slowest step
  // (usually labeling on a 503 spike) gates everything.
  //
  // Backfill: `windows` holds the target (`cappedCount`) PLUS a reserve
  // (sized by CLIP_BACKFILL_BUFFER_FACTOR). Lanes keep pulling from the
  // pool — including the reserve — until `cappedCount` clips have actually
  // SURVIVED (passed the cut + clean + face gates), or the pool is
  // exhausted. Because failed/dirty/wrong-person clips don't increment
  // `succeeded`, each loss is automatically replaced by the next reserve
  // window. When losses are low we stop early and never cut the full
  // reserve, so a clean source doesn't over-produce.
  const concurrency = Math.max(1, Math.min(env.CLIP_PIPELINE_CONCURRENCY, windows.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        // Stop pulling new windows once the surviving-clip target is met.
        // Checked before claiming an index so in-flight lanes can still
        // finish, but no new reserve window is started unnecessarily.
        if (succeeded >= cappedCount) return;
        const i = cursor++;
        if (i >= windows.length) return;
        await processOne(i, windows[i]);
      }
    }),
  );

  if (succeeded === 0 && failed > 0) {
    await sb.from("video_sources").update({ status: "failed", error: "all clip cuts failed" }).eq("id", videoSourceId);
    await setMediaJob(mediaJobId, {
      status: "failed", progress: 100, error: "all clips failed",
      metadata: {
        videoSourceId,
        totalClips: windows.length,
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
      totalClips: windows.length,
      succeeded,
      failed,
      droppedJunk,
      // Reason-split + yield diagnostics (mirrors the clip.summary log) so the
      // job record / UI can explain a short source: target vs succeeded, and
      // whether the dirty-overlay or wrong-person gate dominated the drops.
      droppedLabelJunk,
      droppedDirty,
      droppedWrongPerson,
      target: cappedCount,
      targetMet: succeeded >= cappedCount,
      junkCategoryCounts,
    },
  });
  // Per-source summary so we can monitor yield + the junk-filter rate across
  // runs. The pool/target fields show how close this source got to its target
  // and WHY it fell short when it did:
  //   - target (cappedCount) vs succeeded → did we hit the goal?
  //   - poolCount / physicalMax           → how many windows were available to
  //                                          try (the full source after the
  //                                          backfill widening) vs how many we
  //                                          actually attempted (`attempted`)
  //   - dropRate                          → fraction of attempted clips killed
  //                                          by ALL gates (junk+dirty+wrong)
  //   - droppedDirty / droppedWrongPerson → which gate dominated the loss, so a
  //                                          short source is diagnosable (logo/
  //                                          text vs face) at a glance
  //   - poolExhausted                     → true when we tried every window and
  //                                          STILL came up short — i.e. the
  //                                          source physically can't yield more
  //                                          clean clips, not a reserve-too-small
  //                                          problem.
  const attempted = processed;
  const dropRate = attempted > 0
    ? Math.round((droppedJunk / attempted) * 1000) / 1000
    : 0;
  await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
    "clip.summary", {
      attempted,
      succeeded,
      failed,
      droppedJunk,
      droppedLabelJunk,
      droppedDirty,
      droppedWrongPerson,
      junkCategoryCounts,
      // Yield diagnostics (added with the full-source backfill widening).
      target: cappedCount,
      targetMet: succeeded >= cappedCount,
      poolCount,
      physicalMax,
      windowsGenerated: windows.length,
      poolExhausted: succeeded < cappedCount && attempted >= windows.length,
      dropRate,
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
// few candidates. Returns start timestamps only — callers wrap each into
// a SceneClipWindow with the default clip duration.
//
// Enforces a minimum stride of CLIP_DURATION_DEFAULT_SECONDS so consecutive
// clips never overlap. If `count` is too high to fit non-overlapping
// windows in the usable range, we silently cap it — better to return
// 4 clean clips than 11 overlapping near-duplicates.
export function pickClipTimestamps(duration: number, count: number): number[] {
  if (count <= 0) return [];
  const start = Math.min(10, duration - CLIP_DURATION_DEFAULT_SECONDS - 1);
  const end = duration - CLIP_DURATION_DEFAULT_SECONDS - 1;
  if (end <= start) return [Math.max(0, duration / 2 - CLIP_DURATION_DEFAULT_SECONDS / 2)];
  // Cap count so step >= CLIP_DURATION_DEFAULT_SECONDS — no overlapping windows.
  const span = end - start;
  const maxNonOverlapping = Math.max(1, Math.floor(span / CLIP_DURATION_DEFAULT_SECONDS) + 1);
  const n = Math.min(count, maxNonOverlapping);
  if (n === 1) return [Math.floor((start + end) / 2)];
  const step = span / (n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.max(0, Math.round((start + step * i) * 100) / 100));
  }
  return out;
}

// Merge window lists into a sorted, dedup'd, gap-respecting list. Used when
// scene-detect returned partial coverage and we want to fill in the gaps
// with uniform-sampled windows without colliding with the scene picks.
// Dedup is on `start` (rounded), so a uniform fallback at t=42 won't push
// out a scene-detected window already at t≈42.
export function mergeWithMinGap(windows: SceneClipWindow[], minGap: number, max: number): SceneClipWindow[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const out: SceneClipWindow[] = [];
  const seen = new Set<number>();
  let last = -Infinity;
  for (const w of sorted) {
    const key = Math.round(w.start * 100) / 100;
    if (seen.has(key)) continue;
    if (w.start - last >= minGap) {
      out.push(w);
      seen.add(key);
      last = w.start;
      if (out.length >= max) break;
    }
  }
  return out;
}


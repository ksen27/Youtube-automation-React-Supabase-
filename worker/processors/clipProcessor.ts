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
import { verifyPoolAsset } from "@/lib/ai/pool-verification";

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
  //
  // Windows carry both start and duration so the clip can end on the
  // next scene boundary instead of bleeding into the following shot.
  let windows: SceneClipWindow[] = [];
  let timestampSource: "scene_detect" | "uniform" | "scene_detect_then_uniform" = "uniform";
  let sceneCount = 0;
  try {
    const scenes = await detectSceneTimestamps({ inputPath: sourceLocal });
    sceneCount = scenes.length;
    const fromScenes = pickFromScenes({
      scenes,
      duration: vs.duration_seconds,
      targetCount: cappedCount,
      minDuration: CLIP_DURATION_MIN_SECONDS,
      maxDuration: CLIP_DURATION_MAX_SECONDS,
      minGapSeconds: 20,
      skipLeadSeconds: 10,
    });
    if (fromScenes.length >= cappedCount) {
      windows = fromScenes;
      timestampSource = "scene_detect";
    } else if (fromScenes.length > 0) {
      // Scene-detect found *some* boundaries but not enough. Pad with
      // uniform samples (default duration) that don't collide with the
      // scene picks.
      const uniform = pickClipTimestamps(vs.duration_seconds, cappedCount)
        .map((t) => ({ start: t, duration: CLIP_DURATION_DEFAULT_SECONDS }));
      windows = mergeWithMinGap([...fromScenes, ...uniform], minStride, cappedCount);
      timestampSource = "scene_detect_then_uniform";
    } else {
      windows = pickClipTimestamps(vs.duration_seconds, cappedCount)
        .map((t) => ({ start: t, duration: CLIP_DURATION_DEFAULT_SECONDS }));
      timestampSource = "uniform";
    }
  } catch (e) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
      "clip.scene_detect.failed", { err: (e as Error).message });
    windows = pickClipTimestamps(vs.duration_seconds, cappedCount)
      .map((t) => ({ start: t, duration: CLIP_DURATION_DEFAULT_SECONDS }));
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

      // Face-reference verification — MULTI-FRAME edition.
      //
      // The single-thumbnail check missed clips where the auto-sampled
      // frame was a wide panel shot (4 judges, faces tiny, all uncertain)
      // even when the rest of the clip had a clear close-up of the
      // celebrity. We now sample THREE frames per clip — start, middle,
      // end — and short-circuit as soon as ANY frame returns a confident
      // "yes". This catches the BGT judges-table case the user flagged
      // where the thumbnail was a wide shot but the clip itself was a
      // Walliams close-up.
      //
      // Aggregation rules (in order, first hit wins):
      //   any frame yes        → overall = yes  (keep, full bonus)
      //   all frames no        → overall = no   (reject — person_gate drops it)
      //   any uncertain/mixed  → overall = uncertain (keep, half bonus)
      //   all frames skipped   → overall = skipped (no reference)
      //
      // Cost: up to 3× the single-frame cost (~$0.003 per clip). We
      // short-circuit on the first "yes" so well-shot clips usually
      // pay only 1 call.
      //
      // The intro candidate is exempt — it has its own dedicated
      // verifier path in the matcher.
      if (env.CLIP_FACE_VERIFY_ENABLED && mainCelebrityForVerify && !isIntroHead) {
        // Generate two additional thumbnails (middle and end). The
        // "start+1" thumbnail is already on disk and uploaded.
        const midSec = start + Math.max(1, Math.floor(dur / 2));
        // Clip is `dur` seconds long; sample at end-1 to avoid empty
        // tail frames on clips that scene-detect snapped tightly.
        const endSec = start + Math.max(1, Math.floor(dur) - 1);
        const thumbMidLocal = path.join(clipsTmp, `${vs.youtube_video_id}_${idx}_mid.jpg`);
        const thumbEndLocal = path.join(clipsTmp, `${vs.youtube_video_id}_${idx}_end.jpg`);
        const thumbMidDest = `projects/${projectId}/clips/${vs.youtube_video_id}_${idx}_mid.jpg`;
        const thumbEndDest = `projects/${projectId}/clips/${vs.youtube_video_id}_${idx}_end.jpg`;
        const tempDeleteList: string[] = [];
        const frameVerdicts: Array<"yes" | "no" | "uncertain" | "skipped"> = [];
        const frameReasons: string[] = [];

        async function verifyOne(url: string, label: string): Promise<"yes" | "no" | "uncertain" | "skipped"> {
          try {
            const v = await verifyPoolAsset({
              projectId,
              entityType: "person",
              entityName: mainCelebrityForVerify!,
              candidateUrl: url,
            });
            frameReasons.push(`${label}=${v.verdict}`);
            return v.verdict;
          } catch (e) {
            void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
              "clip.face_verify.frame_failed", {
                start, frame: label, err: (e as Error).message?.slice(0, 120),
              });
            return "skipped";
          }
        }

        try {
          // Start frame (the existing thumbnail, already uploaded).
          const startVerdict = await verifyOne(thumbUp.publicUrl, "start");
          frameVerdicts.push(startVerdict);

          // Mid frame. Sample regardless of start verdict so the
          // aggregation has enough signal to apply the majority rule
          // (see "Aggregate" below). Earlier versions short-circuited on
          // start=yes, but that let clips through where the celebrity
          // appears for ~1s of a 6s clip and the rest shows contestants
          // (failure mode the user flagged on blocks 102 / 107).
          if (midSec > start + 1) {
            try {
              await generateThumbnail({
                inputPath: sourceLocal, outputPath: thumbMidLocal, atSeconds: midSec,
              });
              const midUp = await uploadFile(thumbMidLocal, thumbMidDest, "image/jpeg");
              tempDeleteList.push(thumbMidDest);
              const midVerdict = await verifyOne(midUp.publicUrl, "mid");
              frameVerdicts.push(midVerdict);
            } catch (e) {
              void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
                "clip.face_verify.mid_frame_failed", {
                  start, err: (e as Error).message?.slice(0, 120),
                });
            } finally {
              await safeUnlink(thumbMidLocal);
            }
          }

          // End frame — always sample (was previously gated on
          // !includes("yes"); now we collect all three so majority
          // aggregation can apply consistently).
          if (endSec > midSec + 1 && endSec < start + dur) {
            try {
              await generateThumbnail({
                inputPath: sourceLocal, outputPath: thumbEndLocal, atSeconds: endSec,
              });
              const endUp = await uploadFile(thumbEndLocal, thumbEndDest, "image/jpeg");
              tempDeleteList.push(thumbEndDest);
              const endVerdict = await verifyOne(endUp.publicUrl, "end");
              frameVerdicts.push(endVerdict);
            } catch (e) {
              void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
                "clip.face_verify.end_frame_failed", {
                  start, err: (e as Error).message?.slice(0, 120),
                });
            } finally {
              await safeUnlink(thumbEndLocal);
            }
          }

          // Aggregate via MAJORITY rule. The previous "any yes wins"
          // rule was too lenient — a 6s clip with the celebrity visible
          // for only 1s would pass as "yes" because one of the three
          // sampled frames happened to land on them, even though 5/6
          // seconds show contestants / co-judges / wide shots. The
          // viewer perceives the clip as "wrong character" because the
          // celebrity isn't on screen most of the time.
          //
          // New rule:
          //   yes  count >= ceil(N/2)  → overall yes
          //   no   count >= ceil(N/2)  → overall no
          //   all  skipped             → skipped
          //   otherwise                → uncertain
          //
          // For N=3 frames, this means 2+ yes for "yes" and 2+ no for
          // "no". Mixed verdicts (1 yes + 2 uncertain, or 1 yes + 1 no
          // + 1 uncertain) fall through to uncertain — the matcher's
          // person-first bonus halves for uncertain, making these clips
          // less competitive against confirmed-yes clips.
          const yesCount = frameVerdicts.filter((v) => v === "yes").length;
          const noCount = frameVerdicts.filter((v) => v === "no").length;
          const skippedCount = frameVerdicts.filter((v) => v === "skipped").length;
          const total = frameVerdicts.length;
          const majority = Math.ceil(total / 2);
          const overallVerdict: "yes" | "no" | "uncertain" | "skipped" =
            total === 0 ? "skipped" :
            skippedCount === total ? "skipped" :
            yesCount >= majority ? "yes" :
            noCount >= majority ? "no" :
            "uncertain";

          labelSet.add(`face_verify: ${overallVerdict}`);
          if (overallVerdict === "no") {
            for (const l of Array.from(labelSet)) {
              if (l.startsWith("subject_present:")) labelSet.delete(l);
            }
            labelSet.add("subject_present: no");
            await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
              "clip.face_verify.rejected", {
                start, person: mainCelebrityForVerify,
                frames: frameReasons.join(","), framesChecked: frameVerdicts.length,
              });
          } else if (frameVerdicts.length > 1) {
            // Successful multi-frame check — useful signal for tuning.
            await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
              "clip.face_verify.multi_frame", {
                start, overall: overallVerdict,
                frames: frameReasons.join(","), framesChecked: frameVerdicts.length,
              });
          }
        } catch (e) {
          void logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
            "clip.face_verify.failed", { start, err: (e as Error).message?.slice(0, 120) });
        } finally {
          // Best-effort cleanup of the extra thumbnails uploaded for
          // verification. Failure to delete here doesn't affect the
          // clip — just leaves orphaned files in R2.
          if (tempDeleteList.length > 0) {
            await removeFiles(tempDeleteList);
          }
        }
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
  const concurrency = Math.max(1, Math.min(env.CLIP_PIPELINE_CONCURRENCY, windows.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
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
      junkCategoryCounts,
    },
  });
  // Per-source summary so we can monitor the junk-filter rate across runs.
  // High droppedJunk on one source = noisy YouTube upload; high droppedJunk
  // across many sources = the labeler is over-classifying as junk.
  await logJob({ projectId, jobId: mediaJobId, sourceId: videoSourceId },
    "clip.summary", {
      attempted: windows.length,
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


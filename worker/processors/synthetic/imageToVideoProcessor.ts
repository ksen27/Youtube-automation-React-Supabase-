import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, logJob } from "@/lib/jobs/db";
import type { ImageToVideoJobData } from "@/lib/jobs/queue";
import { uploadBuffer } from "@/lib/storage";
import { generateImage, plannedImageProvider, isCensored } from "@/lib/synthetic/sixtynine-labs";
import { degradeImageLowFi } from "@/lib/synthetic/degrade";
import { generateClipWithFallback } from "@/lib/synthetic/falai";
import { isLtxConfigured, isLtxPermanentFailure, ltxModel, ltxPoolSize } from "@/lib/synthetic/ltx";
import { generateVeoClip, isVeoConfigured, isVeoPermanentFailure, veoModel } from "@/lib/synthetic/sixtynine-video";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { resolveAnimationPrompt } from "@/lib/synthetic/clip-motion";
import { findReusableAsset, indexGeneratedAsset } from "@/lib/synthetic/asset-library";
import { finishSegment, maybeFinalizeSynthetic, withSegmentHeartbeat } from "@/worker/processors/synthetic/_shared";
import type { JobAttemptInfo } from "@/worker/index";

// 'ai_clip' generation: nano-banana still -> LTX-2 (fal.ai Veo 3 Fast, then
// Kling, as fallback) animated clip, WITHOUT audio (the voiceover is the
// master track). The generated still is uploaded first (so we can degrade to
// holding it if the animation step fails), then animated.
//
// Provider policy (per client direction):
//   - LTX-2 is the ONLY clip provider (no fal.ai Veo/Kling fallback). See
//     generateClipWithFallback in falai.ts.
//   - An ai_clip MUST be real AI video. On the FINAL attempt we do NOT degrade
//     to a held still; the segment is marked failed with LTX's actual error so
//     the reason is visible and the segment stays retryable in the UI.
export async function processImageToVideoJob(
  data: ImageToVideoJobData,
  attempt?: JobAttemptInfo,
): Promise<void> {
  const { projectId, mediaJobId, segmentId } = data;
  const sb = getServerSupabase();
  const isFinalAttempt = (attempt?.attemptsMade ?? 1) >= (attempt?.attemptsAllowed ?? 1);

  // ABANDONED-JOB GUARD. BullMQ entries are keyed on mediaJobId, but nothing
  // removes a waiting entry when its media_jobs row reaches a terminal state by
  // another route — the stall sweep failing it, or the row being deleted by a
  // re-plan. Those entries stay in the queue and, on pickup, ran the FULL job:
  // a paid nano-banana still plus a multi-minute LTX render, writing the result
  // onto a segment nobody is waiting for (or resurrecting one the sweep had
  // already failed). Measured on the live queue: 388 of 1060 waiting entries
  // (37%) were in exactly this state — 163 already failed, 225 with no row at
  // all — so better than a third of clip throughput was being spent on work
  // that could not land. Checking first turns each one into a no-op.
  //
  // Deliberately BEFORE the status='running' write, which would otherwise flip
  // a swept row back to running and undo the sweep's decision.
  //
  // A BullMQ RETRY is not affected: attempt 1 sets the row to 'running' and
  // markJobFailedIfExhausted only writes 'failed' once attempts are spent, so
  // a mid-retry row still reads 'running' here.
  const { data: jobRow } = await sb
    .from("media_jobs")
    .select("status")
    .eq("id", mediaJobId)
    .maybeSingle();
  if (!jobRow || jobRow.status === "completed" || jobRow.status === "failed") {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_to_video.abandoned", {
      reason: jobRow ? `media_job already ${jobRow.status}` : "media_job row no longer exists",
    });
    return;
  }

  await setMediaJob(mediaJobId, { status: "running", progress: 10, metadata: { segmentId } });

  const { data: seg, error } = await sb
    .from("synthetic_segments")
    .select("id, image_prompt, animation_prompt, script, duration, image_url, metadata")
    .eq("id", segmentId)
    .single();
  if (error || !seg) throw new Error(`image_to_video: segment ${segmentId} not found`);

  // Picture prompt for the source still. NEVER fall back to seg.script (the
  // spoken narration) — that produced literal, off-topic frames. When the
  // per-block prompt is missing, use the video's recurring world (base_prompt,
  // stashed by the planner) so the still is on-topic.
  const meta = seg.metadata as { base_prompt?: string; clip_engine?: string | null } | null;
  const basePrompt = (meta?.base_prompt ?? "").trim();
  // Which clip engine the PLAN chose for this block (assignClipDurationQuota).
  // Falls back to LTX when absent — segments planned before the veo lane existed
  // carry no clip_engine, and LTX is the workhorse.
  const wantVeo = meta?.clip_engine === "veo" && isVeoConfigured();
  const imagePrompt = (seg.image_prompt?.trim() || basePrompt).trim();
  // The per-block action the planner wrote, else the generic action fallback.
  // Both describe a PERSON PERFORMING AN ACTION with the camera locked off —
  // see ACTION_CLIP_RULE for why that specific combination satisfies both the
  // 2026-08-17 "human movement, not random zoom" ask and the 2026-06-28
  // no-blur rule it appears to contradict.
  //
  // A block planned BEFORE this change may still carry an old frozen-scene
  // animation_prompt. Those are left alone rather than rewritten: the stored
  // prompt is editable on the review screen, and silently overriding a prompt
  // an operator can see would make the screen lie about what will render. A
  // re-plan (or a per-segment prompt regenerate) refreshes them.
  // The FALLBACK now depends on what the still actually shows. The old default
  // opened with "The person in the frame continues the everyday action they are
  // already doing" and was applied to every prompt-less clip -- including the
  // ~87% of scenes with no person in them, which is why the model invented hands
  // into spider webs and bark. See lib/synthetic/clip-motion.ts.
  const { prompt: animationPrompt, source: animationPromptSource } = resolveAnimationPrompt(
    seg.animation_prompt,
    imagePrompt,
  );
  const duration = Math.max(2, Math.min(10, Number(seg.duration) || 5));

  // ASSET LIBRARY (migration 0030): a matching PRIOR clip skips BOTH paid
  // steps (69labs still + LTX render). Clips are keyed on the scene prompt
  // (imagePrompt) — the animation prompt is a near-constant subtle push-in and
  // carries no scene identity. Urls already used in this project are excluded
  // (no repeats within one video); disabled/error falls through to generate.
  if (imagePrompt) {
    const clipReuse = await findReusableAsset({ prompt: imagePrompt, assetType: "clip", projectId });
    if (clipReuse) {
      await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_to_video.reused", {
        via: clipReuse.via,
        similarity: Number(clipReuse.similarity.toFixed(4)),
        assetId: clipReuse.id,
      });
      await finishSegment(segmentId, {
        status: "ready",
        video_url: clipReuse.assetUrl,
        // Carry the reused clip's source still too (when known) so a later
        // image-only regenerate / degrade path has a matching frame.
        ...(clipReuse.sourceImageUrl && !seg.image_url ? { image_url: clipReuse.sourceImageUrl } : {}),
        provider: clipReuse.provider ?? "library_reuse",
        error: null,
      }, { via: clipReuse.via, similarity: clipReuse.similarity, assetId: clipReuse.id });
      await setMediaJob(mediaJobId, {
        status: "completed",
        progress: 100,
        metadata: { reusedFromLibrary: true, libraryAssetId: clipReuse.id },
      });
      await maybeFinalizeSynthetic(projectId);
      return;
    }
  }

  // --- step 1: ensure a source still exists (reuse on retry) ---
  let imageUrl = seg.image_url as string | null;
  if (!imageUrl) {
    const t0 = Date.now();
    await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: plannedImageProvider(), phase: "request" });
    // imagePrompt already resolves to the per-block scene, else the video's
    // recurring world (base_prompt). It is intentionally NOT the spoken script.
    if (!imagePrompt) throw new Error(`image_to_video: segment ${segmentId} has no usable image prompt`);
    // A clip's source still goes through the same content filter as a plain
    // image, and the same refusal is partly a coin flip — the same prompt was
    // measured passing 4 of 6 fresh submits (see imageGenProcessor's re-roll,
    // and safe-depiction.ts). This path had no handling at all, so an ai_clip
    // block died on one unlucky roll with no second chance anywhere. One
    // re-roll, in-process: BullMQ's own retries cannot serve here because the
    // still may already have been uploaded by then.
    let img;
    try {
      img = await generateImage(imagePrompt);
    } catch (err) {
      if (!isCensored(err)) throw err;
      await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_to_video.censored", {
        err: (err as Error).message?.slice(0, 200),
        note: "re-rolling the same prompt once",
      });
      img = await generateImage(imagePrompt);
    }
    await logProviderCall({
      projectId, jobId: mediaJobId, segmentId, provider: img.provider, phase: "response",
      durationMs: Date.now() - t0, cost: { provider: img.provider, images: 1 },
    });
    // Low-fi degrade the source still BEFORE upload so the animated clip
    // inherits the real-footage texture (keeps dimensions, lowers quality only).
    const deg = await degradeImageLowFi(img.image);
    const up = await uploadBuffer(
      deg.image,
      r2Keys.segmentImage(projectId, segmentId, Date.now()),
      deg.degraded ? deg.contentType : img.contentType,
    );
    imageUrl = up.publicUrl;
    // Persist the still immediately so a later video failure can degrade to it.
    await finishSegment(segmentId, { image_url: imageUrl, provider: img.provider });
    // Index the fresh still as a reusable IMAGE too — it's the same
    // nano-banana output the image_gen lane produces. Best-effort no-op when
    // the library is disabled.
    await indexGeneratedAsset({
      prompt: imagePrompt,
      assetType: "image",
      assetUrl: imageUrl,
      provider: img.provider,
      projectId,
      segmentId,
    });
    await setMediaJob(mediaJobId, { progress: 45 });
  }

  // --- step 2: animate the still ---
  try {
    const t0 = Date.now();
    // The actual provider isn't known until the fallback chain resolves
    // (reported on the response line via clip.provider); the request line logs
    // the configured primary so the two lines line up when LTX succeeds.
    const primaryProvider = wantVeo ? "sixtynine_veo" : isLtxConfigured() ? "ltx2" : "fal_veo3_fast";
    await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: primaryProvider, phase: "request",
      // Log the actual model so the request line proves which engine ran (the
      // "ltx2" provider label alone can't distinguish ltx-2-fast from
      // ltx-2-3-fast) and how many accounts are balancing.
      // animationPromptSource makes the "why is every clip hands" class of bug
      // visible in the logs: a run that is overwhelmingly action_default on
      // person-less scenes is the symptom, and it was previously invisible.
      extra: wantVeo
        ? { durationSeconds: duration, model: veoModel(), clipEngine: "veo", animationPromptSource }
        : isLtxConfigured()
          ? { durationSeconds: duration, model: ltxModel(), ltxPoolSize: ltxPoolSize(), clipEngine: "ltx", animationPromptSource }
          : { durationSeconds: duration, animationPromptSource } });
    // Heartbeat the segment AND the media_job across the render so neither
    // stall sweeper can false-fail work that is alive and rendering.
    //
    // The engine is NOT a fallback chain: a block planned as veo renders on veo
    // or fails. Quietly re-rendering it on LTX would silently dissolve the 5%
    // veo share the plan exists to enforce, and the shortfall would be
    // invisible — the failure has to be visible and retryable instead.
    const clip = await withSegmentHeartbeat(
      segmentId,
      () =>
        wantVeo
          ? generateVeoClip({ imageUrl, prompt: animationPrompt, durationSeconds: duration })
          : generateClipWithFallback({ imageUrl, prompt: animationPrompt, durationSeconds: duration }),
      60_000,
      // Beat the media_jobs row too. Between the progress:45 write above and
      // the completion write below this processor is silent for the entire
      // render, so without this the row's updated_at freezes and a slow render
      // is indistinguishable from a dead worker to sweepStalledJobs.
      mediaJobId,
    );
    await logProviderCall({
      projectId, jobId: mediaJobId, segmentId, provider: clip.provider, phase: "response",
      durationMs: Date.now() - t0,
      // veo bills per GENERATION (a flat credit), LTX per second — charging veo
      // by seconds would overstate a long block several times over.
      cost: clip.provider === "sixtynine_veo"
        ? { provider: clip.provider, clips: 1 }
        : { provider: clip.provider, seconds: clip.seconds },
    });

    const up = await uploadBuffer(clip.video, r2Keys.segmentVideo(projectId, segmentId, Date.now()), "video/mp4");
    await finishSegment(segmentId, { status: "ready", video_url: up.publicUrl, provider: clip.provider, error: null });
    // Index the fresh clip into the cross-project asset library (keyed on the
    // scene prompt, with its source still recorded). Best-effort; no-op when
    // ASSET_LIBRARY_ENABLED is off.
    if (imagePrompt) {
      await indexGeneratedAsset({
        prompt: imagePrompt,
        assetType: "clip",
        assetUrl: up.publicUrl,
        sourceImageUrl: imageUrl,
        provider: clip.provider,
        projectId,
        segmentId,
      });
    }
    await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { provider: clip.provider } });
  } catch (err) {
    // A billing/quota failure (LTX out of funds) can NEVER succeed on retry, and
    // each retry re-generates the nano-banana still (~4¢) for nothing. Fail it
    // immediately instead of burning the whole retry budget + image cost.
    const permanent = wantVeo ? isVeoPermanentFailure(err) : isLtxPermanentFailure(err);
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_to_video.failed", {
      err: (err as Error).message?.slice(0, 200),
      isFinalAttempt,
      permanent,
    });
    if (isFinalAttempt || permanent) {
      // Per client direction, an ai_clip MUST be real AI video — we do NOT
      // degrade to a held still (that would silently hide a generation failure).
      // Mark the segment failed with the genuine LTX reason so it is visible and
      // retryable in the UI instead of masked as a static image.
      const reason = (err as Error).message?.slice(0, 300);
      await finishSegment(segmentId, { status: "failed", error: reason });
      await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_to_video.failed_final", { err: reason, permanent });
      await setMediaJob(mediaJobId, { status: "failed", error: reason });
      await maybeFinalizeSynthetic(projectId);
      return;
    }
    throw err; // retry
  }

  await maybeFinalizeSynthetic(projectId);
}

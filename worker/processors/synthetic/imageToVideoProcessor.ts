import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, logJob } from "@/lib/jobs/db";
import type { ImageToVideoJobData } from "@/lib/jobs/queue";
import { uploadBuffer } from "@/lib/storage";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { generateClipWithFallback } from "@/lib/synthetic/falai";
import { isLtxConfigured } from "@/lib/synthetic/ltx";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { finishSegment, maybeFinalizeSynthetic } from "@/worker/processors/synthetic/_shared";
import type { JobAttemptInfo } from "@/worker/index";

// 'ai_clip' generation: nano-banana still -> LTX-2 (fal.ai Veo 3 Fast, then
// Kling, as fallback) animated clip, WITHOUT audio (the voiceover is the
// master track). The generated still is uploaded first (so we can degrade to
// holding it if the animation step fails), then animated.
//
// Multi-tier fallback:
//   1. LTX-2 -> Veo -> Kling is handled inside generateClipWithFallback.
//   2. If EVERY video provider fails on the FINAL attempt, we degrade to the
//      still image (segment becomes a held image) rather than failing the
//      whole block — a held still is far better than a hole in the timeline.
export async function processImageToVideoJob(
  data: ImageToVideoJobData,
  attempt?: JobAttemptInfo,
): Promise<void> {
  const { projectId, mediaJobId, segmentId } = data;
  const sb = getServerSupabase();
  const isFinalAttempt = (attempt?.attemptsMade ?? 1) >= (attempt?.attemptsAllowed ?? 1);

  await setMediaJob(mediaJobId, { status: "running", progress: 10, metadata: { segmentId } });

  const { data: seg, error } = await sb
    .from("synthetic_segments")
    .select("id, image_prompt, animation_prompt, script, duration, image_url")
    .eq("id", segmentId)
    .single();
  if (error || !seg) throw new Error(`image_to_video: segment ${segmentId} not found`);

  const imagePrompt = (seg.image_prompt ?? seg.script ?? "").trim();
  const animationPrompt = (seg.animation_prompt ?? "Subtle natural motion, slow push-in").trim();
  const duration = Math.max(2, Math.min(10, Number(seg.duration) || 5));

  // --- step 1: ensure a source still exists (reuse on retry) ---
  let imageUrl = seg.image_url as string | null;
  if (!imageUrl) {
    const t0 = Date.now();
    await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: "sixtynine_image", phase: "request" });
    const img = await generateImage(imagePrompt || seg.script || "a relevant scene");
    await logProviderCall({
      projectId, jobId: mediaJobId, segmentId, provider: img.provider, phase: "response",
      durationMs: Date.now() - t0, cost: { provider: img.provider, images: 1 },
    });
    const up = await uploadBuffer(img.image, r2Keys.segmentImage(projectId, segmentId), img.contentType);
    imageUrl = up.publicUrl;
    // Persist the still immediately so a later video failure can degrade to it.
    await finishSegment(segmentId, { image_url: imageUrl, provider: img.provider });
    await setMediaJob(mediaJobId, { progress: 45 });
  }

  // --- step 2: animate the still ---
  try {
    const t0 = Date.now();
    // The actual provider isn't known until the fallback chain resolves
    // (reported on the response line via clip.provider); the request line logs
    // the configured primary so the two lines line up when LTX succeeds.
    const primaryProvider = isLtxConfigured() ? "ltx2" : "fal_veo3_fast";
    await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: primaryProvider, phase: "request",
      extra: { durationSeconds: duration } });
    const clip = await generateClipWithFallback({ imageUrl, prompt: animationPrompt, durationSeconds: duration });
    await logProviderCall({
      projectId, jobId: mediaJobId, segmentId, provider: clip.provider, phase: "response",
      durationMs: Date.now() - t0, cost: { provider: clip.provider, seconds: clip.seconds },
    });

    const up = await uploadBuffer(clip.video, r2Keys.segmentVideo(projectId, segmentId), "video/mp4");
    await finishSegment(segmentId, { status: "ready", video_url: up.publicUrl, provider: clip.provider, error: null });
    await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { provider: clip.provider } });
  } catch (err) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_to_video.failed", {
      err: (err as Error).message?.slice(0, 200),
      isFinalAttempt,
    });
    if (isFinalAttempt) {
      // Degrade: keep the still as a held image so the block survives.
      await finishSegment(segmentId, {
        status: "ready",
        error: `video failed, held still: ${(err as Error).message?.slice(0, 200)}`,
      });
      await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_to_video.degraded_to_still", {});
      await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { degradedToStill: true } });
      await maybeFinalizeSynthetic(projectId);
      return;
    }
    throw err; // retry
  }

  await maybeFinalizeSynthetic(projectId);
}

import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, logJob } from "@/lib/jobs/db";
import type { ImageToVideoJobData } from "@/lib/jobs/queue";
import { uploadBuffer } from "@/lib/storage";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { degradeImageLowFi } from "@/lib/synthetic/degrade";
import { generateClipWithFallback } from "@/lib/synthetic/falai";
import { isLtxConfigured, isLtxPermanentFailure } from "@/lib/synthetic/ltx";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { finishSegment, maybeFinalizeSynthetic } from "@/worker/processors/synthetic/_shared";
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
  const basePrompt = ((seg.metadata as { base_prompt?: string } | null)?.base_prompt ?? "").trim();
  const imagePrompt = (seg.image_prompt?.trim() || basePrompt).trim();
  // Default to the client's preferred look. Client feedback (2026-06-28): the
  // earlier pan-across-scene with "shake / motion blur" cues read as a SUDDEN
  // movement that BLURRED the footage — they want motion so subtle it is barely
  // perceptible, like the reference channels. So: an extremely slow, very slight
  // push-in over an otherwise frozen scene, no panning, and NO blur/shake cues
  // (those were literally producing the blur they objected to). Keep the low-fi
  // grain so the clip still matches the source still's texture.
  const animationPrompt = (
    seg.animation_prompt ??
    "Extremely slow, very slight camera push-in over an otherwise completely still, frozen scene. " +
      "The movement is minimal and barely perceptible — no panning, no sudden motion, no shake, no motion blur. " +
      "Steady and locked-off. Slightly low quality and grainy like real phone footage, not smooth or cinematic."
  ).trim();
  const duration = Math.max(2, Math.min(10, Number(seg.duration) || 5));

  // --- step 1: ensure a source still exists (reuse on retry) ---
  let imageUrl = seg.image_url as string | null;
  if (!imageUrl) {
    const t0 = Date.now();
    await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: "sixtynine_image", phase: "request" });
    // imagePrompt already resolves to the per-block scene, else the video's
    // recurring world (base_prompt). It is intentionally NOT the spoken script.
    if (!imagePrompt) throw new Error(`image_to_video: segment ${segmentId} has no usable image prompt`);
    const img = await generateImage(imagePrompt);
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

    const up = await uploadBuffer(clip.video, r2Keys.segmentVideo(projectId, segmentId, Date.now()), "video/mp4");
    await finishSegment(segmentId, { status: "ready", video_url: up.publicUrl, provider: clip.provider, error: null });
    await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { provider: clip.provider } });
  } catch (err) {
    // A billing/quota failure (LTX out of funds) can NEVER succeed on retry, and
    // each retry re-generates the nano-banana still (~4¢) for nothing. Fail it
    // immediately instead of burning the whole retry budget + image cost.
    const permanent = isLtxPermanentFailure(err);
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

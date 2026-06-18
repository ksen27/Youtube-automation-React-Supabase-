import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, logJob } from "@/lib/jobs/db";
import type { ImageGenerationJobData } from "@/lib/jobs/queue";
import { uploadBuffer } from "@/lib/storage";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { finishSegment, maybeFinalizeSynthetic } from "@/worker/processors/synthetic/_shared";
import type { JobAttemptInfo } from "@/worker/index";

// Image generation for 'image' and 'split_2' blocks (nano-banana, Flux
// fallback handled inside generateImage). For split_2 the generated still is
// the RIGHT half; the avatar video is composited on the left at render time, so
// it is stored as right_image_url. For 'image' it is the full-frame still.
//
// Failure policy: BullMQ retries (attempts=3) the whole job. Only on the FINAL
// exhausted attempt do we mark the segment 'failed' so the pipeline can
// finalize without it; mid-attempt failures just throw and let BullMQ retry.
export async function processImageGenJob(
  data: ImageGenerationJobData,
  attempt?: JobAttemptInfo,
): Promise<void> {
  const { projectId, mediaJobId, segmentId } = data;
  const sb = getServerSupabase();
  const isFinalAttempt = (attempt?.attemptsMade ?? 1) >= (attempt?.attemptsAllowed ?? 1);

  await setMediaJob(mediaJobId, { status: "running", progress: 10, metadata: { segmentId } });

  const { data: seg, error } = await sb
    .from("synthetic_segments")
    .select("id, block_type, image_prompt, script")
    .eq("id", segmentId)
    .single();
  if (error || !seg) throw new Error(`image_gen: segment ${segmentId} not found`);

  const prompt = (seg.image_prompt ?? seg.script ?? "").trim();
  if (!prompt) throw new Error(`image_gen: segment ${segmentId} has no prompt`);

  try {
    const t0 = Date.now();
    await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: "sixtynine_image", phase: "request" });
    const out = await generateImage(prompt);
    await logProviderCall({
      projectId, jobId: mediaJobId, segmentId,
      provider: out.provider, phase: "response",
      durationMs: Date.now() - t0, cost: { provider: out.provider, images: 1 },
    });

    const isSplit = seg.block_type === "split_2";
    const key = isSplit
      ? r2Keys.segmentRightImage(projectId, segmentId)
      : r2Keys.segmentImage(projectId, segmentId);
    const up = await uploadBuffer(out.image, key, out.contentType);

    await finishSegment(segmentId, {
      status: "ready",
      provider: out.provider,
      ...(isSplit ? { right_image_url: up.publicUrl } : { image_url: up.publicUrl }),
    });
    await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { provider: out.provider } });
  } catch (err) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_gen.failed", {
      err: (err as Error).message?.slice(0, 200),
      isFinalAttempt,
    });
    if (isFinalAttempt) {
      await finishSegment(segmentId, { status: "failed", error: (err as Error).message?.slice(0, 300) });
      await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: (err as Error).message });
      await maybeFinalizeSynthetic(projectId);
      return; // swallow on final attempt so the project can finalize
    }
    throw err; // let BullMQ retry
  }

  await maybeFinalizeSynthetic(projectId);
}

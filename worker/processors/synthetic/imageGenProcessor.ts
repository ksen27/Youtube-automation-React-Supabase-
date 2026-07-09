import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, logJob } from "@/lib/jobs/db";
import type { ImageGenerationJobData } from "@/lib/jobs/queue";
import { uploadBuffer } from "@/lib/storage";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { degradeImageLowFi } from "@/lib/synthetic/degrade";
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

  // ZOMBIE-LOOP FIX: if a PRIOR attempt of this job already submitted a 69labs
  // generation (recorded here) but its poll timed out, resume polling THAT job
  // instead of submitting a new one — resubmitting stacks a second generation on
  // the same account and fills its 7-slot ceiling, which is what causes the
  // chronic "Concurrent limit reached (7)" 403 under load. Read the recorded
  // (jobId, keyIdx) off the media_job metadata (setMediaJob merges metadata, so
  // it survives across BullMQ attempts).
  const { data: jobRow } = await sb
    .from("media_jobs")
    .select("metadata")
    .eq("id", mediaJobId)
    .single();
  const jobMeta = (jobRow?.metadata as { sixtynineJobId?: string; sixtynineKeyIdx?: number } | null) ?? {};
  const resume = {
    // A prior attempt's recorded 69labs job, or ("", -1) when there's nothing to
    // resume — generateImage's canResume guard falls through to a fresh submit in
    // that case, and onSubmit persists the new (jobId, keyIdx) either way so the
    // NEXT attempt can resume it.
    jobId: jobMeta.sixtynineJobId ?? "",
    keyIdx: typeof jobMeta.sixtynineKeyIdx === "number" ? jobMeta.sixtynineKeyIdx : -1,
    onSubmit: async (jobId: string, keyIdx: number) => {
      await setMediaJob(mediaJobId, { metadata: { sixtynineJobId: jobId, sixtynineKeyIdx: keyIdx } });
    },
  };

  const { data: seg, error } = await sb
    .from("synthetic_segments")
    .select("id, block_type, image_prompt, script, metadata")
    .eq("id", segmentId)
    .single();
  if (error || !seg) throw new Error(`image_gen: segment ${segmentId} not found`);

  // Resolve the picture prompt. NEVER fall back to seg.script — the script is
  // the SPOKEN narration, and drawing it verbatim is what produced literal,
  // off-topic stills (e.g. "Be honest, I read these." rendered as a person
  // reading). When the per-block prompt is missing, use the video's recurring
  // world (base_prompt, stashed by the planner) so the still is at least
  // on-topic. If neither exists, fail loudly so the segment is retryable rather
  // than silently mis-generated.
  const basePrompt = ((seg.metadata as { base_prompt?: string } | null)?.base_prompt ?? "").trim();
  const prompt = (seg.image_prompt?.trim() || basePrompt).trim();
  if (!prompt) throw new Error(`image_gen: segment ${segmentId} has no usable image prompt`);

  try {
    const t0 = Date.now();
    await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: "sixtynine_image", phase: "request" });
    const out = await generateImage(prompt, resume);
    await logProviderCall({
      projectId, jobId: mediaJobId, segmentId,
      provider: out.provider, phase: "response",
      durationMs: Date.now() - t0, cost: { provider: out.provider, images: 1 },
    });

    // Low-fi "vlogging" degrade (keeps dimensions, lowers texture quality) so
    // the still reads as real phone footage instead of a clean AI render.
    const deg = await degradeImageLowFi(out.image);

    const isSplit = seg.block_type === "split_2";
    // Versioned key (timestamp) so a regenerate writes a NEW file and the prior
    // version survives in R2 for the review screen's history. finishSegment
    // archives the previous URL into asset_history.
    const version = Date.now();
    const key = isSplit
      ? r2Keys.segmentRightImage(projectId, segmentId, version)
      : r2Keys.segmentImage(projectId, segmentId, version);
    const up = await uploadBuffer(deg.image, key, deg.degraded ? deg.contentType : out.contentType);

    await finishSegment(segmentId, {
      status: "ready",
      provider: out.provider,
      error: null, // clear any prior-attempt / stall-sweep error on success
      ...(isSplit ? { right_image_url: up.publicUrl } : { image_url: up.publicUrl }),
    });
    // Clear the resume pointer on success so a later regenerate of this segment
    // starts a fresh generation instead of re-polling this now-consumed job.
    await setMediaJob(mediaJobId, {
      status: "completed",
      progress: 100,
      metadata: { provider: out.provider, sixtynineJobId: null, sixtynineKeyIdx: null },
    });
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

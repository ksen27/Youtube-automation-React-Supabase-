import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, logJob } from "@/lib/jobs/db";
import type { AvatarJobData } from "@/lib/jobs/queue";
import { fetchOrThrow, withHttpRetry } from "@/lib/synthetic/http";
import { uploadBuffer } from "@/lib/storage";
import { generateAvatar } from "@/lib/synthetic/heygen";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { finishSegment, maybeFinalizeSynthetic } from "@/worker/processors/synthetic/_shared";
import type { JobAttemptInfo } from "@/worker/index";

// 'avatar' and 'split_2' avatar-half generation via HeyGen Playwright
// automation. The avatar is generated from the project's uploaded avatar image,
// driven by the segment's narration. For split_2 the still half is produced by
// the image-gen processor; THIS processor produces the talking-head video that
// is composited on the left at render time — so both 'avatar' and the
// avatar-bearing 'split_2' segments route here.
//
// Account rotation, cookie sessions, proxy support, screenshots, and failure
// detection all live in generateAvatar(); this processor handles the DB/job
// lifecycle and the final-attempt degrade.
export async function processAvatarJob(data: AvatarJobData, attempt?: JobAttemptInfo): Promise<void> {
  const { projectId, mediaJobId, segmentId } = data;
  const sb = getServerSupabase();
  const isFinalAttempt = (attempt?.attemptsMade ?? 1) >= (attempt?.attemptsAllowed ?? 1);

  await setMediaJob(mediaJobId, { status: "running", progress: 10, metadata: { segmentId } });

  const [{ data: seg, error: segErr }, { data: project, error: projErr }] = await Promise.all([
    sb.from("synthetic_segments").select("id, block_type, script, image_prompt, right_image_url").eq("id", segmentId).single(),
    sb.from("projects").select("avatar_image_url").eq("id", projectId).single(),
  ]);
  if (segErr || !seg) throw new Error(`avatar: segment ${segmentId} not found`);
  if (projErr || !project?.avatar_image_url) {
    throw new Error(`avatar: project ${projectId} has no avatar_image_url`);
  }

  // For split_2 blocks, generate the RIGHT-half still first (idempotent: reused
  // on retry once present). The avatar video becomes the LEFT half, composited
  // at render time by buildSplitScreenAvatarVideo.
  if (seg.block_type === "split_2" && !seg.right_image_url) {
    const t0 = Date.now();
    const prompt = (seg.image_prompt ?? seg.script ?? "a relevant scene").trim();
    await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: "sixtynine_image", phase: "request" });
    const img = await generateImage(prompt);
    await logProviderCall({
      projectId, jobId: mediaJobId, segmentId, provider: img.provider, phase: "response",
      durationMs: Date.now() - t0, cost: { provider: img.provider, images: 1 },
    });
    const up = await uploadBuffer(img.image, r2Keys.segmentRightImage(projectId, segmentId), "image/jpeg");
    await finishSegment(segmentId, { right_image_url: up.publicUrl });
    await setMediaJob(mediaJobId, { progress: 25 });
  }

  // Fetch the uploaded avatar image bytes to feed into the HeyGen upload step.
  const imgRes = await withHttpRetry("avatar.image_fetch", () =>
    fetchOrThrow(project.avatar_image_url as string, { timeoutMs: 60_000 }),
  );
  const imageBytes = Buffer.from(await imgRes.arrayBuffer());

  await setMediaJob(mediaJobId, { progress: 30 });

  try {
    const result = await generateAvatar(
      { projectId, segmentId, jobId: mediaJobId, avatarImageUrl: project.avatar_image_url as string, script: seg.script ?? "" },
      imageBytes,
    );
    // For split_2 the avatar is the LEFT video; the right still is set by the
    // image-gen processor. video_url holds the avatar mp4 either way.
    await finishSegment(segmentId, { status: "ready", video_url: result.videoUrl, provider: "heygen" });
    await setMediaJob(mediaJobId, {
      status: "completed",
      progress: 100,
      metadata: { accountId: result.accountId, seconds: result.seconds },
    });
  } catch (err) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.avatar.failed", {
      err: (err as Error).message?.slice(0, 200),
      isFinalAttempt,
    });
    if (isFinalAttempt) {
      await finishSegment(segmentId, { status: "failed", error: (err as Error).message?.slice(0, 300) });
      await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: (err as Error).message });
      await maybeFinalizeSynthetic(projectId);
      return;
    }
    throw err;
  }

  await maybeFinalizeSynthetic(projectId);
}

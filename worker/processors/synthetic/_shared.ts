import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob, setMediaJob, setProjectStatus, logJob } from "@/lib/jobs/db";
import {
  enqueueImageGeneration,
  enqueueImageToVideo,
  enqueueAvatar,
} from "@/lib/jobs/queue";
import type { SyntheticSegment, ProjectStatus } from "@/lib/types";

// Shared orchestration for the synthetic asset-generation fan-out.
//
// The planner produces synthetic_segments[]; this module fans each segment out
// to the right queue by block_type and, once every segment reaches a terminal
// state (ready/failed/skipped), materializes timeline_items and flips the
// project to ready_for_review. Each segment owns its own media_job so the
// progress screen can show per-block status and offer per-block retry.

// Map a block_type to the queue + media_job type that generates its asset.
//   avatar  -> avatar queue (HeyGen talking-head video)
//   image   -> image_gen queue (nano-banana still)
//   ai_clip -> image_to_video queue (still -> fal.ai; the processor generates
//              the still internally then animates it)
//   split_2 -> avatar queue. A split_2 needs BOTH an avatar video (left) and a
//              still (right). Routing it to a SINGLE queue keeps the segment's
//              one `status` column unambiguous — the avatar processor generates
//              the right still inline (cheap nano-banana call) before/around
//              the avatar video, so the whole block goes ready in one job
//              rather than racing two jobs against one row.
export type SegmentQueue = "image_gen" | "image_to_video" | "avatar";

export function queueForBlockType(blockType: SyntheticSegment["block_type"]): SegmentQueue {
  switch (blockType) {
    case "avatar":
    case "split_2":
      return "avatar";
    case "ai_clip":
      return "image_to_video";
    case "image":
      return "image_gen";
  }
}

/**
 * Fan out every pending segment of a project to its asset queue. Creates one
 * media_job per segment (type matches the queue) and enqueues it. Returns the
 * number of jobs enqueued. Safe to call repeatedly — only 'pending' segments
 * are dispatched, so a retry re-dispatches just the unfinished ones.
 */
export async function dispatchSegments(projectId: string): Promise<number> {
  const sb = getServerSupabase();
  const { data: segs, error } = await sb
    .from("synthetic_segments")
    .select("id, block_type, status")
    .eq("project_id", projectId)
    .eq("status", "pending")
    .order("position", { ascending: true });
  if (error) throw new Error(`dispatchSegments: ${error.message}`);

  let count = 0;
  for (const seg of segs ?? []) {
    const queue = queueForBlockType(seg.block_type);
    const mediaType =
      queue === "avatar" ? "avatar" : queue === "image_to_video" ? "image_to_video" : "image_gen";
    const mediaJobId = await createMediaJob({
      projectId,
      type: mediaType,
      metadata: { segmentId: seg.id, blockType: seg.block_type },
    });
    // Stamp the segment as generating + link its job so the UI can correlate.
    await sb
      .from("synthetic_segments")
      .update({ status: "generating", metadata: { mediaJobId } })
      .eq("id", seg.id);

    if (queue === "avatar") {
      await enqueueAvatar({ projectId, mediaJobId, segmentId: seg.id });
    } else if (queue === "image_to_video") {
      await enqueueImageToVideo({ projectId, mediaJobId, segmentId: seg.id });
    } else {
      await enqueueImageGeneration({ projectId, mediaJobId, segmentId: seg.id });
    }
    count++;
  }
  await logJob({ projectId }, "synthetic.dispatch", { enqueued: count });
  return count;
}

// Pick the most descriptive in-progress project status from the segment mix
// still being generated, so the progress screen's headline reflects the
// dominant outstanding work.
function inProgressStatus(blockTypesPending: Set<string>): ProjectStatus {
  if (blockTypesPending.has("avatar") || blockTypesPending.has("split_2")) return "generating_avatars";
  if (blockTypesPending.has("ai_clip")) return "generating_clips";
  return "generating_images";
}

/**
 * Called by each asset processor when it finishes a segment. Checks whether the
 * whole project's asset generation has drained; if so, materializes the
 * timeline and advances to ready_for_review. Otherwise nudges the project
 * status to reflect the remaining work. Idempotent + safe under concurrency.
 */
export async function maybeFinalizeSynthetic(projectId: string): Promise<void> {
  const sb = getServerSupabase();
  const { data: segs } = await sb
    .from("synthetic_segments")
    .select("id, block_type, status, position, start_time, duration, script, image_url, video_url, right_image_url")
    .eq("project_id", projectId)
    .order("position", { ascending: true });
  const all = (segs ?? []) as Array<Pick<SyntheticSegment,
    "id" | "block_type" | "status" | "position" | "start_time" | "duration" | "script" | "image_url" | "video_url" | "right_image_url">>;
  if (all.length === 0) return;

  const pending = all.filter((s) => s.status === "pending" || s.status === "generating");
  if (pending.length > 0) {
    // Still working — keep the status meaningful for the progress screen.
    await setProjectStatus(projectId, inProgressStatus(new Set(pending.map((s) => s.block_type))));
    return;
  }

  // Guard against double-finalize: if timeline_items already exist for this
  // project's synthetic blocks, don't re-materialize.
  const { count: existing } = await sb
    .from("timeline_items")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  if ((existing ?? 0) > 0) {
    await setProjectStatus(projectId, "ready_for_review");
    return;
  }

  // Materialize timeline_items from ready segments (skipped/failed are dropped;
  // their narration time is absorbed by neighbours at render via durations).
  const ready = all.filter((s) => s.status === "ready");
  const rows = ready.map((s, idx) => ({
    project_id: projectId,
    type: s.block_type, // 'avatar' | 'image' | 'ai_clip' | 'split_2'
    position: idx,
    start_time: s.start_time,
    duration: s.duration,
    script_text: s.script,
    image_url: s.image_url,
    video_url: s.video_url,
    right_image_url: s.right_image_url,
    approved: false,
    metadata: { synthetic_segment_id: s.id },
  }));
  if (rows.length > 0) {
    const { error } = await sb.from("timeline_items").insert(rows);
    if (error) throw new Error(`maybeFinalizeSynthetic materialize: ${error.message}`);
  }
  await setProjectStatus(projectId, "ready_for_review");
  await logJob({ projectId }, "synthetic.finalize", {
    materialized: rows.length,
    failed: all.filter((s) => s.status === "failed").length,
  });
}

// Convenience: set a segment terminal state + (optionally) its media_job.
export async function finishSegment(
  segmentId: string,
  patch: Partial<Pick<SyntheticSegment, "status" | "image_url" | "video_url" | "right_image_url" | "provider" | "error">>,
): Promise<void> {
  const sb = getServerSupabase();
  const { error } = await sb.from("synthetic_segments").update(patch).eq("id", segmentId);
  if (error) throw new Error(`finishSegment: ${error.message}`);
}

// Re-export so processors import job helpers from one place if they prefer.
export { setMediaJob };

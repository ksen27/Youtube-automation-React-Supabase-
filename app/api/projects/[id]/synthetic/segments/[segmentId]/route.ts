import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob } from "@/lib/jobs/db";
import { enqueueImageGeneration, enqueueImageToVideo, enqueueAvatar, queuePriority } from "@/lib/jobs/queue";
import { queueForBlockType, resetSegmentForRegen } from "@/worker/processors/synthetic/_shared";
import type { SyntheticBlockType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Patch = z.object({
  blockType: z.enum(["avatar", "image", "ai_clip", "split_2"]).optional(),
  imagePrompt: z.string().max(4000).optional(),
  animationPrompt: z.string().max(4000).optional(),
  script: z.string().max(8000).optional(),
});

async function loadSegment(projectId: string, segmentId: string) {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("synthetic_segments")
    .select("id, project_id, block_type")
    .eq("id", segmentId)
    .eq("project_id", projectId)
    .single();
  return data;
}

// Edit a segment's type/prompts/script (review screen: Change Type, Edit
// Prompt). Does NOT regenerate — the user calls POST (regenerate) after.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; segmentId: string }> }) {
  const { id, segmentId } = await ctx.params;
  const body = Patch.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "invalid input", issues: body.error.flatten() }, { status: 400 });
  }
  const seg = await loadSegment(id, segmentId);
  if (!seg) return NextResponse.json({ error: "segment not found" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (body.data.blockType) patch.block_type = body.data.blockType;
  if (body.data.imagePrompt !== undefined) patch.image_prompt = body.data.imagePrompt;
  if (body.data.animationPrompt !== undefined) patch.animation_prompt = body.data.animationPrompt;
  if (body.data.script !== undefined) patch.script = body.data.script;

  const sb = getServerSupabase();
  const { data, error } = await sb.from("synthetic_segments").update(patch).eq("id", segmentId).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ segment: data });
}

// Delete a segment (review screen: Delete). The timeline_item materialized from
// it (if any) is also removed so a re-render doesn't include it.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; segmentId: string }> }) {
  const { id, segmentId } = await ctx.params;
  const seg = await loadSegment(id, segmentId);
  if (!seg) return NextResponse.json({ error: "segment not found" }, { status: 404 });

  const sb = getServerSupabase();
  await sb.from("timeline_items").delete().eq("project_id", id).contains("metadata", { synthetic_segment_id: segmentId });
  const { error } = await sb.from("synthetic_segments").delete().eq("id", segmentId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// Regenerate a single segment's asset (review screen: Regenerate). Resets the
// segment, keeps its prior asset urls (finishSegment archives them), and
// re-enqueues it to the right queue based on its (possibly just-edited)
// block_type.
//
// Query/body ?imageOnly=1 (split_2 only): regenerate ONLY the right-half image
// and KEEP the avatar video — used by the per-row "Regenerate image" button.
// Ignored for non-split_2 blocks (they have one asset; a normal regenerate is
// already image-only for `image`/`ai_clip`).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; segmentId: string }> }) {
  const { id, segmentId } = await ctx.params;
  const seg = await loadSegment(id, segmentId);
  if (!seg) return NextResponse.json({ error: "segment not found" }, { status: 404 });

  const url = new URL(req.url);
  const imageOnly = url.searchParams.get("imageOnly") === "1";

  const blockType = seg.block_type as SyntheticBlockType;
  const queue = queueForBlockType(blockType);
  const mediaType = queue === "avatar" ? "avatar" : queue === "image_to_video" ? "image_to_video" : "image_gen";

  const sb = getServerSupabase();
  // Keep the current asset urls in place — finishSegment archives them into
  // asset_history before writing the new one, and the old asset stays visible
  // until the new one lands. Only flip status + clear error.
  // A full (non-imageOnly) regen of an image-bearing block must drop the cached
  // still (clearStill) so the processor generates a FRESH one from the (possibly
  // just-edited) prompt. Otherwise a still that a provider content-filtered (e.g.
  // LTX image-to-video) is re-sent UNCHANGED on every Retry — the image, not the
  // prompt, is what gets filtered — so it could never clear. clearStill archives
  // the old asset first, so Restore still recovers it. Avatar (HeyGen render) and
  // split_2 imageOnly (keeps the avatar video) intentionally keep their asset.
  const clearStill = !imageOnly && (blockType === "image" || blockType === "ai_clip");
  await resetSegmentForRegen([segmentId], "generating", { clearStill });
  // Drop any timeline_item materialized from a prior run so finalize re-creates it.
  await sb.from("timeline_items").delete().eq("project_id", id).contains("metadata", { synthetic_segment_id: segmentId });

  const mediaJobId = await createMediaJob({ projectId: id, type: mediaType, metadata: { segmentId, regenerate: true } });
  if (queue === "avatar") await enqueueAvatar({ projectId: id, mediaJobId, segmentId, imageOnly: imageOnly && blockType === "split_2" });
  else if (queue === "image_to_video") {
    // A hand-retried block is the most urgent thing in the queue: someone is on
    // the review screen waiting for exactly this one, so it outranks even the
    // current project's bulk dispatch.
    await enqueueImageToVideo({ projectId: id, mediaJobId, segmentId }, { priority: queuePriority() });
  }
  else await enqueueImageGeneration({ projectId: id, mediaJobId, segmentId });

  return NextResponse.json({ ok: true, media_job_id: mediaJobId }, { status: 202 });
}

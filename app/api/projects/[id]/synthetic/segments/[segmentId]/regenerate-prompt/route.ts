import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { checkProjectEngine } from "@/lib/jobs/db";
import { regenerateSegmentPrompt } from "@/lib/synthetic/planner";
import type { SyntheticBlockType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-segment "Regenerate prompt" (review screen). Re-runs Gemini for THIS one
// block's script — using the same single-subject / no-text rules as the full
// planner — and overwrites the segment's image_prompt with a fresh one. Does
// NOT regenerate the image: the user reviews the new prompt, then clicks the
// existing Regenerate to rebuild the asset. avatar blocks have no image prompt
// and are rejected.
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; segmentId: string }> },
) {
  const { id, segmentId } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(segmentId).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const eng = await checkProjectEngine(id, "synthetic");
  if (!eng.ok) {
    return eng.status === 404
      ? NextResponse.json({ error: "project not found" }, { status: 404 })
      : NextResponse.json({ error: "not an AI Avatar (synthetic) project" }, { status: 400 });
  }

  const sb = getServerSupabase();
  const { data: seg, error: segErr } = await sb
    .from("synthetic_segments")
    .select("id, block_type, script, metadata")
    .eq("id", segmentId)
    .eq("project_id", id)
    .single();
  if (segErr || !seg) return NextResponse.json({ error: "segment not found" }, { status: 404 });

  const blockType = seg.block_type as SyntheticBlockType;
  if (blockType === "avatar") {
    return NextResponse.json({ error: "avatar blocks have no image prompt to regenerate" }, { status: 400 });
  }

  // Recover the video's shared base prompt. It is stamped on every segment's
  // metadata.base_prompt at plan time, but dispatchSegments overwrites a
  // segment's metadata with { mediaJobId } once it generates — so THIS row may
  // no longer carry it. Fall back to any sibling segment in the project that
  // still has it (the base prompt is identical project-wide).
  let basePrompt = ((seg.metadata as { base_prompt?: string } | null)?.base_prompt ?? "").trim();
  if (!basePrompt) {
    const { data: siblings } = await sb
      .from("synthetic_segments")
      .select("metadata")
      .eq("project_id", id)
      .not("metadata->base_prompt", "is", null)
      .limit(1);
    basePrompt = ((siblings?.[0]?.metadata as { base_prompt?: string } | null)?.base_prompt ?? "").trim();
  }

  let result;
  try {
    result = await regenerateSegmentPrompt({
      projectId: id,
      script: (seg.script as string) ?? "",
      basePrompt,
      blockType,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  // Persist the new prompt only — the user regenerates the image afterward.
  const patch: Record<string, unknown> = { image_prompt: result.imagePrompt };
  if (blockType === "ai_clip") patch.animation_prompt = result.animationPrompt;
  const { data: updated, error: updErr } = await sb
    .from("synthetic_segments")
    .update(patch)
    .eq("id", segmentId)
    .select("*")
    .single();
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ segment: updated });
}

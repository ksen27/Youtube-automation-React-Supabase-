import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { checkProjectEngine, setProjectStatus } from "@/lib/jobs/db";
import { dispatchSegments, resetSegmentForRegen } from "@/worker/processors/synthetic/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bulk "Regenerate all" for the review screen. Resets the targeted segments
// back to 'pending' (clearing prior asset urls + errors), then fans them ALL
// out at once via dispatchSegments — the worker then renders them in PARALLEL
// up to IMAGE_GEN_CONCURRENCY, instead of the user clicking Retry per row.
//
// Body: { scope?: "failed" | "incomplete" | "images" | "all" }  (default "failed")
//   failed     -> only segments whose status is 'failed'
//   incomplete -> failed + anything not yet 'ready' (failed/pending/generating),
//                 useful to kick a batch that stalled mid-run.
//   images     -> EVERY image-bearing block (image / ai_clip / split_2),
//                 regardless of status. Used to re-test a prompt change (e.g. a
//                 new STYLE_PROMPT) on an EXISTING project without re-planning
//                 or making a new project. Avatars are left untouched — the
//                 client is happy with them and re-rendering them is slow/costly.
//   all        -> every segment, any status, including avatars.
const Body = z.object({
  scope: z.enum(["failed", "incomplete", "images", "all"]).optional(),
});

// Block types that produce a generated IMAGE (and so are affected by an image
// prompt / STYLE_PROMPT change). avatar is excluded — it is HeyGen-driven and
// carries no image prompt.
const IMAGE_BLOCK_TYPES = ["image", "ai_clip", "split_2"] as const;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const eng = await checkProjectEngine(id, "synthetic");
  if (!eng.ok) {
    return eng.status === 404
      ? NextResponse.json({ error: "project not found" }, { status: 404 })
      : NextResponse.json({ error: "not an AI Avatar (synthetic) project" }, { status: 400 });
  }

  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "invalid input", issues: body.error.flatten() }, { status: 400 });
  }
  const scope = body.data.scope ?? "failed";

  const sb = getServerSupabase();

  // Build the target query. status-based scopes filter on status; the
  // prompt-retest scopes ("images"/"all") ignore status and instead target by
  // block type so a READY segment is re-generated too (that's the whole point —
  // re-run already-good blocks against the new prompt).
  let query = sb.from("synthetic_segments").select("id").eq("project_id", id);
  if (scope === "images") {
    query = query.in("block_type", IMAGE_BLOCK_TYPES as unknown as string[]);
  } else if (scope === "all") {
    // no extra filter — every segment
  } else {
    const statuses = scope === "incomplete"
      ? ["failed", "pending", "generating"]
      : ["failed"];
    query = query.in("status", statuses);
  }

  // Reset the targeted segments to 'pending' and clear prior asset state so
  // dispatchSegments (which only picks up 'pending') re-enqueues them. We also
  // drop any timeline_items materialized from a prior run for these segments.
  const { data: targets, error: selErr } = await query;
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });

  const ids = (targets ?? []).map((t) => t.id);
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, enqueued: 0, note: "nothing to regenerate" }, { status: 200 });
  }

  // Keep current asset urls — finishSegment archives them into asset_history
  // before writing the new ones, and the old assets stay visible until the new
  // ones land. Reset to 'pending' so dispatchSegments re-enqueues them.
  try {
    await resetSegmentForRegen(ids, "pending");
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  for (const segId of ids) {
    await sb
      .from("timeline_items")
      .delete()
      .eq("project_id", id)
      .contains("metadata", { synthetic_segment_id: segId });
  }

  // Fan everything out at once — the worker renders them concurrently. For the
  // "images" scope, split_2 blocks regenerate ONLY their right still (the avatar
  // video is kept) and pure-avatar blocks are skipped entirely.
  const enqueued = await dispatchSegments(id, { imageOnly: scope === "images" });
  if (enqueued > 0) await setProjectStatus(id, "generating_images");

  return NextResponse.json({ ok: true, enqueued }, { status: 202 });
}

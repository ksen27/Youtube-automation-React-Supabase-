import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { checkProjectEngine, setProjectStatus } from "@/lib/jobs/db";
import { dispatchSegments } from "@/worker/processors/synthetic/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Review-gate "Generate" button. The planner stopped at 'plan_ready'; this
// fans the (possibly user-edited) segments out to the asset-generation queues.
// Idempotent: dispatchSegments only enqueues 'pending' segments, so re-clicking
// after a partial run re-dispatches just the unfinished ones.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

  const sb = getServerSupabase();
  // Must have a plan to generate from.
  const { count } = await sb
    .from("synthetic_segments")
    .select("id", { count: "exact", head: true })
    .eq("project_id", id);
  if (!count || count === 0) {
    return NextResponse.json({ error: "no plan to generate — build the plan first" }, { status: 400 });
  }

  // Don't double-start asset generation.
  const { data: open } = await sb
    .from("media_jobs").select("id")
    .eq("project_id", id)
    .in("type", ["image_gen", "image_to_video", "avatar"])
    .in("status", ["queued", "running"]).limit(1);
  if ((open ?? []).length > 0) {
    return NextResponse.json({ error: "asset generation already in progress" }, { status: 409 });
  }

  const enqueued = await dispatchSegments(id);
  // dispatchSegments flips the status via maybeFinalize later; set an immediate
  // in-progress status so the UI leaves the review gate right away.
  if (enqueued > 0) await setProjectStatus(id, "generating_images");

  return NextResponse.json({ ok: true, enqueued }, { status: 202 });
}

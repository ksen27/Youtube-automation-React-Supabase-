import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { checkProjectEngine, setProjectStatus } from "@/lib/jobs/db";
import { dispatchSegments } from "@/worker/processors/synthetic/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bulk "Regenerate all" for the review screen. Resets the targeted segments
// back to 'pending' (clearing prior asset urls + errors), then fans them ALL
// out at once via dispatchSegments — the worker then renders them in PARALLEL
// up to IMAGE_GEN_CONCURRENCY, instead of the user clicking Retry per row.
//
// Body: { scope?: "failed" | "incomplete" }  (default "failed")
//   failed     -> only segments whose status is 'failed'
//   incomplete -> failed + anything not yet 'ready' (failed/pending/generating),
//                 useful to kick a batch that stalled mid-run.
const Body = z.object({
  scope: z.enum(["failed", "incomplete"]).optional(),
});

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
  const statuses = scope === "incomplete"
    ? ["failed", "pending", "generating"]
    : ["failed"];

  const sb = getServerSupabase();

  // Reset the targeted segments to 'pending' and clear prior asset state so
  // dispatchSegments (which only picks up 'pending') re-enqueues them. We also
  // drop any timeline_items materialized from a prior run for these segments.
  const { data: targets, error: selErr } = await sb
    .from("synthetic_segments")
    .select("id")
    .eq("project_id", id)
    .in("status", statuses);
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });

  const ids = (targets ?? []).map((t) => t.id);
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, enqueued: 0, note: "nothing to regenerate" }, { status: 200 });
  }

  const { error: updErr } = await sb
    .from("synthetic_segments")
    .update({ status: "pending", image_url: null, video_url: null, right_image_url: null, error: null })
    .in("id", ids);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  for (const segId of ids) {
    await sb
      .from("timeline_items")
      .delete()
      .eq("project_id", id)
      .contains("metadata", { synthetic_segment_id: segId });
  }

  // Fan everything out at once — the worker renders them concurrently.
  const enqueued = await dispatchSegments(id);
  if (enqueued > 0) await setProjectStatus(id, "generating_images");

  return NextResponse.json({ ok: true, enqueued }, { status: 202 });
}

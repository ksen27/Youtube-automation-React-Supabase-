import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { checkProjectEngine } from "@/lib/jobs/db";
import { maybeFinalizeSynthetic } from "@/worker/processors/synthetic/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Restore a PREVIOUS asset version (review screen: history "Restore"). Swaps the
// chosen asset_history entry into the live image_url/video_url/right_image_url
// columns, archives the currently-live asset back into history (so nothing is
// lost and you can flip between versions), re-materializes the timeline_item so
// the render uses the restored asset, and leaves the segment 'ready'.
//
// Body: { index: number }  — 0-based index into asset_history (newest last).
const Body = z.object({ index: z.number().int().min(0) });

interface AssetVersion {
  image_url: string | null;
  video_url: string | null;
  right_image_url: string | null;
  provider: string | null;
  created_at?: string;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; segmentId: string }> }) {
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
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "invalid input", issues: body.error.flatten() }, { status: 400 });
  }

  const sb = getServerSupabase();
  const { data: seg, error: segErr } = await sb
    .from("synthetic_segments")
    .select("id, image_url, video_url, right_image_url, provider, asset_history")
    .eq("id", segmentId)
    .eq("project_id", id)
    .single();
  if (segErr || !seg) return NextResponse.json({ error: "segment not found" }, { status: 404 });

  const history: AssetVersion[] = Array.isArray(seg.asset_history) ? (seg.asset_history as AssetVersion[]) : [];
  const target = history[body.data.index];
  if (!target) {
    return NextResponse.json({ error: `no history version at index ${body.data.index}` }, { status: 404 });
  }

  // Archive the currently-live asset back into history (replacing the slot we're
  // restoring FROM), so the version you're leaving isn't lost and you can switch
  // back. Then make the chosen version live.
  const currentLive: AssetVersion = {
    image_url: (seg.image_url as string | null) ?? null,
    video_url: (seg.video_url as string | null) ?? null,
    right_image_url: (seg.right_image_url as string | null) ?? null,
    provider: (seg.provider as string | null) ?? null,
    created_at: new Date().toISOString(),
  };
  const newHistory = history.slice();
  newHistory[body.data.index] = currentLive; // swap: the version we restored is now live; the old live takes its slot

  const { error: updErr } = await sb
    .from("synthetic_segments")
    .update({
      image_url: target.image_url ?? null,
      video_url: target.video_url ?? null,
      right_image_url: target.right_image_url ?? null,
      provider: target.provider ?? null,
      status: "ready",
      error: null,
      asset_history: newHistory,
    })
    .eq("id", segmentId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Drop the stale timeline_item for this segment, then reconcile so it is
  // re-materialized from the restored asset urls.
  await sb.from("timeline_items").delete().eq("project_id", id).contains("metadata", { synthetic_segment_id: segmentId });
  try {
    await maybeFinalizeSynthetic(id);
  } catch (e) {
    // The asset swap succeeded; a finalize hiccup just means the timeline_item
    // re-materializes on the next finalize. Surface it but don't fail the swap.
    return NextResponse.json({ ok: true, warning: `restored, but re-materialize failed: ${(e as Error).message}` });
  }

  return NextResponse.json({ ok: true });
}

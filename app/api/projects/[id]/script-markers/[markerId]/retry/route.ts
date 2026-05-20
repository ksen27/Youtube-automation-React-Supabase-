import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob } from "@/lib/jobs/db";
import { enqueueScriptClip } from "@/lib/jobs/queue";

// Re-enqueues a single script-doc marker's download job. Idempotent: even
// if the marker is currently 'ready' we still allow retry — the user might
// want to refetch after a doc edit. The processor is itself idempotent
// (uploads overwrite by key naming, status flips back to 'downloading').

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; markerId: string }> },
) {
  const { id, markerId } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid project id" }, { status: 400 });
  }
  if (!z.string().uuid().safeParse(markerId).success) {
    return NextResponse.json({ error: "invalid marker id" }, { status: 400 });
  }

  const sb = getServerSupabase();
  const { data: marker, error: loadErr } = await sb
    .from("project_script_markers")
    .select("id, project_id, kind, youtube_url, ordinal")
    .eq("id", markerId)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!marker) return NextResponse.json({ error: "marker not found" }, { status: 404 });
  if (marker.project_id !== id) {
    return NextResponse.json({ error: "marker does not belong to this project" }, { status: 403 });
  }
  if (!marker.youtube_url) {
    return NextResponse.json(
      { error: "marker has no YouTube URL — nothing to retry" },
      { status: 400 },
    );
  }

  // Flip the row to 'pending' so the UI immediately shows the retry took
  // effect. The processor will move it to 'downloading' once it picks up.
  const { error: updErr } = await sb
    .from("project_script_markers")
    .update({
      download_status: "pending",
      download_error: null,
      download_updated_at: new Date().toISOString(),
    })
    .eq("id", markerId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  const mediaJobId = await createMediaJob({
    projectId: id,
    type: "script_clip",
    metadata: { markerId, kind: marker.kind, ordinal: marker.ordinal, retry: true },
  });
  await enqueueScriptClip({ projectId: id, mediaJobId, markerId });

  return NextResponse.json({ ok: true, mediaJobId });
}

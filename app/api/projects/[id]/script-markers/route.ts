import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";

// Lists all script-doc markers for a project, ordered by ordinal so the UI
// can group them into intro / title-card / lower-third sections without
// extra sort work client-side. Polled by the intake screen to show per-clip
// download status while the worker is processing them.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("project_script_markers")
    .select(
      "id, kind, text, ordinal, paragraph_index, char_offset, youtube_url, start_seconds, end_seconds, download_status, download_error, clip_storage_url, audio_storage_url, download_updated_at",
    )
    .eq("project_id", id)
    .order("ordinal");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const markers = data ?? [];
  // Pre-compute a project-level gate: any marker with a youtube_url that's
  // not yet 'ready' or 'failed' means the project is still waiting on at
  // least one clip. The UI uses this to disable Generate.
  const clipMarkers = markers.filter((m) => m.youtube_url);
  const allClipsReady = clipMarkers.every(
    (m) => m.download_status === "ready" || m.download_status === "failed",
  );
  const anyClipFailed = clipMarkers.some((m) => m.download_status === "failed");
  const stillDownloading = clipMarkers.filter(
    (m) => m.download_status === "downloading" || m.download_status === "pending",
  ).length;

  return NextResponse.json({
    markers,
    summary: {
      total: markers.length,
      clips: clipMarkers.length,
      ready: clipMarkers.filter((m) => m.download_status === "ready").length,
      downloading: clipMarkers.filter((m) => m.download_status === "downloading").length,
      pending: clipMarkers.filter((m) => m.download_status === "pending").length,
      failed: clipMarkers.filter((m) => m.download_status === "failed").length,
      allClipsReady,
      anyClipFailed,
      stillDownloading,
    },
  });
}

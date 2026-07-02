import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live synthetic-pipeline state for the generation-progress + review screens.
// Returns the project, all media_jobs (so the progress screen can aggregate
// per-step), and all synthetic_segments (so it can show per-block status +
// thumbnails and the review screen can render the timeline).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const sb = getServerSupabase();

  const [projectRes, mediaRes, segmentsRes] = await Promise.all([
    sb.from("projects")
      .select("id, title, engine, status, voiceover_url, voiceover_duration_seconds, avatar_image_url, heygen_avatar_name, voiceover_source, tts_voice_id, transcript, script_doc_url, avatar_mark_ranges, pitch_video_url, pitch_video_duration_seconds, pitch_video_insert_seconds")
      .eq("id", id).single(),
    sb.from("media_jobs")
      .select("id, type, status, progress, attempts, error, metadata, created_at, updated_at")
      .eq("project_id", id).order("created_at", { ascending: true }),
    sb.from("synthetic_segments")
      .select("id, position, block_type, avatar_model, start_time, end_time, duration, script, image_prompt, animation_prompt, status, image_url, video_url, right_image_url, provider, error, metadata, asset_history")
      .eq("project_id", id).order("position", { ascending: true }),
  ]);

  // Surface real DB errors instead of collapsing them into a blank 404. A
  // missing migration column/table (e.g. avatar_image_url, voiceover_source,
  // synthetic_segments) errors here — returning that message tells us exactly
  // what's wrong rather than a misleading "project not found".
  // PGRST116 = "no rows" from .single(), which is a genuine 404.
  const firstError = projectRes.error ?? mediaRes.error ?? segmentsRes.error;
  if (firstError && (firstError as { code?: string }).code !== "PGRST116") {
    return NextResponse.json(
      { error: "synthetic query failed", detail: firstError.message },
      { status: 500 },
    );
  }

  const project = projectRes.data;
  const mediaJobs = mediaRes.data;
  const segments = segmentsRes.data;

  if (!project) {
    // Distinguish "row genuinely absent" from "exists but wrong engine" so the
    // UI/logs aren't misleading. A sourced project hitting the synthetic route
    // would also land here.
    const { data: existing } = await sb.from("projects").select("id, engine").eq("id", id).maybeSingle();
    const detail = !existing
      ? "no project row with this id"
      : `project exists but engine=${existing.engine ?? "null"} (not synthetic)`;
    return NextResponse.json({ error: "project not found", detail }, { status: 404 });
  }

  // Roll up segment counts so the UI can render completed/total per block type
  // without re-deriving it client-side.
  const segs = segments ?? [];
  const total = segs.length;
  const ready = segs.filter((s) => s.status === "ready").length;
  const failed = segs.filter((s) => s.status === "failed").length;
  const generating = segs.filter((s) => s.status === "generating" || s.status === "pending").length;

  return NextResponse.json({
    project,
    media_jobs: mediaJobs ?? [],
    segments: segs,
    summary: { total, ready, failed, generating },
  });
}

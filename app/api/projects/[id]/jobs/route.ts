import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const sb = getServerSupabase();
  const [
    { data: media },
    { data: render },
    { data: project },
    { data: sources },
    { data: clipRows },
  ] = await Promise.all([
    sb.from("media_jobs").select("*").eq("project_id", id).order("created_at", { ascending: true }),
    sb.from("render_jobs").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    sb.from("projects").select("status").eq("id", id).single(),
    sb.from("video_sources")
      .select("id, youtube_video_id, title, status, error, duration_seconds")
      .eq("project_id", id),
    sb.from("video_clips")
      .select("video_source_id, status")
      .eq("project_id", id),
  ]);

  // Roll clip counts up per source so the UI can show "3/5 cut" without
  // re-fetching the clips list separately on every poll.
  const clipsBySource = new Map<string, number>();
  for (const c of clipRows ?? []) {
    if (!c.video_source_id) continue;
    clipsBySource.set(c.video_source_id, (clipsBySource.get(c.video_source_id) ?? 0) + 1);
  }

  const enrichedSources = (sources ?? []).map((s) => ({
    ...s,
    clip_count: clipsBySource.get(s.id) ?? 0,
  }));

  return NextResponse.json({
    project_status: project?.status ?? null,
    media_jobs: media ?? [],
    render_jobs: render ?? [],
    video_sources: enrichedSources,
  });
}

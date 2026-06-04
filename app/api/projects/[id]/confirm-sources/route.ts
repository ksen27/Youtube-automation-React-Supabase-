import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob, setProjectStatus, logJob } from "@/lib/jobs/db";
import { enqueueDownload } from "@/lib/jobs/queue";
import { recordApprovedSource } from "@/lib/youtube/search";

// Persist the user's video selection from the Analyze & Search screen, then
// kick off the existing download pipeline (one media_job per accepted video).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  selectedVideoIds: z.array(z.string().min(1)).min(1).max(50),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  const sb = getServerSupabase();
  const { data: candidates, error: candErr } = await sb
    .from("youtube_search_results")
    .select("youtube_video_id, url, title, channel_id, channel_title, duration_seconds, metadata")
    .eq("project_id", id)
    .in("youtube_video_id", parsed.data.selectedVideoIds);
  if (candErr) return NextResponse.json({ error: candErr.message }, { status: 500 });
  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ error: "no matching candidates" }, { status: 400 });
  }

  // Block double-confirm if downloads are already in flight.
  const { data: openDownloads } = await sb
    .from("media_jobs")
    .select("id")
    .eq("project_id", id)
    .eq("type", "download")
    .in("status", ["queued", "running"])
    .limit(1);
  if ((openDownloads ?? []).length > 0) {
    return NextResponse.json({ error: "downloads already in progress" }, { status: 409 });
  }

  // Mark winners selected, losers rejected.
  const winners = new Set(candidates.map((c) => c.youtube_video_id));
  const { error: updWinErr } = await sb
    .from("youtube_search_results")
    .update({ status: "selected" })
    .eq("project_id", id)
    .in("youtube_video_id", Array.from(winners));
  if (updWinErr) return NextResponse.json({ error: updWinErr.message }, { status: 500 });

  await sb
    .from("youtube_search_results")
    .update({ status: "rejected" })
    .eq("project_id", id)
    .eq("status", "candidate");

  await setProjectStatus(id, "downloading");

  // Record each confirmed source as APPROVED for its entity — cross-project
  // memory (Phase 3). A future project featuring the same celebrity re-surfaces
  // these as top-ranked candidates at zero API cost. Best-effort: an approval
  // write failure must not block the download pipeline.
  for (const c of candidates) {
    const md = (c.metadata ?? {}) as Record<string, unknown>;
    const entityValue = typeof md.entity_value === "string" ? md.entity_value
      : typeof md.intended_subject === "string" ? md.intended_subject : "";
    if (!entityValue) continue;
    try {
      await recordApprovedSource({
        entityValue,
        entityType: typeof md.entity_type === "string" ? md.entity_type : null,
        fromProjectId: id,
        video: {
          youtubeVideoId: c.youtube_video_id,
          url: c.url ?? null,
          title: c.title ?? null,
          channelId: c.channel_id ?? null,
          channelTitle: c.channel_title ?? null,
          durationSeconds: c.duration_seconds ?? null,
        },
      });
    } catch (e) {
      await logJob({ projectId: id }, "confirm_sources.approve_failed", {
        videoId: c.youtube_video_id, err: (e as Error).message?.slice(0, 160),
      });
    }
  }

  for (const c of candidates) {
    const url = c.url ?? `https://www.youtube.com/watch?v=${c.youtube_video_id}`;
    const childJobId = await createMediaJob({
      projectId: id,
      type: "download",
      metadata: { youtube_video_id: c.youtube_video_id, youtube_url: url, title: c.title },
    });
    await enqueueDownload({
      projectId: id,
      mediaJobId: childJobId,
      youtubeVideoId: c.youtube_video_id,
      youtubeUrl: url,
      title: c.title,
    });
  }

  await logJob({ projectId: id }, "confirm_sources.queued", { count: candidates.length });
  return NextResponse.json({ ok: true, queued: candidates.length });
}

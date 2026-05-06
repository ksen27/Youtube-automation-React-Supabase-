import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob, logJob } from "@/lib/jobs/db";
import { enqueueDownload } from "@/lib/jobs/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Re-queue download jobs that hit a terminal failure. We create *new* media_jobs
// rather than flipping the failed rows back to "queued" so the failure history
// is preserved (useful for debugging which sources kept failing).
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const sb = getServerSupabase();

  const { data: failed, error } = await sb
    .from("media_jobs")
    .select("id, metadata")
    .eq("project_id", id)
    .eq("type", "download")
    .eq("status", "failed");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!failed || failed.length === 0) {
    return NextResponse.json({ ok: true, requeued: 0 });
  }

  let requeued = 0;
  for (const job of failed) {
    const md = (job.metadata ?? {}) as Record<string, unknown>;
    const youtubeVideoId = typeof md.youtube_video_id === "string" ? md.youtube_video_id : null;
    const youtubeUrl = typeof md.youtube_url === "string" ? md.youtube_url : null;
    if (!youtubeVideoId || !youtubeUrl) continue;
    const title = typeof md.title === "string" ? md.title : null;

    const newJobId = await createMediaJob({
      projectId: id,
      type: "download",
      metadata: { ...md, retried_from: job.id },
    });
    await enqueueDownload({
      projectId: id,
      mediaJobId: newJobId,
      youtubeVideoId,
      youtubeUrl,
      title,
    });
    requeued++;
  }

  await logJob({ projectId: id }, "retry-failed.requeued", { requeued, totalFailed: failed.length });
  return NextResponse.json({ ok: true, requeued });
}

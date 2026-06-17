import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob, setProjectStatus, checkProjectEngine } from "@/lib/jobs/db";
import { enqueueSearch } from "@/lib/jobs/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  // Celebrity (sourced) pipeline only. Reject AI Avatar projects so they can't
  // be pushed into the YouTube search/download flow.
  const eng = await checkProjectEngine(id, "sourced");
  if (!eng.ok) {
    return eng.status === 404
      ? NextResponse.json({ error: "project not found" }, { status: 404 })
      : NextResponse.json({ error: "not a celebrity (sourced) project" }, { status: 400 });
  }
  const sb = getServerSupabase();
  const { data: project, error } = await sb.from("projects").select("*").eq("id", id).single();
  if (error || !project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  if (!project.transcript || !project.transcript.trim()) {
    return NextResponse.json({ error: "transcript required before generation" }, { status: 400 });
  }

  // Refuse to start if there's already an active pipeline media_job
  const { data: open } = await sb
    .from("media_jobs")
    .select("id, type, status")
    .eq("project_id", id)
    .in("status", ["queued", "running"])
    .limit(1);
  if ((open ?? []).length > 0) {
    return NextResponse.json({ error: "generation already in progress" }, { status: 409 });
  }

  const mediaJobId = await createMediaJob({ projectId: id, type: "search" });
  await enqueueSearch({ projectId: id, mediaJobId });
  await setProjectStatus(id, "extracting");

  return NextResponse.json({ ok: true, media_job_id: mediaJobId }, { status: 202 });
}

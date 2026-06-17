import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { checkProjectEngine, createMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { enqueueTts, enqueueSyntheticPlanner } from "@/lib/jobs/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Retry a FAILED synthetic pipeline step (voiceover / alignment / planner).
// Asset steps (images/clips/avatars) have their own per-segment retry; this is
// for the early stages that have no segment to retry against.
//
// Body: { step: "voiceover" | "planner" }  (alignment is part of the tts job,
// so retrying it == retrying "voiceover").
//   voiceover -> re-enqueue the TTS job (regenerates audio + alignment, then
//                the planner runs and stops at the review gate)
//   planner   -> re-enqueue just the planner (voiceover already succeeded)
const Body = z.object({ step: z.enum(["voiceover", "planner"]) });

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

  const sb = getServerSupabase();
  // Don't double-run: block if any pipeline job is already in flight.
  const { data: open } = await sb
    .from("media_jobs").select("id")
    .eq("project_id", id)
    .in("type", ["tts", "plan_synthetic"])
    .in("status", ["queued", "running"]).limit(1);
  if ((open ?? []).length > 0) {
    return NextResponse.json({ error: "a step is already running" }, { status: 409 });
  }

  if (body.data.step === "voiceover") {
    // Re-read the resolved voiceover source so the retried job behaves the same.
    const { data: project } = await sb
      .from("projects").select("voiceover_source").eq("id", id).single();
    const mediaJobId = await createMediaJob({
      projectId: id, type: "tts",
      metadata: { voiceoverSource: project?.voiceover_source ?? null, retry: true },
    });
    await enqueueTts({ projectId: id, mediaJobId });
    await setProjectStatus(id, "voiceover");
    return NextResponse.json({ ok: true, media_job_id: mediaJobId, step: "voiceover" }, { status: 202 });
  }

  // planner retry
  const mediaJobId = await createMediaJob({ projectId: id, type: "plan_synthetic", metadata: { retry: true } });
  await enqueueSyntheticPlanner({ projectId: id, mediaJobId });
  await setProjectStatus(id, "planning");
  return NextResponse.json({ ok: true, media_job_id: mediaJobId, step: "planner" }, { status: 202 });
}

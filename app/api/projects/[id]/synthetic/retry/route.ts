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
// step:
//   voiceover      -> re-run TTS + alignment, THEN re-plan (rebuilds segments).
//                     For a FAILED early pipeline (assets not yet generated).
//   voiceover_only -> re-run ONLY TTS + alignment; keep existing segments/assets
//                     (replace a corrupted voiceover on a finished project).
//   planner        -> re-enqueue just the planner (voiceover already succeeded).
const Body = z.object({ step: z.enum(["voiceover", "voiceover_only", "planner"]) });

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

  // Mark any in-flight TTS/planner job for THIS step as failed first, so a
  // stuck/orphaned job (e.g. left queued from earlier debugging) can't block a
  // legitimate retry with a 409. This makes Re-plan/Retry always actionable.
  const jobType = body.data.step === "planner" ? "plan_synthetic" : "tts";
  await sb
    .from("media_jobs")
    .update({ status: "failed", error: "superseded by retry" })
    .eq("project_id", id)
    .eq("type", jobType)
    .in("status", ["queued", "running"]);

  if (body.data.step === "voiceover" || body.data.step === "voiceover_only") {
    const voiceoverOnly = body.data.step === "voiceover_only";
    // Re-read the resolved voiceover source so the retried job behaves the same.
    const { data: project } = await sb
      .from("projects").select("voiceover_source").eq("id", id).single();
    const mediaJobId = await createMediaJob({
      projectId: id, type: "tts",
      metadata: { voiceoverSource: project?.voiceover_source ?? null, retry: true, voiceoverOnly },
    });
    // voiceoverOnly skips the planner re-run in the TTS processor, so existing
    // segments/assets are preserved — nothing here touches synthetic_segments or
    // timeline_items (unlike the planner branch below).
    await enqueueTts({ projectId: id, mediaJobId, voiceoverOnly });
    await setProjectStatus(id, "voiceover");
    return NextResponse.json({ ok: true, media_job_id: mediaJobId, step: body.data.step }, { status: 202 });
  }

  // planner retry / re-plan. Also clear any in-flight ASSET jobs + their
  // segments, since the planner rebuilds the segment list from scratch.
  await sb
    .from("media_jobs")
    .update({ status: "failed", error: "superseded by re-plan" })
    .eq("project_id", id)
    .in("type", ["image_gen", "image_to_video", "avatar"])
    .in("status", ["queued", "running"]);
  // The planner deletes + reinserts synthetic_segments, and also drops any
  // timeline_items materialized from a prior (now-stale) plan.
  await sb.from("timeline_items").delete().eq("project_id", id);

  const mediaJobId = await createMediaJob({ projectId: id, type: "plan_synthetic", metadata: { retry: true } });
  await enqueueSyntheticPlanner({ projectId: id, mediaJobId });
  await setProjectStatus(id, "planning");
  return NextResponse.json({ ok: true, media_job_id: mediaJobId, step: "planner" }, { status: 202 });
}

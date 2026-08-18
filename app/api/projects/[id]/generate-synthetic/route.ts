import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { enqueueTts } from "@/lib/jobs/queue";
import { isSixtyNineConfigured } from "@/lib/synthetic/sixtynine-labs";
import { LANGUAGES } from "@/lib/i18n/locale";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Kick off the synthetic pipeline (STEP 2 onward). Body optionally sets the
// voiceover source + tts voice; if omitted we infer from project state:
//   * has voiceover_url already -> 'uploaded'
//   * has transcript only       -> 'tts'
// The pipeline is: tts -> alignment -> planner -> asset fan-out -> review.
const Body = z.object({
  voiceoverSource: z.enum(["tts", "uploaded"]).optional(),
  ttsVoiceId: z.string().min(1).max(120).optional(),
  // Narration language of the script (lib/i18n/locale.ts). Persisted before the
  // pipeline starts because all three consumers — TTS voice, Deepgram
  // alignment, and the planner's visual region — read it off the project row.
  language: z.enum(LANGUAGES).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "invalid input", issues: body.error.flatten() }, { status: 400 });
  }

  const sb = getServerSupabase();
  const { data: project, error } = await sb.from("projects").select("*").eq("id", id).single();
  if (error || !project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  if (project.engine !== "synthetic") {
    return NextResponse.json({ error: "not a synthetic project" }, { status: 400 });
  }

  // Resolve voiceover source.
  const hasVoiceover = Boolean(project.voiceover_url);
  const hasTranscript = Boolean(project.transcript && project.transcript.trim());
  const source = body.data.voiceoverSource ?? (hasVoiceover ? "uploaded" : "tts");

  if (source === "tts") {
    if (!hasTranscript) {
      return NextResponse.json({ error: "transcript required for TTS voiceover" }, { status: 400 });
    }
    if (!isSixtyNineConfigured()) {
      return NextResponse.json({ error: "69labs TTS not configured (SIXTYNINE_LABS_API_KEY)" }, { status: 503 });
    }
  } else if (!hasVoiceover) {
    return NextResponse.json({ error: "no uploaded voiceover to use" }, { status: 400 });
  }

  if (!project.avatar_image_url) {
    return NextResponse.json({ error: "avatar image required before generation" }, { status: 400 });
  }

  // Don't double-start.
  const { data: open } = await sb
    .from("media_jobs")
    .select("id")
    .eq("project_id", id)
    .in("status", ["queued", "running"])
    .limit(1);
  if ((open ?? []).length > 0) {
    return NextResponse.json({ error: "generation already in progress" }, { status: 409 });
  }

  // Persist the resolved source + voice + language so the TTS processor and the
  // planner read them. Language is omitted-means-unchanged (not
  // omitted-means-English) so a re-run that doesn't resend it can't silently
  // demote a German project back to English mid-pipeline.
  await sb
    .from("projects")
    .update({
      voiceover_source: source,
      tts_voice_id: body.data.ttsVoiceId ?? project.tts_voice_id ?? null,
      language: body.data.language ?? project.language ?? "en",
    })
    .eq("id", id);

  const mediaJobId = await createMediaJob({ projectId: id, type: "tts", metadata: { voiceoverSource: source } });
  await enqueueTts({ projectId: id, mediaJobId });
  await setProjectStatus(id, "voiceover");

  return NextResponse.json({ ok: true, media_job_id: mediaJobId, voiceover_source: source }, { status: 202 });
}

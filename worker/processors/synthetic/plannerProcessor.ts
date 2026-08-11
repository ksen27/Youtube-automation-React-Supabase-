import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, setProjectStatus, logJob } from "@/lib/jobs/db";
import { getEnv } from "@/lib/env";
import { admitProjectIfSlotFree } from "./_shared";
import type { SyntheticPlannerJobData } from "@/lib/jobs/queue";
import type { WordTiming } from "@/lib/ai/deepgram";
import { buildSyntheticTimeline } from "@/lib/synthetic/planner";
import type { AvatarMarkRange } from "@/lib/synthetic/doc-marks";
import type { JobAttemptInfo } from "@/worker/index";

// STEP 4 of the synthetic pipeline (planner). Reads the aligned transcript +
// word timings + the red/orange avatar marks, runs Gemini to produce
// synthetic_segments[], then hands off to asset generation.
//
// Handoff depends on SYNTHETIC_AUTO_DISPATCH (default ON, client request
// 2026-08-10 "after step 1 it should go automatically to generate assets"):
//   on  -> dispatchSegments() here; project goes straight to generating_images
//   off -> stop at the review gate ('plan_ready') so the user can inspect and
//          edit the segmentation/prompts/types before any (paid) asset is made,
//          then clicks "Generate" -> POST /generate-assets -> dispatchSegments()
// The route stays valid in both modes and is still the way to re-dispatch after
// a partial failure.
export async function processSyntheticPlannerJob(
  data: SyntheticPlannerJobData,
  _attempt?: JobAttemptInfo,
): Promise<void> {
  const { projectId, mediaJobId } = data;
  const sb = getServerSupabase();

  await setMediaJob(mediaJobId, { status: "running", progress: 10 });
  await setProjectStatus(projectId, "planning");

  const { data: project, error } = await sb
    .from("projects")
    .select("title, transcript, transcript_words, voiceover_duration_seconds, avatar_mark_ranges")
    .eq("id", projectId)
    .single();
  if (error || !project) throw new Error(`planner: project ${projectId} not found`);

  const transcript = (project.transcript ?? "").trim();
  if (!transcript) throw new Error("planner: project has no transcript");

  const words = (project.transcript_words as WordTiming[] | null) ?? null;
  const voiceoverDuration = Number(project.voiceover_duration_seconds) || 0;
  const avatarRanges = (project.avatar_mark_ranges as AvatarMarkRange[] | null) ?? [];

  const planned = await buildSyntheticTimeline({
    projectId,
    jobId: mediaJobId,
    projectTitle: (project.title as string | null) ?? "",
    transcript,
    words,
    voiceoverDuration,
    avatarRanges,
  });

  await setMediaJob(mediaJobId, {
    status: "completed",
    progress: 100,
    metadata: { segments: planned.length, avatarForced: avatarRanges.length > 0 },
  });

  // Hand off to asset generation. With SYNTHETIC_AUTO_DISPATCH on (default) the
  // planner fans the plan out itself so step 1 flows straight into "generate
  // assets"; otherwise we park at the review gate and wait for the user's click.
  if (!getEnv().SYNTHETIC_AUTO_DISPATCH) {
    await setProjectStatus(projectId, "plan_ready");
    return;
  }

  // ADMISSION CONTROL: dispatch only if fewer than
  // SYNTHETIC_MAX_GENERATING_PROJECTS are already generating. Otherwise the
  // project WAITS at 'plan_ready' and is promoted automatically when a slot
  // frees. Without this, every planned project fanned its whole segment list
  // into one FIFO queue at once (2,666 queued jobs / 12 projects on
  // 2026-08-11), so nothing finished until everything finished.
  const admitted = await admitProjectIfSlotFree(projectId);
  await logJob({ projectId, jobId: mediaJobId }, "planner.auto_dispatch", { admitted });
}

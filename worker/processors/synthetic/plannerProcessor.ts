import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, setProjectStatus } from "@/lib/jobs/db";
import type { SyntheticPlannerJobData } from "@/lib/jobs/queue";
import type { WordTiming } from "@/lib/ai/deepgram";
import { buildSyntheticTimeline } from "@/lib/synthetic/planner";
import type { AvatarMarkRange } from "@/lib/synthetic/doc-marks";
import type { JobAttemptInfo } from "@/worker/index";

// STEP 4 of the synthetic pipeline (planner). Reads the aligned transcript +
// word timings + the red/orange avatar marks, runs Gemini to produce
// synthetic_segments[], then STOPS at the review gate (status 'plan_ready').
//
// IMPORTANT: this no longer auto-dispatches asset generation. The user reviews
// the plan on the review screen and clicks "Generate", which calls
// POST /generate-assets -> dispatchSegments(). This lets the user inspect and
// edit the segmentation/prompts/types before any (paid) asset is produced.
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
    .select("transcript, transcript_words, voiceover_duration_seconds, avatar_mark_ranges")
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

  // Review gate: stop here. The user generates assets from the review screen.
  await setProjectStatus(projectId, "plan_ready");
}

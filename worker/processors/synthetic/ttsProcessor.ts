import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, setProjectStatus, createMediaJob, logJob } from "@/lib/jobs/db";
import { enqueueSyntheticPlanner, type TtsJobData } from "@/lib/jobs/queue";
import { uploadBuffer } from "@/lib/storage";
import { transcribeAudioFromUrl } from "@/lib/ai/deepgram";
import { generateVoice } from "@/lib/synthetic/sixtynine-labs";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import type { JobAttemptInfo } from "@/worker/index";

// STEP 2 + 3 of the synthetic pipeline (voiceover resolution + alignment).
//
//  voiceover_source = 'tts'      -> generate master_voiceover.mp3 via 69labs
//  voiceover_source = 'uploaded' -> use the already-uploaded voiceover_url
//
// Either way we then run Deepgram alignment against the (public) audio URL to
// get word timings + duration — reusing the SAME integration the sourced
// engine uses — and persist them on the project. On success the planner job is
// enqueued. Idempotent on retry: TTS regenerates from the transcript and
// alignment is recomputed.
export async function processTtsJob(data: TtsJobData, _attempt?: JobAttemptInfo): Promise<void> {
  const { projectId, mediaJobId } = data;
  const sb = getServerSupabase();

  await setMediaJob(mediaJobId, { status: "running", progress: 5 });
  await setProjectStatus(projectId, "voiceover");

  const { data: project, error } = await sb
    .from("projects")
    .select("id, transcript, voiceover_url, voiceover_source, tts_voice_id")
    .eq("id", projectId)
    .single();
  if (error || !project) throw new Error(`tts: project ${projectId} not found`);

  let voiceoverUrl = project.voiceover_url as string | null;

  // --- voiceover resolution ---
  if (project.voiceover_source === "tts") {
    const transcript = (project.transcript ?? "").trim();
    if (!transcript) throw new Error("tts: transcript required for tts voiceover_source");

    const t0 = Date.now();
    await logProviderCall({ projectId, jobId: mediaJobId, provider: "sixtynine_tts", phase: "request",
      extra: { chars: transcript.length, voiceId: project.tts_voice_id ?? "default" } });
    const voice = await generateVoice({ text: transcript, voiceId: project.tts_voice_id ?? undefined });
    await logProviderCall({ projectId, jobId: mediaJobId, provider: "sixtynine_tts", phase: "response",
      durationMs: Date.now() - t0, cost: { provider: "sixtynine_tts", chars: voice.chars } });

    const up = await uploadBuffer(voice.audio, r2Keys.masterVoiceover(projectId), voice.contentType);
    voiceoverUrl = up.publicUrl;
    await sb.from("projects").update({ voiceover_url: voiceoverUrl }).eq("id", projectId);
    await setMediaJob(mediaJobId, { progress: 50, metadata: { ttsChars: voice.chars } });
  } else {
    if (!voiceoverUrl) throw new Error("tts: voiceover_source='uploaded' but no voiceover_url");
    await setMediaJob(mediaJobId, { progress: 50 });
  }

  // --- alignment (STEP 3) — reuse the existing Deepgram URL transcription ---
  await setProjectStatus(projectId, "aligning");
  const result = await transcribeAudioFromUrl(voiceoverUrl!);
  const durationSeconds =
    result.durationSeconds && result.durationSeconds > 0 ? Math.round(result.durationSeconds) : null;

  await sb
    .from("projects")
    .update({
      // For tts-source projects the transcript IS the source of truth; keep it.
      // For uploaded-source projects, adopt Deepgram's transcript so the
      // planner segments against what was actually spoken.
      ...(project.voiceover_source === "uploaded" ? { transcript: result.transcript } : {}),
      voiceover_duration_seconds: durationSeconds,
      transcript_words: result.words,
    })
    .eq("id", projectId);

  await logJob({ projectId, jobId: mediaJobId }, "synthetic.tts.aligned", {
    durationSeconds,
    words: result.words?.length ?? 0,
    source: project.voiceover_source,
  });
  await setMediaJob(mediaJobId, { status: "completed", progress: 100 });

  // --- enqueue the planner (STEP 4) ---
  const plannerJobId = await createMediaJob({ projectId, type: "plan_synthetic" });
  await enqueueSyntheticPlanner({ projectId, mediaJobId: plannerJobId });
}

import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, setProjectStatus, createMediaJob, logJob } from "@/lib/jobs/db";
import { enqueueSyntheticPlanner, type TtsJobData } from "@/lib/jobs/queue";
import { uploadBuffer } from "@/lib/storage";
import { transcribeAudioFromUrl } from "@/lib/ai/deepgram";
import { generateVoice, type GenerateVoiceResult } from "@/lib/synthetic/sixtynine-labs";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { detectLoudnessDropout } from "@/lib/media/ffmpeg";
import { getEnv } from "@/lib/env";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobAttemptInfo } from "@/worker/index";

// Generate the master voiceover with a corruption guard. 69labs occasionally
// renders a middle stretch of a long TTS job at the wrong voice / a dropped
// level (client-reported: ~5 min much quieter from 9:12 on a 31-min voiceover);
// the render pipeline faithfully plays back whatever it produced. So after each
// generation we scan the audio for a SUSTAINED low-volume span and, if found,
// re-generate — up to SYNTHETIC_VOICEOVER_QC_MAX_REGEN times — keeping the
// cleanest take. Returns the chosen audio plus the QC verdict for logging.
async function generateVoiceQC(
  args: { projectId: string; mediaJobId: string; text: string; voiceId?: string },
): Promise<{ voice: GenerateVoiceResult; attempts: number; clean: boolean; note: string }> {
  const env = getEnv();
  const dropDb = env.SYNTHETIC_VOICEOVER_QC_DROP_DB;
  const minSpan = env.SYNTHETIC_VOICEOVER_QC_MIN_SPAN_S;
  const maxRegen = env.SYNTHETIC_VOICEOVER_QC_MAX_REGEN;

  let best: { voice: GenerateVoiceResult; spanSeconds: number } | null = null;
  const total = maxRegen + 1; // one initial generation + up to maxRegen retries

  for (let attempt = 1; attempt <= total; attempt++) {
    const t0 = Date.now();
    await logProviderCall({ projectId: args.projectId, jobId: args.mediaJobId, provider: "sixtynine_tts", phase: "request",
      extra: { chars: args.text.length, voiceId: args.voiceId ?? "default", attempt } });
    const voice = await generateVoice({ text: args.text, voiceId: args.voiceId });
    await logProviderCall({ projectId: args.projectId, jobId: args.mediaJobId, provider: "sixtynine_tts", phase: "response",
      durationMs: Date.now() - t0, cost: { provider: "sixtynine_tts", chars: voice.chars } });

    // QC disabled → accept the first take unconditionally.
    if (maxRegen === 0) return { voice, attempts: attempt, clean: true, note: "qc_disabled" };

    // Scan a temp copy of the mp3. On analysis failure (samples:0) we can't
    // judge it, so we DON'T burn a regen — accept and move on.
    const tmpPath = path.join(os.tmpdir(), `vo_qc_${args.mediaJobId}_${attempt}.mp3`);
    let scan;
    try {
      await fs.writeFile(tmpPath, voice.audio);
      scan = await detectLoudnessDropout({ inputPath: tmpPath, dropDb, minSpanSeconds: minSpan });
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }

    if (scan.samples === 0) {
      await logJob({ projectId: args.projectId, jobId: args.mediaJobId }, "synthetic.tts.qc_inconclusive", { attempt });
      return { voice, attempts: attempt, clean: true, note: "qc_inconclusive" };
    }

    if (!scan.dropout) {
      await logJob({ projectId: args.projectId, jobId: args.mediaJobId }, "synthetic.tts.qc_clean",
        { attempt, medianLufs: Math.round(scan.medianLufs * 10) / 10 });
      return { voice, attempts: attempt, clean: true, note: "qc_clean" };
    }

    // Dropout found. Remember the least-bad take (smallest offending span) in
    // case every attempt is defective, then retry if budget remains.
    const spanSeconds = scan.worstSpan ? scan.worstSpan.endSeconds - scan.worstSpan.startSeconds : Infinity;
    if (!best || spanSeconds < best.spanSeconds) best = { voice, spanSeconds };
    await logJob({ projectId: args.projectId, jobId: args.mediaJobId }, "synthetic.tts.qc_dropout", {
      attempt,
      willRetry: attempt < total,
      medianLufs: Math.round(scan.medianLufs * 10) / 10,
      spanStart: scan.worstSpan ? Math.round(scan.worstSpan.startSeconds) : null,
      spanEnd: scan.worstSpan ? Math.round(scan.worstSpan.endSeconds) : null,
      minLufs: scan.worstSpan ? Math.round(scan.worstSpan.minLufs * 10) / 10 : null,
    });
  }

  // Every attempt had a dropout — ship the cleanest one rather than fail the
  // whole project (a slightly-quiet stretch is still usable; hard-failing here
  // would strand a 30-min generation).
  return { voice: best!.voice, attempts: total, clean: false, note: "qc_exhausted_best_effort" };
}

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

    const { voice, attempts, clean, note } = await generateVoiceQC({
      projectId, mediaJobId, text: transcript, voiceId: project.tts_voice_id ?? undefined,
    });

    const up = await uploadBuffer(voice.audio, r2Keys.masterVoiceover(projectId), voice.contentType);
    voiceoverUrl = up.publicUrl;
    await sb.from("projects").update({ voiceover_url: voiceoverUrl }).eq("id", projectId);
    await setMediaJob(mediaJobId, { progress: 50, metadata: { ttsChars: voice.chars, qcAttempts: attempts, qcClean: clean, qcNote: note } });
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

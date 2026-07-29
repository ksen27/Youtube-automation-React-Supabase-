import path from "node:path";
import { promises as fs } from "node:fs";
import { getServerSupabase } from "@/lib/supabase/server";
import { logJob } from "@/lib/jobs/db";
import type { PitchGenJobData } from "@/lib/jobs/queue";
import { fetchOrThrow, withHttpRetry } from "@/lib/synthetic/http";
import { uploadFile, ensureTmp, safeUnlink, publicUrlForKey } from "@/lib/storage";
import { generateAvatar } from "@/lib/synthetic/heygen";
import { generateAvatarViaApi, heygenApiFallbackEnabled } from "@/lib/synthetic/heygen-api";
import { generateVoice } from "@/lib/synthetic/sixtynine-labs";
import { recordWebsiteScroll } from "@/lib/synthetic/website-recorder";
import { logProviderCall } from "@/lib/synthetic/cost";
import { SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, SYNTHETIC_FPS } from "@/lib/synthetic/constants";
import { buildPitchClip, concatPitchParts } from "@/lib/media/ffmpeg";
import { probeFile } from "@/lib/media/probe";
import { userFacingMessage } from "@/lib/synthetic/heygen-errors";
import type { JobAttemptInfo } from "@/worker/index";

// STANDALONE SALES-PITCH GENERATOR (migration 0029).
//
// The client separated the AI sales-pitch GENERATOR from the AI Avatar workflow
// into its own sidebar tool (see /sales-pitch). This processor builds ONE pitch
// video for a `pitch_videos` row — it has NO project. The output is a downloadable
// mp4 (pitch_videos.output_url); the user later uploads it to an avatar project
// via the existing upload field.
//
// The generated pitch = an AVATAR talking-head (HeyGen, driven by the script's
// own 69labs TTS) followed by a FIXED-length screen-recording that scrolls the
// real website, with the narration playing continuously over BOTH parts. Same
// generation engine as before; only the storage/trigger moved from a project row
// to the standalone pitch_videos table.
//
// PROGRESS/STATUS lives on the pitch_videos row (status: generating|ready|failed),
// NOT media_jobs — media_jobs.project_id is a NOT NULL FK to projects and this
// tool has no project (same pattern as the standalone Thumbnails feature). The
// BullMQ jobId is the pitch_videos id.
//
// Runs on the avatar worker (WORKER_ROLE synthetic): it ships Chromium (website
// recording) and owns the HeyGen pool (avatar half).

// A pitch narration is a single short spoken window; LOG if it runs long rather
// than silently producing a minutes-long avatar upload.
const PITCH_AVATAR_MAX_SECONDS = 90;

// Client rule: the pitch always shows the website scroll for a FIXED window at the
// END, and (client 2026-07-22) the narration keeps playing OVER it — the website
// is never silent. The single TTS narration is the master audio track for the
// whole video; the avatar is on screen until the last PITCH_WEBSITE_SECONDS of
// narration, then the website scroll plays that tail:
//   pitch = [avatar: narration - website window] + [website: PITCH_WEBSITE_SECONDS]
const PITCH_WEBSITE_SECONDS = 10;

// Never let the website window swallow the avatar entirely on a short script —
// the avatar stays on screen at least this long (the website window shrinks).
const PITCH_AVATAR_MIN_SECONDS = 5;

export async function processPitchGenJob(
  data: PitchGenJobData,
  attempt?: JobAttemptInfo,
): Promise<void> {
  const { pitchVideoId } = data;
  const sb = getServerSupabase();
  const isFinalAttempt = (attempt?.attemptsMade ?? 1) >= (attempt?.attemptsAllowed ?? 1);

  const { data: row, error: rowErr } = await sb
    .from("pitch_videos")
    .select("id, website_url, avatar_image_url, avatar_name, script, tts_voice_id")
    .eq("id", pitchVideoId)
    .single();
  if (rowErr || !row) throw new Error(`pitch_gen: pitch_videos ${pitchVideoId} not found`);

  const websiteUrl = (row.website_url ?? "").trim();
  const avatarImageUrl = (row.avatar_image_url ?? "").trim();
  const script = (row.script ?? "").trim();

  // Validate inputs (a missing one is a permanent failure — fail on any attempt).
  const missing: string[] = [];
  if (!websiteUrl) missing.push("website URL");
  if (!avatarImageUrl) missing.push("avatar image");
  if (!script) missing.push("script");
  if (missing.length > 0) {
    await failPitch(pitchVideoId, `Sales pitch needs: ${missing.join(", ")}.`);
    return;
  }

  const tmp = await ensureTmp(`pitch/${pitchVideoId}`);
  const staged: string[] = [];
  const ts = pitchVideoId; // stable version suffix for R2 keys + logging id
  const logScope = { jobId: pitchVideoId };

  try {
    // --- 1) TTS the pitch script (69labs), stage as a local mp3 for HeyGen ---
    const t0 = Date.now();
    const pitchVoiceId = row.tts_voice_id ?? undefined;
    await logProviderCall({ projectId: pitchVideoId, jobId: pitchVideoId, provider: "sixtynine_tts", phase: "request", extra: { chars: script.length, kind: "pitch", voiceId: pitchVoiceId ?? "default" } });
    const voice = await generateVoice({ text: script, voiceId: pitchVoiceId });
    await logProviderCall({ projectId: pitchVideoId, jobId: pitchVideoId, provider: "sixtynine_tts", phase: "response", durationMs: Date.now() - t0, cost: { provider: "sixtynine_tts", chars: voice.chars } });

    const audioPath = path.join(tmp, `pitch_${ts}.mp3`);
    await fs.writeFile(audioPath, voice.audio);
    staged.push(audioPath);
    // Publish the audio so the HeyGen API fallback can pass audio_url directly.
    const audioKey = `pitch-videos/${pitchVideoId}/audio_${ts}.mp3`;
    const audioUrl = await uploadFile(audioPath, audioKey, "audio/mpeg")
      .then(() => publicUrlForKey(audioKey))
      .catch(() => null);

    let audioSeconds = 0;
    try { const p = await probeFile(audioPath); audioSeconds = p.durationSeconds || 0; } catch { /* best-effort */ }
    if (audioSeconds > PITCH_AVATAR_MAX_SECONDS) {
      await logJob(logScope, "pitch.audio_over_length", {
        audioSeconds: Math.round(audioSeconds * 100) / 100, capSeconds: PITCH_AVATAR_MAX_SECONDS,
      });
    }

    // --- 2) Render the AVATAR half via HeyGen (audio-driven, Avatar III) ---
    const imgRes = await withHttpRetry("pitch.avatar_image_fetch", () =>
      fetchOrThrow(avatarImageUrl, { timeoutMs: 60_000 }),
    );
    const imageBytes = Buffer.from(await imgRes.arrayBuffer());

    // Avatar generation input. It's AUDIO-DRIVEN: the clip lip-syncs to the pitch
    // TTS we generated above (audioFilePath/audioUrl), NOT HeyGen's own TTS — so
    // the avatar speaks the pitch script in the chosen 69labs voice. generateAvatar*
    // never reads a DB row; the id args are just for logging + R2 asset keys.
    const avatarInput = {
      projectId: pitchVideoId,
      segmentId: `pitch-${ts}`,
      jobId: pitchVideoId,
      avatarImageUrl,
      script,
      audioFilePath: audioPath,
      audioUrl: audioUrl ?? undefined,
      audioDurationSeconds: audioSeconds || undefined,
      aspectRatio: "landscape" as const,
      avatarModel: "avatar_iii" as const,
      heygenAvatarName: row.avatar_name ?? null,
    };

    // API-FIRST (client 2026-07-21): render the pitch avatar via the HeyGen API
    // directly (audio-driven Avatar III). The API path avoids the browser pool +
    // Cloudflare/session fragility that fails on this worker; it's the same
    // audio-driven render, just through the official API. Fall back to the browser
    // pool only if the API is unavailable/errors, so a pitch still renders.
    let avatarResult;
    if (heygenApiFallbackEnabled()) {
      try {
        avatarResult = await generateAvatarViaApi(avatarInput, imageBytes);
        await logJob(logScope, "pitch.avatar_rendered", { via: "api", seconds: avatarResult.seconds });
      } catch (apiErr) {
        await logJob(logScope, "pitch.avatar_api_failed_fallback_browser", {
          err: (apiErr as Error).message?.slice(0, 200),
        });
        avatarResult = await generateAvatar(avatarInput, imageBytes);
        await logJob(logScope, "pitch.avatar_rendered", {
          via: "browser", accountId: avatarResult.accountId, seconds: avatarResult.seconds,
        });
      }
    } else {
      // API not configured (no HEYGEN_API_KEY / HEYGEN_API_FALLBACK) — browser pool.
      avatarResult = await generateAvatar(avatarInput, imageBytes);
      await logJob(logScope, "pitch.avatar_rendered", {
        via: "browser", accountId: avatarResult.accountId, seconds: avatarResult.seconds,
      });
    }

    // The narration runs over the WHOLE pitch (avatar + website), so the website
    // window overlaps the END of the narration instead of extending past it. On a
    // short script the window shrinks so the avatar keeps a minimum on-screen run.
    // If the audio probe failed (audioSeconds 0) fall back to no overlap: full
    // avatar, then the website with the narration already finished (apad silence).
    const websiteOverlapSeconds = Math.min(
      PITCH_WEBSITE_SECONDS,
      Math.max(0, audioSeconds - PITCH_AVATAR_MIN_SECONDS),
    );
    const avatarShowSeconds = audioSeconds > 0 ? audioSeconds - websiteOverlapSeconds : 0;

    // Download the avatar mp4 + normalize to canvas. Its own audio is dropped —
    // the original 69labs narration mp3 is muxed as the master track at concat,
    // so cutting the avatar video early never cuts the voiceover.
    const avatarRaw = path.join(tmp, `avatar_raw_${ts}.mp4`);
    const avatarClip = path.join(tmp, `avatar_${ts}.mp4`);
    staged.push(avatarRaw, avatarClip);
    const avRes = await withHttpRetry("pitch.avatar_download", () =>
      fetchOrThrow(avatarResult.videoUrl, { timeoutMs: 120_000 }),
    );
    await fs.writeFile(avatarRaw, Buffer.from(await avRes.arrayBuffer()));
    await buildPitchClip({
      inputPath: avatarRaw, outputPath: avatarClip, keepAudio: false,
      durationSeconds: avatarShowSeconds > 0 ? avatarShowSeconds : undefined,
      width: SYNTHETIC_WIDTH, height: SYNTHETIC_HEIGHT, fps: SYNTHETIC_FPS,
    });

    // --- 3) Record the WEBSITE scroll (real UI, narration continues over it) ---
    const webRaw = path.join(tmp, `website_raw_${ts}.webm`);
    const webClip = path.join(tmp, `website_${ts}.mp4`);
    staged.push(webRaw, webClip);
    const webRec = await recordWebsiteScroll({
      url: websiteUrl, outputPath: webRaw,
      width: SYNTHETIC_WIDTH, height: SYNTHETIC_HEIGHT,
      targetScrollSeconds: PITCH_WEBSITE_SECONDS,
    });
    // Trim front dead-air; PIN to the window. The recording itself is silent —
    // the narration master track covers it at concat.
    await buildPitchClip({
      inputPath: webRaw, outputPath: webClip, keepAudio: false,
      startSeconds: webRec.scrollStartSeconds,
      durationSeconds: PITCH_WEBSITE_SECONDS,
      width: SYNTHETIC_WIDTH, height: SYNTHETIC_HEIGHT, fps: SYNTHETIC_FPS,
    });

    // --- 4) Concat avatar → website; narration voiceover runs across BOTH ---
    const finalPath = path.join(tmp, `pitch_final_${ts}.mp4`);
    staged.push(finalPath);
    // The output length is the two pinned parts back-to-back. Pass it so the
    // concat ENDS deterministically (explicit -t + bounded silence-pad) instead
    // of relying on -shortest, which hangs on the worker's ffmpeg 5.1 and burns
    // the 240s watchdog. avatarShowSeconds can be 0 (audio probe failed) — in
    // that case the avatar clip ran at natural length, which we don't know here,
    // so leave the total unset and fall back to -shortest.
    const totalDurationSeconds =
      avatarShowSeconds > 0 ? avatarShowSeconds + PITCH_WEBSITE_SECONDS : undefined;
    await concatPitchParts({
      inputPaths: [avatarClip, webClip], outputPath: finalPath,
      masterAudioPath: audioPath,
      totalDurationSeconds,
      width: SYNTHETIC_WIDTH, height: SYNTHETIC_HEIGHT, fps: SYNTHETIC_FPS,
    });
    await logJob(logScope, "pitch.voiceover_layout", {
      audioSeconds: Math.round(audioSeconds * 100) / 100,
      avatarShowSeconds: Math.round(avatarShowSeconds * 100) / 100,
      websiteOverlapSeconds: Math.round(websiteOverlapSeconds * 100) / 100,
    });

    let finalSeconds = 0;
    try { const p = await probeFile(finalPath); finalSeconds = p.durationSeconds || 0; } catch { /* best-effort */ }

    // --- 5) Upload + mark the pitch_videos row ready ---
    const key = `pitch-videos/${pitchVideoId}/pitch_${ts}.mp4`;
    await uploadFile(finalPath, key, "video/mp4");
    const pitchUrl = publicUrlForKey(key);

    const { error: updErr } = await sb
      .from("pitch_videos")
      .update({
        output_url: pitchUrl,
        duration_seconds: finalSeconds > 0 ? Math.round(finalSeconds * 100) / 100 : null,
        status: "ready",
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", pitchVideoId);
    if (updErr) throw new Error(`pitch_gen: row update failed: ${updErr.message}`);

    await logJob(logScope, "pitch.generated", {
      pitchUrl, finalSeconds: Math.round(finalSeconds * 100) / 100, avatarSeconds: avatarResult.seconds,
    });
  } catch (err) {
    await logJob(logScope, "pitch.failed", { err: (err as Error).message?.slice(0, 300), isFinalAttempt });
    if (isFinalAttempt) {
      await failPitch(pitchVideoId, userFacingMessage(err));
      return;
    }
    throw err; // let BullMQ retry
  } finally {
    for (const p of staged) await safeUnlink(p);
  }
}

// Mark the pitch_videos row failed (surfaces on the gallery). Does NOT clear a
// previously-generated output_url — a failed re-generate keeps the last good one.
async function failPitch(pitchVideoId: string, message: string): Promise<void> {
  const sb = getServerSupabase();
  await sb
    .from("pitch_videos")
    .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
    .eq("id", pitchVideoId);
}

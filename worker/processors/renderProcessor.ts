import path from "node:path";
import { promises as fs, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { RenderJobData } from "@/lib/jobs/queue";
import { logJob, setMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { getServerSupabase } from "@/lib/supabase/server";
import { ensureTmp, safeUnlink, uploadFile } from "@/lib/storage";
import { concatNormalizedClips, cutClip, cutAudio, normalizeClip, buildStillVideo } from "@/lib/media/ffmpeg";
import { downloadYoutubeAudio } from "@/lib/media/ytdlp";
import { getEnv } from "@/lib/env";

const VALIDATION_FAILED_MSG =
  "Timeline duration must match voiceover and use unique clips.";

export async function processRenderJob(data: RenderJobData): Promise<void> {
  const sb = getServerSupabase();
  const { projectId, mediaJobId, renderJobId } = data;

  await setMediaJob(mediaJobId, { status: "running", progress: 5 });
  await sb.from("render_jobs").update({ status: "running", progress: 5 }).eq("id", renderJobId);
  await setProjectStatus(projectId, "rendering");

  // Pull approved timeline items (only ones with clips — placeholders are skipped
  // for MVP rendering; their script_text/overlay_text would be added in v2)
  const { data: items, error: itemsErr } = await sb
    .from("timeline_items")
    .select("*")
    .eq("project_id", projectId)
    .order("position", { ascending: true });
  if (itemsErr) throw new Error(`load timeline: ${itemsErr.message}`);
  // Renderable items: footage clips OR image blocks with a fetched image.
  // Intro rows are UI-only and rendered separately as a prefix segment.
  // Image blocks without image_url are skipped (no still to hold) — the
  // timeline shrinks by their duration rather than holding a black frame.
  const renderable = (items ?? []).filter((it) => {
    if (it.type === "intro") return false;
    if (it.clip_id) return true;
    if (it.type === "image" && it.image_url) return true;
    return false;
  });
  if (renderable.length === 0) {
    await setMediaJob(mediaJobId, { status: "failed", error: "no renderable timeline items" });
    await sb.from("render_jobs").update({ status: "failed", error: "no renderable timeline items" }).eq("id", renderJobId);
    await setProjectStatus(projectId, "failed");
    throw new Error("no renderable timeline items");
  }

  // Defense-in-depth: enforce unique clip ids among footage items. Image
  // blocks have clip_id=null, so they don't participate in this check.
  const footageClipIds = renderable.map((it) => it.clip_id as string | null).filter(Boolean) as string[];
  if (new Set(footageClipIds).size !== footageClipIds.length) {
    await setMediaJob(mediaJobId, { status: "failed", error: VALIDATION_FAILED_MSG });
    await sb.from("render_jobs").update({ status: "failed", error: VALIDATION_FAILED_MSG }).eq("id", renderJobId);
    await setProjectStatus(projectId, "failed");
    throw new Error(VALIDATION_FAILED_MSG);
  }

  const { data: clipRows } = footageClipIds.length
    ? await sb.from("video_clips").select("id, clip_url").in("id", footageClipIds)
    : { data: [] };
  const clipUrlById = new Map<string, string | null>(
    (clipRows ?? []).map((c) => [c.id as string, (c.clip_url as string | null) ?? null])
  );

  const tmp = await ensureTmp(`render/${projectId}`);
  // Output slots indexed by timeline position so we can build them in
  // parallel without losing order. Failed items leave their slot null and
  // get filtered out before concat.
  const slots: (string | null)[] = new Array(renderable.length).fill(null);
  let imageRendered = 0;
  let imageFailed = 0;

  try {
    // 1) Process each item in parallel lanes. Footage items are downloaded
    //    then trimmed+normalized; image items fetch the URL, save locally,
    //    and build a still video segment. Each lane writes into its
    //    timeline slot so the final order matches `renderable`.
    //
    // Lane count tracks CLIP_PIPELINE_CONCURRENCY: it's the same shape of
    // workload (download + ffmpeg) with the same CPU/network trade-off,
    // so reusing the tunable means operators only have one knob.
    const env = getEnv();
    const laneCount = Math.max(1, Math.min(env.CLIP_PIPELINE_CONCURRENCY, renderable.length));
    let cursor = 0;
    let completed = 0;

    async function processItem(i: number): Promise<void> {
      const it = renderable[i];
      const plannedDur = Math.max(0.5, Number(it.duration) || 0);
      const idx = String(i).padStart(3, "0");
      const out = path.join(tmp, `norm_${idx}.mp4`);

      if (it.type === "image" && it.image_url) {
        try {
          const localImg = path.join(tmp, `img_${idx}`);
          await downloadHttp(it.image_url as string, localImg);
          await buildStillVideo({
            inputImagePath: localImg,
            outputPath: out,
            durationSeconds: plannedDur,
            width: 1280, height: 720, fps: 30,
          });
          slots[i] = out;
          imageRendered++;
          await safeUnlink(localImg);
        } catch (e) {
          imageFailed++;
          await logJob({ projectId, jobId: mediaJobId },
            "render.image.failed", { idx: i, url: it.image_url, err: (e as Error).message });
        }
      } else if (it.clip_id) {
        const url = clipUrlById.get(it.clip_id as string);
        if (!url) {
          await logJob({ projectId, jobId: mediaJobId },
            "render.clip.missing_url", { idx: i, clipId: it.clip_id });
          return;
        }
        const local = path.join(tmp, `in_${idx}.mp4`);
        const trimmed = path.join(tmp, `cut_${idx}.mp4`);
        try {
          await downloadHttp(url, local);
          await cutClip({
            inputPath: local, outputPath: trimmed,
            startSeconds: 0, durationSeconds: plannedDur,
          });
          await normalizeClip({
            inputPath: trimmed, outputPath: out,
            width: 1280, height: 720, fps: 30,
          });
          slots[i] = out;
          await safeUnlink(trimmed);
        } catch (e) {
          await logJob({ projectId, jobId: mediaJobId },
            "render.clip.failed", { idx: i, err: (e as Error).message });
        }
      }
    }

    await Promise.all(
      Array.from({ length: laneCount }, async () => {
        while (true) {
          const i = cursor++;
          if (i >= renderable.length) return;
          await processItem(i);
          completed++;
          const pct = 5 + Math.floor((completed / renderable.length) * 60);
          await setMediaJob(mediaJobId, { progress: pct });
          await sb.from("render_jobs").update({ progress: pct }).eq("id", renderJobId);
        }
      }),
    );

    // Flatten the slots into the in-order list of normalized segments,
    // dropping any failed items.
    const normalized: string[] = slots.filter((s): s is string => s !== null);

    if (normalized.length === 0) throw new Error("all timeline items failed to render");

    await logJob({ projectId, jobId: mediaJobId }, "render.segments", {
      total: renderable.length,
      built: normalized.length,
      imageRendered,
      imageFailed,
    });

    // 3) Optional voiceover from project + intro clip selection + bg music
    const { data: project } = await sb.from("projects")
      .select("voiceover_url, title, intro_clip_id, intro_duration_seconds, bg_music_url, bg_music_gain")
      .eq("id", projectId).single();
    let voiceoverLocal: string | undefined;
    if (project?.voiceover_url) {
      voiceoverLocal = path.join(tmp, "voiceover.audio");
      try { await downloadHttp(project.voiceover_url, voiceoverLocal); }
      catch { voiceoverLocal = undefined; }
    }
    // Background music is best-effort — a download failure should not
    // block the render. The user gets a video without the bed and the
    // log line tells the operator why.
    let bgMusicLocal: string | undefined;
    if (project?.bg_music_url) {
      bgMusicLocal = path.join(tmp, "bg_music.audio");
      try {
        await downloadHttp(project.bg_music_url, bgMusicLocal);
      } catch (e) {
        bgMusicLocal = undefined;
        await logJob({ projectId, jobId: mediaJobId },
          "render.bg_music.download_failed", { err: (e as Error).message });
      }
    }

    // 3b) Build the intro segment (best-effort — failures fall back to a
    // render without an intro). The intro plays BEFORE the planned timeline:
    //   - Its silent video gets prepended to `normalized[]`
    //   - Its source audio is re-downloaded via yt-dlp and cut to the
    //     [start_time, end_time] window
    //   - concatNormalizedClips uses introAudioPath + crossfade to mix in
    //     the source audio for the intro window, voiceover for the rest.
    let introAudioPath: string | undefined;
    let introDurationActual = 0;
    if (project?.intro_clip_id) {
      try {
        const introClipId = project.intro_clip_id as string;
        const { data: introClip } = await sb
          .from("video_clips")
          .select("id, clip_url, start_time, end_time, video_source_id")
          .eq("id", introClipId).single();
        if (!introClip) throw new Error("intro clip row not found");
        const { data: introSource } = await sb
          .from("video_sources")
          .select("youtube_video_id, youtube_url")
          .eq("id", introClip.video_source_id as string).single();
        if (!introSource) throw new Error("intro clip's source row not found");

        const declaredDur = Number(project.intro_duration_seconds)
          || (Number(introClip.end_time) - Number(introClip.start_time))
          || 5.5;
        // Hard-clamp to 5–6 s per spec.
        introDurationActual = Math.min(6, Math.max(5, declaredDur));

        // (a) Download silent intro video, trim, normalize, prepend to list.
        const introVideoLocal = path.join(tmp, "intro_in.mp4");
        await downloadHttp(introClip.clip_url as string, introVideoLocal);
        const introTrimmed = path.join(tmp, "intro_trim.mp4");
        await cutClip({
          inputPath: introVideoLocal,
          outputPath: introTrimmed,
          startSeconds: 0,
          durationSeconds: introDurationActual,
        });
        const introNormalized = path.join(tmp, "intro_norm.mp4");
        await normalizeClip({
          inputPath: introTrimmed, outputPath: introNormalized,
          width: 1280, height: 720, fps: 30,
        });
        normalized.unshift(introNormalized);   // prepend
        await safeUnlink(introVideoLocal);
        await safeUnlink(introTrimmed);

        // (b) yt-dlp the audio for the intro source, cut to [start, end].
        const introTmp = path.join(tmp, "intro_audio");
        await fs.mkdir(introTmp, { recursive: true });
        const audioDl = await downloadYoutubeAudio({
          url: introSource.youtube_url as string,
          outputDir: introTmp,
          videoId: introSource.youtube_video_id as string,
        });
        const introAudioCut = path.join(tmp, "intro_audio_cut.m4a");
        await cutAudio({
          inputPath: audioDl.outputPath,
          outputPath: introAudioCut,
          startSeconds: Number(introClip.start_time) || 0,
          durationSeconds: introDurationActual,
        });
        await safeUnlink(audioDl.outputPath);
        introAudioPath = introAudioCut;

        // (c) Persist the cut audio URL on the project for traceability.
        const audioDest = `projects/${projectId}/intro/audio_${Date.now()}.m4a`;
        const audioUp = await uploadFile(introAudioCut, audioDest, "audio/mp4");
        await sb.from("projects").update({
          intro_audio_url: audioUp.publicUrl,
          intro_duration_seconds: introDurationActual,
        }).eq("id", projectId);

        await logJob({ projectId, jobId: mediaJobId },
          "render.intro.ready", {
            introClipId,
            introDurationActual,
            introAudioUrl: audioUp.publicUrl,
          });
      } catch (e) {
        // Intro is best-effort. Render without it on any failure — log so
        // the operator knows the project shipped without the planned intro.
        introAudioPath = undefined;
        introDurationActual = 0;
        await logJob({ projectId, jobId: mediaJobId },
          "render.intro.failed", { err: (e as Error).message });
      }
    }

    // 4) Concat
    const finalLocal = path.join(tmp, `final_${projectId}.mp4`);
    const bgMusicGain = project?.bg_music_gain != null
      ? Number(project.bg_music_gain)
      : 0.15;
    await concatNormalizedClips({
      inputPaths: normalized,
      outputPath: finalLocal,
      voiceoverPath: voiceoverLocal,
      voiceoverGain: 1.0,
      bgMusicPath: bgMusicLocal,
      bgMusicGain,
      introAudioPath,
      introDurationSeconds: introDurationActual || undefined,
    });
    await setMediaJob(mediaJobId, { progress: 85 });
    await sb.from("render_jobs").update({ progress: 85 }).eq("id", renderJobId);

    // 5) Upload final
    const dest = `projects/${projectId}/final/${Date.now()}.mp4`;
    const up = await uploadFile(finalLocal, dest, "video/mp4");

    await sb.from("render_jobs").update({
      status: "completed", progress: 100, output_url: up.publicUrl,
    }).eq("id", renderJobId);
    await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { outputUrl: up.publicUrl } });
    await setProjectStatus(projectId, "completed");
  } catch (e) {
    const msg = (e as Error).message;
    await sb.from("render_jobs").update({ status: "failed", error: msg }).eq("id", renderJobId);
    await setMediaJob(mediaJobId, { status: "failed", error: msg });
    await setProjectStatus(projectId, "failed");
    throw e;
  } finally {
    // Best-effort cleanup. Walking the tmp dir covers every file the run
    // might have written (downloads, trimmed cuts, normalized segments,
    // intro pieces, the final mp4 itself once uploaded) without us having
    // to maintain a parallel list.
    try {
      const entries = await fs.readdir(tmp);
      for (const f of entries) await safeUnlink(path.join(tmp, f));
    } catch { /* ignore */ }
  }
}

async function downloadHttp(url: string, destPath: string): Promise<void> {
  const timeoutMs = getEnv().HTTP_DOWNLOAD_TIMEOUT_SECONDS * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`download ${url}: ${r.status}`);
    if (!r.body) throw new Error(`download ${url}: empty body`);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    // Stream the response straight to disk instead of buffering the entire
    // body via arrayBuffer(). For a 16-clip render this loop runs 17+ times
    // with 1–10 MB per file; the buffered version peaked all of them in RAM
    // at once and starved ffmpeg. Streaming holds ~64KB at any moment and
    // overlaps network read with disk write.
    //
    // pipeline() honors the signal option natively — without it, a server
    // that holds the connection open without sending bytes (slow CDN, dead
    // origin) leaves the read half waiting forever and the AbortController's
    // fire-on-timeout never propagates to the disk-write side. We've seen
    // renders hang at 64% (one image left) for exactly this reason.
    await pipeline(
      Readable.fromWeb(r.body as never),
      createWriteStream(destPath),
      { signal: ctrl.signal },
    );
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.name === "AbortError" || err.code === "ABORT_ERR") {
      throw new Error(`download ${url}: timed out after ${timeoutMs / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

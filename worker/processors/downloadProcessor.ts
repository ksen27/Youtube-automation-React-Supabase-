import path from "node:path";
import { promises as fs } from "node:fs";
import type { DownloadJobData } from "@/lib/jobs/queue";
import { createMediaJob, logJob, setMediaJob } from "@/lib/jobs/db";
import { enqueueClip, enqueueDownload } from "@/lib/jobs/queue";
import { getServerSupabase } from "@/lib/supabase/server";
import { downloadYoutubeVideo } from "@/lib/media/ytdlp";
import { probeFile } from "@/lib/media/probe";
import { ensureTmp, safeUnlink, uploadFile } from "@/lib/storage";
import { getEnv } from "@/lib/env";
import { safeFilename } from "@/lib/utils";
import type { JobAttemptInfo } from "../index";
import { maybeEnqueueMatch } from "./_shared";

// Dedup guard for clip-job enqueue. Returns true when a queued or running
// clip job already exists for the given video_source. Used by both enqueue
// sites in this processor to prevent two concurrent clip jobs from sharing
// /tmp/work/<videoId>/ paths and corrupting each other's frame stills /
// source mp4 (the ENOENT-mid-clip-extraction symptom).
async function hasOpenClipJob(videoSourceId: string): Promise<boolean> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("media_jobs")
    .select("id, metadata, status")
    .eq("type", "clip")
    .in("status", ["queued", "running"]);
  if (!data || data.length === 0) return false;
  for (const row of data) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    if (meta.videoSourceId === videoSourceId) return true;
  }
  return false;
}

export async function processDownloadJob(
  data: DownloadJobData,
  attempt?: JobAttemptInfo,
): Promise<void> {
  const env = getEnv();
  const sb = getServerSupabase();
  const { projectId, mediaJobId, youtubeVideoId, youtubeUrl, title } = data;
  const attemptsMade = attempt?.attemptsMade ?? 1;
  const attemptsAllowed = attempt?.attemptsAllowed ?? 1;
  const isFinalAttempt = attemptsMade >= attemptsAllowed;

  await setMediaJob(mediaJobId, { status: "running", progress: 5 });

  // 1) Reuse-cached: if we have a video_source for this YouTube ID already with
  //    clipped clips, just enqueue match (or skip — clips are already linked
  //    to a different project; for MVP, fork by re-clipping for new project).
  const safeId = safeFilename(youtubeVideoId);
  const { data: existing } = await sb
    .from("video_sources")
    .select("*")
    .eq("youtube_video_id", safeId)
    .maybeSingle();

  if (existing && existing.status === "clipped" && existing.storage_url) {
    // Already have the source persisted in R2 — re-clip cheaply by re-downloading
    // it on the clip worker and cutting again. (We cannot trust local_path: the
    // file may live on a different worker's disk or have been GC'd since.)
    await logJob({ projectId, jobId: mediaJobId, sourceId: existing.id }, "download.cache.hit");
    // Make sure source is associated with this project (one source row per video).
    if (existing.project_id !== projectId) {
      await sb.from("video_sources").update({ project_id: projectId }).eq("id", existing.id);
    }
    // Dedup guard: refuse to enqueue a clip job if one is already in flight
    // for this source. Without this, restarting a partially-processed project
    // (user stopped + resumed) re-enqueues a clip job for sources that ALREADY
    // had one running, which then races on /tmp/work/<videoId>/ paths and
    // corrupts the in-flight job's tmp directory. Symptom: ENOENT errors mid-
    // clip-extraction and duplicate source rows in the editor.
    const alreadyInFlight = await hasOpenClipJob(existing.id);
    if (alreadyInFlight) {
      await logJob({ projectId, jobId: mediaJobId, sourceId: existing.id },
        "download.clip.dedup_skip", { reason: "clip job already running" });
      await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { cached: true, dedupSkipped: true } });
      return;
    }
    const childId = await createMediaJob({ projectId, type: "clip", metadata: { videoSourceId: existing.id, cached: true } });
    await enqueueClip({ projectId, mediaJobId: childId, videoSourceId: existing.id });
    await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { cached: true } });
    return;
  }

  // Phase B: copy source-intent provenance from the youtube_search_results
  // row so it follows the video into video_sources.metadata. This is the
  // chain that ends with each video_clip carrying the same trio (matched
  // query / intended subject / source intent) and lets the matcher's
  // deterministic scorer apply its +50 person-first bonus without having
  // to re-derive who the clip is supposed to depict.
  //
  // We look it up by youtube_video_id (not by id) because the analyze
  // route inserts rows for the WHOLE project and the standalone search
  // processor inserts a subset — but both keyed by the same safeId.
  const { data: searchRow } = await sb
    .from("youtube_search_results")
    .select("metadata")
    .eq("project_id", projectId)
    .eq("youtube_video_id", safeId)
    .maybeSingle();
  const searchMeta = (searchRow?.metadata as Record<string, unknown> | null) ?? {};
  const sourceProvenance = {
    matched_query: (searchMeta.matched_query as string | null) ?? null,
    intended_subject: (searchMeta.intended_subject as string | null) ?? null,
    source_intent: (searchMeta.source_intent as string | null) ?? null,
  };

  // 2) Upsert a video_source row (status=downloading). Include the title from
  // the search result so the UI has something readable while the download is
  // in flight — without this, the processing screen falls back to "Unknown
  // video" until ffprobe completes (and even then we never populated title).
  const { data: vs, error: vsErr } = await sb.from("video_sources").upsert(
    {
      project_id: projectId,
      youtube_video_id: safeId,
      youtube_url: youtubeUrl,
      title: title ?? null,
      status: "downloading",
      error: null,
      metadata: sourceProvenance,
    },
    { onConflict: "youtube_video_id" }
  ).select("*").single();
  if (vsErr || !vs) throw new Error(`upsert video_source: ${vsErr?.message}`);

  await setMediaJob(mediaJobId, { progress: 15, metadata: { videoSourceId: vs.id, attemptsMade, attemptsAllowed } });

  // 3) Download with yt-dlp
  const tmp = await ensureTmp(`source/${safeId}`);
  try {
    const result = await downloadYoutubeVideo({
      // 1080p, not 2160p: the export is 4K but the FOOTAGE need not be (client
      // 2026-08-03). Raised from 720 anyway because the 3840x2160 canvas would
      // upscale 720p footage 3x across most of a celebrity video's screen time,
      // and yt-dlp costs bandwidth only — no per-unit price. Raise to 2160 if real
      // 4K footage is ever wanted (few YouTube sources actually carry it).
      url: youtubeUrl, outputDir: tmp, videoId: safeId, maxHeight: 1080,
      onLog: () => { /* keep stdout clean — high-volume */ },
    });

    await setMediaJob(mediaJobId, { progress: 60 });

    // 4) Probe
    const probe = await probeFile(result.outputPath);

    // Guard: yt-dlp can succeed but produce a file that lacks a video stream
    // (e.g. audio-only fallback when format negotiation fails). Treat as a
    // terminal failure and promote the next candidate.
    if (!probe.videoCodec || probe.width == null || probe.height == null) {
      const msg = "download produced incomplete file (no video stream — video may be age-gated, region-blocked, or lack a compatible format)";
      await safeUnlink(result.outputPath);
      await sb.from("video_sources").update({ status: "failed", error: msg }).eq("id", vs.id);
      await sb.from("youtube_search_results")
        .update({ status: "failed" })
        .eq("project_id", projectId)
        .eq("youtube_video_id", safeId);
      await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: msg });
      await tryPromoteFallback(projectId, safeId, mediaJobId, "no_video_stream");
      return;
    }

    if (probe.durationSeconds > env.MAX_SOURCE_DURATION_SECONDS) {
      await safeUnlink(result.outputPath);
      await sb.from("video_sources").update({
        status: "failed",
        error: `duration ${Math.round(probe.durationSeconds)}s > max ${env.MAX_SOURCE_DURATION_SECONDS}s`,
      }).eq("id", vs.id);
      await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: "source too long" });
      // Terminal failure (won't change on retry) — try to promote a fallback.
      await tryPromoteFallback(projectId, safeId, mediaJobId, "source_too_long");
      return; // do not throw — terminal, not retryable
    }

    // 5) Upload source to R2 so the clip worker (potentially a different
    //    machine) can fetch it. Without this, clipProcessor sees no file at
    //    `local_path` and every cutClip throws → "all clip cuts failed".
    const sourceDest = `projects/${projectId}/source/${safeId}.mp4`;
    await setMediaJob(mediaJobId, { progress: 75 });
    const sourceUp = await uploadFile(result.outputPath, sourceDest, "video/mp4");

    // 6) Mark video_source ready for clipping. local_path stays unset — the
    //    R2 key on storage_url is the source of truth across workers.
    const { error: updErr } = await sb.from("video_sources").update({
      status: "downloaded",
      storage_url: sourceUp.publicUrl,
      duration_seconds: Math.round(probe.durationSeconds),
      title: vs.title,
      metadata: {
        ...(vs.metadata as Record<string, unknown> ?? {}),
        storage_path: sourceDest,
        probe: { width: probe.width, height: probe.height, hasAudio: probe.hasAudio,
                 videoCodec: probe.videoCodec, audioCodec: probe.audioCodec },
      },
    }).eq("id", vs.id);
    if (updErr) throw new Error(`update video_source: ${updErr.message}`);

    // Local copy is no longer needed — the clip worker pulls from R2.
    await safeUnlink(result.outputPath);

    // 7) Update youtube_search_results status to "downloaded"
    await sb.from("youtube_search_results")
      .update({ status: "downloaded" })
      .eq("project_id", projectId)
      .eq("youtube_video_id", safeId);

    await setMediaJob(mediaJobId, { progress: 90 });

    // 8) Enqueue clip job — same dedup guard as the cache-hit path above.
    // Protects against a download retry (BullMQ attempt 2/3) racing the
    // clip job from attempt 1, which would otherwise share the same
    // /tmp/work/<videoId>/ paths and corrupt each other.
    const alreadyInFlight = await hasOpenClipJob(vs.id);
    if (alreadyInFlight) {
      await logJob({ projectId, jobId: mediaJobId, sourceId: vs.id },
        "download.clip.dedup_skip", { reason: "clip job already running" });
      await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { dedupSkipped: true } });
      return;
    }
    const clipJobId = await createMediaJob({
      projectId, type: "clip", metadata: { videoSourceId: vs.id },
    });
    await enqueueClip({ projectId, mediaJobId: clipJobId, videoSourceId: vs.id });

    await setMediaJob(mediaJobId, { status: "completed", progress: 100 });
  } catch (e) {
    const msg = (e as Error).message;
    // Try to clean partial files on every attempt.
    try {
      const files = await fs.readdir(tmp);
      for (const f of files) await safeUnlink(path.join(tmp, f));
    } catch { /* ignore */ }

    const terminalReason = classifyTerminalError(msg);
    await logJob({ projectId, jobId: mediaJobId, sourceId: vs.id },
      "download.attempt.failed", { attemptsMade, attemptsAllowed, err: msg, terminalReason });

    if (!isFinalAttempt && !terminalReason) {
      // Surface as "running with retry pending" but rethrow so BullMQ retries.
      // Don't mark video_source as failed yet — keep it "downloading" so siblings
      // know it's still in flight.
      throw e;
    }

    // Final attempt OR a known-terminal error — record failure and promote fallback.
    // The user-facing error replaces yt-dlp's stderr blob (which links to
    // GitHub wikis about cookies and proxies — not actionable for the user).
    // The full raw `msg` is already in the structured log above.
    const userMessage = humanizeDownloadError(msg);
    await sb.from("video_sources").update({ status: "failed", error: userMessage }).eq("id", vs.id);
    await sb.from("youtube_search_results")
      .update({ status: "failed" })
      .eq("project_id", projectId)
      .eq("youtube_video_id", safeId);
    await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: userMessage });

    await tryPromoteFallback(projectId, safeId, mediaJobId, terminalReason ?? "download_failed");
    // Do NOT rethrow — we've handled the terminal state and (if possible) queued
    // a fallback. Throwing here would just leave a noisy "failed" job on top of
    // the recorded media_job state.
  }
}

// Match yt-dlp stderr against known-permanent failure modes. Returning a
// reason string short-circuits the BullMQ retry loop and goes straight to
// fallback promotion; null means "transient, worth retrying".
function classifyTerminalError(msg: string): string | null {
  const m = msg.toLowerCase();
  // "Sign in to confirm you're not a bot" is YouTube's bot-detection wall
  // hitting cloud IPs — NOT a permanent failure. A retry through a different
  // residential proxy from YTDLP_PROXIES usually succeeds, so we let BullMQ
  // run its full attempts loop instead of short-circuiting to fallback
  // promotion (which produced duplicate-title sources from re-uploads).
  if (m.includes("age-restricted") || m.includes("age restricted")) return "age_gated";
  if (m.includes("private video")) return "private";
  if (m.includes("video unavailable") || m.includes("removed by the uploader") || m.includes("account associated with this video has been terminated")) return "unavailable";
  if (m.includes("not available in your country") || m.includes("blocked it in your country") || m.includes("geo restrict")) return "geo_blocked";
  if (m.includes("members-only") || m.includes("join this channel")) return "members_only";
  if (m.includes("requested format is not available") || m.includes("no video formats found")) return "no_compatible_format";
  return null;
}

// Convert a raw yt-dlp stderr blob into a short, user-friendly sentence for
// the UI. The raw text contains GitHub wiki URLs and CLI flag instructions
// that aren't actionable for the end user — the worker is the one that
// would need new cookies/proxy, not them. We keep the full raw message in
// the structured log (logJob) for debugging; this function only shapes what
// the user sees on the processing screen.
function humanizeDownloadError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes("sign in to confirm") || m.includes("not a bot") || m.includes("confirm you're not a bot")) {
    return "YouTube blocked the download (bot check). Retrying with a different network route — if every retry fails, the next-best source will be used.";
  }
  if (m.includes("age-restricted") || m.includes("age restricted")) {
    return "Video is age-restricted on YouTube and can't be downloaded without sign-in. Using the next-best source.";
  }
  if (m.includes("private video")) {
    return "Video is private. Using the next-best source.";
  }
  if (m.includes("removed by the uploader") || m.includes("account associated with this video has been terminated")) {
    return "Video was removed from YouTube. Using the next-best source.";
  }
  if (m.includes("video unavailable")) {
    return "Video is unavailable on YouTube. Using the next-best source.";
  }
  if (m.includes("not available in your country") || m.includes("blocked it in your country") || m.includes("geo restrict")) {
    return "Video is region-blocked and can't be reached from this server. Using the next-best source.";
  }
  if (m.includes("members-only") || m.includes("join this channel")) {
    return "Video is members-only on YouTube. Using the next-best source.";
  }
  if (m.includes("requested format is not available") || m.includes("no video formats found")) {
    return "Video has no compatible format (likely live or audio-only). Using the next-best source.";
  }
  if (m.includes("timed out") || m.includes("etimedout") || m.includes("network is unreachable")) {
    return "Network timed out while downloading. Retrying.";
  }
  // Fallback: yt-dlp surfaced something we don't have a friendly translation
  // for. Strip the wiki URLs and the CLI-flag noise so at least the UI line
  // is readable, and cap the length.
  const cleaned = raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/--cookies(-from-browser)?/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 180 ? `Download failed: ${cleaned.slice(0, 180)}…` : `Download failed: ${cleaned}`;
}

// Pick the next-best youtube_search_results row that hasn't been tried yet
// and enqueue a fresh download job for it. Caps total promotions per project
// via env.MAX_FALLBACK_PROMOTIONS_PER_PROJECT to prevent runaway retries.
async function tryPromoteFallback(
  projectId: string,
  failedVideoId: string,
  parentMediaJobId: string,
  reason: string,
): Promise<void> {
  const env = getEnv();
  const sb = getServerSupabase();
  const cap = env.MAX_FALLBACK_PROMOTIONS_PER_PROJECT;
  if (cap <= 0) return;

  // Count how many download media_jobs for this project were promoted as
  // fallbacks already.
  const { data: priorPromotions } = await sb.from("media_jobs")
    .select("id, metadata")
    .eq("project_id", projectId)
    .eq("type", "download");
  const promotedCount = (priorPromotions ?? []).filter((j) => {
    const md = j.metadata as Record<string, unknown> | null;
    return Boolean(md && md["promoted_from"]);
  }).length;
  if (promotedCount >= cap) {
    await logJob({ projectId, jobId: parentMediaJobId },
      "download.fallback.cap_reached", { promotedCount, cap });
    // Cap reached — same reasoning as no_candidate: don't leave the project
    // stuck waiting for a download that will never happen.
    await maybeEnqueueMatch(projectId);
    return;
  }

  // Pick the highest-scoring untried candidate. "Untried" means status is still
  // 'candidate' (not selected/downloaded/failed).
  const { data: next } = await sb.from("youtube_search_results")
    .select("id, youtube_video_id, url, score, title")
    .eq("project_id", projectId)
    .eq("status", "candidate")
    .order("score", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!next) {
    await logJob({ projectId, jobId: parentMediaJobId },
      "download.fallback.no_candidate", { failedVideoId, reason });
    // No replacement available — this download is permanently done. The
    // project's queue may now be drained, so try to advance the pipeline
    // with whatever succeeded instead of leaving it stuck.
    await maybeEnqueueMatch(projectId);
    return;
  }

  await sb.from("youtube_search_results")
    .update({ status: "selected" })
    .eq("id", next.id);

  const childJobId = await createMediaJob({
    projectId,
    type: "download",
    metadata: {
      youtube_video_id: next.youtube_video_id,
      youtube_url: next.url,
      title: next.title,
      promoted_from: failedVideoId,
      promotion_reason: reason,
    },
  });
  await enqueueDownload({
    projectId,
    mediaJobId: childJobId,
    youtubeVideoId: next.youtube_video_id,
    youtubeUrl: next.url ?? "",
  });

  await logJob({ projectId, jobId: parentMediaJobId },
    "download.fallback.promoted", {
      failedVideoId, replacementVideoId: next.youtube_video_id, score: next.score,
    });
}

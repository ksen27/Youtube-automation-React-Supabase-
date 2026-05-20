import path from "node:path";
import { promises as fs, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { RenderJobData } from "@/lib/jobs/queue";
import { logJob, setMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { getServerSupabase } from "@/lib/supabase/server";
import { ensureTmp, safeUnlink, uploadFile } from "@/lib/storage";
import { concatAudioFiles, concatNormalizedClips, cutClip, cutAudio, normalizeClip, buildStillVideo, buildTitleCardVideo, buildSplitScreenVideo, xfadePair, xfadeFadeBlack, applyEdgeFade, IMAGE_XFADE_PALETTE, type SfxCue } from "@/lib/media/ffmpeg";
import { probeFile } from "@/lib/media/probe";
import { detectSceneTimestamps } from "@/lib/media/scenes";
import { downloadYoutubeAudio, downloadYoutubeVideo } from "@/lib/media/ytdlp";
import { getEnv } from "@/lib/env";

const VALIDATION_FAILED_MSG =
  "Timeline duration must match voiceover and use unique clips.";

// Pull the 11-char video id out of the YouTube URL the user pasted on the
// intake screen. Accepts watch?v=, youtu.be/, shorts/, embed/, and a bare
// id. The PATCH route already validates this on save — this helper is the
// worker-side fallback so we never invoke yt-dlp with an unusable URL.
function extractIntroVideoId(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

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
    // Forced clip from a script-doc title-card marker. No clip_id (we never
    // ran search/match for these), no image_url — but a YouTube URL + window
    // on metadata.forced_clip that the render step downloads on demand.
    if (it.type === "footage") {
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      const fc = meta.forced_clip as { youtube_url?: string } | undefined;
      if (fc?.youtube_url) return true;
    }
    if (it.type === "image" && it.image_url) return true;
    // Title cards have no clip and no image — they're rendered from a
    // section title string in overlay_text. Keep them in the renderable
    // list so the segment appears at the right timeline position.
    if (it.type === "title_card" && typeof it.overlay_text === "string" && it.overlay_text.trim().length > 0) return true;
    // Split-screen blocks: matcher persists the left image on image_url
    // and the right image on metadata.right_image_url. Need BOTH to render
    // a usable split; if either is missing the matcher downgraded the row
    // to a plain image already.
    if (it.type === "split_2") {
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      return !!it.image_url && typeof meta.right_image_url === "string" && (meta.right_image_url as string).length > 0;
    }
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
  // Per-slot recorded duration of the rendered segment, in seconds. For image
  // slots that have an image neighbor this is `planned + headroom` so the
  // xfade pass can eat the overlap; for footage and isolated images it's the
  // plain planned duration. Used downstream to compute xfade offset.
  const slotDurations: number[] = new Array(renderable.length).fill(0);
  // Transition timing.
  //   - image↔image: 0.5s xfade, rotating through IMAGE_XFADE_PALETTE.
  //   - image↔video and video↔image: 0.4s fade-through-black (no xfade,
  //     just an edge fade on each side that meets at black).
  //   - video↔video: hard cut, no transition.
  //
  // For image↔image we render each image with HALF the xfade baked in on the
  // sides that have an image neighbor (existing behavior), so the xfade
  // consumes the headroom and visible hold stays equal to planned duration.
  //
  // For image↔video boundaries we extend the IMAGE side with HALF the fade
  // duration of headroom (so the visible content time on the image side
  // matches its planned duration), but the VIDEO side keeps its exact
  // cutClip duration — the fade just darkens existing frames, doesn't
  // shorten the clip. Net effect on total timeline length: each mixed
  // boundary stays within ~0.2s of the planned length.
  const IMAGE_XFADE_SECONDS = 0.5;
  const MIXED_FADE_SECONDS = 0.4;
  // Title cards and split-screens are still frames (no motion), so for
  // transition purposes they behave like image neighbors: dissolve into
  // adjacent images, dip-to-black into adjacent footage. The boundary
  // code below never inspects what's inside the segment, only whether
  // it's a still or motion source.
  const isImageNeighbor = (i: number): boolean => {
    const it = renderable[i];
    if (it?.type === "image" && it.image_url) return true;
    if (it?.type === "title_card") return true;
    if (it?.type === "split_2") return true;
    return false;
  };
  const isVideoNeighbor = (i: number): boolean => {
    const it = renderable[i];
    return !!it?.clip_id;
  };
  // SFX cues should only land on REAL photo→photo dissolves, not on
  // title-card or split-screen transitions. isImageNeighbor lumps all three
  // together for transition-math purposes (they're all still frames), so we
  // use this stricter predicate just for the SFX trigger.
  const isRealImage = (i: number): boolean => {
    const it = renderable[i];
    return it?.type === "image" && !!it.image_url;
  };
  let imageRendered = 0;
  let imageFailed = 0;

  try {
    // 1) Process each item in parallel lanes. Footage items are downloaded
    //    then trimmed+normalized; image items fetch the URL, save locally,
    //    and build a still video segment. Each lane writes into its
    //    timeline slot so the final order matches `renderable`.
    //
    // Render is encode-heavy (every clip gets a full libx264 pass during
    // normalize, then again in the final concat). Use the dedicated render
    // knob — clip-stage parallelism is download-heavy and tolerates more
    // concurrency than encoding does. Tune RENDER_PIPELINE_CONCURRENCY *
    // FFMPEG_THREADS ≤ vCPU count to avoid encoder thrash.
    const env = getEnv();
    const laneCount = Math.max(1, Math.min(env.RENDER_PIPELINE_CONCURRENCY, renderable.length));
    let cursor = 0;
    let completed = 0;

    async function processItem(i: number): Promise<void> {
      const it = renderable[i];
      const plannedDur = Math.max(0.5, Number(it.duration) || 0);
      const idx = String(i).padStart(3, "0");
      const out = path.join(tmp, `norm_${idx}.mp4`);

      if (it.type === "split_2") {
        // Split-screen: matcher persisted the LEFT image URL on
        // image_url and the RIGHT URL on metadata.right_image_url.
        // Download both, then call buildSplitScreenVideo to assemble the
        // half-width side-by-side composite. Same headroom logic as a
        // single image — split blocks are still frames, so their
        // transition partners treat them identically.
        const leftPartnerImage = isImageNeighbor(i - 1);
        const leftPartnerVideo = isVideoNeighbor(i - 1);
        const rightPartnerImage = isImageNeighbor(i + 1);
        const rightPartnerVideo = isVideoNeighbor(i + 1);
        const headLeft = leftPartnerImage
          ? IMAGE_XFADE_SECONDS / 2
          : leftPartnerVideo
            ? MIXED_FADE_SECONDS / 2
            : 0;
        const headRight = rightPartnerImage
          ? IMAGE_XFADE_SECONDS / 2
          : rightPartnerVideo
            ? MIXED_FADE_SECONDS / 2
            : 0;
        const renderDur = plannedDur + headLeft + headRight;
        const meta = (it.metadata ?? {}) as Record<string, unknown>;
        const leftUrl = it.image_url as string;
        const rightUrl = meta.right_image_url as string;
        const leftLocal = path.join(tmp, `splitL_${idx}`);
        const rightLocal = path.join(tmp, `splitR_${idx}`);
        try {
          await Promise.all([
            downloadHttp(leftUrl, leftLocal),
            downloadHttp(rightUrl, rightLocal),
          ]);
          const splitMeta = (it.metadata ?? {}) as Record<string, unknown>;
          const splitLt = splitMeta.lower_third as { text?: string } | undefined;
          await buildSplitScreenVideo({
            leftImagePath: leftLocal,
            rightImagePath: rightLocal,
            outputPath: out,
            durationSeconds: renderDur,
            width: 1280, height: 720, fps: 30,
            lowerThird: splitLt?.text ? { text: splitLt.text } : undefined,
          });
          slots[i] = out;
          slotDurations[i] = renderDur;
          imageRendered++;
        } catch (e) {
          imageFailed++;
          await logJob({ projectId, jobId: mediaJobId },
            "render.split.failed", { idx: i, leftUrl, rightUrl, err: (e as Error).message });
        } finally {
          await safeUnlink(leftLocal);
          await safeUnlink(rightLocal);
        }
      } else if (it.type === "title_card") {
        // Section-break title card: black background with the section
        // title rendered as centered white text. Source comes from
        // overlay_text, populated by the matcher from Gemini's per-segment
        // sectionTitle. We bake the same per-side headroom an image
        // neighbor would (still frames behave identically through xfades),
        // so the transition math downstream still adds up.
        const leftPartnerImage = isImageNeighbor(i - 1);
        const leftPartnerVideo = isVideoNeighbor(i - 1);
        const rightPartnerImage = isImageNeighbor(i + 1);
        const rightPartnerVideo = isVideoNeighbor(i + 1);
        const headLeft = leftPartnerImage
          ? IMAGE_XFADE_SECONDS / 2
          : leftPartnerVideo
            ? MIXED_FADE_SECONDS / 2
            : 0;
        const headRight = rightPartnerImage
          ? IMAGE_XFADE_SECONDS / 2
          : rightPartnerVideo
            ? MIXED_FADE_SECONDS / 2
            : 0;
        const renderDur = plannedDur + headLeft + headRight;
        const text = String(it.overlay_text ?? "").trim();
        try {
          await buildTitleCardVideo({
            text,
            outputPath: out,
            durationSeconds: renderDur,
            width: 1280, height: 720, fps: 30,
          });
          slots[i] = out;
          slotDurations[i] = renderDur;
        } catch (e) {
          await logJob({ projectId, jobId: mediaJobId },
            "render.title_card.failed", { idx: i, text, err: (e as Error).message });
        }
      } else if (it.type === "image" && it.image_url) {
        // Bake headroom into the still video on every side that has a
        // transition partner. For image↔image we eat IMAGE_XFADE_SECONDS / 2
        // because the xfade overlaps the tail of A with the head of B; for
        // image↔video we eat MIXED_FADE_SECONDS / 2 because the edge fade
        // darkens the last frames into black (still visible, but content
        // time effectively halves on that side). Either way the visible
        // "useful" hold time stays close to plannedDur.
        const leftPartnerImage = isImageNeighbor(i - 1);
        const leftPartnerVideo = isVideoNeighbor(i - 1);
        const rightPartnerImage = isImageNeighbor(i + 1);
        const rightPartnerVideo = isVideoNeighbor(i + 1);
        const headLeft = leftPartnerImage
          ? IMAGE_XFADE_SECONDS / 2
          : leftPartnerVideo
            ? MIXED_FADE_SECONDS / 2
            : 0;
        const headRight = rightPartnerImage
          ? IMAGE_XFADE_SECONDS / 2
          : rightPartnerVideo
            ? MIXED_FADE_SECONDS / 2
            : 0;
        const renderDur = plannedDur + headLeft + headRight;
        try {
          const localImg = path.join(tmp, `img_${idx}`);
          await downloadHttp(it.image_url as string, localImg);
          const imgMeta = (it.metadata ?? {}) as Record<string, unknown>;
          const imgLt = imgMeta.lower_third as { text?: string } | undefined;
          await buildStillVideo({
            inputImagePath: localImg,
            outputPath: out,
            durationSeconds: renderDur,
            width: 1280, height: 720, fps: 30,
            // Alternate zoom direction by timeline index so consecutive
            // image blocks don't all push the viewer the same way.
            motionDirection: i % 2 === 0 ? "in" : "out",
            lowerThird: imgLt?.text ? { text: imgLt.text } : undefined,
          });
          slots[i] = out;
          slotDurations[i] = renderDur;
          imageRendered++;
          await safeUnlink(localImg);
        } catch (e) {
          imageFailed++;
          await logJob({ projectId, jobId: mediaJobId },
            "render.image.failed", { idx: i, url: it.image_url, err: (e as Error).message });
        }
      } else if (it.type === "footage" && (((it.metadata ?? {}) as Record<string, unknown>).forced_clip as { youtube_url?: string } | undefined)?.youtube_url) {
        // Forced clip from a script-doc title-card marker. We download the
        // YouTube source via the proxied yt-dlp pipeline, cut the window the
        // doc specified, and normalize — same shape as the user-intro path
        // above, but for a mid-timeline footage segment. clip_id stays null
        // because there's no video_clips row for this content.
        const meta = (it.metadata ?? {}) as Record<string, unknown>;
        const fc = meta.forced_clip as { youtube_url: string; start_seconds?: number; end_seconds?: number };
        const videoId = extractIntroVideoId(fc.youtube_url);
        if (!videoId) {
          await logJob({ projectId, jobId: mediaJobId },
            "render.forced_clip.bad_url", { idx: i, url: fc.youtube_url });
          return;
        }
        const startSeconds = Number(fc.start_seconds ?? 0);
        const endSeconds = Number(fc.end_seconds ?? startSeconds + plannedDur);
        const windowDur = Math.max(1, endSeconds - startSeconds);
        const leftIsImage = isImageNeighbor(i - 1);
        const rightIsImage = isImageNeighbor(i + 1);
        const headLeft = leftIsImage ? MIXED_FADE_SECONDS / 2 : 0;
        const headRight = rightIsImage ? MIXED_FADE_SECONDS / 2 : 0;
        const renderDur = windowDur + headLeft + headRight;
        const dlDir = path.join(tmp, `forced_${idx}`);
        const trimmed = path.join(tmp, `forced_cut_${idx}.mp4`);
        try {
          await fs.mkdir(dlDir, { recursive: true });
          const dl = await downloadYoutubeVideo({
            url: fc.youtube_url,
            outputDir: dlDir,
            videoId,
          });
          await cutClip({
            inputPath: dl.outputPath, outputPath: trimmed,
            startSeconds, durationSeconds: renderDur,
          });
          const lt = meta.lower_third as { text?: string } | undefined;
          await normalizeClip({
            inputPath: trimmed, outputPath: out,
            width: 1280, height: 720, fps: 30,
            lowerThird: lt?.text ? { text: lt.text } : undefined,
          });
          slots[i] = out;
          let actualDur = renderDur;
          try {
            const probed = await probeFile(out);
            if (probed.durationSeconds > 0) actualDur = probed.durationSeconds;
          } catch { /* keep renderDur fallback */ }
          slotDurations[i] = actualDur;
          await safeUnlink(dl.outputPath);
          await safeUnlink(trimmed);
        } catch (e) {
          await logJob({ projectId, jobId: mediaJobId },
            "render.forced_clip.failed", {
              idx: i,
              url: fc.youtube_url,
              videoId,
              err: (e as Error).message,
            });
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
          // Bake MIXED_FADE_SECONDS / 2 of headroom on each side that
          // borders an image neighbor. The image side already extends
          // itself by the same amount; without this, the xfaceFadeBlack
          // pass subtracts MIXED_FADE_SECONDS of wall-clock time but only
          // one side contributed headroom, leaving the timeline short by
          // 0.2s per mixed boundary (compounds to 13s+ on a 10-min video).
          const leftIsImage = isImageNeighbor(i - 1);
          const rightIsImage = isImageNeighbor(i + 1);
          const headLeft = leftIsImage ? MIXED_FADE_SECONDS / 2 : 0;
          const headRight = rightIsImage ? MIXED_FADE_SECONDS / 2 : 0;
          const renderDur = plannedDur + headLeft + headRight;
          await cutClip({
            inputPath: local, outputPath: trimmed,
            startSeconds: 0, durationSeconds: renderDur,
          });
          // Lower-third stamped by the matcher: { text, type } on
          // metadata.lower_third when this clip should introduce a name
          // (first occurrence only) or label a year/place visual. Render
          // passes only the text — type is used by the matcher for the
          // first-time-only rule and is irrelevant downstream.
          const meta = (it.metadata ?? {}) as Record<string, unknown>;
          const lt = meta.lower_third as { text?: string } | undefined;
          await normalizeClip({
            inputPath: trimmed, outputPath: out,
            width: 1280, height: 720, fps: 30,
            lowerThird: lt?.text ? { text: lt.text } : undefined,
          });
          slots[i] = out;
          // Probe the actually-produced clip. When the source footage is
          // shorter than renderDur, cutClip silently outputs the available
          // tail — the matcher's clampedFootageBlocks counter sees this on
          // the planning side, but slotDurations[i] used to record the
          // REQUESTED renderDur regardless. That lie made every downstream
          // SFX cue land later than its visual transition, because the cue
          // offsets are computed by walking mergedDurations. Use the probed
          // duration so the timeline arithmetic matches the bytes on disk.
          // Fallback to renderDur if probing fails (best-effort).
          let actualDur = renderDur;
          try {
            const probed = await probeFile(out);
            if (probed.durationSeconds > 0) actualDur = probed.durationSeconds;
          } catch { /* keep renderDur fallback */ }
          slotDurations[i] = actualDur;
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

    // Apply transitions at boundaries between successfully-rendered slots.
    // Three cases:
    //   1) image↔image: fold via xfadePair with a palette style (rotated by
    //      boundary index). Merged segment replaces the previous list entry;
    //      chains of 3+ images chain through the same slot.
    //   2) image↔video and video↔image: apply a fade-out on the tail of the
    //      left segment and a fade-in on the head of the right segment.
    //      Both segments stay separate in the concat list; they meet at
    //      black for a clean dip-to-black transition.
    //   3) video↔video: hard cut, no edits.
    //
    // A failed slot (null) is skipped, which also breaks any transition
    // chain it sat in — the surrounding boundaries become hard cuts.
    type SegKind = "image" | "video";
    const mergedSegments: string[] = [];
    const mergedDurations: number[] = [];
    const mergedKinds: SegKind[] = [];
    // Parallel to mergedKinds: tracks whether the segment that produced the
    // CURRENT tail of each merged entry is a real photo (type=image). Used by
    // the SFX cadence so a title-card→image dissolve doesn't get counted as a
    // photo→photo transition. mergeMixedBoundary and the image-xfade branch
    // both keep this in sync with whatever last contributed to the tail.
    const mergedTailIsRealImage: boolean[] = [];
    let xfadeMerges = 0;
    let mixedFades = 0;
    // Boundary index for palette rotation. Incremented every time we apply
    // an image→image xfade so consecutive dissolves cycle through the list.
    let imageBoundaryIdx = 0;
    // Separate counter for SFX cadence — only ticks on REAL photo→photo
    // dissolves, so the every-3rd cue rotation doesn't get skewed by
    // intervening title-card or split-screen transitions.
    let realImageBoundaryIdx = 0;
    // SFX cue offsets, measured from the start of the rendered timeline
    // (BEFORE any intro is prepended — intro offset is added later when we
    // pass these into concatNormalizedClips). Offsets are computed mid-xfade
    // so the click/swipe lands on the visual transition midpoint. Cadence
    // and SFX-file rotation are wired in after fetching the project row.
    const sfxOffsetsAtBoundary: number[] = [];

    // Helper: merge the previous segment with `seg` through a single
    // dip-to-black xfade pass. Replaces the older two-pass approach
    // (fade tail of A in one ffmpeg call, fade head of B in another) with
    // xfade's `fadeblack` transition — same visual result, half the encode
    // work per mixed boundary. On failure we fall back to a hard cut so one
    // boundary glitch doesn't kill the render.
    async function mergeMixedBoundary(seg: string, segKind: SegKind, idx: number): Promise<boolean> {
      if (mergedSegments.length === 0) return false;
      const j = mergedSegments.length - 1;
      const a = mergedSegments[j];
      const aDur = mergedDurations[j];
      const out = path.join(tmp, `mixfade_${String(idx).padStart(3, "0")}.mp4`);
      try {
        await xfadeFadeBlack({
          inputAPath: a,
          inputBPath: seg,
          outputPath: out,
          inputADurationSeconds: aDur,
          transitionDurationSeconds: MIXED_FADE_SECONDS,
          fps: 30,
        });
        mergedSegments[j] = out;
        // xfade output length = aDur + segDur - transitionDuration. Total
        // visible content time matches the planned timeline because BOTH
        // sides baked MIXED_FADE_SECONDS / 2 of headroom on the touching
        // edge (image side via buildStillVideo, video side via cutClip).
        mergedDurations[j] = aDur + slotDurations[idx] - MIXED_FADE_SECONDS;
        // Kind tracks what plays AFTER the transition midpoint — i.e. the
        // incoming segment — so the next boundary decision sees the right
        // neighbor type.
        mergedKinds[j] = segKind;
        mergedTailIsRealImage[j] = isRealImage(idx);
        mixedFades++;
        await safeUnlink(a);
        await safeUnlink(seg);
        return true;
      } catch (e) {
        await logJob({ projectId, jobId: mediaJobId },
          "render.mixed_fade.failed", { idx, err: (e as Error).message });
        return false;
      }
    }

    for (let i = 0; i < slots.length; i++) {
      const seg = slots[i];
      if (seg === null) continue;
      const itemKind: SegKind = isImageNeighbor(i) ? "image" : "video";
      const prevKind: SegKind | null =
        mergedKinds.length > 0 ? mergedKinds[mergedKinds.length - 1] : null;

      if (itemKind === "image" && prevKind === "image") {
        // image→image: fold via xfade with rotating palette.
        const a = mergedSegments[mergedSegments.length - 1];
        const aDur = mergedDurations[mergedDurations.length - 1];
        const style = IMAGE_XFADE_PALETTE[imageBoundaryIdx % IMAGE_XFADE_PALETTE.length];
        const mergedOut = path.join(tmp, `xfade_${String(i).padStart(3, "0")}.mp4`);
        // Timeline offset where this xfade STARTS (sum of all prior merged
        // durations). Computed before we mutate mergedDurations[]. The
        // midpoint of the xfade is `boundaryStart + IMAGE_XFADE_SECONDS / 2`
        // — that's where we want the click/swipe to land if this boundary
        // is selected for an SFX trigger.
        let boundaryStart = 0;
        for (let k = 0; k < mergedDurations.length - 1; k++) boundaryStart += mergedDurations[k];
        boundaryStart += aDur - IMAGE_XFADE_SECONDS;
        try {
          await xfadePair({
            inputAPath: a,
            inputBPath: seg,
            outputPath: mergedOut,
            inputADurationSeconds: aDur,
            transitionDurationSeconds: IMAGE_XFADE_SECONDS,
            style,
            fps: 30,
          });
          mergedSegments[mergedSegments.length - 1] = mergedOut;
          mergedDurations[mergedDurations.length - 1] = aDur + slotDurations[i] - IMAGE_XFADE_SECONDS;
          xfadeMerges++;
          // SFX cadence: only fire on REAL photo→photo dissolves (both the
          // tail of the merged segment AND the incoming segment must be
          // type=image with an image_url). Title-card and split-screen
          // dissolves are visually similar but shouldn't trigger SFX. The
          // tail-was-real-image flag is what the previous merge wrote into
          // mergedTailIsRealImage; the incoming side uses isRealImage(i).
          const tailIsRealImage = mergedTailIsRealImage[mergedTailIsRealImage.length - 1] === true;
          const incomingIsRealImage = isRealImage(i);
          if (tailIsRealImage && incomingIsRealImage) {
            if (realImageBoundaryIdx % 3 === 0) {
              sfxOffsetsAtBoundary.push(boundaryStart + IMAGE_XFADE_SECONDS / 2);
            }
            realImageBoundaryIdx++;
          }
          mergedTailIsRealImage[mergedTailIsRealImage.length - 1] = incomingIsRealImage;
          imageBoundaryIdx++;
          await safeUnlink(a);
          await safeUnlink(seg);
        } catch (e) {
          // Fall back to a hard cut so one xfade failure doesn't kill the
          // whole render.
          await logJob({ projectId, jobId: mediaJobId },
            "render.xfade.failed", { idx: i, style, err: (e as Error).message });
          mergedSegments.push(seg);
          mergedDurations.push(slotDurations[i]);
          mergedKinds.push("image");
          mergedTailIsRealImage.push(isRealImage(i));
        }
      } else if (
        (itemKind === "image" && prevKind === "video") ||
        (itemKind === "video" && prevKind === "image")
      ) {
        // image↔video boundary: merge A and B through a single dip-to-black
        // xfade. One libx264 pass instead of the old tail-then-head pair.
        // The merged segment replaces the previous entry in place (just like
        // image→image), so the next boundary decision sees this transition's
        // incoming kind as its `prevKind`.
        const merged = await mergeMixedBoundary(seg, itemKind, i);
        if (!merged) {
          // Fall back to a hard cut. Visible jump but render still completes.
          mergedSegments.push(seg);
          mergedDurations.push(slotDurations[i]);
          mergedKinds.push(itemKind);
          mergedTailIsRealImage.push(isRealImage(i));
        }
      } else {
        // First segment, or video↔video — hard cut, append as-is.
        mergedSegments.push(seg);
        mergedDurations.push(slotDurations[i]);
        mergedKinds.push(itemKind);
        mergedTailIsRealImage.push(isRealImage(i));
      }
    }
    const normalized: string[] = mergedSegments;

    if (normalized.length === 0) throw new Error("all timeline items failed to render");

    await logJob({ projectId, jobId: mediaJobId }, "render.segments", {
      total: renderable.length,
      built: normalized.length,
      imageRendered,
      imageFailed,
      xfadeMerges,
      mixedFades,
    });

    // 3) Optional voiceover from project + intro clip selection + bg music + SFX
    const { data: project } = await sb.from("projects")
      .select("voiceover_url, title, intro_clip_id, intro_duration_seconds, intro_source_youtube_url, intro_source_start_seconds, bg_music_url, bg_music_gain, sfx_urls, sfx_gain")
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

    // SFX: also best-effort. Download each URL into tmp. If a file fails to
    // download, drop just that one — the others still get used. The cue
    // collection below rotates through whatever ended up local.
    const sfxLocals: string[] = [];
    const sfxUrlsRaw = project?.sfx_urls;
    const sfxUrls: string[] = Array.isArray(sfxUrlsRaw)
      ? (sfxUrlsRaw as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
      : [];
    for (let k = 0; k < sfxUrls.length; k++) {
      const dest = path.join(tmp, `sfx_${String(k).padStart(2, "0")}.audio`);
      try {
        await downloadHttp(sfxUrls[k], dest);
        sfxLocals.push(dest);
      } catch (e) {
        await logJob({ projectId, jobId: mediaJobId },
          "render.sfx.download_failed", { idx: k, err: (e as Error).message });
      }
    }
    const sfxGain = project?.sfx_gain != null ? Number(project.sfx_gain) : 0.7;

    // 3b) Build the intro segment (best-effort — failures fall back to a
    // render without an intro). The intro plays BEFORE the planned timeline:
    //   - Its silent video gets prepended to `normalized[]`
    //   - Its source audio is re-downloaded via yt-dlp and cut to the
    //     [start_time, end_time] window
    //   - concatNormalizedClips uses introAudioPath + crossfade to mix in
    //     the source audio for the intro window, voiceover for the rest.
    let introAudioPath: string | undefined;
    let introDurationActual = 0;

    // Multi-clip intro from script-doc markers takes priority over
    // everything else. Each intro_card row in project_script_markers is a
    // blue-bold timestamp block at the top of the user's Google Doc; we
    // download each one's YouTube source, cut its window, and prepend them
    // back-to-back as the pre-roll. Original-source audio is concatenated
    // into a single intro audio track that concatNormalizedClips uses for
    // the first introDurationActual seconds before crossfading into the
    // voiceover.
    const { data: introCardRows } = await sb
      .from("project_script_markers")
      .select("id, text, ordinal, youtube_url, start_seconds, end_seconds")
      .eq("project_id", projectId)
      .eq("kind", "intro_card")
      .order("ordinal");

    if (introCardRows && introCardRows.length > 0) {
      const introTmp = path.join(tmp, "intro_cards");
      try {
        await fs.mkdir(introTmp, { recursive: true });
        const builtVideos: string[] = []; // in doc order, prepended in reverse below
        const builtAudios: string[] = []; // in doc order
        let accumulatedDuration = 0;

        for (let k = 0; k < introCardRows.length; k++) {
          const row = introCardRows[k] as {
            id: string;
            text: string | null;
            ordinal: number;
            youtube_url: string | null;
            start_seconds: number | null;
            end_seconds: number | null;
          };
          const url = row.youtube_url?.trim();
          if (!url) continue;
          const start = Number(row.start_seconds ?? 0);
          const end = Number(row.end_seconds ?? start + 6);
          const dur = Math.max(1, end - start);
          const videoId = extractIntroVideoId(url);
          if (!videoId) {
            await logJob({ projectId, jobId: mediaJobId },
              "render.intro_card.bad_url", { ordinal: row.ordinal, url });
            continue;
          }
          try {
            const cardDir = path.join(introTmp, `card_${row.ordinal}`);
            await fs.mkdir(cardDir, { recursive: true });
            // Use a per-card subdirectory so concurrent multi-intro renders
            // don't collide on the yt-dlp output filename (it derives from
            // videoId only).
            const [videoDl, audioDl] = await Promise.all([
              downloadYoutubeVideo({ url, outputDir: cardDir, videoId }),
              downloadYoutubeAudio({ url, outputDir: cardDir, videoId: `${videoId}_audio` }),
            ]);
            const trimmed = path.join(introTmp, `trim_${row.ordinal}.mp4`);
            await cutClip({
              inputPath: videoDl.outputPath, outputPath: trimmed,
              startSeconds: start, durationSeconds: dur,
            });
            const normalizedCard = path.join(introTmp, `norm_${row.ordinal}.mp4`);
            await normalizeClip({
              inputPath: trimmed, outputPath: normalizedCard,
              width: 1280, height: 720, fps: 30,
            });
            builtVideos.push(normalizedCard);
            await safeUnlink(videoDl.outputPath);
            await safeUnlink(trimmed);

            const audioCut = path.join(introTmp, `audio_${row.ordinal}.m4a`);
            await cutAudio({
              inputPath: audioDl.outputPath, outputPath: audioCut,
              startSeconds: start, durationSeconds: dur,
            });
            builtAudios.push(audioCut);
            await safeUnlink(audioDl.outputPath);

            accumulatedDuration += dur;
          } catch (e) {
            await logJob({ projectId, jobId: mediaJobId },
              "render.intro_card.failed", {
                ordinal: row.ordinal, url, err: (e as Error).message,
              });
          }
        }

        if (builtVideos.length > 0 && builtAudios.length > 0) {
          // Prepend videos in doc order (so first card plays first).
          // unshift in reverse pushes them into normalized[] in the right
          // order — same trick the single-intro path uses.
          for (let k = builtVideos.length - 1; k >= 0; k--) {
            normalized.unshift(builtVideos[k]);
          }
          // Concatenate intro audios into one m4a so the existing intro
          // audio crossfade in concatNormalizedClips works unchanged.
          const introAudioMerged = path.join(tmp, "intro_cards_audio.m4a");
          await concatAudioFiles({ inputPaths: builtAudios, outputPath: introAudioMerged });
          for (const a of builtAudios) await safeUnlink(a);
          introAudioPath = introAudioMerged;
          introDurationActual = accumulatedDuration;
          await logJob({ projectId, jobId: mediaJobId },
            "render.intro_cards.ready", {
              count: builtVideos.length,
              totalDurationSeconds: Math.round(accumulatedDuration * 10) / 10,
            });
        }
      } catch (e) {
        await logJob({ projectId, jobId: mediaJobId },
          "render.intro_cards.failed", { err: (e as Error).message });
        introAudioPath = undefined;
        introDurationActual = 0;
      }
    }

    // Legacy single-intro path. Only runs when no intro_card markers exist
    // (old projects, or projects whose doc had no leading blue-bold blocks).
    // User-provided intro source takes priority over the auto-pick path.
    // When the user pasted a YouTube URL + timestamp on the intake screen
    // we download THAT video via the proxied yt-dlp pipeline and cut the
    // intro window from it directly. This fixes the "narrator voiceover
    // over the celebrity's face" bug — the auto-picker only scored on
    // visual quality and had no way to verify whose voice was actually
    // under the chosen frame.
    const userIntroUrl = (project?.intro_source_youtube_url as string | null | undefined)?.trim();
    const userIntroStart = project?.intro_source_start_seconds != null
      ? Number(project.intro_source_start_seconds)
      : null;
    // Skip the legacy single-intro path entirely if the multi-intro
    // markers path already produced an intro — both writing to
    // normalized.unshift would stack a second intro on top.
    const introAlreadyBuilt = introDurationActual > 0;
    if (introAlreadyBuilt) {
      // No-op — multi-intro path already populated normalized + introAudioPath.
    } else if (userIntroUrl && userIntroStart != null && Number.isFinite(userIntroStart) && userIntroStart >= 0) {
      try {
        const declaredDur = Number(project?.intro_duration_seconds) || 6;
        introDurationActual = Math.min(15, Math.max(1, declaredDur));

        const videoId = extractIntroVideoId(userIntroUrl);
        if (!videoId) throw new Error(`unable to parse YouTube id from ${userIntroUrl}`);

        const introTmp = path.join(tmp, "intro_user");
        await fs.mkdir(introTmp, { recursive: true });

        // (a) Download full video + audio via the proxied yt-dlp helpers.
        // These already handle proxy rotation on bot-check / 429 / 403 so
        // we get the same protection as the regular source-download queue.
        const [videoDl, audioDl] = await Promise.all([
          downloadYoutubeVideo({
            url: userIntroUrl,
            outputDir: introTmp,
            videoId,
          }),
          downloadYoutubeAudio({
            url: userIntroUrl,
            outputDir: introTmp,
            videoId: `${videoId}_audio`,
          }),
        ]);

        // (b) Cut video at the user's window, then normalize to the render
        // pipeline's canonical 1280x720@30 so concat -c:v copy works.
        const introTrimmed = path.join(tmp, "intro_user_trim.mp4");
        await cutClip({
          inputPath: videoDl.outputPath,
          outputPath: introTrimmed,
          startSeconds: userIntroStart,
          durationSeconds: introDurationActual,
        });
        const introNormalized = path.join(tmp, "intro_user_norm.mp4");
        await normalizeClip({
          inputPath: introTrimmed, outputPath: introNormalized,
          width: 1280, height: 720, fps: 30,
        });
        normalized.unshift(introNormalized);
        await safeUnlink(videoDl.outputPath);
        await safeUnlink(introTrimmed);

        // (c) Cut audio at the same window.
        const introAudioCut = path.join(tmp, "intro_user_audio.m4a");
        await cutAudio({
          inputPath: audioDl.outputPath,
          outputPath: introAudioCut,
          startSeconds: userIntroStart,
          durationSeconds: introDurationActual,
        });
        await safeUnlink(audioDl.outputPath);
        introAudioPath = introAudioCut;

        // (d) Upload cut audio + persist on project for traceability and
        // so re-renders can skip the yt-dlp step if we ever cache it.
        const audioDest = `projects/${projectId}/intro/user_audio_${Date.now()}.m4a`;
        const audioUp = await uploadFile(introAudioCut, audioDest, "audio/mp4");
        await sb.from("projects").update({
          intro_audio_url: audioUp.publicUrl,
          intro_duration_seconds: introDurationActual,
        }).eq("id", projectId);

        await logJob({ projectId, jobId: mediaJobId },
          "render.intro.user_ready", {
            videoId,
            startSeconds: userIntroStart,
            introDurationActual,
            introAudioUrl: audioUp.publicUrl,
          });
      } catch (e) {
        introAudioPath = undefined;
        introDurationActual = 0;
        await logJob({ projectId, jobId: mediaJobId },
          "render.intro.user_failed", {
            url: userIntroUrl,
            startSeconds: userIntroStart,
            err: (e as Error).message,
          });
      }
    } else if (project?.intro_clip_id) {
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

        // Scene-boundary clamp: if a hard cut falls inside the visible
        // intro window, shorten the intro so it ends just before the cut.
        // Without this, the rendered intro showed the real opening shot for
        // the first ~3s and then jumped to whatever came next in the source
        // (the "0–3s intro, 4–5s different footage" symptom). We keep a 5s
        // floor — going below the spec minimum would defeat the point of
        // having an intro. If the first shot is shorter than 5s we accept
        // the small overflow and log it so the operator can investigate.
        try {
          const sceneCuts = await detectSceneTimestamps({ inputPath: introVideoLocal });
          const firstCutInside = sceneCuts.find((t) => t > 0.5 && t < introDurationActual);
          if (firstCutInside !== undefined) {
            const SHOT_TAIL_BUFFER = 0.1;
            const candidate = firstCutInside - SHOT_TAIL_BUFFER;
            if (candidate >= 5) {
              introDurationActual = Math.round(candidate * 10) / 10;
              await logJob({ projectId, jobId: mediaJobId },
                "render.intro.scene_clamp", {
                  declaredDur,
                  introDurationActual,
                  firstCutInside,
                });
            } else {
              await logJob({ projectId, jobId: mediaJobId },
                "render.intro.scene_clamp_skipped", {
                  declaredDur,
                  introDurationActual,
                  firstCutInside,
                  reason: "first shot shorter than 5s floor",
                });
            }
          }
        } catch (e) {
          // Scene-detect failures are non-fatal — keep the original duration.
          await logJob({ projectId, jobId: mediaJobId },
            "render.intro.scene_clamp_failed", { err: (e as Error).message });
        }

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
    // Build the SFX cue list now that we know the intro offset. Cue offsets
    // recorded during the transition loop are timeline-relative (no intro),
    // so we add introDurationActual to each one to land them at the right
    // spot in the final audio mix. SFX files rotate so consecutive cues use
    // different sounds. If no SFX files are local, the list stays empty and
    // concatNormalizedClips skips the SFX branch entirely.
    const sfxCues: SfxCue[] = sfxLocals.length > 0
      ? sfxOffsetsAtBoundary.map((t, n) => ({
          path: sfxLocals[n % sfxLocals.length],
          atSeconds: t + introDurationActual,
          gain: sfxGain,
        }))
      : [];
    if (sfxCues.length > 0) {
      await logJob({ projectId, jobId: mediaJobId }, "render.sfx.cues", {
        count: sfxCues.length,
        files: sfxLocals.length,
        gain: sfxGain,
      });
    }

    // Outro polish: fade the last segment's tail to black and fade the final
    // audio mix down in parallel so the video doesn't hard-cut on the
    // voiceover's last word. We re-encode only the last segment (one short
    // libx264 pass) so the concat itself still uses cheap -c:v copy.
    //
    // The intro (if any) sits at index 0 in `normalized`, so the last entry
    // is always normalized[normalized.length - 1] regardless of intro state.
    // mergedDurations tracks the rendered timeline length (excluding intro);
    // total output duration = introDurationActual + sum(mergedDurations).
    const OUTRO_FADE_SECONDS = 1.5;
    const lastIdx = normalized.length - 1;
    const lastSegDur = mergedDurations[mergedDurations.length - 1] ?? 0;
    const totalVideoDurationSeconds = introDurationActual + mergedDurations.reduce((a, b) => a + b, 0);
    let outroFadeStartSeconds = 0;
    if (lastSegDur > OUTRO_FADE_SECONDS) {
      const fadedLast = path.join(tmp, "outro_fade.mp4");
      try {
        await applyEdgeFade({
          inputPath: normalized[lastIdx],
          outputPath: fadedLast,
          inputDurationSeconds: lastSegDur,
          fadeOutSeconds: OUTRO_FADE_SECONDS,
          fps: 30,
        });
        await safeUnlink(normalized[lastIdx]);
        normalized[lastIdx] = fadedLast;
        outroFadeStartSeconds = Math.max(0, totalVideoDurationSeconds - OUTRO_FADE_SECONDS);
      } catch (e) {
        // Fade failure shouldn't kill the render — ship without the polish.
        await logJob({ projectId, jobId: mediaJobId },
          "render.outro_fade.failed", { err: (e as Error).message });
      }
    }

    await concatNormalizedClips({
      inputPaths: normalized,
      outputPath: finalLocal,
      voiceoverPath: voiceoverLocal,
      voiceoverGain: 1.0,
      bgMusicPath: bgMusicLocal,
      bgMusicGain,
      introAudioPath,
      introDurationSeconds: introDurationActual || undefined,
      sfxCues,
      outroFadeSeconds: outroFadeStartSeconds > 0 ? OUTRO_FADE_SECONDS : undefined,
      outroFadeStartSeconds: outroFadeStartSeconds > 0 ? outroFadeStartSeconds : undefined,
      totalVideoDurationSeconds,
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

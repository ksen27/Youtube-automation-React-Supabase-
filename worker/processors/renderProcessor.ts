import path from "node:path";
import { promises as fs, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { RenderJobData } from "@/lib/jobs/queue";
import { logJob, setMediaJob, setProjectStatus, touchMediaJob } from "@/lib/jobs/db";
import { getServerSupabase } from "@/lib/supabase/server";
import { ensureTmp, safeUnlink, uploadFile } from "@/lib/storage";
import { concatAudioFiles, concatNormalizedClips, cutClip, cutAudio, normalizeClip, buildStillVideo, buildBlackVideo, padVideoToLength, buildTitleCardVideo, buildSplitScreenVideo, buildSplitScreenAvatarVideo, xfadePair, xfadeFadeBlack, applyEdgeFade, extractAudio, buildSilentAudio, overlayEffectVideo, degradeVideoLowFi, segmentVcodecArgsFor, renderCanvasFor, IMAGE_XFADE_PALETTE, type SfxCue } from "@/lib/media/ffmpeg";
import { probeFile } from "@/lib/media/probe";
import { detectSceneTimestamps } from "@/lib/media/scenes";
import { downloadYoutubeAudio, downloadYoutubeVideo } from "@/lib/media/ytdlp";
import { extractYoutubeVideoId } from "@/lib/youtube/url";
import { getEnv } from "@/lib/env";
import {
  clipCacheKey,
  lookupCachedClip,
  storeCachedClip,
  clearProjectCache,
} from "./renderCache";
import { reconcileTimelineOrder } from "@/lib/synthetic/pitch-timeline";

// Minimum seconds of host clip that must remain after a lower-third's slide-in
// begins, so a word spoken near the very end of a clip still produces a
// visible chip instead of one that slides in as the clip cuts away.
const MIN_LT_VISIBLE_SECONDS = 1.0;

// Max seconds a pre-downloaded intro-card clip may exceed its marker window
// before the renderer re-pins it. Assets cut before the pinDurationSeconds
// fix in scriptClipProcessor were keyframe-cut and overshoot by whole
// seconds; post-fix assets land within frame-rounding of the window, so a
// quarter second cleanly splits "stale asset" from "fine, skip the re-encode".
const INTRO_CARD_PIN_TOLERANCE_SECONDS = 0.25;

// Compute the in-clip offset (seconds) at which a lower-third chyron should
// begin its slide-in, so it appears exactly when the narrator says the
// red-marked word rather than at the host clip's start. Returns 0 (chip at
// clip start — the legacy behavior) when the word time or the host's audio
// start is missing, which is also the fallback for entity-name lower-thirds
// that carry no per-word timestamp.
//   lt        — the host row's metadata.lower_third object
//   hostMeta  — the host row's metadata (for its vo_start_seconds)
//   headLeft  — mixed-fade headroom baked in FRONT of the rendered content
//   renderDur — the rendered clip's total length (content + headroom)
function lowerThirdStartOffset(
  lt: { vo_start_seconds?: number } | undefined,
  hostMeta: Record<string, unknown>,
  headLeft: number,
  renderDur: number,
): number {
  if (!lt || typeof lt.vo_start_seconds !== "number") return 0;
  const hostVoStart = hostMeta.vo_start_seconds;
  if (typeof hostVoStart !== "number") return 0;
  const rawOffset = lt.vo_start_seconds - hostVoStart + headLeft;
  const maxOffset = Math.max(0, renderDur - MIN_LT_VISIBLE_SECONDS);
  return Math.min(Math.max(0, rawOffset), maxOffset);
}

export async function processRenderJob(data: RenderJobData): Promise<void> {
  const sb = getServerSupabase();
  const { projectId, mediaJobId, renderJobId } = data;

  await setMediaJob(mediaJobId, { status: "running", progress: 5 });
  await sb.from("render_jobs").update({ status: "running", progress: 5 }).eq("id", renderJobId);
  await setProjectStatus(projectId, "rendering");

  // Engine decides per-segment encode quality. Celebrity (sourced) renders keep
  // the original ultrafast/crf25 (byte-for-byte unchanged); only synthetic
  // renders use the higher-quality preset. Both engines render on THIS worker
  // (the render queue is sourced-side only), so the choice can't be a per-worker
  // env — it must be per-render, driven by the project's engine. Resolved once
  // here and passed into every segment encoder so the whole video stays uniform
  // (required for the -c:v copy concat fast path).
  const { data: projRow } = await sb
    .from("projects")
    .select("engine")
    .eq("id", projectId)
    .single();
  const isSyntheticRender = ((projRow?.engine as string | null) ?? "sourced") === "synthetic";
  const vcodec = segmentVcodecArgsFor(isSyntheticRender ? "synthetic" : "sourced");

  // PERFORMANCE_MODE: synthetic-engine "no visual effects" pipeline. ONLY active
  // for synthetic renders — the sourced/celebrity path is never affected. When
  // on, the merge loop is bypassed (hard cuts only — no xfade/fadeblack), all
  // transition headroom is zeroed so segments render at their exact planned
  // length, and the global particle overlay post-pass is skipped. Audio,
  // timing, subtitles and avatar generation are untouched. Resolved once here so
  // every stage below reads the same value.
  const performanceMode = getEnv().PERFORMANCE_MODE && isSyntheticRender;
  // Per-stage wall-clock timing (ms) so the log shows exactly where render time
  // goes and how much PERFORMANCE_MODE saves. Stamped as each stage completes.
  const stageTimings: Record<string, number> = {};
  await logJob({ projectId, jobId: mediaJobId }, "render.performance_mode", {
    enabled: performanceMode,
    rawEnvFlag: getEnv().PERFORMANCE_MODE,
    engine: isSyntheticRender ? "synthetic" : "sourced",
    note: performanceMode
      ? "EFFECTS DISABLED: hard cuts only, no transitions, no global overlay"
      : "effects active (PERFORMANCE_MODE off or non-synthetic engine)",
  });

  // Output resolution, PER ENGINE. Every segment in one render shares these
  // dims (required for the -c:v copy concat fast path).
  //
  // synthetic (AI avatar) = 3840x2160. Client 2026-08-02 wants 4K here.
  // How much of the frame is TRUE 4K varies by block type — worth knowing before
  // reading a "4K looks soft" report as a bug:
  //   still      69labs at "4k" returns 5504×3072 -> downscaled, genuinely 4K
  //   ai_clip    LTX at 3840x2160 -> genuinely 4K
  //   avatar     HeyGen Avatar III caps at 1080p (engine limit, see env.ts)
  //              -> UPSCALED 2x. split_2 avatars fill only a 1920×2160 half-cell,
  //              so they upscale 1.78x and hold up better than full-frame ones.
  //   footage    YouTube source; only as good as the original upload.
  //
  // sourced (celebrity/CelebForge) = 1920x1080. Client 2026-08-08 reverted this
  // engine off 4K: after the cutover celebrity renders ran to a ~59min median
  // (render-time-audit.ts) because libx264 cost scales with pixel count. Going
  // back to 1080p cuts the encoded area 4x. Celebrity footage is YouTube-sourced
  // and was mostly being upscaled into the 4K frame anyway, so little real
  // detail is lost.
  const { width: outW, height: outH } = renderCanvasFor(
    isSyntheticRender ? "synthetic" : "sourced"
  );

  // ORDER GATE (synthetic only). Everything below concatenates strictly by
  // `position`, against ONE continuous voiceover — so a wrong position column
  // does not fail, it silently ships a video whose visuals do not match the
  // words. That is exactly what happened on 2026-08-21 (project e8177073: the
  // last 23 blocks played first and the opening avatar landed ~11s in), and
  // nothing in the pipeline noticed because the positions were unique and
  // contiguous, just permuted.
  //
  // So re-derive the order from synthetic_segments.position and verify it right
  // before rendering. On a settled timeline this is a couple of reads and zero
  // writes; on a damaged one it repairs it. If it still does not verify we
  // FAIL the render — a failed render is recoverable, a scrambled 20-minute
  // upload that looks fine to the pipeline is not.
  if (isSyntheticRender) {
    const order = await reconcileTimelineOrder(projectId);
    await logJob({ projectId, jobId: mediaJobId }, "render.timeline_order.gate", order);
    if (!order.verified) {
      throw new Error(
        "timeline is out of order (segment positions did not verify) — refusing to " +
          "render. Re-run the render; if it keeps failing, a concurrent finalize is " +
          "still writing to this project.",
      );
    }
  }

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
    // --- SYNTHETIC ENGINE blocks (migration 0020) ---
    // avatar / ai_clip carry a generated mp4 on video_url (a degraded ai_clip
    // may have only image_url, in which case it renders as a held still).
    if ((it.type === "avatar" || it.type === "ai_clip") && (it.video_url || it.image_url)) return true;
    // Sales-pitch video (migration 0025): user-uploaded mp4 on video_url,
    // inserted near 3:00. Renders as a full-motion video segment that KEEPS its
    // own audio (the narration pauses over it — see the audio splice below).
    if (it.type === "pitch_video" && it.video_url) return true;
    // Split-screen blocks. Sourced split: left+right are both stills
    // (image_url + metadata.right_image_url). Synthetic split: avatar VIDEO on
    // video_url + still on right_image_url. Renderable when a usable pair
    // exists for either flavor.
    if (it.type === "split_2") {
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      const rightFromCol = typeof it.right_image_url === "string" && it.right_image_url.length > 0;
      const rightFromMeta = typeof meta.right_image_url === "string" && (meta.right_image_url as string).length > 0;
      const synthetic = !!it.video_url && rightFromCol;          // avatar | still
      const sourced = !!it.image_url && rightFromMeta;           // still | still
      return synthetic || sourced;
    }
    return false;
  });
  if (renderable.length === 0) {
    await setMediaJob(mediaJobId, { status: "failed", error: "no renderable timeline items" });
    await sb.from("render_jobs").update({ status: "failed", error: "no renderable timeline items" }).eq("id", renderJobId);
    await setProjectStatus(projectId, "failed");
    throw new Error("no renderable timeline items");
  }

  // Planned render durations, floored at 0.5s with neighbor repayment.
  // Fades/xfades need at least ~0.5s of frames, so sub-0.5s narration blocks
  // must render longer than their audio interval — but flooring each block
  // independently never gives the borrowed time back, so every floored block
  // pushes all later visuals 100–200ms further behind the voiceover. Across a
  // 40-minute timeline that compounded to ~2.3s of lag at the end (the
  // 2026-06-12 driftMs 2339 post_validation failure). Here the floor's
  // overshoot becomes a debt repaid by trimming the next blocks that have
  // headroom, capped per block so a run of tiny blocks can't gut one
  // neighbor, keeping cumulative video time pinned to the voiceover.
  const FLOOR_SECONDS = 0.5;
  const REPAY_MAX_PER_BLOCK_SECONDS = 0.3;
  const plannedDurations: number[] = new Array(renderable.length).fill(FLOOR_SECONDS);
  {
    let floorDebt = 0;
    let flooredBlocks = 0;
    let totalFloorAdded = 0;
    for (let i = 0; i < renderable.length; i++) {
      let d = Number(renderable[i].duration) || 0;
      if (d < FLOOR_SECONDS) {
        floorDebt += FLOOR_SECONDS - d;
        totalFloorAdded += FLOOR_SECONDS - d;
        flooredBlocks++;
        d = FLOOR_SECONDS;
      } else if (floorDebt > 0) {
        const repay = Math.min(floorDebt, d - FLOOR_SECONDS, REPAY_MAX_PER_BLOCK_SECONDS);
        d -= repay;
        floorDebt -= repay;
      }
      plannedDurations[i] = d;
    }
    if (flooredBlocks > 0) {
      await logJob({ projectId, jobId: mediaJobId }, "render.duration_floor", {
        flooredBlocks,
        totalFloorAddedMs: Math.round(totalFloorAdded * 1000),
        unrepaidMs: Math.round(floorDebt * 1000),
      });
    }
  }

  // Snap every planned duration onto the 30fps frame grid, carrying the rounding
  // error forward so the RUNNING SUM stays pinned to the voiceover.
  //
  // Block durations arrive as raw floats (narration windows divided into slots:
  // 4.958333333333332, 5.648750749999998, ...). Every renderer pins its block
  // with `-t`, which FLOORS to floor(sec*30) frames — so each block ships 0-33ms
  // short, always in the same direction. The avatar branch already snaps its own
  // pin (see ~line 598), but that only fixes the 10 avatar blocks: on project
  // 81ad97bc 236 of 250 blocks were off-grid (143 image, 60 ai_clip, 24 split_2,
  // 9 avatar) and the summed timeline came out 1531.000s against a true
  // voiceover of 1531.263s. Since the master voiceover is laid down as ONE
  // continuous track while the video is assembled by summing slots, each lost
  // fraction shifts every LATER avatar earlier against its words — sync is right
  // at the first avatar and degrades with position (~300ms by the end, reported
  // 2026-07-17). The final-length pin (~line 2357) then stretches the last frame
  // so the FILE length matches the audio, which hid the interior error from every
  // whole-file check and is why this bug kept "coming back".
  //
  // Rounding each block independently would leave the same one-way leak (just
  // smaller). Instead we track the accumulated error and let it steer each
  // block's rounding: a block is snapped to whatever whole-frame count keeps the
  // running sum closest to the true cumulative float time. Errors alternate sign
  // and cancel instead of compounding, so Σ durations is frame-exact AND tracks
  // the voiceover to within half a frame at EVERY block boundary, not just at the
  // end. `-t` then has nothing left to truncate.
  //
  // FLOOR_SECONDS is a whole frame count at 30fps (0.5*30 = 15), so snapping can
  // never push a floored block back under the fade minimum.
  //
  // SYNTHETIC ONLY. The measured bug is the AI-Avatar engine's (its continuous
  // master voiceover is what the lips are judged against), and celebrity/sourced
  // renders are deliberately left byte-for-byte unchanged — the same containment
  // the PERFORMANCE_MODE and subtle-motion changes keep.
  const FRAME_RATE = 30;
  if (isSyntheticRender) {
    let exactSum = 0;   // running sum of the raw float durations (the truth)
    let snappedSum = 0; // running sum of what we actually render
    let maxAbsErrMs = 0;
    let offGridBlocks = 0;
    for (let i = 0; i < plannedDurations.length; i++) {
      const raw = plannedDurations[i];
      if (Math.abs(raw * FRAME_RATE - Math.round(raw * FRAME_RATE)) > 1e-6) offGridBlocks++;
      exactSum += raw;
      // Choose the frame count that lands the running total nearest the truth,
      // absorbing the previous block's rounding error rather than repeating it.
      // Never below one frame, and never below the fade floor for a block that
      // the floor/repay pass above already raised to FLOOR_SECONDS.
      const minFrames = raw >= FLOOR_SECONDS ? Math.round(FLOOR_SECONDS * FRAME_RATE) : 1;
      const frames = Math.max(minFrames, Math.round((exactSum - snappedSum) * FRAME_RATE));
      const snapped = frames / FRAME_RATE;
      plannedDurations[i] = snapped;
      snappedSum += snapped;
      maxAbsErrMs = Math.max(maxAbsErrMs, Math.abs(snappedSum - exactSum) * 1000);
    }
    await logJob({ projectId, jobId: mediaJobId }, "render.duration_frame_snap", {
      fps: FRAME_RATE,
      blocks: plannedDurations.length,
      offGridBlocksBefore: offGridBlocks,
      exactSumSeconds: Math.round(exactSum * 1000) / 1000,
      snappedSumSeconds: Math.round(snappedSum * 1000) / 1000,
      residualMs: Math.round((snappedSum - exactSum) * 1000),
      maxRunningErrorMs: Math.round(maxAbsErrMs),
      note: "planned durations pinned to the frame grid; running sum tracks the voiceover within half a frame at every block",
    });
  }

  // Diagnostic: count how many renderable items carry a lower_third overlay
  // and from which source. Helps verify the matcher's lower_third stamping
  // survived the round-trip from match step to render step. If this number
  // is 0 but the matcher reported lowerThirdsApplied > 0, the metadata was
  // dropped during DB write/read. If non-zero but no overlay appears in the
  // final video, the failure is downstream in the drawtext filter.
  {
    // Per-lower-third placement audit. For each LT we log the marked word's
    // spoken time (lt.vo_start_seconds) against its HOST block's audio window
    // (block vo_start..vo_end). `wordInBlock` is true when the word the chyron
    // labels is actually spoken WHILE this block is on screen — i.e. the LT is
    // on the correct clip. After the 2026-06-10 host-selection fix this should
    // be true for every LT that carries a word time; a `false` means the
    // chyron is still landing on the wrong clip. `offsetInClip` is how far into
    // the block the chyron slides in (word_vo_start − block_vo_start), which is
    // what the renderer passes as the drawtext start offset.
    const ltSummary = {
      count: 0,
      wordInBlock: 0,
      wordOutOfBlock: 0,
      noWordTime: 0,
      samples: [] as Array<{
        idx: number; type: string; text: string; source: string;
        wordVoStart: number | null; blockVoStart: number | null;
        blockVoEnd: number | null; offsetInClip: number | null; wordInBlock: boolean | null;
      }>,
    };
    for (let i = 0; i < renderable.length; i++) {
      const it = renderable[i];
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      const lt = meta.lower_third as
        | { text?: string; type?: string; vo_start_seconds?: number }
        | undefined;
      if (lt?.text) {
        ltSummary.count++;
        const wordVoStart = typeof lt.vo_start_seconds === "number" ? lt.vo_start_seconds : null;
        const blockVoStart = typeof meta.vo_start_seconds === "number" ? (meta.vo_start_seconds as number) : null;
        const blockVoEnd = typeof meta.vo_end_seconds === "number" ? (meta.vo_end_seconds as number) : null;
        let wordInBlock: boolean | null = null;
        let offsetInClip: number | null = null;
        if (wordVoStart != null && blockVoStart != null) {
          offsetInClip = Math.round((wordVoStart - blockVoStart) * 100) / 100;
          if (blockVoEnd != null) {
            wordInBlock = wordVoStart >= blockVoStart - 0.05 && wordVoStart <= blockVoEnd + 0.05;
          }
        }
        if (wordVoStart == null) ltSummary.noWordTime++;
        else if (wordInBlock === true) ltSummary.wordInBlock++;
        else if (wordInBlock === false) ltSummary.wordOutOfBlock++;
        if (ltSummary.samples.length < 10) {
          ltSummary.samples.push({
            idx: i, type: String(it.type), text: lt.text, source: String(lt.type ?? "?"),
            wordVoStart: wordVoStart != null ? Math.round(wordVoStart * 100) / 100 : null,
            blockVoStart: blockVoStart != null ? Math.round(blockVoStart * 100) / 100 : null,
            blockVoEnd: blockVoEnd != null ? Math.round(blockVoEnd * 100) / 100 : null,
            offsetInClip, wordInBlock,
          });
        }
      }
    }
    await logJob({ projectId, jobId: mediaJobId }, "render.lower_thirds.preflight", ltSummary);
  }

  const footageClipIds = renderable.map((it) => it.clip_id as string | null).filter(Boolean) as string[];

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
  // Per-slot CONTENT duration — what the viewer perceives as the scene length,
  // excluding the xfade headroom baked into slotDurations. Used to write back
  // the truth-of-render value to timeline_items.duration after concat so the
  // editor stops lying about scene lengths. content_dur = slot_dur − (headLeft
  // + headRight) for image/title_card/split_2, or slot_dur − (headLeft +
  // headRight) for footage (clip cut also bakes headroom on mixed edges).
  const slotContentDurations: number[] = new Array(renderable.length).fill(0);
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
    if (it?.clip_id) return true;
    // Synthetic avatar / ai_clip blocks render as full-motion video segments.
    if ((it?.type === "avatar" || it?.type === "ai_clip") && it?.video_url) return true;
    // The sales-pitch video is also a full-motion video segment.
    if (it?.type === "pitch_video" && it?.video_url) return true;
    return false;
  };
  // SFX cues should only land on REAL photo→photo dissolves, not on
  // title-card or split-screen transitions. isImageNeighbor lumps all three
  // together for transition-math purposes (they're all still frames), so we
  // use this stricter predicate just for the SFX trigger.
  const isRealImage = (i: number): boolean => {
    const it = renderable[i];
    return it?.type === "image" && !!it.image_url;
  };
  // Transition headroom for the side of block `i` facing neighbor `neighborIdx`.
  // Normally a still segment is rendered XFADE/2 (0.25s) longer toward an image
  // neighbor and MIXED/2 (0.2s) longer toward a video neighbor so the xfade/
  // fadeblack pass can consume the overlap. In PERFORMANCE_MODE there IS no
  // transition pass, so headroom must be 0 — otherwise every block would render
  // a fraction long with nothing to eat it, drifting the timeline past the
  // voiceover. Returning 0 here keeps each segment at its exact planned length
  // for the hard-cut concat. The merge loop is also skipped (see below), so the
  // two changes stay consistent.
  const headroomFor = (neighborIdx: number): number => {
    if (performanceMode) return 0;
    if (isImageNeighbor(neighborIdx)) return IMAGE_XFADE_SECONDS / 2;
    if (isVideoNeighbor(neighborIdx)) return MIXED_FADE_SECONDS / 2;
    return 0;
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

    // Resume cache wrapper. Before doing the (expensive) normalize work for
    // item i, check the persistent render cache for a valid prior result; on a
    // hit, restore the clip + its durations and skip the encode entirely. On a
    // miss, run renderItem() and persist whatever it produced. This is what
    // makes a render survive a mid-flight worker restart without redoing every
    // clip. See worker/processors/renderCache.ts.
    async function processItem(i: number): Promise<void> {
      const it = renderable[i];
      const idx = String(i).padStart(3, "0");
      const out = path.join(tmp, `norm_${idx}.mp4`);
      const cacheKey = clipCacheKey({
        itemId: (it.id as string | undefined) ?? null,
        index: i,
        type: String(it.type),
        signature: {
          image_url: it.image_url ?? null,
          clip_id: (it as Record<string, unknown>).clip_id ?? null,
          // The repayment-adjusted duration, not the raw row value — a block
          // trimmed to repay floor debt must not hit a cache entry rendered
          // at its untrimmed length.
          duration: plannedDurations[i],
          metadata: it.metadata ?? null,
          // PERFORMANCE_MODE renders each segment WITHOUT the transition
          // headroom (headroomFor returns 0), so a perf-mode segment is shorter
          // than the same block rendered with effects on. The two must NEVER
          // share a cache entry: a normal-mode clip carries ~0.2-0.45s of baked
          // headroom, and serving it to a perf-mode render restores that
          // inflated slotDuration with no transition to absorb it — summed
          // across ~50 cached blocks that drifted the video ~22s past the
          // voiceover. Keying on the mode forces a clean re-render per mode.
          performanceMode,
          // Frame-exact pin generation. Clips cached before the -frames:v fix
          // (2026-07-17) are one frame LONGER than their recorded duration —
          // the lip-lag leak — and share every other signature field with the
          // fixed ones, so they must never be served again. Bump on any future
          // change to how a slot's length is pinned.
          // v2: the 12:30 frames_v1 render cached avatar slots one frame SHORT
          // (pad threshold missed a one-frame gap); those must not be reused.
          // v3: the 13:06 frames_v2 render cached still/image slots N±1 frames
          // long (buildStillVideo's on-boundary input -t); superseded by the
          // exactFrames pin on buildStillVideo.
          pin: "frames_v3",
          // Output canvas. The cache survives redeploys on /data, so entries
          // encoded at 3840x2160 before the 2026-08-08 sourced-1080p revert are
          // still on disk. Serving one into a 1080p render would copy a 4K
          // segment into the timeline and break the -c:v copy concat (the
          // demuxer requires identical dims across inputs). Keying on the canvas
          // retires those entries automatically instead of needing a cache wipe.
          canvas: `${outW}x${outH}`,
        },
      });

      const cached = await lookupCachedClip(projectId, cacheKey);
      if (cached) {
        try {
          await fs.copyFile(cached.mp4Path, out);
          slots[i] = out;
          slotDurations[i] = cached.meta.slotDuration;
          slotContentDurations[i] = cached.meta.slotContentDuration;
          await logJob({ projectId, jobId: mediaJobId },
            "render.clip.cache_hit", { idx: i });
          return;
        } catch {
          // Copy failed (e.g. cache file vanished between probe and copy) —
          // fall through and render fresh.
        }
      }

      await renderItem(i, out);

      // Persist on success. slots[i] is only set when renderItem produced a
      // usable clip; a failed item leaves it null (and durations at 0), so we
      // cache nothing and the next retry re-attempts it.
      if (slots[i] && slotDurations[i] > 0) {
        await storeCachedClip(projectId, cacheKey, out, {
          slotDuration: slotDurations[i],
          slotContentDuration: slotContentDurations[i],
          probedDuration: slotDurations[i],
        });
      }
    }

    async function renderItem(i: number, out: string): Promise<void> {
      const it = renderable[i];
      const plannedDur = plannedDurations[i];
      const idx = String(i).padStart(3, "0");

      if (it.type === "split_2") {
        // Split-screen: matcher persisted the LEFT image URL on
        // image_url and the RIGHT URL on metadata.right_image_url.
        // Download both, then call buildSplitScreenVideo to assemble the
        // half-width side-by-side composite. Same headroom logic as a
        // single image — split blocks are still frames, so their
        // transition partners treat them identically.
        const headLeft = headroomFor(i - 1);
        const headRight = headroomFor(i + 1);
        const meta = (it.metadata ?? {}) as Record<string, unknown>;
        // SYNTHETIC split: avatar VIDEO (video_url) left + still (right_image_url)
        // right. SOURCED split: still (image_url) left + still (meta.right_image_url)
        // right. Detected by the presence of video_url.
        const isSyntheticSplit = !!it.video_url;
        // A synthetic split carries a HeyGen avatar (25fps -> 30fps), so it has
        // the same sub-frame `-t` floor drift the full-frame avatar branch fixes:
        // buildSplitScreenAvatarVideo bounds the avatar with `-t`/trim on a 30fps
        // stream (floors to floor(dur*30) frames) while slotDurations recorded the
        // un-floored float, overstating each block by up to ~33ms. Snap the pin
        // target to a mid-frame value so the floor lands on exactly renderFrames
        // and slotDurations is truthful. Sourced splits (still images, exact
        // length) keep the raw float — behavior byte-identical to before.
        const rawSplitDur = plannedDur + headLeft + headRight;
        const splitFrames = Math.max(1, Math.round(rawSplitDur * 30));
        const renderDur = isSyntheticSplit ? (splitFrames + 0.5) / 30 : rawSplitDur;
        const leftUrl = isSyntheticSplit ? (it.video_url as string) : (it.image_url as string);
        const rightUrl = isSyntheticSplit
          ? (it.right_image_url as string)
          : (meta.right_image_url as string);
        const leftLocal = path.join(tmp, `splitL_${idx}`);
        const rightLocal = path.join(tmp, `splitR_${idx}`);
        try {
          await Promise.all([
            downloadHttp(leftUrl, leftLocal),
            downloadHttp(rightUrl, rightLocal),
          ]);
          const splitMeta = (it.metadata ?? {}) as Record<string, unknown>;
          const splitLt = splitMeta.lower_third as
            | { text?: string; vo_start_seconds?: number }
            | undefined;
          const splitLtOffset = lowerThirdStartOffset(splitLt, splitMeta, headLeft, renderDur);
          if (isSyntheticSplit) {
            // Reuse the synthetic split-screen builder: avatar video left, still right.
            await buildSplitScreenAvatarVideo({
              vcodecArgs: vcodec,
              avatarVideoPath: leftLocal,
              rightImagePath: rightLocal,
              outputPath: out,
              durationSeconds: renderDur,
              width: outW, height: outH, fps: 30,
              // Exact frame pin so the file matches the splitFrames/30 recorded
              // below — without it the builder shipped one frame short (149 vs
              // 150, render.concat.timeline 2026-07-17).
              exactFrames: splitFrames,
              lowerThird: splitLt?.text
                ? { text: splitLt.text, startOffsetSeconds: splitLtOffset }
                : undefined,
            });
          } else {
            await buildSplitScreenVideo({
              vcodecArgs: vcodec,
              leftImagePath: leftLocal,
              rightImagePath: rightLocal,
              outputPath: out,
              durationSeconds: renderDur,
              width: outW, height: outH, fps: 30,
              lowerThird: splitLt?.text
                ? { text: splitLt.text, startOffsetSeconds: splitLtOffset }
                : undefined,
            });
          }
          slots[i] = out;
          // For a synthetic (avatar) split the file is exactly splitFrames/30 —
          // pinned by exactFrames above; record that, not the mid-frame value.
          // Sourced splits build exact-length stills, so renderDur is truthful.
          slotDurations[i] = isSyntheticSplit ? splitFrames / 30 : renderDur;
          slotContentDurations[i] = plannedDur;
          imageRendered++;
        } catch (e) {
          imageFailed++;
          await logJob({ projectId, jobId: mediaJobId },
            "render.split.failed", { idx: i, leftUrl, rightUrl, err: (e as Error).message });
        } finally {
          await safeUnlink(leftLocal);
          await safeUnlink(rightLocal);
        }
      } else if (it.type === "pitch_video" && it.video_url) {
        // SALES-PITCH video (migration 0025). Unlike avatar/ai_clip blocks,
        // this is NOT cut to a narration window — its duration IS its own
        // length, and it KEEPS its audio (extracted and spliced into the
        // master track below so the narration pauses over it). We download,
        // probe the real length, and normalize to the output canvas at the
        // SHARED encode settings (required for the -c:v copy concat fast path),
        // holding the audio through normalize so the splice has something to
        // extract. Headroom is added toward image neighbors so the dip-to-black
        // transition has frames to consume, same as any video block.
        const headLeft = headroomFor(i - 1);
        const headRight = headroomFor(i + 1);
        const localPre = path.join(tmp, `pitch_${idx}.mp4`);
        try {
          await downloadHttp(it.video_url as string, localPre);
          let pitchDur = Number(it.duration) || 0;
          try { const p = await probeFile(localPre); if (p.durationSeconds > 0) pitchDur = p.durationSeconds; } catch { /* fall back to row duration */ }
          // Normalize to the canvas, keeping audio. We pin to the probed length
          // + headroom so the slot matches what the audio splice expects.
          const renderDur = pitchDur + headLeft + headRight;
          await normalizeClip({
            inputPath: localPre, outputPath: out,
            width: outW, height: outH, fps: 30,
            keepAudio: true, vcodecArgs: vcodec,
            pinDurationSeconds: renderDur,
          });
          slots[i] = out;
          let actualDur = renderDur;
          try { const p = await probeFile(out); if (p.durationSeconds > 0) actualDur = p.durationSeconds; } catch { /* keep renderDur */ }
          slotDurations[i] = actualDur;
          slotContentDurations[i] = Math.max(0.1, actualDur - headLeft - headRight);
          await logJob({ projectId, jobId: mediaJobId }, "render.pitch_video.rendered", {
            idx: i,
            probedSeconds: Math.round(pitchDur * 100) / 100,
            renderedSeconds: Math.round(actualDur * 100) / 100,
          });
        } catch (e) {
          await logJob({ projectId, jobId: mediaJobId }, "render.pitch_video.failed", { idx: i, url: it.video_url, err: (e as Error).message });
        } finally {
          await safeUnlink(localPre);
        }
      } else if (it.type === "avatar" || it.type === "ai_clip") {
        // SYNTHETIC full-frame video block. avatar = HeyGen talking head;
        // ai_clip = fal.ai animated clip. Either is a no-audio mp4 on video_url
        // (a degraded ai_clip may have only image_url -> render as a held
        // still). The master voiceover is the single audio track, muxed at
        // concat time, so these segments are silent like every other one.
        const headLeft = headroomFor(i - 1);
        const headRight = headroomFor(i + 1);
        // Snap the pin target to a whole 30fps frame count. The clip is pinned
        // with `-t renderDur` twice (normalizeClip below, then padVideoToLength on
        // a short clip), and `-t` on a 30fps CFR stream FLOORS to floor(sec*30)
        // frames. A raw float renderDur never lands on a frame boundary, so every
        // avatar clip (HeyGen renders 25fps, converted to 30) came back 0-33ms
        // short of renderDur in the SAME direction, was recorded into
        // slotDurations[i], and the sub-frame shortfalls accumulated — later
        // avatar lips finished ahead of their words, worse toward the end of the
        // video (measured on 2856195f: every avatar delta negative). We round to
        // the nearest whole frame COUNT and hand `-t` a value sitting mid-frame
        // ((frames+0.5)/30): flooring it always yields exactly `frames`, immune to
        // padVideoToLength's `.toFixed(3)` rounding (a value like 6.0333 would
        // else round to 6.033 and floor back to 180 frames, re-losing one). Both
        // pins then emit exactly `frames` frames, the rendered file equals
        // renderDur to the millisecond, and slotDurations[i]=renderDur is
        // truthful — interior drift is zero by construction. Round-to-nearest
        // (not ceil) keeps the summed timeline on the voiceover grid; the final
        // total-length pin absorbs any half-frame residual. avatar/ai_clip only;
        // sourced footage untouched.
        const renderFrames = Math.max(1, Math.round((plannedDur + headLeft + headRight) * 30));
        const renderDur = (renderFrames + 0.5) / 30;

        if (it.video_url) {
          const localPre = path.join(tmp, `synvid_${idx}.mp4`);
          const trimmed = path.join(tmp, `synvid_cut_${idx}.mp4`);
          try {
            await downloadHttp(it.video_url as string, localPre);
            // DIAGNOSTIC (avatar lip-sync hunt, 2026-07-17). Trace the FULL chain for
            // every avatar block: the voiceover window HeyGen was lip-synced to, the
            // clip it returned, and what each ffmpeg stage does to that clip's timing.
            // Everything measured from outside the worker so far says the pipeline is
            // correct (placement exact, HeyGen audio bit-identical to the master VO
            // slice at r=1.0000, sources clean CFR 25fps, totals matched) while the
            // avatars still read out of sync — so the mismatch has to appear at one of
            // these seams, which nothing currently observes. Probes are per-avatar
            // only (10 blocks on a 250-block render), so the cost is negligible.
            if (it.type === "avatar") {
              try {
                const src = await probeFile(localPre);
                const seg = it.synthetic_segment_id
                  ? (await sb.from("synthetic_segments")
                      .select("start_time, end_time, provider, avatar_model")
                      .eq("id", it.synthetic_segment_id as string).maybeSingle()).data
                  : null;
                const segStart = seg?.start_time != null ? Number(seg.start_time) : null;
                const segEnd = seg?.end_time != null ? Number(seg.end_time) : null;
                await logJob({ projectId, jobId: mediaJobId }, "render.avatar.chain.source", {
                  idx: i,
                  // Which HeyGen path produced this clip. The API-fallback path
                  // (`_api_` in the key) is normally gated off and is the one lead
                  // never chased — if the out-of-sync avatars are all `_api_`, that
                  // localises the bug immediately.
                  heygenPath: /_api_/.test(String(it.video_url)) ? "api_fallback" : "browser",
                  provider: seg?.provider ?? null,
                  avatarModel: seg?.avatar_model ?? null,
                  // The voiceover window the lips were synced to.
                  segStartSeconds: segStart,
                  segEndSeconds: segEnd,
                  voWindowSeconds: segStart != null && segEnd != null
                    ? Math.round((segEnd - segStart) * 1000) / 1000 : null,
                  // What HeyGen actually returned.
                  heygenDurationSeconds: Math.round(src.durationSeconds * 1000) / 1000,
                  // Positive = HeyGen clip is SHORTER than the audio it was given.
                  heygenVsVoWindowMs: segStart != null && segEnd != null
                    ? Math.round(((segEnd - segStart) - src.durationSeconds) * 1000) : null,
                  plannedDurationSeconds: Math.round(plannedDur * 1000) / 1000,
                  headLeftSeconds: headLeft,
                  headRightSeconds: headRight,
                  renderTargetSeconds: Math.round(renderDur * 1000) / 1000,
                  renderFrames,
                });
              } catch (e) {
                await logJob({ projectId, jobId: mediaJobId }, "render.avatar.chain.source_probe_failed",
                  { idx: i, err: (e as Error).message });
              }
            }
            await cutClip({ inputPath: localPre, outputPath: trimmed, startSeconds: 0, durationSeconds: renderDur, keepAudio: false });
            if (it.type === "avatar") {
              try {
                const cut = await probeFile(trimmed);
                await logJob({ projectId, jobId: mediaJobId }, "render.avatar.chain.after_cut", {
                  idx: i,
                  afterCutSeconds: Math.round(cut.durationSeconds * 1000) / 1000,
                  targetSeconds: Math.round(renderDur * 1000) / 1000,
                  deltaMs: Math.round((cut.durationSeconds - renderDur) * 1000),
                });
              } catch { /* diagnostic only */ }
            }
            // Pin the normalize re-encode to renderDur. cutClip's stream-copy
            // overshoots to the next keyframe (60-180ms), and HeyGen/LTX clips
            // already run a few frames longer than their audio slice. Without
            // the pin, normalizeClip preserved that surplus and slotDurations
            // recorded it — every one of the ~80 synthetic-video blocks landed a
            // fraction long, compounding to ~1.1s positive drift on a 6-min
            // render and ~6s at 249 blocks (post_validation driftMs 1124,
            // passed:false). The video then runs longer than the voiceover and
            // each avatar part's last words drift past their lip movement. This
            // is the same overshoot the footage branch pins out below (line ~972).
            // Pin by EXACT FRAME COUNT, not by `-t`. The mid-frame renderDur
            // handed to `-t` emitted renderFrames+1 frames (ffmpeg keeps the
            // frame that STARTS before t), so every avatar/ai_clip slot shipped
            // one frame (~33ms) longer than slotDurations recorded — measured
            // 2026-07-17 in render.concat.timeline as +2.36s of excess video
            // over the voiceover on this 250-block render, growing lip-lag at
            // every avatar, with the surplus invisibly chopped off the tail by
            // the final mux's -t. -frames:v renderFrames emits exactly
            // renderFrames frames; the slot's true length is renderFrames/30.
            await normalizeClip({ inputPath: trimmed, outputPath: out, width: outW, height: outH, fps: 30, keepAudio: false, vcodecArgs: vcodec, pinDurationSeconds: renderDur, pinFrames: renderFrames });
            if (it.type === "avatar") {
              try {
                const norm = await probeFile(out);
                // The 25->30fps conversion happens HERE (normalizeClip's fps filter).
                // If the face's motion is re-timed rather than resampled, this is the
                // stage that does it: compare the frame count actually emitted against
                // what the duration implies at 30fps. A mismatch means frames were
                // duplicated/dropped unevenly and the mouth no longer tracks the audio
                // it was synced to.
                const impliedFrames = norm.durationSeconds * 30;
                await logJob({ projectId, jobId: mediaJobId }, "render.avatar.chain.after_normalize", {
                  idx: i,
                  afterNormalizeSeconds: Math.round(norm.durationSeconds * 1000) / 1000,
                  targetSeconds: Math.round(renderDur * 1000) / 1000,
                  deltaMs: Math.round((norm.durationSeconds - renderDur) * 1000),
                  impliedFramesAt30: Math.round(impliedFrames * 100) / 100,
                  expectedFrames: renderFrames,
                  frameDelta: Math.round(impliedFrames - renderFrames),
                });
              } catch { /* diagnostic only */ }
            }
            slots[i] = out;
            // The slot's intended length is a WHOLE number of frames. renderDur
            // is the mid-frame value ((frames+0.5)/30) used only as a cut/pad
            // ceiling; recording it into slotDurations would overstate every
            // block by 16.7ms — half the one-frame leak this fix removes.
            const exactDur = renderFrames / 30;
            let actualDur = exactDur;
            // Probe the file we actually built and record THAT. -frames:v caps
            // the upper end at renderFrames, so the probe only ever detects a
            // clip that came back SHORT, which the pad-up branch below fills.
            try { const p = await probeFile(out); if (p.durationSeconds > 0) actualDur = Math.min(p.durationSeconds, exactDur); } catch { /* fallback */ }
            // HeyGen/LTX often return a clip SHORTER than the narration window
            // it was planned for (cutClip can't extend, only trim). Summing the
            // short actual duration drags the whole video below the voiceover
            // and the final mux clips the voiceover tail. Hold the last frame up
            // to renderDur so the slot always fills its planned window — video
            // and voiceover stay in sync, audio is never cut. A gross shortfall
            // (a long frozen face) is logged for regeneration on the review
            // screen rather than silently shipped.
            //
            // The threshold MUST stay tiny. A per-block tolerance of 0.2s used to
            // sit here, but on a 303-block avatar render ~74 ai_clip blocks came
            // back short by 0.12-0.17s each — each just UNDER 0.2s, so none were
            // padded and the shortfalls compounded to -2.25s of video drift
            // (post_validation driftMs -2452, passed:false). Below the audio, the
            // final mux clips the voiceover tail and every avatar part's lips
            // finish ahead of its words. Pad on any shortfall past one frame
            // (~33ms at 30fps): padVideoToLength pins to exact renderDur, so
            // filling even a 40ms gap is free and keeps cumulative drift at zero.
            // Compare FRAME COUNTS, not seconds. A one-frame shortfall is
            // exactly 33.3ms, which the old `> 0.034` seconds threshold let
            // slip through once the target became exactDur (with the mid-frame
            // renderDur the same gap read 49ms and padded fine) — caught live
            // on the 2026-07-17 12:30 render: every avatar emitted 580/581
            // frames and skipped the pad. Any missing whole frame must pad;
            // -frames:v can only cap, tpad is what creates the missing frame.
            const actualFrames = Math.round(actualDur * 30);
            if (actualFrames < renderFrames) {
              const padOut = path.join(tmp, `synvid_pad_${idx}.mp4`);
              try {
                // targetFrames pins the pad to exactly renderFrames frames;
                // targetSeconds only sizes tpad's clone reservoir.
                await padVideoToLength({ inputPath: out, outputPath: padOut, targetSeconds: renderDur, fps: 30, vcodecArgs: vcodec, targetFrames: renderFrames });
                await safeUnlink(out);
                slots[i] = padOut;
                if (exactDur - actualDur >= 3) {
                  await logJob({ projectId, jobId: mediaJobId }, "render.synthetic_video.gross_short", {
                    idx: i, type: it.type,
                    plannedSeconds: Math.round(exactDur * 100) / 100,
                    renderedSeconds: Math.round(actualDur * 100) / 100,
                    shortfallSeconds: Math.round((exactDur - actualDur) * 100) / 100,
                    note: "held last frame to fill slot; regenerate this block for true sync",
                  });
                }
                // Record what the pad actually produced, not what we asked for
                // — trusting the intent here is exactly how the one-frame leak
                // stayed invisible (slotDurations said 19.383s, file was 19.4s).
                actualDur = exactDur;
                try { const pp = await probeFile(padOut); if (pp.durationSeconds > 0) actualDur = pp.durationSeconds; } catch { /* keep exactDur */ }
              } catch (e) {
                await logJob({ projectId, jobId: mediaJobId }, "render.synthetic_video.pad_failed", { idx: i, err: (e as Error).message });
              }
            }
            slotDurations[i] = actualDur;
            slotContentDurations[i] = Math.max(0.1, actualDur - headLeft - headRight);
          } catch (e) {
            await logJob({ projectId, jobId: mediaJobId }, "render.synthetic_video.failed", { idx: i, type: it.type, url: it.video_url, err: (e as Error).message });
          } finally {
            await safeUnlink(localPre);
            await safeUnlink(trimmed);
          }
        } else if (it.image_url) {
          // Degraded ai_clip: hold the still with zoom-only motion, same as an
          // image block (client wants zoom, no pan — see the image branch).
          const MOTION_CYCLE = ["in", "out"] as const;
          const localImg = path.join(tmp, `synimg_${idx}`);
          // buildStillVideo builds an EXACT-length still (no `-t` floor problem),
          // so pass the clean frame-aligned duration rather than the mid-frame pin
          // value renderDur uses for the video path — otherwise round(x.5) rounds
          // up and the still runs one frame long while slotDurations understates.
          const stillDur = renderFrames / 30;
          try {
            await downloadHttp(it.image_url as string, localImg);
            await buildStillVideo({
              vcodecArgs: vcodec,
              inputImagePath: localImg, outputPath: out, durationSeconds: stillDur,
              width: outW, height: outH, fps: 30, motionDirection: MOTION_CYCLE[i % MOTION_CYCLE.length],
              // Frame-exact: stillDur sits ON a frame boundary, where the
              // looped input's -t emits N or N+1 frames on float luck.
              exactFrames: renderFrames,
            });
            slots[i] = out;
            slotDurations[i] = stillDur;
            slotContentDurations[i] = plannedDur;
            imageRendered++;
          } catch (e) {
            imageFailed++;
            await logJob({ projectId, jobId: mediaJobId }, "render.synthetic_still.failed", { idx: i, url: it.image_url, err: (e as Error).message });
          } finally {
            await safeUnlink(localImg);
          }
        }
      } else if (it.type === "title_card") {
        // Section-break title card: black background with the section
        // title rendered as centered white text. Source comes from
        // overlay_text, populated by the matcher from Gemini's per-segment
        // sectionTitle. We bake the same per-side headroom an image
        // neighbor would (still frames behave identically through xfades),
        // so the transition math downstream still adds up.
        const headLeft = headroomFor(i - 1);
        const headRight = headroomFor(i + 1);
        const renderDur = plannedDur + headLeft + headRight;
        const text = String(it.overlay_text ?? "").trim();
        // Script-doc title cards opt in to typewriter animation by stamping
        // metadata.animation = "typewriter". Cards inserted by the analyze
        // pipeline (chapter breaks) leave it unset and get the static
        // treatment they had before.
        const tcMeta = (it.metadata ?? {}) as Record<string, unknown>;
        const tcAnimation: "static" | "typewriter" =
          tcMeta.animation === "typewriter" ? "typewriter" : "static";
        // Typewriter sub-window: the spoken duration of the title phrase.
        // The typing animation runs for this long; the remainder of the
        // segment holds the fully-typed text so the viewer can read it.
        // When missing (legacy rows), fall back to full segment so the
        // old behavior — type-across-the-whole-card — still works.
        const tcTypewriterRaw = tcMeta.typewriter_seconds;
        const tcTypewriterSeconds =
          typeof tcTypewriterRaw === "number" && tcTypewriterRaw > 0
            ? Math.min(tcTypewriterRaw, renderDur)
            : undefined;
        try {
          await buildTitleCardVideo({
            vcodecArgs: vcodec,
            text,
            outputPath: out,
            durationSeconds: renderDur,
            width: outW, height: outH, fps: 30,
            animation: tcAnimation,
            typewriterDurationSeconds: tcTypewriterSeconds,
          });
          slots[i] = out;
          slotDurations[i] = renderDur;
          slotContentDurations[i] = plannedDur;
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
        const headLeft = headroomFor(i - 1);
        const headRight = headroomFor(i + 1);
        const renderDur = plannedDur + headLeft + headRight;
        try {
          const localImg = path.join(tmp, `img_${idx}`);
          await downloadHttp(it.image_url as string, localImg);
          const imgMeta = (it.metadata ?? {}) as Record<string, unknown>;
          const imgLt = imgMeta.lower_third as
            | { text?: string; vo_start_seconds?: number }
            | undefined;
          const imgLtOffset = lowerThirdStartOffset(imgLt, imgMeta, headLeft, renderDur);
          // ZOOM ONLY, alternating in/out per consecutive image (client
          // requirement 2026-06: "the small zoom effect, you can add that …
          // only single images" — they want a gentle zoom, NOT the pan/slide
          // moves). Alternating zoom-in / zoom-out keeps consecutive stills
          // from moving identically while staying pan-free.
          const MOTION_CYCLE = ["in", "out"] as const;
          const motion = MOTION_CYCLE[i % MOTION_CYCLE.length];
          // Synthetic: pin to an exact frame count and record frames/30. The
          // frame-snap puts renderDur ON a frame boundary, where the builder's
          // input-side -t emits N or N+1 frames on float luck — the +586ms of
          // unrecorded still-block video measured 2026-07-17. Sourced renders
          // omit the pin and keep byte-identical behavior.
          const imgFrames = Math.max(1, Math.round(renderDur * 30));
          await buildStillVideo({
            vcodecArgs: vcodec,
            inputImagePath: localImg,
            outputPath: out,
            durationSeconds: renderDur,
            width: outW, height: outH, fps: 30,
            motionDirection: motion,
            exactFrames: isSyntheticRender ? imgFrames : undefined,
            lowerThird: imgLt?.text
              ? { text: imgLt.text, startOffsetSeconds: imgLtOffset }
              : undefined,
          });
          slots[i] = out;
          slotDurations[i] = isSyntheticRender ? imgFrames / 30 : renderDur;
          slotContentDurations[i] = plannedDur;
          imageRendered++;
          await safeUnlink(localImg);
        } catch (e) {
          imageFailed++;
          await logJob({ projectId, jobId: mediaJobId },
            "render.image.failed", { idx: i, url: it.image_url, err: (e as Error).message });
        }
      } else if (it.type === "footage" && (((it.metadata ?? {}) as Record<string, unknown>).forced_clip as { youtube_url?: string } | undefined)?.youtube_url) {
        // Forced clip from a script-doc title-card marker. Two paths:
        //   • Pre-downloaded (preferred): the script_clip worker has
        //     already pulled the YouTube source, cut the doc's window,
        //     normalized to the project engine's canvas @30, and uploaded to R2.
        //     The marker row carries clip_storage_url. We just downloadHttp
        //     it and re-encode if a lower_third overlay needs baking in.
        //   • Fallback: the pre-download didn't run or failed. We do the
        //     full yt-dlp + cut + normalize at render time, paying the
        //     same cost the script_clip worker would have.
        const meta = (it.metadata ?? {}) as Record<string, unknown>;
        const fc = meta.forced_clip as { youtube_url: string; start_seconds?: number; end_seconds?: number };
        const startSeconds = Number(fc.start_seconds ?? 0);
        const endSeconds = Number(fc.end_seconds ?? startSeconds + plannedDur);
        const windowDur = Math.max(1, endSeconds - startSeconds);
        const leftIsImage = isImageNeighbor(i - 1);
        const rightIsImage = isImageNeighbor(i + 1);
        const headLeft = leftIsImage ? MIXED_FADE_SECONDS / 2 : 0;
        const headRight = rightIsImage ? MIXED_FADE_SECONDS / 2 : 0;
        // Slow-mo: when the matcher stretched this row's duration past
        // the source YouTube window (audio interval > clip length), the
        // source clip needs to play slower to fill the full narration.
        // forced_clip_source_window_seconds is the natural source length
        // (set by the matcher's vo_start_duration_pass when it extended
        // the row). Cap the stretch at 1.5× — beyond that, slow-mo looks
        // unnatural and the residue (audio overflow) is accepted as a
        // small visual freeze on the clip's last frame.
        const sourceWindowSeconds = typeof meta.forced_clip_source_window_seconds === "number"
          ? Number(meta.forced_clip_source_window_seconds)
          : windowDur;
        const MAX_SLOWMO_FACTOR_FORCED = 1.5;
        const targetContentDur = plannedDur; // the matcher-extended duration
        const rawStretch = sourceWindowSeconds > 0 ? targetContentDur / sourceWindowSeconds : 1.0;
        const forcedSlowmoFactor = rawStretch > 1.0
          ? Math.min(rawStretch, MAX_SLOWMO_FACTOR_FORCED)
          : undefined;
        if (forcedSlowmoFactor) {
          await logJob({ projectId, jobId: mediaJobId },
            "render.forced_clip.slowmo", {
              idx: i,
              docMarkerId: (meta.doc_marker_id as string | null | undefined) ?? null,
              sourceWindowSeconds: Math.round(sourceWindowSeconds * 100) / 100,
              targetContentDur: Math.round(targetContentDur * 100) / 100,
              rawStretch: Math.round(rawStretch * 1000) / 1000,
              appliedSlowmo: Math.round(forcedSlowmoFactor * 1000) / 1000,
              capped: rawStretch > MAX_SLOWMO_FACTOR_FORCED,
            });
        }
        // Render duration must reflect the matcher-committed audio
        // interval, NOT the source window length. Using windowDur here
        // would cut the output back to the source's natural length,
        // erasing the slow-mo stretch.
        const renderDur = targetContentDur + headLeft + headRight;

        // Look up the marker's pre-downloaded URL if metadata points to one.
        const docMarkerId = (meta.doc_marker_id as string | null | undefined) ?? null;
        let preClipUrl: string | null = null;
        if (docMarkerId) {
          const { data: markerRow } = await sb
            .from("project_script_markers")
            .select("clip_storage_url")
            .eq("id", docMarkerId)
            .maybeSingle();
          preClipUrl = (markerRow?.clip_storage_url as string | null) ?? null;
        }
        const lt = meta.lower_third as
          | { text?: string; vo_start_seconds?: number }
          | undefined;
        const ltStartOffset = lowerThirdStartOffset(lt, meta, headLeft, renderDur);

        if (preClipUrl) {
          // Pre-downloaded path. The asset on R2 is already cut + normalized
          // so we only re-encode when we need to bake a lower-third overlay
          // or when the renderer's mixed-boundary headroom adds duration.
          //
          // Forced doc clips need their audio track retained on every
          // intermediate file — the audio-splice pass after rendering
          // extracts the audio and inserts it into the voiceover chain.
          // If we drop the audio at any stage (cutClip / normalizeClip
          // default -an), there's nothing to splice and the clip plays
          // silent.
          const localPre = path.join(tmp, `forced_pre_${idx}.mp4`);
          try {
            await downloadHttp(preClipUrl, localPre);
            if (lt?.text || headLeft > 0 || headRight > 0 || forcedSlowmoFactor) {
              const trimmedPre = path.join(tmp, `forced_pretrim_${idx}.mp4`);
              await cutClip({
                inputPath: localPre, outputPath: trimmedPre,
                startSeconds: 0, durationSeconds: renderDur,
                keepAudio: true,
                slowmoFactor: forcedSlowmoFactor,
              });
              await normalizeClip({
                vcodecArgs: vcodec,
                inputPath: trimmedPre, outputPath: out,
                width: outW, height: outH, fps: 30,
                lowerThird: lt?.text
                  ? { text: lt.text, startOffsetSeconds: ltStartOffset }
                  : undefined,
                keepAudio: true,
              });
              await safeUnlink(trimmedPre);
            } else {
              // No overlay/headroom work needed. The pre-download is USUALLY
              // already the final shape — but only if it was normalized to the
              // canvas THIS render is using. Clips downloaded before the
              // 2026-08-08 sourced-1080p revert are 3840x2160, and renaming one
              // into a 1080p timeline puts a 4K segment in the concat list,
              // which fails the -c:v copy demuxer (it requires identical dims).
              // Probe and re-normalize only on mismatch, so the common case
              // stays a free rename.
              let preMatches = true;
              try {
                const p = await probeFile(localPre);
                preMatches = p.width === outW && p.height === outH;
              } catch { preMatches = false; }
              if (preMatches) {
                await fs.rename(localPre, out);
              } else {
                await logJob({ projectId, jobId: mediaJobId },
                  "render.forced_clip.pre.canvas_mismatch", { idx: i, docMarkerId, outW, outH });
                await normalizeClip({
                  vcodecArgs: vcodec,
                  inputPath: localPre, outputPath: out,
                  width: outW, height: outH, fps: 30,
                  keepAudio: true,
                });
              }
            }
            slots[i] = out;
            let actualDur = renderDur;
            try {
              const probed = await probeFile(out);
              if (probed.durationSeconds > 0) actualDur = probed.durationSeconds;
            } catch { /* keep renderDur fallback */ }
            slotDurations[i] = actualDur;
            // Content duration = rendered file minus the xfade headroom
            // baked in for mixed-boundary neighbors. Stays in sync with
            // the on-screen visible content time the editor displays.
            slotContentDurations[i] = Math.max(0.1, actualDur - headLeft - headRight);
            await safeUnlink(localPre);
          } catch (e) {
            await logJob({ projectId, jobId: mediaJobId },
              "render.forced_clip.pre.failed", {
                idx: i,
                docMarkerId,
                preClipUrl,
                err: (e as Error).message,
              });
          }
        } else {
          // Fallback: do the whole yt-dlp dance at render time.
          const videoId = extractYoutubeVideoId(fc.youtube_url);
          if (!videoId) {
            await logJob({ projectId, jobId: mediaJobId },
              "render.forced_clip.bad_url", { idx: i, url: fc.youtube_url });
            return;
          }
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
              keepAudio: true,
              slowmoFactor: forcedSlowmoFactor,
            });
            await normalizeClip({
              vcodecArgs: vcodec,
              inputPath: trimmed, outputPath: out,
              width: outW, height: outH, fps: 30,
              lowerThird: lt?.text
                ? { text: lt.text, startOffsetSeconds: ltStartOffset }
                : undefined,
              keepAudio: true,
            });
            slots[i] = out;
            let actualDur = renderDur;
            try {
              const probed = await probeFile(out);
              if (probed.durationSeconds > 0) actualDur = probed.durationSeconds;
            } catch { /* keep renderDur fallback */ }
            slotDurations[i] = actualDur;
            slotContentDurations[i] = Math.max(0.1, actualDur - headLeft - headRight);
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

          // Source-duration-aware stretch decision. Probe the downloaded
          // clip's real length so we can decide between three rendering
          // modes:
          //   • clipDur ≥ renderDur            → normal stream-copy cut
          //   • renderDur > clipDur, stretch ≤ 1.5× → slow-mo the clip
          //     (PTS rewrite) so the rendered slot matches the sentence
          //     duration exactly. Imperceptible on documentary B-roll.
          //   • stretch > 1.5×                 → slow-mo capped at 1.5×,
          //     residual gap absorbed by the matcher's duration_reclaim
          //     pass onto OTHER blocks with headroom. Anything beyond
          //     1.5× starts to look unnatural; Phase B will add a true
          //     image-fallback path for these.
          //
          // Probing happens AFTER download so we know the on-disk truth
          // even when video_clips.duration in the DB is stale.
          let sourceClipDur = renderDur;
          try {
            const sourceProbe = await probeFile(local);
            if (sourceProbe.durationSeconds > 0) sourceClipDur = sourceProbe.durationSeconds;
          } catch { /* probe failure → assume the clip is long enough */ }

          const MAX_SLOWMO_FACTOR = 1.5;
          const rawStretch = sourceClipDur > 0 ? renderDur / sourceClipDur : 1.0;
          let slowmoFactor: number | undefined;
          if (rawStretch > 1.0) {
            slowmoFactor = Math.min(rawStretch, MAX_SLOWMO_FACTOR);
            await logJob({ projectId, jobId: mediaJobId },
              "render.clip.slowmo", {
                idx: i, clipId: it.clip_id,
                sourceClipDur: Math.round(sourceClipDur * 100) / 100,
                renderDur: Math.round(renderDur * 100) / 100,
                rawStretch: Math.round(rawStretch * 1000) / 1000,
                appliedSlowmo: Math.round(slowmoFactor * 1000) / 1000,
                capped: rawStretch > MAX_SLOWMO_FACTOR,
              });
          }

          // When slow-mo was capped (clip too short to fill the slot even at
          // 1.5×), the stretched output would land SHORT of renderDur and the
          // clip would end before its narration does — drifting every later
          // title card / lower-third off the spoken word. Pass the renderDur
          // as a freeze-hold target so cutClip holds the last frame to fill
          // the slot exactly. Only set it when capped; an uncapped slow-mo (or
          // a long-enough clip) already fills renderDur, so the freeze is a
          // no-op there.
          const freezeTarget =
            slowmoFactor != null && rawStretch > MAX_SLOWMO_FACTOR
              ? renderDur
              : undefined;
          await cutClip({
            inputPath: local, outputPath: trimmed,
            startSeconds: 0, durationSeconds: renderDur,
            slowmoFactor,
            padToFreezeDurationSeconds: freezeTarget,
          });
          // Lower-third stamped by the matcher: { text, type } on
          // metadata.lower_third when this clip should introduce a name
          // (first occurrence only) or label a year/place visual. Render
          // passes only the text — type is used by the matcher for the
          // first-time-only rule and is irrelevant downstream.
          const meta = (it.metadata ?? {}) as Record<string, unknown>;
          const lt = meta.lower_third as
            | { text?: string; vo_start_seconds?: number }
            | undefined;
          // Delay the chyron to the in-clip moment the narrator says the
          // red-marked word (falls back to clip start when no word time).
          const ltStartOffset = lowerThirdStartOffset(lt, meta, headLeft, renderDur);
          // Pin the normalized footage clip to exactly renderDur. The cut
          // above (stream-copy in the normal path) overshoots renderDur to the
          // next keyframe by 60-180ms; this re-encode caps it back so the slot
          // matches what the timeline planned. We pin to renderDur (NOT the
          // probed cut length) on purpose: renderDur includes the mixed-fade
          // headroom that the xfade merge later subtracts, and the headroom
          // accounting at slotContentDurations below assumes the clip is
          // exactly renderDur long. Without the pin that assumption was false
          // and the residual leaked as ~9s of cumulative positive drift.
          await normalizeClip({
            vcodecArgs: vcodec,
            inputPath: trimmed, outputPath: out,
            width: outW, height: outH, fps: 30,
            lowerThird: lt?.text
              ? { text: lt.text, startOffsetSeconds: ltStartOffset }
              : undefined,
            pinDurationSeconds: renderDur,
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
          // Content duration = actual rendered length minus the xfade
          // headroom baked in for mixed-boundary neighbors. When the source
          // was shorter than asked AND slow-mo was capped (rawStretch >
          // 1.5×), actualDur < renderDur and content_dur < plannedDur —
          // the editor writeback below will reflect that the scene plays
          // shorter than the matcher planned. Reclaim absorbs the gap
          // onto other rows so total timeline still equals voiceover.
          slotContentDurations[i] = Math.max(0.1, actualDur - headLeft - headRight);
          await safeUnlink(trimmed);
        } catch (e) {
          await logJob({ projectId, jobId: mediaJobId },
            "render.clip.failed", { idx: i, err: (e as Error).message });
        }
      }
    }

    const renderStageStart = Date.now();
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
    stageTimings.render_clips_ms = Date.now() - renderStageStart;

    // ---- failed-slot filler pass ----------------------------------------
    // A slot that failed to render (source download timeout, ffmpeg error)
    // leaves slots[i] === null. The merge loop below skips null slots, which
    // silently DROPS that block's planned narration window — so every later
    // segment, including title cards and lower-thirds, slides earlier by the
    // dropped duration and lands off its spoken moment (the audit showed a
    // single timed-out clip costing 6s of permanent downstream drift).
    //
    // Replace each null non-intro slot with a black filler of the block's
    // PLANNED duration so the timeline hole is held, not collapsed. The
    // viewer sees a brief black hold; cumulative video-time keeps tracking
    // the voiceover so downstream anchoring survives one failed clip. We
    // re-use the planned duration (timeline_items.duration) — not a probe —
    // because there is no rendered file to probe.
    {
      const fillerHeadroom = 0; // filler is a standalone hold; no xfade headroom
      let fillersInserted = 0;
      for (let i = 0; i < renderable.length; i++) {
        if (slots[i] !== null) continue;
        const it = renderable[i];
        if (it.type === "intro") continue;
        const plannedDur = plannedDurations[i];
        const out = path.join(tmp, `filler_${String(i).padStart(3, "0")}.mp4`);
        try {
          await buildBlackVideo({
            vcodecArgs: vcodec,
            outputPath: out,
            durationSeconds: plannedDur,
            width: outW, height: outH, fps: 30,
          });
          slots[i] = out;
          slotDurations[i] = plannedDur;
          slotContentDurations[i] = Math.max(0.1, plannedDur - fillerHeadroom);
          fillersInserted++;
        } catch (e) {
          // If even the filler fails, leave the slot null (it'll be skipped
          // as before) — better a small drift than aborting the whole render.
          await logJob({ projectId, jobId: mediaJobId },
            "render.filler.failed", { idx: i, err: (e as Error).message });
        }
      }
      if (fillersInserted > 0) {
        await logJob({ projectId, jobId: mediaJobId },
          "render.filler.inserted", { count: fillersInserted });
      }
    }

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
          vcodecArgs: vcodec,
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

    // Liveness heartbeat for the merge phase. Each boundary is a full ffmpeg
    // xfade re-encode and there's no per-boundary progress write, so on a big
    // project this loop can run many minutes — long enough for the stall
    // sweeper to false-kill the job. Touch updated_at at most every ~20s so a
    // live merge keeps signalling without hammering the DB.
    let lastMergeHeartbeat = 0;
    const mergeHeartbeat = async () => {
      const now = Date.now();
      if (now - lastMergeHeartbeat < 20_000) return;
      lastMergeHeartbeat = now;
      await touchMediaJob(mediaJobId);
    };

    const mergeStageStart = Date.now();
    // Count every boundary that WOULD have received a transition in the normal
    // pipeline, so the log shows how many xfade/fadeblack re-encodes
    // PERFORMANCE_MODE skipped (in normal mode this matches xfadeMerges +
    // mixedFades). Computed by walking adjacent successfully-rendered slots.
    let transitionsSkipped = 0;
    {
      let prevWasStill: boolean | null = null;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i] === null) continue;
        const still = isImageNeighbor(i);
        if (prevWasStill !== null) {
          // still↔still (xfade), still↔video / video↔still (fadeblack) get a
          // transition; video↔video is already a hard cut.
          if (prevWasStill || still) transitionsSkipped++;
        }
        prevWasStill = still;
      }
    }

    if (performanceMode) {
      // PERFORMANCE_MODE: NO transitions. Every successfully-rendered slot is
      // appended as a hard cut — no xfadePair, no xfadeFadeBlack, no
      // mergeMixedBoundary, no headroom to consume (headroomFor returned 0 so
      // each slot is exactly its planned length). This is the simplest possible
      // assembly: render clips → (concat) → audio. mergedKinds /
      // mergedTailIsRealImage are still tracked so the (now empty) SFX cadence
      // and downstream duration accounting see consistent state.
      for (let i = 0; i < slots.length; i++) {
        await mergeHeartbeat();
        const seg = slots[i];
        if (seg === null) continue;
        const itemKind: SegKind = isImageNeighbor(i) ? "image" : "video";
        mergedSegments.push(seg);
        mergedDurations.push(slotDurations[i]);
        mergedKinds.push(itemKind);
        mergedTailIsRealImage.push(isRealImage(i));
      }
      await logJob({ projectId, jobId: mediaJobId }, "render.transitions.skipped", {
        performanceMode: true,
        transitionsSkipped,
        hardCuts: mergedSegments.length,
        note: "all clip-to-clip transitions disabled — hard cuts only",
      });
    } else {
    for (let i = 0; i < slots.length; i++) {
      await mergeHeartbeat();
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
            vcodecArgs: vcodec,
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
    } // end normal (effects-on) merge path
    stageTimings.merge_transitions_ms = Date.now() - mergeStageStart;
    const normalized: string[] = mergedSegments;

    if (normalized.length === 0) throw new Error("all timeline items failed to render");

    await logJob({ projectId, jobId: mediaJobId }, "render.segments", {
      total: renderable.length,
      built: normalized.length,
      imageRendered,
      imageFailed,
      // In PERFORMANCE_MODE both stay 0 (no transition encodes ran); the count
      // that WOULD have run is logged as transitionsSkipped above.
      xfadeMerges,
      mixedFades,
      transitionsSkipped,
      performanceMode,
      mergeStageMs: stageTimings.merge_transitions_ms,
      renderClipsMs: stageTimings.render_clips_ms,
    });

    // 3) Optional voiceover from project + intro clip selection + bg music + SFX
    const { data: project } = await sb.from("projects")
      .select("voiceover_url, title, intro_clip_id, intro_duration_seconds, intro_source_youtube_url, intro_source_start_seconds, bg_music_url, bg_music_gain, sfx_urls, sfx_gain")
      .eq("id", projectId).single();
    // The voiceover IS the master audio track — the whole video's sound. Unlike
    // bg music / SFX (best-effort polish below), a MISSING voiceover means a
    // completely silent render, which the duration-only post-validation happily
    // passes (a silent video has the exact right length). That shipped ≥5
    // "completed" videos with no voice (client report 2026-07-30). So a
    // voiceover download failure must NOT be swallowed: downloadHttp already
    // retries transient CDN failures, and if it still throws we HARD-FAIL the
    // render (the catch at the bottom marks it failed + retryable) rather than
    // silently producing a voiceless video. A project that legitimately has no
    // voiceover_url (voiceoverLocal stays undefined) is a different, valid case
    // — an audio guard after concat catches an unexpectedly-silent render there.
    let voiceoverLocal: string | undefined;
    if (project?.voiceover_url) {
      voiceoverLocal = path.join(tmp, "voiceover.audio");
      try {
        await downloadHttp(project.voiceover_url, voiceoverLocal);
        // Guard against a "successful" download of an empty/corrupt file that
        // would produce a silent track — probe it and require real audio.
        const voProbe = await probeFile(voiceoverLocal);
        if (!voProbe.hasAudio || !(voProbe.durationSeconds > 0)) {
          throw new Error(
            `voiceover downloaded but has no audio stream (hasAudio=${voProbe.hasAudio}, dur=${voProbe.durationSeconds})`,
          );
        }
      } catch (e) {
        await logJob({ projectId, jobId: mediaJobId }, "render.voiceover.download_failed", {
          url: project.voiceover_url,
          err: (e as Error).message?.slice(0, 300),
        });
        throw new Error(
          `render aborted: could not fetch the master voiceover (${(e as Error).message}). ` +
            `Rendering without it would ship a silent video; retrying instead.`,
        );
      }
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
    //
    // Per user direction (2026-05-27): mid-timeline forced clips (doc
    // markers placed inside the script body) play VIDEO ONLY — the
    // narrator voiceover keeps playing continuously over them, no pause.
    // The intro pre-roll is UNAFFECTED — it still plays its source audio
    // before the voiceover, as before. The flag below gates only the
    // mid-timeline splice; introAudioPath is wired in as usual.
    const MID_TIMELINE_FORCED_CLIP_AUDIO_ENABLED = false;
    let introAudioPath: string | undefined;
    let introDurationActual = 0;

    // Opening title — the overall video title shown as a 5s black
    // title-card BEFORE the intro clips play. Set when the doc starts
    // with a blue-bold title paragraph above the first intro timestamp.
    // Rendered with the same buildTitleCardVideo helper the chapter
    // title cards use, with a silent audio track of matching duration
    // so the intro audio crossfade lands at the right offset.
    //
    // The card is prepended to `normalized[]` AFTER the intro cards
    // below (because the multi-intro block unshifts in reverse order).
    // We build it first so the file exists when we unshift it.
    const OPENING_TITLE_DURATION = 5;
    let openingTitleVideoPath: string | undefined;
    let openingTitleAudioPath: string | undefined;
    let openingTitleDuration = 0;
    {
      const { data: openingTitleRow } = await sb
        .from("project_script_markers")
        .select("text")
        .eq("project_id", projectId)
        .eq("kind", "opening_title")
        .maybeSingle();
      const titleText = ((openingTitleRow?.text as string | null) ?? "").trim();
      if (titleText) {
        try {
          const openingTmp = path.join(tmp, "opening_title");
          await fs.mkdir(openingTmp, { recursive: true });
          const cardPath = path.join(openingTmp, "card.mp4");
          // Opening title uses the same typewriter animation as the
          // chapter title cards inserted mid-timeline. Type for ~60% of
          // the card's duration, hold the fully-typed text for the rest
          // so the viewer has a beat to read it before the intro plays.
          // The chapter cards use ~73% typing / 27% hold (e.g. 2.88s
          // typing on a 3.93s card), which feels slightly fast on a
          // ceremonial opening title — 60% gives a more deliberate beat.
          const OPENING_TITLE_TYPEWRITER_RATIO = 0.6;
          await buildTitleCardVideo({
            vcodecArgs: vcodec,
            text: titleText,
            outputPath: cardPath,
            durationSeconds: OPENING_TITLE_DURATION,
            width: outW,
            height: outH,
            fps: 30,
            animation: "typewriter",
            typewriterDurationSeconds: OPENING_TITLE_DURATION * OPENING_TITLE_TYPEWRITER_RATIO,
          });
          const normalizedCard = path.join(openingTmp, "card_norm.mp4");
          await normalizeClip({
            vcodecArgs: vcodec,
            inputPath: cardPath,
            outputPath: normalizedCard,
            width: outW,
            height: outH,
            fps: 30,
          });
          // Silent audio track matching the card's duration so the intro
          // audio path concat lands at the right offset.
          const silentPath = path.join(openingTmp, "card_silent.m4a");
          await buildSilentAudio({
            outputPath: silentPath,
            durationSeconds: OPENING_TITLE_DURATION,
          });
          openingTitleVideoPath = normalizedCard;
          openingTitleAudioPath = silentPath;
          openingTitleDuration = OPENING_TITLE_DURATION;
          await safeUnlink(cardPath);
          await logJob({ projectId, jobId: mediaJobId },
            "render.opening_title.ready", {
              text: titleText.slice(0, 80),
              durationSeconds: OPENING_TITLE_DURATION,
            });
        } catch (e) {
          await logJob({ projectId, jobId: mediaJobId },
            "render.opening_title.failed", { err: (e as Error).message });
          openingTitleVideoPath = undefined;
          openingTitleAudioPath = undefined;
          openingTitleDuration = 0;
        }
      }
    }

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
      .select("id, text, ordinal, youtube_url, start_seconds, end_seconds, clip_storage_url, audio_storage_url")
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
            clip_storage_url: string | null;
            audio_storage_url: string | null;
          };
          const url = row.youtube_url?.trim();
          if (!url) continue;
          const start = Number(row.start_seconds ?? 0);
          const end = Number(row.end_seconds ?? start + 6);
          const dur = Math.max(1, end - start);
          try {
            // Fast path: the script-clip pre-download produced cut +
            // normalized assets on R2. Pull them via HTTP and we're done —
            // no yt-dlp, no ffmpeg cut, no normalize pass.
            const preClipUrl = row.clip_storage_url?.trim();
            const preAudioUrl = row.audio_storage_url?.trim();
            if (preClipUrl && preAudioUrl) {
              const localClip = path.join(introTmp, `pre_card_${row.ordinal}.mp4`);
              const localAudio = path.join(introTmp, `pre_audio_${row.ordinal}.m4a`);
              await Promise.all([
                downloadHttp(preClipUrl, localClip),
                downloadHttp(preAudioUrl, localAudio),
              ]);
              // Assets pre-downloaded before the pin fix were keyframe-cut
              // and can run seconds past the marker window, while
              // accumulatedDuration only counts `dur` — the voiceover then
              // starts under leftover intro footage and every block after
              // it lags the narration. Probe and re-pin to `dur` so the
              // file matches what we account for.
              //
              // The excess sits at the HEAD, not the tail: cutClip's copy
              // seek starts at the keyframe at or before the marker start,
              // so the requested window is the LAST `dur` seconds of the
              // stored file. Trim the head excess and keep the tail — a
              // tail trim keeps pre-marker footage and plays it under the
              // (exactly-cut) intro audio, several seconds out of sync.
              let introClipPath = localClip;
              try {
                const probed = await probeFile(localClip);
                const overshoot = probed.durationSeconds - dur;
                if (overshoot > INTRO_CARD_PIN_TOLERANCE_SECONDS) {
                  const pinned = path.join(introTmp, `pre_card_${row.ordinal}_pinned.mp4`);
                  await normalizeClip({
                    vcodecArgs: vcodec,
                    inputPath: localClip, outputPath: pinned,
                    width: outW, height: outH, fps: 30,
                    startOffsetSeconds: overshoot,
                    pinDurationSeconds: dur,
                  });
                  await safeUnlink(localClip);
                  introClipPath = pinned;
                  await logJob({ projectId, jobId: mediaJobId },
                    "render.intro_card.repinned", {
                      ordinal: row.ordinal,
                      storedDuration: Math.round(probed.durationSeconds * 100) / 100,
                      pinnedDuration: dur,
                      headTrimSeconds: Math.round(overshoot * 100) / 100,
                    });
                }
              } catch (e) {
                await logJob({ projectId, jobId: mediaJobId },
                  "render.intro_card.pin_check_failed", {
                    ordinal: row.ordinal, err: (e as Error).message,
                  });
              }
              builtVideos.push(introClipPath);
              builtAudios.push(localAudio);
              accumulatedDuration += dur;
              continue;
            }

            // Fallback: pre-download didn't run or partially failed. Fetch
            // via proxied yt-dlp like the original path.
            const videoId = extractYoutubeVideoId(url);
            if (!videoId) {
              await logJob({ projectId, jobId: mediaJobId },
                "render.intro_card.bad_url", { ordinal: row.ordinal, url });
              continue;
            }
            const cardDir = path.join(introTmp, `card_${row.ordinal}`);
            await fs.mkdir(cardDir, { recursive: true });
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
            // Pin to the requested window. cutClip stream-copies, so the cut
            // starts at the keyframe at or before `start` — the wanted
            // window is the TAIL of the trimmed file, behind up to a GOP of
            // earlier footage. Probe the cut and skip that head excess, then
            // cap at `dur`, so the output matches the separately-cut intro
            // audio frame-accurately.
            let cardHeadTrim = 0;
            try {
              const trimmedProbe = await probeFile(trimmed);
              cardHeadTrim = Math.max(0, trimmedProbe.durationSeconds - dur);
            } catch { /* pin-only fallback below */ }
            await normalizeClip({
              vcodecArgs: vcodec,
              inputPath: trimmed, outputPath: normalizedCard,
              width: outW, height: outH, fps: 30,
              startOffsetSeconds: cardHeadTrim > 0 ? cardHeadTrim : undefined,
              pinDurationSeconds: dur,
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

        const videoId = extractYoutubeVideoId(userIntroUrl);
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
          vcodecArgs: vcodec,
          inputPath: introTrimmed, outputPath: introNormalized,
          width: outW, height: outH, fps: 30,
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
          vcodecArgs: vcodec,
          inputPath: introTrimmed, outputPath: introNormalized,
          width: outW, height: outH, fps: 30,
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

    // Prepend the opening-title card (if built) so it lands at the very
    // front of the final video — BEFORE any intro clips. Runs AFTER all
    // intro paths so the unshift order is stable regardless of which
    // intro variant ran. Audio: prepend the matching silent clip to
    // introAudioPath so the voiceover crossfade still lands at the right
    // offset (now: opening_title_duration + intro_duration).
    if (openingTitleVideoPath && openingTitleAudioPath && openingTitleDuration > 0) {
      normalized.unshift(openingTitleVideoPath);
      if (introAudioPath) {
        // Concat the silent opening title audio in FRONT of the existing
        // intro audio so the merged track starts with silence then plays
        // the intro source audio at offset openingTitleDuration.
        const mergedIntroAudio = path.join(tmp, "intro_with_opening_title.m4a");
        await concatAudioFiles({
          inputPaths: [openingTitleAudioPath, introAudioPath],
          outputPath: mergedIntroAudio,
        });
        await safeUnlink(introAudioPath);
        introAudioPath = mergedIntroAudio;
      } else {
        // No intro audio at all — the opening title's silent track IS the
        // entire intro audio. The voiceover crossfade in concatNormalizedClips
        // will hand off to the voiceover at openingTitleDuration.
        introAudioPath = openingTitleAudioPath;
      }
      introDurationActual += openingTitleDuration;
      await logJob({ projectId, jobId: mediaJobId },
        "render.opening_title.prepended", {
          openingTitleDuration,
          newIntroDurationActual: introDurationActual,
        });
    }

    // 4) Concat
    let finalLocal = path.join(tmp, `final_${projectId}.mp4`);
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
    // FIX #1: the intro audio and voiceover no longer overlap. The ffmpeg
    // intro path used to acrossfade=0.3s, overlapping the two audio tracks so
    // combined audio was 0.3s SHORTER than introDur + voiceoverDur, and this
    // deduction kept the encoder's `-t totalDur` flag from clipping the last
    // 0.3s of narration. Now the voiceover is adelay'd to start EXACTLY at
    // intro end (no overlap), so combined audio == introDur + voiceoverDur and
    // total video == introDurationActual + sum(mergedDurations) with NO
    // deduction. The overlap constant is therefore 0 — padding
    // totalVideoDurationSeconds to the full intro + voiceover length is correct
    // and does NOT re-introduce the narration-clipping bug (there's nothing to
    // subtract anymore).
    const INTRO_ACROSSFADE_SECONDS = 0;
    const introAudioOverlap = introAudioPath && introDurationActual > 0
      ? INTRO_ACROSSFADE_SECONDS
      : 0;
    // The rendered-slot sum is the WRONG target for a synthetic render. Every
    // avatar/ai_clip/split_2 slot lands a few ms off its planned narration
    // window (25fps HeyGen source, computed xfade durations, frame quantization
    // on `-c:v copy`); those residuals are same-signed enough to accumulate, so
    // sum(mergedDurations) drifts from the true voiceover by hundreds of ms
    // (measured +567ms on an 1668s render). Because the concat apad's the
    // voiceover UP to totalVideoDurationSeconds and pins the file with `-t`, a
    // slot-sum target STRETCHES the video timeline the audio is laid onto — the
    // narration then trails its visuals progressively, worst at the end (the
    // accumulating avatar lip-sync drift). The authoritative length is the
    // voiceover itself: it's one continuous track the lips must follow, and the
    // planner already sizes the timeline to it. So for a synthetic render we
    // target the PROBED voiceover duration (+intro prefix, +pitch/own-audio
    // blocks that add timeline time without adding voiceover time), and let the
    // final-length pin below hold the assembled video's last frame up to that
    // exact length — the interior slot residual is absorbed once, on the silent
    // outro, instead of inflating the whole grid. Sourced (celebrity) renders
    // keep the legacy slot-sum target: their footage path is already length-
    // pinned and this reconciliation is specific to the synthetic drift.
    const slotSumSeconds =
      introDurationActual
      + mergedDurations.reduce((a, b) => a + b, 0)
      - introAudioOverlap;
    let totalVideoDurationSeconds = slotSumSeconds;
    if (isSyntheticRender && voiceoverLocal) {
      try {
        const voProbe = await probeFile(voiceoverLocal);
        const voDur = voProbe.durationSeconds;
        if (voDur > 0) {
          // Pitch blocks play their OWN audio and pause the narration, so they
          // add timeline length without adding voiceover length — count their
          // rendered slot durations into the target. (Same set the forced-audio
          // splice below keys on: a pitch_video block with a video_url. The
          // mid-timeline forced-footage case is gated off, so pitch is the only
          // own-audio block today; kept explicit so it tracks isOwnAudioBlock.)
          let ownAudioSeconds = 0;
          for (let i = 0; i < renderable.length; i++) {
            const it = renderable[i];
            if (it?.type === "pitch_video" && it.video_url && slotDurations[i] > 0) {
              ownAudioSeconds += slotDurations[i];
            }
          }
          const reconciled = voDur + introDurationActual - introAudioOverlap + ownAudioSeconds;
          await logJob({ projectId, jobId: mediaJobId }, "render.total_duration.reconciled", {
            slotSumSeconds: Math.round(slotSumSeconds * 1000) / 1000,
            voiceoverSeconds: Math.round(voDur * 1000) / 1000,
            introSeconds: Math.round(introDurationActual * 1000) / 1000,
            ownAudioSeconds: Math.round(ownAudioSeconds * 1000) / 1000,
            reconciledSeconds: Math.round(reconciled * 1000) / 1000,
            slotResidualMs: Math.round((slotSumSeconds - reconciled) * 1000),
            note: "targeting true voiceover length; interior slot residual absorbed by final-length pin",
          });
          totalVideoDurationSeconds = reconciled;
        }
      } catch (e) {
        // Probe failure → keep the slot-sum target (legacy behavior). Best
        // effort: a drift-corrected target is an improvement, not a hard
        // dependency of a shippable render.
        await logJob({ projectId, jobId: mediaJobId }, "render.total_duration.reconcile_failed", { err: (e as Error).message });
      }
    }
    let outroFadeStartSeconds = 0;
    if (lastSegDur > OUTRO_FADE_SECONDS) {
      const fadedLast = path.join(tmp, "outro_fade.mp4");
      try {
        await applyEdgeFade({
          vcodecArgs: vcodec,
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

    // Forced-clip audio splice.
    //
    // Per client direction: when a forced doc clip plays, the narrator
    // (voiceover) pauses; the clip plays with its OWN audio; then the
    // narrator resumes from where it stopped. Implementation:
    //
    //   1. Walk renderable[] computing each item's video-timeline position.
    //   2. For every forced-clip-with-audio row, the voiceover should pause
    //      at the position where the clip starts (in the voiceover, that's
    //      the sum of NON-forced item durations preceding the clip).
    //   3. Cut the voiceover into chunks at every forced-clip boundary,
    //      extract each forced clip's audio, then concat:
    //         [vo[0..pos1]] + [clip1_audio] + [vo[pos1..pos2]] + [clip2_audio] + ...
    //
    // When no forced clips carry their own audio, this whole pass is a
    // no-op and the original voiceover path goes through unchanged.
    let voiceoverForConcat = voiceoverLocal;
    // A timeline segment carries its OWN audio (and pauses the narration over
    // it) in two cases: a mid-timeline forced doc clip (currently disabled via
    // MID_TIMELINE_FORCED_CLIP_AUDIO_ENABLED) OR a sales-pitch video block
    // (always on — that's the whole point of the pitch insertion). The splice
    // pass below handles both; it runs whenever at least one such block exists.
    const isOwnAudioBlock = (it: { type?: string; metadata?: unknown; video_url?: string | null }): boolean => {
      if (it.type === "pitch_video" && it.video_url) return true;
      if (MID_TIMELINE_FORCED_CLIP_AUDIO_ENABLED && it.type === "footage") {
        const meta = (it.metadata ?? {}) as Record<string, unknown>;
        const fc = meta.forced_clip as { youtube_url?: string } | undefined;
        if (fc?.youtube_url) return true;
      }
      return false;
    };
    const hasOwnAudioBlocks = renderable.some((it) => isOwnAudioBlock(it as { type?: string; metadata?: unknown; video_url?: string | null }));
    if (voiceoverLocal && hasOwnAudioBlocks) {
      type ForcedAudio = {
        timelinePos: number;     // start time within the video timeline
        videoDuration: number;   // own-audio clip's actual rendered duration
        voPos: number;           // start time within the voiceover (excludes prior own-audio clips)
        slotPath: string;        // rendered MP4 slot containing audio
      };
      const forcedAudioItems: ForcedAudio[] = [];
      let tlPos = 0;
      let voPos = 0;
      for (let i = 0; i < renderable.length; i++) {
        const it = renderable[i];
        const slotDur = slotDurations[i] ?? Number(it.duration ?? 0);
        const slotPath = slots[i];
        if (isOwnAudioBlock(it as { type?: string; metadata?: unknown; video_url?: string | null }) && slotPath) {
          forcedAudioItems.push({
            timelinePos: tlPos,
            videoDuration: slotDur,
            voPos,
            slotPath,
          });
          // Forced clip consumes timeline time but NOT voiceover time —
          // voPos doesn't advance, so the next vo chunk picks up where
          // the narrator was when the clip started.
        } else {
          voPos += slotDur;
        }
        tlPos += slotDur;
      }
      if (forcedAudioItems.length > 0) {
        await logJob({ projectId, jobId: mediaJobId },
          "render.forced_audio_splice.start", {
            clips: forcedAudioItems.length,
            originalVoiceoverPath: voiceoverLocal,
          });
        try {
          // Probe the voiceover for its real duration — we may need to
          // clamp the final vo-cut at its end.
          let voiceoverTotal = 0;
          try {
            const probed = await probeFile(voiceoverLocal);
            voiceoverTotal = probed.durationSeconds;
          } catch { voiceoverTotal = voPos; /* approximate fallback */ }

          // Build the splice plan: [vo_chunk_0, clip0_audio, vo_chunk_1, clip1_audio, ...].
          const chunkPaths: string[] = [];
          let voCursor = 0;
          for (let n = 0; n < forcedAudioItems.length; n++) {
            const fa = forcedAudioItems[n];
            const chunkDur = Math.max(0, fa.voPos - voCursor);
            if (chunkDur > 0.02) {
              const voChunkPath = path.join(tmp, `vo_chunk_${n}.m4a`);
              await cutAudio({
                inputPath: voiceoverLocal,
                outputPath: voChunkPath,
                startSeconds: voCursor,
                durationSeconds: chunkDur,
              });
              chunkPaths.push(voChunkPath);
            }
            voCursor = fa.voPos;
            // Extract this clip's audio. If extraction fails (clip had no
            // audio track or yt-dlp grabbed a video-only stream), fall
            // back to silence of the same length so the timeline stays
            // aligned. We never abort the render on splice failure —
            // worst case the viewer hears silence under the clip.
            const clipAudioPath = path.join(tmp, `forced_audio_${n}.m4a`);
            try {
              await extractAudio({
                inputPath: fa.slotPath,
                outputPath: clipAudioPath,
              });
            } catch (e) {
              await logJob({ projectId, jobId: mediaJobId },
                "render.forced_audio_splice.extract_failed", {
                  index: n, err: (e as Error).message?.slice(0, 200),
                });
              await buildSilentAudio({
                outputPath: clipAudioPath,
                durationSeconds: fa.videoDuration,
              });
            }
            chunkPaths.push(clipAudioPath);
          }
          // Tail chunk — voiceover from the last splice point to its end.
          const tailDur = Math.max(0, voiceoverTotal - voCursor);
          if (tailDur > 0.02) {
            const tailPath = path.join(tmp, `vo_chunk_tail.m4a`);
            await cutAudio({
              inputPath: voiceoverLocal,
              outputPath: tailPath,
              startSeconds: voCursor,
              durationSeconds: tailDur,
            });
            chunkPaths.push(tailPath);
          }
          if (chunkPaths.length > 0) {
            const splicedPath = path.join(tmp, "voiceover_spliced.m4a");
            await concatAudioFiles({
              inputPaths: chunkPaths,
              outputPath: splicedPath,
            });
            voiceoverForConcat = splicedPath;
            await logJob({ projectId, jobId: mediaJobId },
              "render.forced_audio_splice.done", {
                clips: forcedAudioItems.length,
                chunks: chunkPaths.length,
                splicedPath,
              });
          }
        } catch (e) {
          // Splice failure shouldn't kill the render — fall back to the
          // unspliced voiceover. The forced clips will then play silent
          // and the narrator will overlap them, which is wrong but
          // shippable.
          await logJob({ projectId, jobId: mediaJobId },
            "render.forced_audio_splice.failed", {
              err: (e as Error).message?.slice(0, 200),
            });
        }
      }
    }

    // The final concat is the single longest ffmpeg pass in the whole render
    // (it RE-ENCODES every segment + mixes voiceover/music/SFX over the full
    // timeline — can run 10-20 min on a long video). Heartbeat both before AND
    // DURING the pass: onProgress fires on every ffmpeg status line, throttled
    // to ~20s, so the stall sweeper never mistakes an actively-encoding job for
    // a dead one no matter how long the encode takes.
    await touchMediaJob(mediaJobId);
    let lastConcatHeartbeat = 0;
    const concatHeartbeat = () => {
      const now = Date.now();
      if (now - lastConcatHeartbeat < 20_000) return;
      lastConcatHeartbeat = now;
      void touchMediaJob(mediaJobId);
    };
    // DIAGNOSTIC (avatar lip-sync hunt, 2026-07-17). Probe every clip in CONCAT
    // ORDER and log the true cumulative video position of each avatar.
    //
    // This is the ground truth nothing has ever measured. Every "correct" finding
    // so far came from the PLAN (timeline_items.duration and its running sum) or
    // from post-hoc probes of the finished mp4 — never from the actual list of
    // files being concatenated. Video position in the final file is the running sum
    // of these probed durations; audio position is the master voiceover, laid down
    // continuously and independently. Those agree only if every clip is exactly the
    // length the plan assumed, and render.timeline.audit already reports 233/250
    // blocks off by up to ±37ms. If an avatar's true concat position differs from
    // its voiceover window, that difference IS the lip-sync error, and this log
    // states it directly instead of leaving it to be reconstructed.
    //
    // `normalized[]` may carry prepended intro/title cards that are not timeline
    // blocks, so positions are reported by concat index with the offset spelled out
    // rather than assumed to line up with `renderable[]`.
    try {
      const extraLead = normalized.length - renderable.length;
      let cum = 0;
      const avatarPositions: Array<Record<string, unknown>> = [];
      let probeFailures = 0;
      for (let n = 0; n < normalized.length; n++) {
        let dur = 0;
        try {
          const p = await probeFile(normalized[n]);
          dur = p.durationSeconds > 0 ? p.durationSeconds : 0;
        } catch { probeFailures++; }
        const blockIdx = n - extraLead; // index into renderable[], negative = intro/card
        const it = blockIdx >= 0 ? renderable[blockIdx] : null;
        if (it?.type === "avatar") {
          const seg = it.synthetic_segment_id
            ? (await sb.from("synthetic_segments").select("start_time, end_time")
                .eq("id", it.synthetic_segment_id as string).maybeSingle()).data
            : null;
          const voStart = seg?.start_time != null ? Number(seg.start_time) : null;
          avatarPositions.push({
            concatIndex: n,
            blockIndex: blockIdx,
            videoStartSeconds: Math.round(cum * 1000) / 1000,
            voStartSeconds: voStart,
            // THE number: where the avatar's video begins vs where its words begin.
            // Negative = video early (lips lead); positive = video late (lips lag).
            videoMinusVoMs: voStart != null ? Math.round((cum - voStart) * 1000) : null,
            clipSeconds: Math.round(dur * 1000) / 1000,
            plannedSeconds: Math.round((plannedDurations[blockIdx] ?? 0) * 1000) / 1000,
            heygenPath: /_api_/.test(String(it.video_url ?? "")) ? "api_fallback" : "browser",
          });
        }
        cum += dur;
      }
      await logJob({ projectId, jobId: mediaJobId }, "render.concat.timeline", {
        concatInputs: normalized.length,
        renderableBlocks: renderable.length,
        introOrCardLead: extraLead,
        probeFailures,
        totalVideoSeconds: Math.round(cum * 1000) / 1000,
        voiceoverSeconds: Math.round((totalVideoDurationSeconds ?? 0) * 1000) / 1000,
        avatars: avatarPositions,
        note: "videoMinusVoMs is the lip-sync error at each avatar: negative = lips lead, positive = lips lag",
      });
    } catch (e) {
      await logJob({ projectId, jobId: mediaJobId }, "render.concat.timeline.failed",
        { err: (e as Error).message });
    }

    const concatStageStart = Date.now();
    await concatNormalizedClips({
      onProgress: concatHeartbeat,
      inputPaths: normalized,
      outputPath: finalLocal,
      voiceoverPath: voiceoverForConcat,
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
    stageTimings.concat_audio_ms = Date.now() - concatStageStart;
    await setMediaJob(mediaJobId, { progress: 85 });
    await sb.from("render_jobs").update({ progress: 85 }).eq("id", renderJobId);

    // 4a-pre-pin) Final total-length pin (synthetic). The concat does -c:v copy,
    // so the VIDEO length is just the sum of the concatenated segment frames; it
    // gets no -t. Each segment is a whole number of frames, so any block whose
    // planned duration falls between frame boundaries lands up to ~1 frame
    // (~16ms) short. tpad in the per-block pad-up can't fix sub-frame shortfalls
    // (it can only add WHOLE cloned frames past a >1-frame gap), so on a 303-block
    // avatar render ~59 blocks each ~9-33ms short summed to -510ms of video drift
    // and the final file came back -758ms under the voiceover (post_validation
    // passed:false) even after the per-block 0.034s threshold fix. Below the
    // audio, the concat's `-t`/apad pins the audio to the SHORT video length and
    // the narration tail is clipped, so every avatar part's lips finish ahead of
    // its words.
    //
    // The fix is to absorb the residual once, here: hold the assembled video's
    // last frame up to totalVideoDurationSeconds — the exact length the concat
    // already pinned the AUDIO to (intro + all merged slots + own-audio blocks).
    // Video and audio then match to the millisecond regardless of per-block
    // frame quantization. The held frame lands on the outro (sub-second, silent),
    // so it's invisible. Best-effort: on any failure we keep the un-pinned
    // finalLocal rather than block the render. PERFORMANCE_MODE included — this is
    // a correctness pin, not an effect.
    if (isSyntheticRender && totalVideoDurationSeconds > 0) {
      try {
        const concatProbe = await probeFile(finalLocal);
        const videoLen = concatProbe.durationSeconds;
        const shortfall = totalVideoDurationSeconds - videoLen;
        // Only pad a real shortfall past one frame; never trim (the audio is
        // already pinned to totalVideoDurationSeconds, so a fractionally-long
        // video is harmless and trimming risks cutting a real last frame).
        if (videoLen > 0 && shortfall > 0.034) {
          const pinnedLocal = path.join(tmp, `final_pinned_${projectId}.mp4`);
          await padVideoToLength({
            inputPath: finalLocal,
            outputPath: pinnedLocal,
            targetSeconds: totalVideoDurationSeconds,
            fps: 30,
            vcodecArgs: vcodec,
          });
          await safeUnlink(finalLocal);
          finalLocal = pinnedLocal;
          await logJob({ projectId, jobId: mediaJobId }, "render.final_length_pin", {
            concatVideoSeconds: Math.round(videoLen * 1000) / 1000,
            targetSeconds: Math.round(totalVideoDurationSeconds * 1000) / 1000,
            shortfallMs: Math.round(shortfall * 1000),
            note: "held last frame to match audio length; absorbs residual per-block frame-quantization drift",
          });
        } else {
          await logJob({ projectId, jobId: mediaJobId }, "render.final_length_pin.skipped", {
            concatVideoSeconds: Math.round(videoLen * 1000) / 1000,
            targetSeconds: Math.round(totalVideoDurationSeconds * 1000) / 1000,
            shortfallMs: Math.round(shortfall * 1000),
            note: shortfall <= 0.034 ? "within one frame; no pin needed" : "video not shorter than target",
          });
        }
      } catch (e) {
        await logJob({ projectId, jobId: mediaJobId },
          "render.final_length_pin.failed", { err: (e as Error).message });
      }
    }

    // 4a-pre0) Low-fi "vlogging" video degrade (best-effort, synthetic only).
    // One re-encode pass over the finished video that lowers TEXTURE quality
    // (grain + slight softness + stronger compression) so the footage reads as
    // a real phone vlog, not a clean AI render. Dimensions are UNCHANGED — the
    // client still wants 1080p; we degrade quality at full size. Runs BEFORE the
    // effect overlay so the overlay composites onto the degraded base. Like the
    // overlay it is polish, never a render-blocker: on any failure we keep the
    // un-degraded finalLocal. PERFORMANCE_MODE skips it (zero post-effects path).
    const degradeEnabled = isSyntheticRender && env.SYNTHETIC_DEGRADE_ENABLED && !performanceMode;
    if (degradeEnabled) {
      const degradeStart = Date.now();
      const degradedLocal = path.join(tmp, `degraded_${projectId}.mp4`);
      try {
        await touchMediaJob(mediaJobId);
        await degradeVideoLowFi({
          inputPath: finalLocal,
          outputPath: degradedLocal,
          width: outW,
          height: outH,
          fps: 30,
          onProgress: () => void touchMediaJob(mediaJobId),
        });
        await safeUnlink(finalLocal);
        finalLocal = degradedLocal;
        await logJob({ projectId, jobId: mediaJobId }, "render.degrade.done", {
          blurSigma: env.SYNTHETIC_DEGRADE_BLUR_SIGMA,
          videoNoise: env.SYNTHETIC_DEGRADE_VIDEO_NOISE,
          crfDelta: env.SYNTHETIC_DEGRADE_VIDEO_CRF_DELTA,
          ms: Date.now() - degradeStart,
        });
      } catch (e) {
        await safeUnlink(degradedLocal);
        await logJob({ projectId, jobId: mediaJobId }, "render.degrade.failed", {
          err: (e as Error).message,
        });
      }
    }

    // 4a-pre) Global effect overlay (best-effort). Screen-blend the configured
    // particle/dust effect over the ENTIRE finished video — intro, opening
    // title, and all body content — as a one-shot post-pass. We overlay
    // finalLocal into a new file then point finalLocal at it, so the probe,
    // post-validation, and upload below operate on the overlaid file with no
    // further changes. On any failure (toggle off, missing asset, ffmpeg
    // error) we keep the un-overlaid finalLocal and ship that — the effect is
    // polish, never a render-blocker.
    //
    // EFFECT_OVERLAY_PATH is resolved two ways so a single global asset can be
    // hosted whichever way the deploy prefers:
    //   • an http(s) URL — downloaded into tmp once per render (e.g. an R2
    //     object alongside the project's other media), or
    //   • a local path — baked into the worker image at build time
    //     (./assets/... → /app/assets/... under the Dockerfile's WORKDIR).
    // The downloaded copy lives in tmp and is reaped by the finally-block
    // cleanup like every other render artifact.
    // PERFORMANCE_MODE force-skips the overlay regardless of its own toggle —
    // it's a full-video re-encode pass and the avatar performance pipeline wants
    // zero post-processing effects. In normal mode the EFFECT_OVERLAY_ENABLED
    // flag governs it as before.
    const overlayStageStart = Date.now();
    const overlayEnabled = env.EFFECT_OVERLAY_ENABLED && !performanceMode;
    if (performanceMode && env.EFFECT_OVERLAY_ENABLED) {
      await logJob({ projectId, jobId: mediaJobId }, "render.effect_overlay.skipped", {
        performanceMode: true,
        note: "global overlay disabled by PERFORMANCE_MODE",
      });
    }
    if (overlayEnabled) {
      const effectSource = env.EFFECT_OVERLAY_PATH;
      const isRemote = /^https?:\/\//i.test(effectSource);
      let effectLocalPath: string | null = null;
      let downloadedEffect = false;
      if (isRemote) {
        const dest = path.join(tmp, "effect_overlay.mp4");
        try {
          await touchMediaJob(mediaJobId);
          await downloadHttp(effectSource, dest);
          effectLocalPath = dest;
          downloadedEffect = true;
        } catch (e) {
          await logJob({ projectId, jobId: mediaJobId },
            "render.effect_overlay.download_failed",
            { effectSource, err: (e as Error).message });
        }
      } else {
        try {
          await fs.access(effectSource);
          effectLocalPath = effectSource;
        } catch {
          await logJob({ projectId, jobId: mediaJobId },
            "render.effect_overlay.missing", { effectSource });
        }
      }
      if (effectLocalPath) {
        const overlaidLocal = path.join(tmp, `final_fx_${projectId}.mp4`);
        try {
          await touchMediaJob(mediaJobId);
          await overlayEffectVideo({
            inputPath: finalLocal,
            effectPath: effectLocalPath,
            outputPath: overlaidLocal,
            width: outW, height: outH, fps: 30,
            opacity: env.EFFECT_OVERLAY_OPACITY,
            gain: env.EFFECT_OVERLAY_GAIN,
          });
          await safeUnlink(finalLocal);
          finalLocal = overlaidLocal;
          await logJob({ projectId, jobId: mediaJobId },
            "render.effect_overlay.done", {
              effectSource,
              opacity: env.EFFECT_OVERLAY_OPACITY,
              gain: env.EFFECT_OVERLAY_GAIN,
            });
        } catch (e) {
          // Keep the un-overlaid finalLocal. Clean up the partial output.
          await safeUnlink(overlaidLocal);
          await logJob({ projectId, jobId: mediaJobId },
            "render.effect_overlay.failed", {
              effectSource, err: (e as Error).message,
            });
        } finally {
          // Reap the downloaded effect copy now (the tmp sweep would too, but
          // this keeps peak disk lower during the upload that follows).
          if (downloadedEffect && effectLocalPath) await safeUnlink(effectLocalPath);
        }
      }
    }
    stageTimings.overlay_ms = Date.now() - overlayStageStart;

    // Per-stage timing summary — the single line to read when comparing a
    // PERFORMANCE_MODE render against a normal one. render_clips and
    // concat_audio run in both modes; merge_transitions and overlay collapse to
    // near-zero when PERFORMANCE_MODE is on (no transition/overlay encodes).
    await logJob({ projectId, jobId: mediaJobId }, "render.stage_timings", {
      performanceMode,
      overlayEnabled,
      renderClipsMs: stageTimings.render_clips_ms ?? null,
      mergeTransitionsMs: stageTimings.merge_transitions_ms ?? null,
      concatAudioMs: stageTimings.concat_audio_ms ?? null,
      overlayMs: stageTimings.overlay_ms ?? null,
      transitionsSkipped,
    });

    // 4a) Per-block drift audit. Emit one log line per renderable item with
    // the four numbers needed to diagnose any future sync regression:
    //   • vo_start / vo_end   — the narrator's real audio window
    //   • planned_duration    — what the matcher wrote to timeline_items
    //   • rendered_duration   — content_dur measured after ffmpeg ran
    //   • drift_ms            — rendered − planned (positive = visual
    //                            stayed too long, negative = ended early)
    //
    // Lives BEFORE the writeback so the planned column reflects what the
    // editor was showing the user at render time, not the writeback value.
    // Capped at the first 20 rows + worst 10 drifters to keep the log
    // payload bounded on 300+ scene projects.
    try {
      type DriftRow = {
        block_index: number;
        type: string | null;
        vo_start_seconds: number | null;
        vo_end_seconds: number | null;
        vo_duration: number | null;
        planned_duration: number;
        rendered_duration: number;
        drift_ms: number;
      };
      const driftRows: DriftRow[] = [];
      let maxDriftMs = 0;
      let totalDriftMs = 0;
      let nonZeroDrifts = 0;
      for (let i = 0; i < renderable.length; i++) {
        const it = renderable[i];
        if (it.type === "intro") continue;
        const meta = (it.metadata ?? {}) as Record<string, unknown>;
        const voStart = (meta.vo_start_seconds as number | null | undefined) ?? null;
        const voEnd = (meta.vo_end_seconds as number | null | undefined) ?? null;
        const planned = Number(it.duration ?? 0);
        const rendered = slotContentDurations[i] || 0;
        const driftMs = Math.round((rendered - planned) * 1000);
        const row: DriftRow = {
          block_index: i,
          type: (it.type as string | null) ?? null,
          vo_start_seconds: voStart,
          vo_end_seconds: voEnd,
          vo_duration: voStart != null && voEnd != null ? Math.round((voEnd - voStart) * 1000) / 1000 : null,
          planned_duration: Math.round(planned * 1000) / 1000,
          rendered_duration: Math.round(rendered * 1000) / 1000,
          drift_ms: driftMs,
        };
        driftRows.push(row);
        const absDrift = Math.abs(driftMs);
        if (absDrift > 0) nonZeroDrifts++;
        totalDriftMs += driftMs;
        if (absDrift > Math.abs(maxDriftMs)) maxDriftMs = driftMs;
      }
      // Sample = first 20 (head of timeline) + the 10 worst drifters
      // sorted by abs(drift). De-dupe in case the head overlaps the worst.
      const head = driftRows.slice(0, 20);
      const worst = [...driftRows]
        .sort((a, b) => Math.abs(b.drift_ms) - Math.abs(a.drift_ms))
        .slice(0, 10);
      const sampleByIdx = new Map<number, DriftRow>();
      for (const r of head) sampleByIdx.set(r.block_index, r);
      for (const r of worst) sampleByIdx.set(r.block_index, r);
      await logJob({ projectId, jobId: mediaJobId }, "render.timeline.audit", {
        total_blocks: driftRows.length,
        non_zero_drifts: nonZeroDrifts,
        total_drift_ms: totalDriftMs,
        max_drift_ms: maxDriftMs,
        sample: Array.from(sampleByIdx.values()).sort((a, b) => a.block_index - b.block_index),
      });
    } catch (e) {
      await logJob({ projectId, jobId: mediaJobId },
        "render.timeline.audit.failed", { err: (e as Error).message });
    }

    // 4b) Writeback truth-of-render durations to timeline_items.
    //
    // Until now the editor read `timeline_items.duration` as written by the
    // matcher (the planned/sentence duration). When a clip was shorter than
    // its sentence the matcher CLAMPED that field down, but with slow-mo
    // now filling small gaps and reclaim absorbing the rest, the editor's
    // value drifts from what was actually rendered for non-clamped cases.
    //
    // Update each row to the content-duration we measured during render
    // (slotContentDurations[i]). This is the visible scene length — the
    // amount of voiceover that plays under this row — so the editor's
    // running total now matches both the audio and the final MP4 exactly.
    //
    // We skip the writeback for intro rows (ui_only, the renderer ignores
    // their duration field at concat time) and for slots that failed to
    // render (slotContentDurations[i] === 0, the row will be a hole).
    try {
      // Build audio-interval map: each non-intro row's duration MUST be at
      // least next.vo_start - cur.vo_start, otherwise the next row's audio
      // begins before this row's visual ends → gap in the final video. The
      // writeback below must never shrink a row below its audio interval.
      const voStarts: Array<{ idx: number; voStart: number }> = [];
      for (let i = 0; i < renderable.length; i++) {
        const it = renderable[i];
        if (it.type === "intro") continue;
        const meta = (it.metadata ?? {}) as Record<string, unknown>;
        // Sourced engine stamps the narration start in metadata.vo_start_seconds.
        // Synthetic engine has no such metadata — its narration start IS the
        // row's `start_time` column (the planner aligned every block to the
        // master voiceover). Without this fallback, synthetic rows had NO audio
        // interval, so the writeback below fell through to the SHORT rendered
        // length and overwrote the planned duration — e.g. a 25.2s avatar slot
        // whose HeyGen clip returned 10.2s got its row clobbered to 10.2s,
        // permanently desyncing the timeline and clipping the voiceover tail on
        // every later render. Using start_time keeps the writeback anchored to
        // the planned narration window, so it stays idempotent for synthetic
        // projects too.
        const vs = typeof meta.vo_start_seconds === "number"
          ? (meta.vo_start_seconds as number)
          : (typeof it.start_time === "number" ? it.start_time : null);
        if (vs == null) continue;
        voStarts.push({ idx: i, voStart: Number(vs) });
      }
      voStarts.sort((a, b) => a.voStart - b.voStart);
      const audioIntervalByIdx = new Map<number, number>();
      for (let k = 0; k < voStarts.length - 1; k++) {
        const cur = voStarts[k];
        const next = voStarts[k + 1];
        audioIntervalByIdx.set(cur.idx, Math.max(0.1, next.voStart - cur.voStart));
      }
      // Last row: no next vo_start to anchor against. Skip the floor for it
      // (the writeback will use contentDur as before). The tail row's
      // duration mismatch is a different bug surface — pre_render_validation
      // catches gross overshoot/undershoot there.

      const writebackPromises: Promise<unknown>[] = [];
      for (let i = 0; i < renderable.length; i++) {
        const it = renderable[i];
        if (it.type === "intro") continue;
        // Title cards keep their typewriter + HOLD_TAIL duration, which is
        // intentionally LONGER than their audio interval (the trailing hold
        // is a visual beat so the viewer can read the fully-typed card, not
        // narration time). The matchProcessor vo-start-driven pass skips
        // title cards for exactly this reason — the writeback must too, or it
        // would shrink every card to its spoken span and drop the read beat.
        // Their duration is already correct from match; leave it untouched.
        if (it.type === "title_card") continue;
        // Skip duration_clamped rows — forced doc clips (the YouTube window
        // the author chose) and the title-card padding rows. The
        // matchProcessor vo-start pass already sized these to their correct
        // value; overwriting them here with the naive next-vo_start delta is
        // WRONG because forced clips stacked under one title card can share
        // (or near-share) a vo_start, making the sorted-delta interval ~0,
        // which Math.max floors to 0.1s — collapsing ~seconds of forced-clip
        // video to nothing and pulling everything after it earlier (the
        // negative-drift jump at stacked-clip sections). Leave clamped rows
        // exactly as match wrote them.
        const itMeta = (it.metadata ?? {}) as Record<string, unknown>;
        if (itMeta.duration_clamped === true) continue;
        const contentDur = slotContentDurations[i];
        if (!(contentDur > 0)) continue;
        // The audio interval (next.vo_start − cur.vo_start) IS the narration
        // window this row covers, and it is the source of truth for the row's
        // duration in BOTH directions:
        //   • Too SHORT (slow-mo capped, source clip too short) → writing the
        //     short rendered length would end the visual before the next
        //     sentence starts, leaving audio-without-picture gaps (the 24→25
        //     mismatch bug, 2026-06-01). The freeze-hold pass in cutClip now
        //     pads the PICTURE to fill the slot, so the row's duration must
        //     stay at the audio interval.
        //   • Too LONG (slow-mo / xfade headroom made the rendered clip run
        //     past its narration window) → the PREVIOUS code took
        //     max(contentDur, audioInterval), which let the inflated rendered
        //     length win. Persisted back to timeline_items, that pushed every
        //     later row — including title cards and lower-thirds — later than
        //     its spoken moment, and because each re-render read the inflated
        //     value and inflated it AGAIN, the drift ratcheted up every render
        //     (the cumulative 9–10s "card appears late" bug). Writing the
        //     audio interval makes each row exactly its narration window, so
        //     cumulative video-time == voiceover-time at every anchor and the
        //     writeback is IDEMPOTENT (a re-render writes the same values, no
        //     compounding).
        // When no audio interval is known (last row, or row missing vo_start)
        // there's no narration window to anchor against — fall back to the
        // rendered content duration as before.
        const audioInterval = audioIntervalByIdx.get(i);
        const safeDur = audioInterval != null ? audioInterval : contentDur;
        // Only write when the value materially differs (>0.05s) to avoid
        // a no-op UPDATE storm on projects where the render exactly matched
        // the plan. id and project_id come from the row we loaded above.
        const currentDur = Number(it.duration ?? 0);
        if (Math.abs(currentDur - safeDur) < 0.05) continue;
        writebackPromises.push(
          (async () =>
            sb.from("timeline_items")
              .update({ duration: Math.round(safeDur * 100) / 100 })
              .eq("id", it.id as string)
          )(),
        );
      }
      if (writebackPromises.length > 0) {
        await Promise.all(writebackPromises);
        await logJob({ projectId, jobId: mediaJobId },
          "render.duration_writeback", {
            updated: writebackPromises.length,
            total: renderable.length,
          });
      }
    } catch (e) {
      // Writeback failure should not fail the render — the MP4 is already
      // produced. Just log so we can audit drift between editor and
      // rendered duration on this project.
      await logJob({ projectId, jobId: mediaJobId },
        "render.duration_writeback.failed", { err: (e as Error).message });
    }

    // 4c) Post-render duration validation. Probe the final MP4 and compare
    // its length against the voiceover length. With the intro acrossfade
    // fix and reclaim-always-on, this should be within 250ms — anything
    // larger means the pipeline regressed and renders are drifting again.
    try {
      const POST_RENDER_TOLERANCE_MS = 250;
      let finalDurationSeconds: number | null = null;
      let voiceoverDurationSeconds: number | null = null;
      try {
        const finalProbe = await probeFile(finalLocal);
        if (finalProbe.durationSeconds > 0) finalDurationSeconds = finalProbe.durationSeconds;
      } catch { /* finalProbe failure → log as null */ }
      if (voiceoverLocal) {
        try {
          const voProbe = await probeFile(voiceoverLocal);
          if (voProbe.durationSeconds > 0) voiceoverDurationSeconds = voProbe.durationSeconds;
        } catch { /* voProbe failure → log as null */ }
      }
      // Pitch video (migration 0025) is a non-voiceover block: the narration
      // pauses over it and it keeps its own audio, so it ADDS its full slot
      // length to the final file without adding anything to the voiceover.
      // Without this term the validator reads the pitch duration as drift and
      // fails a render that is actually perfectly in sync (e.g. 2026-06-30:
      // driftMs 27408 == the 27.8s pitch block). Sum the rendered slot length
      // of every pitch block — they never merge into a neighbor, so the slot
      // duration equals their contribution to the timeline.
      let pitchVideoSeconds = 0;
      for (let i = 0; i < renderable.length; i++) {
        if (renderable[i]?.type === "pitch_video" && slotDurations[i] > 0) {
          pitchVideoSeconds += slotDurations[i];
        }
      }
      // Expected final length = voiceover + intro − intro acrossfade overlap
      // + pitch video. The intro is a prefix and the pitch is a mid-timeline
      // insert; neither sits under the voiceover, so both ADD to the total.
      const expectedFinalSeconds = voiceoverDurationSeconds != null
        ? voiceoverDurationSeconds + introDurationActual - introAudioOverlap + pitchVideoSeconds
        : null;
      const driftMs = finalDurationSeconds != null && expectedFinalSeconds != null
        ? Math.round((finalDurationSeconds - expectedFinalSeconds) * 1000)
        : null;
      await logJob({ projectId, jobId: mediaJobId }, "render.post_validation", {
        finalDurationSeconds: finalDurationSeconds != null ? Math.round(finalDurationSeconds * 1000) / 1000 : null,
        voiceoverDurationSeconds: voiceoverDurationSeconds != null ? Math.round(voiceoverDurationSeconds * 1000) / 1000 : null,
        introDurationActual: Math.round(introDurationActual * 1000) / 1000,
        introAudioOverlap,
        pitchVideoSeconds: Math.round(pitchVideoSeconds * 1000) / 1000,
        expectedFinalSeconds: expectedFinalSeconds != null ? Math.round(expectedFinalSeconds * 1000) / 1000 : null,
        driftMs,
        toleranceMs: POST_RENDER_TOLERANCE_MS,
        passed: driftMs != null ? Math.abs(driftMs) <= POST_RENDER_TOLERANCE_MS : null,
      });
    } catch (e) {
      await logJob({ projectId, jobId: mediaJobId },
        "render.post_validation.failed", { err: (e as Error).message });
    }

    // 4d) SILENT-RENDER SAFEGUARD (client report 2026-07-30: ≥5 "completed"
    // videos with no voice). The duration-only validation above passes a silent
    // video — a voiceless MP4 is the exact right LENGTH — which is how voiceless
    // renders shipped as completed. `voiceoverLocal` is set only when the project
    // had a voiceover_url that downloaded AND probed as real audio, so its
    // presence means "narration was expected". Probe the FINAL mp4 for an audio
    // stream; if we expected narration but the file came back with no audio,
    // abort BEFORE upload so the render fails + retries instead of publishing a
    // voiceless video. Deliberately OUTSIDE the post_validation try/catch above
    // (that catch swallows) so the throw reaches the render's outer catch. Cheap
    // whole-file probe; last line of defense past every upstream best-effort catch.
    if (voiceoverLocal) {
      let finalHasAudio: boolean | null = null;
      try {
        const audioProbe = await probeFile(finalLocal);
        finalHasAudio = audioProbe.hasAudio;
      } catch (e) {
        await logJob({ projectId, jobId: mediaJobId }, "render.silent_check.probe_failed",
          { err: (e as Error).message });
      }
      if (finalHasAudio === false) {
        await logJob({ projectId, jobId: mediaJobId }, "render.silent_output.detected", {
          note: "expected narration but final MP4 has no audio stream — failing render so it retries",
        });
        throw new Error(
          "render produced a SILENT video (no audio stream) despite an expected voiceover — aborting so it retries instead of shipping voiceless.",
        );
      }
    }

    // 5) Upload final. Pushing a multi-hundred-MB mp4 to R2 can take a while on
    // a slow link — heartbeat first so the sweeper doesn't fire during upload.
    await touchMediaJob(mediaJobId);
    const dest = `projects/${projectId}/final/${Date.now()}.mp4`;
    const up = await uploadFile(finalLocal, dest, "video/mp4");

    await sb.from("render_jobs").update({
      status: "completed", progress: 100, output_url: up.publicUrl,
    }).eq("id", renderJobId);
    await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { outputUrl: up.publicUrl } });
    await setProjectStatus(projectId, "completed");
    // Render succeeded — the per-clip resume cache has served its purpose, so
    // free the disk it holds on the /data volume.
    await clearProjectCache(projectId);
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

// Render-path download error carrying enough context to decide whether a retry
// is worthwhile. `retryable` is false for permanent failures (4xx other than
// 429) so we don't burn the global render budget re-fetching a 404, and true
// for timeouts, 5xx/429, and mid-stream network drops.
class DownloadError extends Error {
  retryable: boolean;
  status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "DownloadError";
    this.retryable = retryable;
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Retrying wrapper around downloadHttpOnce. A single slow/flaky CDN response
// (e.g. media.celebforge.org stalling past the 120s timeout) previously failed
// its clip outright and stalled the whole render until the stall-sweep watchdog
// reaped it. We now make HTTP_DOWNLOAD_RETRIES extra attempts with exponential
// backoff on transient failures only; permanent 4xx failures throw immediately.
// The public signature is unchanged so all call sites benefit transparently.
async function downloadHttp(url: string, destPath: string): Promise<void> {
  const retries = getEnv().HTTP_DOWNLOAD_RETRIES;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await downloadHttpOnce(url, destPath);
      return;
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof DownloadError ? e.retryable : true;
      if (!retryable || attempt === retries) throw e;
      // Exponential backoff: 1s, 2s, 4s, ... capped at 10s. Clean up any
      // partial file the failed attempt left behind before retrying so the
      // next stream write starts from an empty destination.
      await safeUnlink(destPath);
      const backoffMs = Math.min(10_000, 1000 * 2 ** attempt);
      await sleep(backoffMs);
    }
  }
  // Unreachable — the loop either returns or throws — but satisfies the
  // type checker that lastErr is always thrown when retries are exhausted.
  throw lastErr;
}

async function downloadHttpOnce(url: string, destPath: string): Promise<void> {
  const timeoutMs = getEnv().HTTP_DOWNLOAD_TIMEOUT_SECONDS * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      // 4xx (except 429 Too Many Requests) is a permanent client error —
      // retrying a 404/403 just wastes the render budget. 5xx and 429 are
      // transient and worth another attempt.
      const retryable = r.status >= 500 || r.status === 429;
      throw new DownloadError(`download ${url}: ${r.status}`, retryable, r.status);
    }
    if (!r.body) throw new DownloadError(`download ${url}: empty body`, true);
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
    // Already-classified errors (the !r.ok / empty-body cases) pass through
    // unchanged so the wrapper sees their retryable flag.
    if (e instanceof DownloadError) throw e;
    const err = e as Error & { code?: string };
    if (err.name === "AbortError" || err.code === "ABORT_ERR") {
      // Timeout — transient, worth a retry against a slow/flaky CDN.
      throw new DownloadError(
        `download ${url}: timed out after ${timeoutMs / 1000}s`,
        true,
      );
    }
    // Network reset, DNS hiccup, mid-stream disconnect, etc. — also transient.
    throw new DownloadError(`download ${url}: ${err.message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

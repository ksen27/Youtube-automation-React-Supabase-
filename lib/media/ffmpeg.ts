import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { getEnv } from "@/lib/env";
import { probeFile } from "@/lib/media/probe";

// All FFmpeg invocations use spawn with an argument array — no shell strings.
// This is critical when input filenames are derived from external IDs/URLs.

// Shared H.264 codec flags for EVERY per-segment encode (still images, clips,
// split-screens, xfades, mixed boundaries, black filler). ALL segments in one
// render MUST share this identical block so the final concat can stay on the
// `-c:v copy` fast path (the concat demuxer requires every input to share codec
// params, GOP structure, and SPS/PPS — see concatNormalizedClips).
//
// Quality is chosen PER RENDER by the project's engine (both engines render on
// the same worker, so it can't be a per-worker env):
//   • sourced (celebrity): HARD-PINNED to the original ultrafast/crf25 so
//     celebrity output is byte-for-byte unchanged. Never reads env.
//   • synthetic (AI avatar): SYNTHETIC_X264_PRESET / SYNTHETIC_X264_CRF
//     (default veryfast/crf21) for sharper output.
// renderProcessor resolves this ONCE per render and passes the result into every
// segment encoder via the `vcodecArgs` option, so the whole video is uniform.
// Encoders that aren't given vcodecArgs fall back to the sourced default, which
// preserves the historical behavior for any caller outside the render loop.
// Do NOT add "-tune" or vary tokens between segments — divergence forces the
// concat to re-encode (30× slower) or fail on strict demuxers.
export type RenderEngine = "sourced" | "synthetic";
export function segmentVcodecArgsFor(engine: RenderEngine): string[] {
  if (engine === "synthetic") {
    const env = getEnv();
    return [
      "-c:v", "libx264",
      "-preset", env.SYNTHETIC_X264_PRESET,
      "-crf", String(env.SYNTHETIC_X264_CRF),
      "-pix_fmt", "yuv420p",
    ];
  }
  // sourced (celebrity): unchanged from the original hardcoded values.
  return [
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "25",
    "-pix_fmt", "yuv420p",
  ];
}
const SOURCED_VCODEC_ARGS = segmentVcodecArgsFor("sourced");

export interface CutClipOptions {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  // Retain the source's audio track on the cut. Default false — most clip
  // cuts feed into a downstream concat that pairs silent video with the
  // project voiceover. Forced doc clips that should play their own audio
  // pass this true (and `normalizeClip` is called the same way) so the
  // audio extraction step downstream sees the audio track on the trimmed
  // file.
  keepAudio?: boolean;
  // Slow-motion factor. When > 1.0, the source is read for
  // `durationSeconds / slowmoFactor` seconds of input then stretched via
  // `setpts=PTS*slowmoFactor` so the output is exactly `durationSeconds`
  // long. Used by the renderer to fill a short clip's footage block when
  // the sentence is up to 1.5× longer than the clip — keeps motion
  // continuity without freeze frames or image substitution.
  //
  // Values ≤ 1.0 (or unset) take the original stream-copy fast path.
  // Slow-mo requires a re-encode (libx264) because PTS rewriting can't
  // be done with `-c:v copy`.
  slowmoFactor?: number;
  // Freeze-hold target (slow-mo branch only). When the source clip is too
  // short to fill its planned slot even at the max slow-mo factor, the
  // renderer caps slowmoFactor (e.g. 1.5×) — which leaves the stretched
  // output SHORTER than durationSeconds. Without this, the clip ends early
  // and the narrator keeps talking over the next scene, so every later
  // title card / lower-third drifts off its spoken moment. When set, after
  // the slow-mo stretch we append `tpad=stop_mode=clone` to hold the last
  // frame until the output reaches padToFreezeDurationSeconds, so the slot
  // fills exactly the planned narration time. Ignored when the stretched
  // content already meets/exceeds the target. Only meaningful with
  // slowmoFactor > 1.0.
  padToFreezeDurationSeconds?: number;
  signal?: AbortSignal;
}

export async function cutClip(opts: CutClipOptions): Promise<void> {
  const env = getEnv();
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  const slowmo = opts.slowmoFactor && opts.slowmoFactor > 1.0
    ? opts.slowmoFactor
    : null;

  if (slowmo) {
    // Slow-motion branch. Read `durationSeconds / slowmo` seconds of source
    // (so the source content covered matches what a normal cutClip would
    // have asked for at the original speed), then stretch via setpts to
    // exactly `durationSeconds` output. Re-encode is mandatory — setpts
    // rewrites timestamps which `-c:v copy` cannot do.
    //
    // Audio side: drop it entirely. The renderer mixes voiceover at concat
    // time; the source clip's audio (if any) would have to be pitch-
    // corrected to stay watchable at 1.0×–1.5× slow-mo and is never used
    // in the final mix. Both regular footage AND forced doc clips (as of
    // 2026-06-01) are silent in the final output — the narrator voiceover
    // plays continuously. keepAudio is intentionally ignored in this
    // branch.
    // Read sourceDuration seconds of input, then stretch via setpts to
    // exactly durationSeconds of output. Critical ordering:
    //
    //   -ss N -t M -i input        ← input-side -t (cuts the read)
    //   -vf setpts=PTS*slowmo      ← stretches PTS
    //   (NO output-side -t)        ← otherwise -t caps output duration
    //                                AFTER setpts already stretched the
    //                                timestamps, so the output only contains
    //                                `output_t / slowmo` seconds of source
    //                                stretched to `output_t` (silent crop).
    //                                Result: probed output = output_t but
    //                                content visibly cut short. This was the
    //                                row-24 5.8s vs expected 8.23s bug
    //                                on 2026-06-01.
    const sourceDuration = opts.durationSeconds / slowmo;
    // ALWAYS pin the slow-mo output to its exact target duration with a
    // pad-then-trim: append `tpad=stop_mode=clone` (holds the last frame) and
    // then cap with output-side `-t target`. This guarantees the rendered
    // clip is EXACTLY `target` seconds in both failure directions:
    //   • OVERSHOOT — libx264 + setpts round the stretched stream UP to whole
    //     frames, so an uncapped slow-mo clip lands ~100–370ms LONGER than
    //     asked. Across ~150 clips that compounded to ~8s of extra video, so
    //     the final MP4 ran ~8s past the voiceover (the "video 29:39 vs
    //     narration 29:31" bug). The output `-t` trims that overshoot off.
    //   • UNDERSHOOT — when the source is too short to fill the slot even at
    //     max slow-mo, the stretched stream lands SHORT. The `tpad` clone
    //     holds the last frame to fill the gap before `-t` trims (the −3.4s
    //     single-step bug at a too-short clip).
    // Why tpad is REQUIRED before `-t` (and a bare `-t` is not enough): a bare
    // output `-t` on the stretched stream caps the wall-clock without holding
    // a tail, which on an undershoot crops real content short. tpad first,
    // then `-t`, means `-t` only ever trims cloned padding or the rounding
    // overshoot — never real footage.
    //
    // target = padToFreezeDurationSeconds when the caller pins a specific slot
    // length (capped case), else the normal durationSeconds. tpad's
    // stop_duration ADDS seconds after the content (it doesn't pad "up to" a
    // total) and we don't know the source's exact on-disk length, so we
    // over-clone by the full target window and let `-t` settle the precise
    // final duration. Cloned frames encode to near-zero bytes, so over-
    // cloning is cheap.
    const target = typeof opts.padToFreezeDurationSeconds === "number"
      && opts.padToFreezeDurationSeconds > 0
      ? opts.padToFreezeDurationSeconds
      : opts.durationSeconds;
    const vf = `setpts=PTS*${slowmo.toFixed(4)},tpad=stop_mode=clone:stop_duration=${target.toFixed(3)}`;
    const args = [
      "-y",
      "-threads", String(env.FFMPEG_THREADS),
      "-ss", String(opts.startSeconds),
      "-t", String(sourceDuration),
      "-i", opts.inputPath,
      "-vf", vf,
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-avoid_negative_ts", "make_zero",
      "-t", String(target),
      "-movflags", "+faststart",
      opts.outputPath,
    ];
    await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
    return;
  }

  // -ss before -i is input-side seek (fast: ffmpeg jumps in the file rather
  // than decoding from frame 0). With -c:v copy we stream-copy the H.264
  // packets straight to the output container — no decode, no encode. On
  // shared-CPU Fly machines this turns a ~2-3s re-encode into ~0.2s of pure
  // I/O, which is the single biggest win for clip-cut throughput.
  //
  // Trade-off: the cut starts at the nearest keyframe at or before the
  // requested -ss, so the clip can begin up to ~1-2s earlier than asked.
  // For 5-second B-roll windows this is invisible — the matcher picks
  // clips by visual labels, not frame-accurate timestamps, and the
  // thumbnail (still re-encoded by generateThumbnail) remains a faithful
  // representation of what's in the clip.
  //
  // -avoid_negative_ts make_zero resets PTS to start at 0; without it some
  // players show a brief black frame at the start because the first packet's
  // PTS reflects its keyframe-relative position in the source.
  // -an by default — final voiceover is mixed in during concat, not from
  // clip audio. Forced doc clips that need their own audio surfaced pass
  // keepAudio:true; we then stream-copy the source's audio packet stream
  // alongside the video instead of dropping the track. AAC is the only
  // codec we trust in MP4; if the source is something else (e.g. opus
  // inside a WebM), the caller should have already remuxed via yt-dlp's
  // post-processing.
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-ss", String(opts.startSeconds),
    "-i", opts.inputPath,
    "-t", String(opts.durationSeconds),
    ...(opts.keepAudio ? ["-c:a", "aac"] : ["-an"]),
    "-c:v", "copy",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Build a still-image video segment of `durationSeconds` length. Used for
// image blocks in the timeline — the same image is held for the block's
// duration. Output codec/res/fps matches normalizeClip so the segment can
// be concatenated alongside footage clips without re-encoding mismatches.
//
// AVIF inputs are pre-transcoded to PNG. ffmpeg 5.1's image2 demuxer (which
// `-loop 1` requires) does not recognize AVIF as a loopable still source,
// so passing an `.avif` directly fails with the misleading "Option loop
// not found" error. ffmpeg can still decode AVIF as a single frame though,
// so we shell out one quick ffmpeg call to write a PNG copy and feed that
// to the still-video build.
export async function buildStillVideo(opts: {
  inputImagePath: string;
  outputPath: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  // Motion applied to the still so it doesn't read as a frozen frame.
  //   "in"        — crops a shrinking window over time (zoom-in feel).
  //   "out"       — crops an expanding window (zoom-out feel).
  //   "pan_left"  — constant zoom; window slides from right edge to left.
  //   "pan_right" — constant zoom; window slides from left edge to right.
  // Caller cycles through the four modes per consecutive image so adjacent
  // stills never move identically. Defaults to "in".
  motionDirection?: "in" | "out" | "pan_left" | "pan_right";
  // Optional lower-third overlay. Same semantics as normalizeClip — when the
  // matcher's minute-cadence picker lands on an image block, the renderer
  // burns the proper-noun text in via the shared drawtext recipe.
  // startOffsetSeconds delays the chyron to the in-clip moment the narrator
  // says the marked word (see normalizeClip's lowerThird doc).
  lowerThird?: { text: string; startOffsetSeconds?: number };
  vcodecArgs?: string[]; // per-render codec flags; defaults to sourced (see segmentVcodecArgsFor)
  signal?: AbortSignal;
  // Pin the output to exactly this many frames (-frames:v). The input-side
  // `-t` on the looped image sits EXACTLY on a frame boundary once durations
  // are frame-snapped, and float rounding then decides whether ffmpeg emits N
  // or N+1 frames — measured 2026-07-17 (render.concat.timeline): +586ms of
  // unrecorded video spread across the still blocks of a 250-block synthetic
  // render, the third instance of the same emit-vs-record leak. Synthetic
  // callers must pass it; sourced callers omit it and keep exact old behavior.
  exactFrames?: number;
}): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  const direction = opts.motionDirection ?? "in";
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  // Always pre-transcode the input image to a clean PNG before feeding it
  // to the looping still-video build. This is unconditional — not just for
  // AVIF/HEIF — because ffmpeg's image2 demuxer combined with `-loop 1` can
  // *hang* on any number of pathological inputs:
  //
  //   - AVIF/HEIF (ISO base-media brands ffmpeg's image2 doesn't accept)
  //   - JPEGs with unusual color profiles or non-standard markers
  //   - Server-rendered "print preview" JPEGs with bleed/crop metadata
  //   - Oversized PNGs (we've seen 8000×8000 inputs lock up the demuxer)
  //   - Animated WEBPs (image2 expects a still)
  //
  // A standalone single-frame decode (no -loop) cannot hang the same way:
  // ffmpeg either decodes one frame and exits, or fails immediately on
  // malformed input. Doing the transcode unconditionally costs <1s for a
  // normal image but turns silent hangs into clean failures.
  //
  // The transcode also gets a tight dedicated timeout. If decoding a single
  // frame takes more than 30s, the input is broken and we want the failure
  // surfaced now, not after burning the global 900s ffmpeg budget.
  const transcodedPng = `${opts.inputImagePath}.normalized.png`;
  await runFFmpeg(env.FFMPEG_PATH, [
    "-y",
    "-i", opts.inputImagePath,
    "-frames:v", "1",
    transcodedPng,
  ], opts.signal, 30);
  const actualInput = transcodedPng;

  // Slow zoom motion using ffmpeg's `zoompan` filter. Earlier versions of
  // this function drove zoom by giving `crop` a time-varying w/h expression,
  // but `crop` rounds w/h to integers every frame — so for slow zooms the
  // crop window held the same integer size for several frames and then
  // jumped 1-2 px. That stair-step is what the eye reads as "wobbly" or
  // "irregular" motion. `zoompan` interpolates the zoom factor in floating
  // point and does sub-pixel sampling internally, so the motion is smooth
  // regardless of how slow the zoom is.
  //
  // Two implementation details that matter:
  //
  //   1) `fps=${fps}` is the FIRST filter, BEFORE zoompan. With `-loop 1`
  //      the image2 demuxer feeds frames at its own default rate (~25 fps).
  //      If `fps=` runs later, ffmpeg duplicates frames to reach 30 — and
  //      duplicate frames produce the visible "every 6th frame freezes"
  //      stutter. Putting `fps=` first means zoompan sees a clean 30 fps
  //      stream and produces a fresh interpolated frame for every output.
  //
  //   2) Pre-scale 4× before zoompan. zoompan samples from the input frame,
  //      so giving it a much-larger source means its sub-pixel sampling
  //      has real pixels to read instead of resampling the same 1280×720
  //      grid. Standard Ken Burns recipe — without this, slow zooms still
  //      look soft and slightly jittery on detailed sources.
  const ZOOM_MAX = 1.12;
  const dur = Math.max(0.1, opts.durationSeconds);
  const totalFrames = Math.max(1, Math.round(dur * fps));
  // Linear time ramp on the on-frame counter `on` (0..totalFrames-1).
  // Clamped so the very last frame doesn't overshoot past zEnd due to
  // rounding of totalFrames.
  const tRamp = `min(on/${totalFrames - 1}\\,1)`;

  // Build the per-frame zoom (z), x, and y expressions for the chosen
  // motion mode. For zoom-in/out, x/y are fixed at center. For pan modes,
  // zoom is fixed at ZOOM_MAX (so there's a crop window smaller than the
  // input) and x animates from one edge to the other while y stays
  // centered.
  const isPan = direction === "pan_left" || direction === "pan_right";
  const zStart = isPan ? ZOOM_MAX : (direction === "in" ? 1.0 : ZOOM_MAX);
  const zEnd = isPan ? ZOOM_MAX : (direction === "in" ? ZOOM_MAX : 1.0);
  const zExpr = `${zStart}+(${zEnd}-${zStart})*${tRamp}`;
  // x window position. At zoom=Z, the visible width inside the source is
  // iw/Z, so x can range over [0, iw - iw/Z].
  //   pan_right: x ramps 0 → iw - iw/Z   (window slides rightward)
  //   pan_left : x ramps iw - iw/Z → 0   (window slides leftward)
  //   zoom    : x = iw/2 - iw/(2*Z)      (centered)
  const xExpr = direction === "pan_right"
    ? `(iw-iw/zoom)*${tRamp}`
    : direction === "pan_left"
      ? `(iw-iw/zoom)*(1-${tRamp})`
      : `iw/2-(iw/zoom/2)`;
  // y stays centered for every mode — vertical pan was not in the client
  // spec and most stills are landscape-ish so a vertical pan would tend
  // to show the matte edge.
  const yExpr = `ih/2-(ih/zoom/2)`;

  // Blurred-background composite: split the input into BG and FG streams.
  // BG covers the full frame (overshoot + center-crop), then heavy gblur so
  // portrait/square images don't show black bars when scaled into 1280×720.
  // BG is static — no zoom — matching how editors typically treat the fill.
  // FG runs the slow zoompan and pads with transparency so the blurred BG
  // shows through the gutters on portrait/square sources. Then overlay FG
  // on BG.
  //
  // CRITICAL: fps FIRST on every branch. See comment block above for why.
  // The encoder flags below stay identical to normalizeClip() so the final
  // concat can still use -c:v copy.
  const BLUR_SIGMA = 20;
  const FG_SUPERSAMPLE = 4;
  const ssW = w * FG_SUPERSAMPLE;
  const ssH = h * FG_SUPERSAMPLE;
  // Optional lower-third drawtext, built from the same recipe normalizeClip
  // uses. Appended to the final composite stage so the overlay sits on top
  // of the blurred-bg + zoomed-fg composite.
  const ltFilter = opts.lowerThird?.text
    ? await buildLowerThirdFilter(
        opts.lowerThird.text,
        h,
        opts.lowerThird.startOffsetSeconds ?? 0,
      )
    : null;
  const ltSuffix = ltFilter ? `,${ltFilter}` : "";

  const vfChain =
    `[0:v]fps=${fps},split=2[bgsrc][fgsrc];` +
    // Background: scale to COVER the target frame, center-crop to exactly
    // w×h, then heavy gaussian blur. Static — the FG zoom carries motion.
    `[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,` +
      `crop=${w}:${h},gblur=sigma=${BLUR_SIGMA},setsar=1[bg];` +
    // Foreground: scale-to-fit into a 4×-supersampled canvas with
    // transparent padding (so portrait/square gutters reveal the blurred
    // BG), then zoompan does the smooth slow zoom down to w×h. d=1 emits
    // exactly one output frame per input frame — without this, zoompan's
    // default d=25 holds frames and ruins the motion.
    `[fgsrc]scale=${ssW}:${ssH}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${ssW}:${ssH}:-1:-1:color=#00000000,format=yuva420p,` +
      `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}'` +
        `:d=1:s=${w}x${h}:fps=${fps},setsar=1[fg];` +
    `[bg][fg]overlay=0:0:format=auto,format=yuv420p${ltSuffix}`;

  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-loop", "1",
    "-t", String(opts.durationSeconds),
    "-i", actualInput,
    "-an",
    "-filter_complex", vfChain,
    // IMPORTANT: keep these encoder flags identical to normalizeClip(). The
    // final concat uses -c:v copy (mux-only, no re-encode) which requires
    // every input segment to share codec params, GOP structure, and SPS/PPS.
    // Adding "-tune stillimage" here would diverge from normalizeClip and
    // cause concat to fall back to re-encoding (or fail outright on strict
    // demuxers). The ~5% extra bitrate that "tune stillimage" would save on
    // image segments is dwarfed by the 30× speedup from skipping concat
    // re-encode, so we deliberately use the SAME shared codec block as every
    // other segment encoder (segmentVcodecArgs()).
    ...(opts.vcodecArgs ?? SOURCED_VCODEC_ARGS),
    "-r", String(fps),
    // Exact frame-count cap for frame-snapped callers — see exactFrames doc.
    // The looped input supplies unlimited frames, so this is always reachable.
    ...(typeof opts.exactFrames === "number" && opts.exactFrames > 0
      ? ["-frames:v", String(Math.round(opts.exactFrames))]
      : []),
    // Force a keyframe at the start of every segment so concat boundaries
    // are clean on stream-copy. Without this, x264's adaptive GOP can put
    // the first keyframe a few frames in, causing the demuxer to drop or
    // freeze the first frames of an image block during -c copy concat.
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  try {
    await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
  } finally {
    if (transcodedPng) {
      try { await fs.unlink(transcodedPng); } catch { /* ignore */ }
    }
  }
}

// Build a plain black video segment of `durationSeconds` length. Used as a
// FILLER when a timeline slot fails to render (e.g. the source clip download
// timed out): without a filler, the failed slot is silently skipped at concat
// and its planned narration window collapses, shifting every later segment —
// including title cards and lower-thirds — permanently off the spoken audio.
// Holding black for the planned duration keeps cumulative video-time tracking
// the voiceover so downstream anchors still land on their narrated moment. The
// viewer sees a brief black hold instead of the whole back half of the video
// drifting out of sync.
//
// Encoder flags match buildStillVideo / normalizeClip BYTE-FOR-BYTE so the
// final concat stays on the -c:v copy fast path.
export async function buildBlackVideo(opts: {
  outputPath: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  vcodecArgs?: string[];
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-f", "lavfi",
    "-i", `color=c=black:s=${w}x${h}:r=${fps}:d=${opts.durationSeconds.toFixed(3)}`,
    "-an",
    ...(opts.vcodecArgs ?? SOURCED_VCODEC_ARGS),
    "-r", String(fps),
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Extend an already-rendered segment to `targetSeconds` by HOLDING ITS LAST
// FRAME (tpad=stop_mode=clone). Used by the renderer when a generated clip
// (HeyGen avatar / LTX ai_clip) comes back SHORTER than the narration window it
// was planned for: those providers routinely return a clip a fraction — and
// occasionally many seconds — under the audio window, so summing actual
// durations makes the whole video drift shorter than the voiceover and the
// final mux's `-t` clips the voiceover tail.
//
// Padding the slot back up to its planned duration keeps cumulative video-time
// tracking the voiceover, so the audio is never cut and every later block stays
// on its spoken moment. The held frame plays silent — fine for the small
// sub-second/1s shortfalls that are unavoidable. A GROSS shortfall (e.g. a 25s
// avatar that returned 10s) should be REGENERATED instead — a 15s frozen face
// is the symptom of a provider failure, not something to paper over here; the
// caller logs those so they surface on the review screen.
//
// Encoder flags match every other segment (segmentVcodecArgs()) + a forced
// start keyframe, so the padded file stays on the concat `-c:v copy` fast path.
export async function padVideoToLength(opts: {
  inputPath: string;
  outputPath: string;
  targetSeconds: number;
  fps?: number;
  vcodecArgs?: string[];
  signal?: AbortSignal;
  // Exact frame-count pin. `-t` keeps every frame whose PTS starts BEFORE t, so
  // a mid-frame target like (N+0.5)/fps emits N+1 frames, not N — measured on
  // 2026-07-17 (render.concat.timeline): every avatar/ai_clip slot shipped one
  // frame (~33ms) longer than slotDurations recorded, summing to +2.36s of
  // video over the voiceover on a 250-block render, chopped off the tail by the
  // final mux's -t so totals looked right while every avatar's lips lagged.
  // `-frames:v N` emits exactly N frames and cannot be misread; callers that
  // know their frame count should always pass it.
  targetFrames?: number;
}): Promise<void> {
  const env = getEnv();
  const fps = opts.fps ?? 30;
  const target = Math.max(0.1, opts.targetSeconds);
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  // tpad clones the last frame to extend the stream, then the -frames:v/-t pin
  // caps the exact length. setsar=1 keeps SAR identical to the other segments.
  // The input may carry audio (avatar/split_2 clips do); we drop it with -an
  // because the master voiceover is the only audio track the concat mixes in.
  const vf = `tpad=stop_mode=clone:stop_duration=${target.toFixed(3)},setsar=1`;
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-i", opts.inputPath,
    "-an",
    "-vf", vf,
    ...(opts.vcodecArgs ?? SOURCED_VCODEC_ARGS),
    "-r", String(fps),
    ...(typeof opts.targetFrames === "number" && opts.targetFrames > 0
      ? ["-frames:v", String(Math.round(opts.targetFrames))]
      : ["-t", target.toFixed(3)]),
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Build a split-screen still video — two source images placed side-by-side,
// each filling its half of the frame. Used for blocks Gemini tagged as
// split_2 ("Salma Hayek and Danny Trejo worked together"). Two inputs,
// each cropped to half-width with scale=cover behavior so portrait and
// square sources still fill their slot cleanly.
//
// Encoder flags match normalizeClip / buildStillVideo BYTE-FOR-BYTE so the
// final concat stays on the stream-copy fast path. Single-frame pre-
// transcode to PNG is the same defense as buildStillVideo — keeps the
// image2 demuxer from hanging on pathological inputs (AVIF/HEIF, animated
// WEBPs, oddly-flagged JPEGs).
export async function buildSplitScreenVideo(opts: {
  leftImagePath: string;
  rightImagePath: string;
  outputPath: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  // Optional lower-third overlay. Same recipe as normalizeClip /
  // buildStillVideo — when the matcher's minute-cadence picker lands on a
  // split_2 block, the renderer burns the proper-noun text in.
  // startOffsetSeconds delays the chyron to the spoken-word moment.
  lowerThird?: { text: string; startOffsetSeconds?: number };
  vcodecArgs?: string[]; // per-render codec flags; defaults to sourced (see segmentVcodecArgsFor)
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  const halfW = Math.floor(w / 2);
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  // Pre-transcode both inputs to PNG single frames. Same rationale as
  // buildStillVideo: the image2 + -loop 1 combo hangs on AVIF/HEIF, weird
  // JPEG markers, oversized PNGs, animated WEBPs. A standalone decode
  // either succeeds in <1s or fails immediately, so we get clean errors
  // instead of silent stalls.
  const leftPng = `${opts.leftImagePath}.normalized.png`;
  const rightPng = `${opts.rightImagePath}.normalized.png`;
  await runFFmpeg(env.FFMPEG_PATH, [
    "-y", "-i", opts.leftImagePath, "-frames:v", "1", leftPng,
  ], opts.signal, 30);
  await runFFmpeg(env.FFMPEG_PATH, [
    "-y", "-i", opts.rightImagePath, "-frames:v", "1", rightPng,
  ], opts.signal, 30);

  // For each side: scale-to-cover its half (force_original_aspect_ratio=
  // increase fills the cell without leaving black bars), then center-crop
  // to exactly halfW × h. setsar=1 keeps the SAR consistent with every
  // other normalized segment so concat doesn't have to re-mux.
  //
  // fps FIRST on each branch, same as buildStillVideo — without it the
  // image2 demuxer feeds its own ~25fps and downstream filters duplicate
  // frames to reach 30, producing the visible "every 6th frame freezes"
  // stutter.
  const sideChain = (label: string) =>
    `[${label}]fps=${fps},scale=${halfW}:${h}:force_original_aspect_ratio=increase,` +
    `crop=${halfW}:${h},setsar=1`;
  // Lower-third drawn after the hstack so it spans both halves of the
  // composite. Skipped when no font is available on the host.
  const ltFilter = opts.lowerThird?.text
    ? await buildLowerThirdFilter(
        opts.lowerThird.text,
        h,
        opts.lowerThird.startOffsetSeconds ?? 0,
      )
    : null;
  const ltSuffix = ltFilter ? `,${ltFilter}` : "";
  const filter =
    `${sideChain("0:v")}[L];` +
    `${sideChain("1:v")}[R];` +
    `[L][R]hstack=inputs=2,format=yuv420p${ltSuffix}[v]`;

  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-loop", "1", "-t", String(opts.durationSeconds), "-i", leftPng,
    "-loop", "1", "-t", String(opts.durationSeconds), "-i", rightPng,
    "-an",
    "-filter_complex", filter,
    "-map", "[v]",
    ...(opts.vcodecArgs ?? SOURCED_VCODEC_ARGS),
    "-r", String(fps),
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  try {
    await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
  } finally {
    try { await fs.unlink(leftPng); } catch { /* ignore */ }
    try { await fs.unlink(rightPng); } catch { /* ignore */ }
  }
}

// Run ffmpeg purely to read a value off its stderr (no output file). Used by
// cropdetect: ffmpeg prints `crop=W:H:X:Y` lines to stderr. We capture the
// tail, never write a file (-f null -). Returns the full stderr text.
function runFFmpegCaptureStderr(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  timeoutSeconds = 30,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const KEEP = 32_768;
    let tail = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutSeconds * 1000);
    child.stderr.on("data", (c: Buffer) => {
      tail += c.toString();
      if (tail.length > KEEP) tail = tail.slice(-KEEP);
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    // cropdetect exits 0 with `-f null -`; resolve with whatever we captured.
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("ffmpeg cropdetect timed out"));
      else resolve(tail);
    });
    signal?.addEventListener("abort", () => { clearTimeout(timer); child.kill("SIGKILL"); });
  });
}

// HeyGen renders a split_2 avatar onto a 9:16 PORTRAIT canvas, but the source
// avatar PHOTO is often LANDSCAPE — so HeyGen fits-to-width and pads the top
// and bottom with WHITE, baking letterbox bars into the mp4. Those bars survive
// the split-cell scale-to-cover and show up in the final video (and the review
// preview). We strip them: detect the real content box, then crop to it before
// the cell scale. cropdetect finds BLACK borders, so we negate first (white ->
// black). Returns a `crop=W:H:X:Y` filter string, or null when no significant
// border is found (already full-bleed, or an unexpected layout — in which case
// we leave the frame untouched rather than risk a bad crop).
async function detectLetterboxCrop(
  videoPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const env = getEnv();
  try {
    // Sample ~2s of frames. limit=24 (after negate) treats near-white as
    // border; reset=0 accumulates the tightest box across sampled frames.
    const stderr = await runFFmpegCaptureStderr(
      env.FFMPEG_PATH,
      ["-y", "-i", videoPath, "-vf", "negate,cropdetect=limit=24:round=2:reset=0",
        "-frames:v", "60", "-an", "-f", "null", "-"],
      signal,
      30,
    );
    const matches = stderr.match(/crop=(\d+):(\d+):(\d+):(\d+)/g);
    if (!matches || matches.length === 0) return null;
    // Take the LAST line — cropdetect refines toward the tightest stable box.
    const last = matches[matches.length - 1];
    const m = last.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
    if (!m) return null;
    const [, wS, hS, xS, yS] = m;
    const cw = Number(wS), ch = Number(hS), cy = Number(yS);
    // Probe the source height so we only crop when a MEANINGFUL band is removed
    // (guards against cropdetect noise that shaves a few pixels).
    let srcH = 0;
    try { const p = await probeFile(videoPath); srcH = p.height ?? 0; } catch { /* best-effort */ }
    // Only act when the detected content is clearly shorter than the frame
    // (>10% removed vertically) and offset from the top — i.e. real letterbox.
    if (srcH > 0 && ch >= srcH * 0.9 && cy < srcH * 0.05) return null;
    if (ch <= 0 || cw <= 0) return null;
    return `crop=${cw}:${ch}:${xS}:${yS}`;
  } catch {
    // Detection is best-effort: on any failure, leave the frame untouched.
    return null;
  }
}

// Crop image BYTES to a 9:16 PORTRAIT JPEG (scale-to-cover, center-crop). Used
// to pre-shape a LANDSCAPE avatar photo before HeyGen upload for split_2 blocks:
// HeyGen pads a landscape source into its portrait canvas with white bars, so
// feeding it an already-portrait crop makes the rendered avatar fill the frame.
// The crop is horizontally centered and anchored toward the TOP (y biased up)
// so a head-and-shoulders subject stays in frame rather than being cut at the
// chin. Best-effort: throws only if ffmpeg fails; the caller falls back to the
// raw bytes. Output is 1080×1920 (HeyGen's portrait canvas).
export async function cropImageToPortrait(
  imageBytes: Buffer,
  signal?: AbortSignal,
): Promise<Buffer<ArrayBuffer>> {
  const env = getEnv();
  const dir = path.join(env.TMP_DIR, "avatar-portrait");
  await fs.mkdir(dir, { recursive: true });
  const inPath = path.join(dir, `src_${Math.abs(hashBuf(imageBytes))}.bin`);
  const outPath = `${inPath}.portrait.jpg`;
  await fs.writeFile(inPath, imageBytes);
  try {
    // scale-to-cover 1080×1920 (increase fills the cell), then center-crop
    // horizontally but anchor the crop window's TOP at the frame top
    // ((ih-1920)/2 would center; we use a smaller y to keep the face) — clamp
    // to >=0 via max(0,...). For a landscape source, ih < 1920 after the
    // cover-scale never happens (cover makes height >= 1920), so the crop trims
    // top/bottom; biasing y up keeps the head.
    const vf =
      "scale=1080:1920:force_original_aspect_ratio=increase," +
      "crop=1080:1920:(iw-1080)/2:max(0\\,(ih-1920)/3)";
    await runFFmpeg(
      env.FFMPEG_PATH,
      ["-y", "-i", inPath, "-vf", vf, "-frames:v", "1", "-q:v", "3", outPath],
      signal,
      30,
    );
    // Re-wrap with Buffer.from so the return type is Buffer<ArrayBuffer>
    // (fs.readFile yields Buffer<ArrayBufferLike>), matching the caller's let.
    return Buffer.from(await fs.readFile(outPath));
  } finally {
    try { await fs.unlink(inPath); } catch { /* ignore */ }
    try { await fs.unlink(outPath); } catch { /* ignore */ }
  }
}

// Cheap stable filename hash for temp staging (not security-sensitive).
function hashBuf(b: Buffer): number {
  let h = 0;
  for (let i = 0; i < b.length; i += 997) h = (h * 31 + b[i]) | 0;
  return h;
}

// SYNTHETIC ENGINE: split-screen with an AVATAR VIDEO on the left and a
// generated STILL on the right. The synthetic split_2 block pairs a HeyGen
// talking-head (left) with an illustrative nano-banana image (right).
//
// Differs from buildSplitScreenVideo (image|image) only in the left input: it
// is a VIDEO, so we scale-to-cover its half directly (no PNG pre-transcode) and
// trim/loop it to the block duration. The right still keeps the same PNG
// pre-transcode defense as the image path. Output flags match buildSplitScreen
// Video BYTE-FOR-BYTE so the final concat stays on the stream-copy fast path.
// Audio is dropped (-an): the master voiceover is the single audio track muxed
// in at concat time, exactly like every other synthetic/sourced segment.
export async function buildSplitScreenAvatarVideo(opts: {
  avatarVideoPath: string;   // LEFT half — HeyGen avatar mp4
  rightImagePath: string;    // RIGHT half — generated still
  outputPath: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  lowerThird?: { text: string; startOffsetSeconds?: number };
  vcodecArgs?: string[]; // per-render codec flags; defaults to sourced (see segmentVcodecArgsFor)
  signal?: AbortSignal;
  // Pin the output to exactly this many frames (-frames:v). Callers that record
  // a frame count into the timeline bookkeeping must pass it, or the trim/fps
  // chain's own quantization ships a file that disagrees with the record.
  exactFrames?: number;
}): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  const halfW = Math.floor(w / 2);
  const dur = opts.durationSeconds;
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  // Pre-transcode the still half to a PNG single frame (same defense as the
  // image|image path). The avatar VIDEO is fed directly.
  const rightPng = `${opts.rightImagePath}.normalized.png`;
  await runFFmpeg(env.FFMPEG_PATH, [
    "-y", "-i", opts.rightImagePath, "-frames:v", "1", rightPng,
  ], opts.signal, 30);

  // HeyGen letterbox: a landscape avatar photo padded into the 9:16 portrait
  // canvas leaves WHITE bars baked into the mp4. Detect and strip them BEFORE
  // the cell scale, so the avatar fills the left half edge-to-edge (no bars in
  // the final video). null when already full-bleed -> no-op.
  const letterboxCrop = await detectLetterboxCrop(opts.avatarVideoPath, opts.signal);
  const stripBars = letterboxCrop ? `${letterboxCrop},` : "";

  // LEFT (avatar video, input 0): trim to duration, normalize fps, strip any
  // letterbox bars, scale-to-cover the left cell, center-crop, setsar=1. setpts
  // resets the PTS so a trimmed clip starts at 0.
  // RIGHT (still, input 1): identical recipe to buildSplitScreenVideo's side.
  const leftChain =
    `[0:v]trim=duration=${dur},setpts=PTS-STARTPTS,fps=${fps},${stripBars}` +
    `scale=${halfW}:${h}:force_original_aspect_ratio=increase,crop=${halfW}:${h},setsar=1`;
  const rightChain =
    `[1:v]fps=${fps},scale=${halfW}:${h}:force_original_aspect_ratio=increase,` +
    `crop=${halfW}:${h},setsar=1`;
  const ltFilter = opts.lowerThird?.text
    ? await buildLowerThirdFilter(opts.lowerThird.text, h, opts.lowerThird.startOffsetSeconds ?? 0)
    : null;
  const ltSuffix = ltFilter ? `,${ltFilter}` : "";
  const filter =
    `${leftChain}[L];` +
    `${rightChain}[R];` +
    `[L][R]hstack=inputs=2,format=yuv420p${ltSuffix}[v]`;

  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    // Loop the avatar video so a clip shorter than the block holds the last
    // beat instead of cutting to black; trim above clamps the upper bound.
    "-stream_loop", "-1", "-t", String(dur), "-i", opts.avatarVideoPath,
    "-loop", "1", "-t", String(dur), "-i", rightPng,
    "-an",
    "-filter_complex", filter,
    "-map", "[v]",
    ...(opts.vcodecArgs ?? SOURCED_VCODEC_ARGS),
    "-r", String(fps),
    // Exact frame-count cap. The trim/fps chain quantizes on its own grid and
    // was measured emitting one frame fewer than the caller recorded (149 vs
    // the 150 in slotDurations, render.concat.timeline 2026-07-17), the same
    // class of leak as the avatar branch's mid-frame `-t`. The looped inputs
    // always supply enough frames, so -frames:v lands the file on exactly the
    // count the timeline bookkeeping assumes.
    ...(typeof opts.exactFrames === "number" && opts.exactFrames > 0
      ? ["-frames:v", String(Math.round(opts.exactFrames))]
      : []),
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  try {
    await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
  } finally {
    try { await fs.unlink(rightPng); } catch { /* ignore */ }
  }
}

// Build a black title-card segment with white text centered on the frame.
// Used at section boundaries: Gemini's analyzeSegment emits a sectionTitle
// (e.g. "The Cancellation", "Marriage") on the first block of every new
// chapter, and the matcher persists it as a `title_card` timeline item.
// This renderer turns that item into a fixed-length still video.
//
// Encoder flags match normalizeClip / buildStillVideo BYTE-FOR-BYTE so the
// final concat can still stream-copy. The drawtext text-wrap relies on a
// pre-computed font line length: ffmpeg's drawtext has no word-wrap, so we
// pre-wrap in JS (see wrapTitleCardText) and use `\n` literals which
// drawtext renders as multi-line output.
export async function buildTitleCardVideo(opts: {
  text: string;
  outputPath: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  // When "typewriter", the text is typed in character-by-character. By
  // default the typing spans the full segment duration so the last
  // character lands as the card ends. Pass typewriterDurationSeconds to
  // finish typing earlier — the remainder of the segment holds the
  // fully-typed text on screen (used for the script-doc title cards so the
  // viewer has a beat to read the title after the narrator finishes saying it).
  // When omitted (default "static"), the entire text shows for the full
  // duration — the original chapter-card behavior used by the analyze
  // pipeline. Script-doc title cards pass "typewriter".
  animation?: "static" | "typewriter";
  typewriterDurationSeconds?: number;
  vcodecArgs?: string[];
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  const font = await resolveLowerThirdFont();
  // No font available — synthesize a plain black card with no text rather
  // than failing the whole render. The matcher log records the requested
  // section_title so operators can see what was supposed to appear.
  const fontPath = font ? font.replace(/\\/g, "/").replace(/'/g, "\\'").replace(/:/g, "\\:") : null;

  // Title-card type sizing. 56px at 720p reads as a documentary chapter
  // title at a comfortable viewing distance. Scales linearly with height
  // so the same call at 1080p (h=1080) lands at ~84px.
  const fontsize = Math.round(h / 12.8);

  // Pre-wrap the text so a long title like "Michael Jackson, Marriage,
  // and the Show That Made It Invisible" lines correctly. drawtext does
  // not word-wrap; without this a long title runs off the side of the
  // frame. ~22 chars per line is a comfortable read at this font size.
  //
  // Pre-wrap the title. We render one drawtext per line and center each
  // line independently via x=(w-text_w)/2. This avoids drawtext's
  // text_align=center option, which only landed in ffmpeg 6.0 — the Fly
  // worker image is on 4.4 (libavfilter 8.44) where text_align trips
  // "Option not found" and the whole render fails. Per-line drawtext also
  // sidesteps the older `textfile=` + `\n` lexer bug that mangled words on
  // some builds.
  const lines = wrapTitleCardText(opts.text, 22);
  // Each line's text has to survive two lexers stacked on top of each
  // other: ffmpeg's filter-graph parser (which sees `text='...'` as a
  // single-quoted value) and drawtext's own arg parser (which uses `:`
  // as the option separator). The filter-graph layer treats backslashes
  // inside a single-quoted value as literal — the ONLY way to embed a
  // literal apostrophe is the close-escape-reopen trick: `'\''`. Without
  // this, a title like "He Didn't" terminates the outer value early and
  // everything after gets parsed as new filter options (which is exactly
  // how `enable=between(t,...)` got chopped at its first comma before).
  // Drawtext itself only cares about `\`, `%`, and `:` inside the text.
  //
  // Apostrophes get replaced with the typographic right-single-quote
  // (U+2019) instead of the close-escape-reopen quoting trick. Reason: on
  // ffmpeg 4.4 the trick has flaky parser behavior — the title card
  // "Simon Cowell Finally Speaks, What He Said and What He Didn't"
  // rendered with the third line missing during the hold tail, while the
  // apostrophe-free "The Moment That Changed Everything, The Walliams
  // Recording" worked fine. The two titles have identical filter chain
  // structure otherwise; the only difference is the apostrophe in
  // "Didn't". The typographic quote is visually indistinguishable in
  // body text and a literal character (no parser interaction).
  const escapeDrawtext = (s: string): string =>
    s
      .replace(/'/g, "’")
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:");
  // Stack lines vertically around the frame center. Each line is
  // (fontsize + line_spacing) tall in flowed text; we approximate by
  // measuring with text_h at draw time per line, but the simplest stable
  // layout is to compute Y offsets in JS from line index. fontsize is the
  // glyph height for line_h; line_spacing widens that gap. The block's
  // total height is lines.length * fontsize + (lines.length - 1) * spacing.
  const lineSpacing = 10;
  const blockHeight = lines.length * fontsize + Math.max(0, lines.length - 1) * lineSpacing;
  const animation = opts.animation ?? "static";

  // Build the line layout helper used by both static and typewriter modes.
  // Each "line draw" is one drawtext filter at a fixed Y. The text may be
  // a prefix of the full line (typewriter) or the full line (static).
  function buildLineDrawtext(line: string, lineIdx: number, enableExpr: string | null): string {
    const yOffset = lineIdx * (fontsize + lineSpacing);
    const yExpr = `(h-${blockHeight})/2+${yOffset}`;
    const enable = enableExpr ? `:enable='${enableExpr}'` : "";
    return (
      `drawtext=fontfile='${fontPath}':text='${escapeDrawtext(line)}':` +
      `fontcolor=white:fontsize=${fontsize}:` +
      `x=(w-text_w)/2:y=${yExpr}${enable}`
    );
  }

  let drawtext = "";
  if (fontPath && lines.length > 0) {
    if (animation === "typewriter") {
      // Typewriter mode: character-by-character reveal, with snapshots
      // taken every CHAR_STEP characters instead of every single one.
      //
      // Why chunked snapshots instead of per-character: each snapshot
      // emits up to `lines.length` drawtext filters. With per-character
      // snapshots, a 60-character 3-line title produces ~180 drawtext
      // invocations — ffmpeg 4.4 on the worker silently drops filters
      // past a chain-length limit, manifesting as the third line briefly
      // appearing then disappearing for the hold tail.
      //
      // CHAR_STEP cuts the chain: with 60 chars and 3 lines, step 4
      // gives ~15 snapshots × 3 = ~45 drawtext filters + 3 final = ~48.
      // Well under ffmpeg 4.4's silent chain-truncation threshold (the
      // 90-filter chain from step 2 was STILL hitting it on the longer
      // of the two title cards, dropping the third line during the hold
      // tail). With typingWindow ≈ 4.7s for a 60-char title, each
      // visible "tick" is ~313ms apart — still 3 visible ticks/second,
      // still reads as typing rather than word-snapping.
      const CHAR_STEP = 4;
      const totalText = lines.join(" ");
      const totalChars = totalText.length;
      const typingWindow = opts.typewriterDurationSeconds != null
        && opts.typewriterDurationSeconds > 0
        && opts.typewriterDurationSeconds <= opts.durationSeconds
          ? opts.typewriterDurationSeconds
          : opts.durationSeconds;
      if (totalChars > 0) {
        const dt = typingWindow / totalChars;
        const filters: string[] = [];
        // Build the prefix split for an arbitrary character count k —
        // same logic as before, just called from chunked-step loop.
        function partialLinesForChars(k: number): string[] {
          const partialLines: string[] = [];
          let remaining = k;
          for (let li = 0; li < lines.length && remaining > 0; li++) {
            const lineText = lines[li];
            if (remaining >= lineText.length) {
              partialLines.push(lineText);
              remaining -= lineText.length;
              if (li + 1 < lines.length && remaining > 0) remaining -= 1;
            } else {
              partialLines.push(lineText.slice(0, remaining));
              remaining = 0;
            }
          }
          return partialLines;
        }
        // Intermediate snapshots — k stepping by CHAR_STEP from CHAR_STEP
        // up to but not including totalChars. The final (full-text) state
        // is emitted separately below with a long enable window so it
        // covers the hold tail reliably.
        for (let k = CHAR_STEP; k < totalChars; k += CHAR_STEP) {
          const partialLines = partialLinesForChars(k);
          const tStart = ((k - CHAR_STEP) * dt).toFixed(3);
          const tEnd = (k * dt).toFixed(3);
          // Escape the commas inside between() — see the lower-third xExpr
          // note: a bare comma here is read as the drawtext-chain separator
          // and the expression gets chopped ("No such filter: '<num>)'").
          const enableExpr = `between(t\\,${tStart}\\,${tEnd})`;
          for (let li = 0; li < partialLines.length; li++) {
            const t = partialLines[li];
            if (!t) continue;
            filters.push(buildLineDrawtext(t, li, enableExpr));
          }
        }
        // Final state: full text held from the last intermediate snapshot
        // through to card end. Use a single long enable window — no
        // per-character pile-up to push past the chain limit.
        const lastIntermediateK = Math.floor((totalChars - 1) / CHAR_STEP) * CHAR_STEP;
        const tailStart = (lastIntermediateK * dt).toFixed(3);
        const tailEnd = opts.durationSeconds.toFixed(3);
        const tailEnable = `between(t\\,${tailStart}\\,${tailEnd})`;
        for (let li = 0; li < lines.length; li++) {
          const t = lines[li];
          if (!t) continue;
          filters.push(buildLineDrawtext(t, li, tailEnable));
        }
        drawtext = filters.join(",") + ",";
      }
    } else {
      // Static mode: one drawtext per final line, no enable expression.
      drawtext = lines
        .map((line, idx) => buildLineDrawtext(line, idx, null))
        .join(",") + ",";
    }
  }
  const vfChain = `${drawtext}setsar=1,format=yuv420p`;
  // Diagnostic: log title-card filter chain so we can see exactly what
  // ffmpeg gets when a card has the "third line drops" bug. Per-text
  // gate (not one-shot) so BOTH title cards in a render get logged —
  // we need to compare the apostrophe-containing card against the
  // apostrophe-free one. Strip after the cause is confirmed.
  const tcKey = opts.text;
  if (animation === "typewriter" && !tcFilterDebugSeen.has(tcKey)) {
    tcFilterDebugSeen.add(tcKey);
    const filterCount = (drawtext.match(/drawtext=/g) ?? []).length;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      msg: "title_card.filter.debug",
      text: opts.text,
      lines,
      durationSeconds: opts.durationSeconds,
      typewriterDurationSeconds: opts.typewriterDurationSeconds,
      filterCount,
      vfChainLength: vfChain.length,
      vfChain,
    }));
  }

  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-f", "lavfi",
    "-i", `color=c=black:s=${w}x${h}:r=${fps}:d=${opts.durationSeconds}`,
    "-vf", vfChain,
    "-an",
    ...(opts.vcodecArgs ?? SOURCED_VCODEC_ARGS),
    "-r", String(fps),
    "-t", String(opts.durationSeconds),
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// drawtext has no word-wrap, so we pre-split the title at the nearest
// whitespace before `maxCharsPerLine` and return one entry per line. The
// caller escapes each line, then joins with the two-character literal `\n`
// which drawtext's text parser renders as a line break.
function wrapTitleCardText(text: string, maxCharsPerLine: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (current.length === 0) {
      current = w;
    } else if ((current.length + 1 + w.length) <= maxCharsPerLine) {
      current += ` ${w}`;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Cut a window of audio out of a longer audio file. Used by the intro
// pipeline to extract the [start, end] segment of the source's audio that
// matches the chosen intro video clip. AAC re-encode is fast and keeps the
// container compatible with the renderer's filter graph.
// Strip the audio out of a video file, re-encoding to AAC so the result
// is concat-compatible with the other audio segments built by cutAudio /
// concatAudioFiles. Used by the forced-clip audio-splice pass: each
// forced doc clip's MP4 still carries its source audio (because cutClip /
// normalizeClip were called with keepAudio:true); this function pulls
// that audio into a standalone .m4a so it can be stitched into the
// voiceover chain.
//
// If the input has no audio stream at all, the resulting file is a
// silent track of the same duration — we don't error out, because a
// rare "video-only forced clip" should still play silently rather than
// failing the whole render.
export async function extractAudio(opts: {
  inputPath: string;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-i", opts.inputPath,
    "-vn",
    "-c:a", "aac",
    "-b:a", "192k",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Generate a silent AAC audio segment of the given duration. Used as a
// neutral filler when a forced clip's audio extraction fails or the
// source clip has no audio track — the splice still produces a track
// of the correct length so the spliced voiceover matches the video
// timeline.
export async function buildSilentAudio(opts: {
  outputPath: string;
  durationSeconds: number;
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-f", "lavfi",
    "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
    "-t", String(Math.max(0.05, opts.durationSeconds)),
    "-c:a", "aac",
    "-b:a", "192k",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Result of a voiceover loudness-dropout scan (see detectLoudnessDropout).
export interface LoudnessDropout {
  // A sustained low-volume span was found (a likely-corrupted TTS stretch).
  dropout: boolean;
  // The track's normal loudness (median of voiced samples), in LUFS.
  medianLufs: number;
  // The worst offending span, when dropout is true.
  worstSpan: { startSeconds: number; endSeconds: number; minLufs: number } | null;
  // How many momentary-loudness samples ebur128 emitted (0 = analysis produced
  // no usable data, e.g. a silent/failed file — caller treats this as "unknown",
  // NOT as a clean pass).
  samples: number;
}

// Scan an audio file for a SUSTAINED low-volume stretch — the signature of a
// corrupted 69labs TTS render where a middle chunk comes back at the wrong
// voice / a dropped level (client-reported: ~5 min much quieter from 9:12 on a
// 31-min voiceover). ffmpeg's ebur128 filter prints momentary loudness (`M:`)
// roughly every 100ms with a timestamp (`t:`); we treat the MEDIAN of the
// voiced samples as the track's normal level and flag any contiguous run of
// samples that sits `dropDb` LU or more below it for at least `minSpanSeconds`.
//
// Using a span floor (not a single quiet sample) is what keeps ordinary
// sentence gaps and breaths from false-flagging — those are far shorter than a
// real corrupted stretch. Best-effort: on any analysis failure it returns
// dropout:false with samples:0 so the caller can distinguish "clean" (samples>0,
// dropout:false) from "couldn't tell" (samples:0) and not regenerate blindly.
export async function detectLoudnessDropout(opts: {
  inputPath: string;
  dropDb: number;
  minSpanSeconds: number;
  signal?: AbortSignal;
}): Promise<LoudnessDropout> {
  const env = getEnv();
  const empty: LoudnessDropout = { dropout: false, medianLufs: -Infinity, worstSpan: null, samples: 0 };

  // ebur128 prints a per-frame CONTINUOUS readout to stderr — one line every
  // ~100ms carrying `t:` (seconds) and `M:` (momentary LUFS). We must NOT pass
  // -nostats (it suppresses exactly these lines, leaving only the end Summary →
  // zero samples). A 22-min track emits ~13k lines (~1.2MB) — far past
  // runFFmpegCaptureStderr's 32KB tail window, which would keep only the last
  // ~30s. So we stream stderr ourselves and parse each line as it arrives,
  // keeping only the parsed {t, m} floats (13k numbers ≈ negligible memory).
  //
  // Parse `t: <sec>` and `M: <lufs>` per line. ffmpeg prints both spaced
  // (`M: -15.9`) and unspaced (`M:-120.7`, true silence). Silence samples are
  // dropped from the median (they're gaps, not voice) but still break a span.
  const samples: Array<{ t: number; m: number }> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(env.FFMPEG_PATH, ["-i", opts.inputPath, "-af", "ebur128", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
      let buf = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
      const lineRe = /t:\s*([\d.]+).*?M:\s*(-?[\d.]+)/;
      child.stderr.on("data", (c: Buffer) => {
        buf += c.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const mm = lineRe.exec(line);
          if (mm) {
            const t = Number(mm[1]);
            const m = Number(mm[2]);
            if (Number.isFinite(t) && Number.isFinite(m)) samples.push({ t, m });
          }
        }
      });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", () => { clearTimeout(timer); resolve(); });
      opts.signal?.addEventListener("abort", () => { clearTimeout(timer); child.kill("SIGKILL"); });
    });
  } catch {
    return empty;
  }

  if (samples.length === 0) return empty;

  // Median of the VOICED samples (drop near-silence so pauses don't drag the
  // baseline down and mask a real dropout). -70 LUFS is comfortably below any
  // spoken level and above ebur128's -120 silence floor.
  const voiced = samples.map((s) => s.m).filter((m) => m > -70).sort((a, b) => a - b);
  if (voiced.length === 0) return { ...empty, samples: samples.length };
  const median = voiced[Math.floor(voiced.length / 2)];
  const floor = median - opts.dropDb;

  // Walk the timeline; accumulate the longest contiguous span whose samples are
  // ALL below `floor`. Track its extent and minimum level for logging.
  let worst: LoudnessDropout["worstSpan"] = null;
  let runStart: number | null = null;
  let runMin = Infinity;
  let runEndT = 0;
  const closeRun = (endT: number) => {
    if (runStart === null) return;
    const span = endT - runStart;
    if (span >= opts.minSpanSeconds && (!worst || span > worst.endSeconds - worst.startSeconds)) {
      worst = { startSeconds: runStart, endSeconds: endT, minLufs: runMin };
    }
    runStart = null;
    runMin = Infinity;
  };
  for (const s of samples) {
    // Ignore true-silence samples: a corrupted stretch is QUIET-BUT-PRESENT, not
    // dead air, and long legit pauses shouldn't seed a false span.
    if (s.m <= -70) { closeRun(runEndT); runEndT = s.t; continue; }
    if (s.m < floor) {
      if (runStart === null) runStart = s.t;
      runMin = Math.min(runMin, s.m);
    } else {
      closeRun(s.t);
    }
    runEndT = s.t;
  }
  closeRun(runEndT);

  return {
    dropout: worst !== null,
    medianLufs: median,
    worstSpan: worst,
    samples: samples.length,
  };
}

export async function cutAudio(opts: {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  // Output codec. Default "aac" (the intro/forced-clip splice path muxes the
  // result into an .m4a/AAC chain). Pass "mp3" when the output is an .mp3 file —
  // e.g. the avatar audio slice uploaded to HeyGen, whose modal accepts MP3/WAV.
  // Writing AAC packets into a .mp3 container is invalid and ffmpeg rejects it,
  // so the codec MUST match the container the caller asked for.
  format?: "aac" | "mp3";
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const codec = opts.format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "192k"] : ["-c:a", "aac", "-b:a", "192k"];
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-ss", String(opts.startSeconds),
    "-i", opts.inputPath,
    "-t", String(opts.durationSeconds),
    "-vn",
    ...codec,
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Concatenate N AAC audio segments into a single .m4a. Uses the concat
// filter (re-encodes once) instead of the concat demuxer because the input
// files come from different sources (different YouTube videos for each intro
// clip) and may not share the exact same codec parameters — the demuxer's
// stream-copy mode would error out on mismatched container metadata.
//
// Used by the multi-intro pre-roll: each intro clip's audio is cut to its
// own window via cutAudio, then this function stitches them into one track
// that aligns with the prepended silent intro videos.
export async function concatAudioFiles(opts: {
  inputPaths: string[];
  outputPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (opts.inputPaths.length === 0) throw new Error("concatAudioFiles: no inputs");
  const env = getEnv();
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  // Single input: just copy through (no need to spend an encode pass).
  if (opts.inputPaths.length === 1) {
    const args = [
      "-y",
      "-threads", String(env.FFMPEG_THREADS),
      "-i", opts.inputPaths[0],
      "-vn",
      "-c:a", "copy",
      opts.outputPath,
    ];
    await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
    return;
  }
  const inputArgs: string[] = [];
  for (const p of opts.inputPaths) {
    inputArgs.push("-i", p);
  }
  const audioInputs = opts.inputPaths.map((_, i) => `[${i}:a:0]`).join("");
  const filter = `${audioInputs}concat=n=${opts.inputPaths.length}:v=0:a=1[a]`;
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    ...inputArgs,
    "-filter_complex", filter,
    "-map", "[a]",
    "-c:a", "aac",
    "-b:a", "192k",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

export interface ThumbnailOptions {
  inputPath: string;
  outputPath: string;
  atSeconds: number;
  signal?: AbortSignal;
}

export async function generateThumbnail(opts: ThumbnailOptions): Promise<void> {
  const env = getEnv();
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-ss", String(opts.atSeconds),
    "-i", opts.inputPath,
    "-frames:v", "1",
    "-vf", "scale=480:-2",
    "-q:v", "3",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

export interface NormalizeOptions {
  inputPath: string;
  outputPath: string;
  width?: number;     // default 1280
  height?: number;    // default 720
  fps?: number;       // default 30
  // Optional lower-third overlay. When set, the matcher decided this clip
  // should introduce a named entity (person, year, or place). The text is
  // burned in via ffmpeg's drawtext filter for ~3.4s with a slide in/out,
  // sitting in the lower-third zone with a solid blue chip.
  //   startOffsetSeconds — in-clip time the chyron begins its slide-in. The
  //   renderer sets this to (word_vo_start − clip_vo_start) so the chip
  //   appears exactly when the narrator says the red-marked word, not at the
  //   clip's start. Omitted/0 → chip appears at clip start (legacy behavior,
  //   used as the fallback when no word time was resolved).
  lowerThird?: { text: string; startOffsetSeconds?: number };
  // Retain the source's audio track on the normalized output. Default
  // false — the downstream concat builds the final audio from the
  // voiceover, so individual clips are silent. Forced doc clips that
  // should play their own audio pass true; the renderer then extracts
  // that audio for splicing into the voiceover chain.
  keepAudio?: boolean;
  // Pin the normalized output to EXACTLY this many seconds via an output-side
  // `-t`. The footage cut path uses `-c:v copy` (fast stream-copy), which can
  // only end on a packet/keyframe boundary — so `cutClip(-t renderDur)`
  // OVERSHOOTS to the next GOP, landing 60-180ms long per clip. The drift is
  // always positive (never short) and across ~140 footage rows compounded to
  // ~9s of video past the voiceover (the 2026-06-10 "video 9s longer than
  // audio" bug). normalizeClip already re-encodes, so capping it with `-t`
  // here costs nothing and trims the GOP overshoot back to the asked length.
  // Verified: brings per-clip drift from +60-180ms to ±10ms (single-frame
  // rounding) with no real frames dropped — the trimmed tail is only the
  // copy-cut's over-included GOP. Leave undefined for image/title builders;
  // they're CFR-clean from frame 0 and need no pin.
  pinDurationSeconds?: number;
  // Pin the output to EXACTLY this many frames via `-frames:v`. Takes
  // precedence over pinDurationSeconds. Prefer this whenever the caller knows
  // its frame count: `-t` keeps every frame whose PTS starts before t, so a
  // mid-frame duration like (N+0.5)/30 emits N+1 frames — the one-frame-per-
  // block leak behind the 2026-07-17 avatar lip-lag (+2.36s of excess video
  // across a 250-block render, invisible in totals because the final mux
  // trimmed it off the tail).
  pinFrames?: number;
  // Skip this many seconds at the head of the input before encoding.
  // cutClip's input-side -ss with -c:v copy starts the cut at the nearest
  // keyframe AT OR BEFORE the requested start, so the requested window sits
  // at the TAIL of the cut file with up to a whole GOP of earlier footage in
  // front of it. Callers that need the window frame-accurate (doc-marker
  // clips, whose separately-cut audio is exact) probe the cut file and pass
  // the excess (probed − requested) here; the seek decodes-and-discards, so
  // it is frame-accurate, and combined with pinDurationSeconds the output is
  // exactly the requested source window.
  startOffsetSeconds?: number;
  vcodecArgs?: string[];
  signal?: AbortSignal;
}

// Escape a string for use inside an ffmpeg filter `text=...` value. ffmpeg's
// filtergraph parser treats `:`, `'`, `\`, and `%` specially, and the
// containing arg already uses single-quoted segments separated by `:`, so we
// also strip newlines defensively. Drawtext's docs spell out the full rules
// (https://ffmpeg.org/ffmpeg-filters.html#drawtext) — this matches them.
function escapeDrawtextValue(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/[\r\n]+/g, " ");
}

// Resolve the font file to hand to ffmpeg's drawtext filter. On the Fly
// worker container the Dockerfile installs `fonts-dejavu-core`, so the
// DejaVu Sans Bold TTF lives at a known absolute path. On Windows dev,
// drawtext can use the system Arial. The path must be filesystem-real and
// readable by the ffmpeg process. Returns null if no font is reachable — the
// caller then skips the overlay rather than failing the whole render.
async function resolveLowerThirdFont(): Promise<string | null> {
  const candidates =
    process.platform === "win32"
      ? ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"]
      : [
          "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
          "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch { /* try next */ }
  }
  return null;
}

// Build the drawtext filter chain for a 3-second lower-third with a
// slide-in-from-left effect. Broadcast-chyron style: solid blue rectangle,
// white bold all-caps text inside, anchored to the lower-third zone (≈ 80%
// of frame height). Padding around the glyphs comes from drawtext's
// `boxborderw`. The chip slides in horizontally from off-screen left to a
// left-margin rest position, holds, then slides back out to the left.
//
// Per the client's "lower third should appear with effect on the screen"
// note, replaced the previous fade in/out (which read as a static chip
// that just got brighter) with a horizontal slide. The slide reads as a
// real broadcast lower-third entrance — viewer's eye is drawn to it
// instead of registering the chip as already-there.
//
// Returns null if no font is available on the host.
async function buildLowerThirdFilter(
  text: string,
  height: number,
  startOffsetSeconds = 0,
): Promise<string | null> {
  const font = await resolveLowerThirdFont();
  if (!font) return null;
  // Timing: 0.4s slide in, 2.6s hold, 0.4s slide out. Total 3.4s.
  // `start` is the in-clip time the chyron begins its slide-in. It defaults to
  // 0 (chip appears at clip start) but the renderer passes the offset of the
  // red-marked word within this host clip so the chip appears exactly when the
  // narrator says it. Every gate/interp expression below is already written
  // relative to `start`, so shifting it is sufficient — no other change.
  // Round to millisecond precision BEFORE building any expression. The slide
  // interpolation math below subtracts/adds these values and interpolates them
  // straight into the ffmpeg filter string. Raw binary floats (startOffset =
  // word_vo_start − clip_vo_start) produce 16-digit tails like
  // `2.840019999999993`, and a long unrounded token inside the drawtext `x`
  // expression has been observed to trip the filtergraph lexer ("No such
  // filter: '2.840019999999993)'") and fail the whole render. ms precision is
  // far finer than any chyron timing needs.
  const r3 = (n: number) => Number(n.toFixed(3));
  const start = r3(Math.max(0, startOffsetSeconds));
  const slideIn = 0.4;
  const hold = 2.6;
  const slideOut = 0.4;
  const end = r3(start + slideIn + hold + slideOut);
  const slideInEnd = r3(start + slideIn);
  const holdEnd = r3(start + slideIn + hold);
  const fontPath = font.replace(/\\/g, "/").replace(/'/g, "\\'").replace(/:/g, "\\:");
  // Upper-case the text to match the broadcast chyron convention
  // ("PANG BOURNE IN BERKSHIRE"). Doing it here rather than in drawtext's
  // `text` expression keeps the filter graph simple and compatible with
  // ffmpeg 4.4 on the worker image.
  const escaped = escapeDrawtextValue(text.toUpperCase());

  // Layout. Box sits in the lower-third zone with a 60px left margin and a
  // ~12% bottom inset from frame height, matching the chyron-style mock the
  // client supplied. Padding (boxborderw) around the glyphs is generous so
  // the box reads as a label rather than a tight rectangle around the text.
  const fontsize = Math.round(height / 18);   // 40 at 720p — slightly larger
  const boxPad = Math.round(height / 30);     // 24 at 720p — chunky padding
  const leftMargin = 60;
  const bottomInset = Math.round(height * 0.12);
  // Y is the text baseline; the box extends boxborderw above and below.
  // Place the text so the box bottom edge sits `bottomInset` from frame
  // bottom: textY + textHeight + boxborderw ≈ h - bottomInset.
  // Drawtext exposes `text_h` at draw time, so anchor via expression.
  const yExpr = `h-${bottomInset}-text_h-${boxPad}`;

  // Slide-in from the left.
  //
  // The chip's left edge moves between two x positions:
  //   off-screen   = -(text_w + boxborderw*2)  — fully past the left edge
  //   rest         = leftMargin               — final chyron position
  //
  // Timing (matches the start/slideIn/hold/slideOut constants above):
  //   t <  start                    → fully off-screen
  //   start..start+slideIn         → linear ramp off → rest
  //   start+slideIn..+hold         → held at rest
  //   start+slideIn+hold..end      → linear ramp rest → off
  //   t >= end                      → fully off-screen
  //
  // We use ffmpeg's nested `if(lt(t,...), A, B)` so the expression is one
  // line and compatible with the worker's ffmpeg 4.4 expression evaluator
  // (no min/max chains, no `between()`).
  const offX = `-(text_w+${boxPad * 2})`;
  const restX = `${leftMargin}`;
  // (rest - off) * progress  +  off  → linear interpolation from off → rest
  const slideInExpr = `((${restX})-(${offX}))*((t-${start})/${slideIn})+(${offX})`;
  // (off - rest) * progress + rest  → linear interpolation from rest → off
  const slideOutExpr = `((${offX})-(${restX}))*((t-${holdEnd})/${slideOut})+(${restX})`;
  // Every comma INSIDE the expression must be escaped as `\,`. ffmpeg's
  // filtergraph parser treats a bare comma as the filter separator (the same
  // role as the comma in `scale=...,crop=...`), so an unescaped `lt(t,2.84)`
  // gets chopped at its comma and the orphaned `2.84)` is read as a (missing)
  // filter name — "No such filter: '2.84)'". The surrounding single quotes are
  // NOT reliable protection here because this string is also embedded into a
  // `-filter_complex` graph (the image/Ken Burns path), where the graph lexer
  // runs before option-level quote handling. Escaping the commas works in both
  // the `-vf` and `-filter_complex` paths — same fix already used for `tRamp`.
  const c = "\\,"; // escaped comma for use inside the expression
  const xExpr =
    `'if(lt(t${c}${start})${c}${offX}${c}` +
    `if(lt(t${c}${slideInEnd})${c}${slideInExpr}${c}` +
    `if(lt(t${c}${holdEnd})${c}${restX}${c}` +
    `if(lt(t${c}${end})${c}${slideOutExpr}${c}${offX}))))'`;

  // Blue (#1E5BC9) matches the reference screenshot; white bold text inside.
  // No alpha ramp — the chip is fully opaque whenever it's on-screen. The
  // motion is what reads as the entrance/exit effect.
  const filter = (
    `drawtext=fontfile='${fontPath}':text='${escaped}':` +
    `fontcolor=white:fontsize=${fontsize}:` +
    `box=1:boxcolor=0x1E5BC9:boxborderw=${boxPad}:` +
    `x=${xExpr}:y=${yExpr}`
  );
  // One-shot diagnostic: log the first filter string we build per process
  // so we can verify the exact drawtext arguments going to ffmpeg. After
  // we've confirmed the syntax works on the worker's ffmpeg 4.4, this can
  // be deleted.
  if (!ltFilterDebugLogged) {
    ltFilterDebugLogged = true;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      msg: "lower_third.filter.debug",
      text,
      fontPath,
      filter,
    }));
  }
  return filter;
}

let ltFilterDebugLogged = false;
const tcFilterDebugSeen = new Set<string>();

export async function normalizeClip(opts: NormalizeOptions): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  // ultrafast + crf 25 is the sweet spot for B-roll on shared CPU. We also
  // force a keyframe at frame 0 so every normalized segment starts with an
  // IDR — that's a hard prerequisite for the final concat to use -c:v copy
  // (mux-only, ~30s instead of ~15min for a 30-minute output).
  //
  // We deliberately DO NOT pass "-tune fastdecode" here, even though it
  // would slightly speed up the *next* ffmpeg pass: tune flags change SPS/PPS
  // in ways that can prevent stream-copy concat. Encoder params must match
  // exactly between normalizeClip() and buildStillVideo() for -c copy to work.
  let vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1:color=black,fps=${fps},setsar=1`;
  if (opts.lowerThird?.text) {
    const lt = await buildLowerThirdFilter(
      opts.lowerThird.text,
      h,
      opts.lowerThird.startOffsetSeconds ?? 0,
    );
    // If the host has no usable font, ship the clip without the overlay
    // rather than failing the render. The match.lower_thirds log already
    // tells operators a lower-third was requested.
    if (lt) vf = `${vf},${lt}`;
  }
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    // Input-side seek past the copy-cut's keyframe head excess. Accurate
    // here (unlike in cutClip) because this pass decodes anyway.
    ...(typeof opts.startOffsetSeconds === "number" && opts.startOffsetSeconds > 0
      ? ["-ss", String(opts.startOffsetSeconds)]
      : []),
    "-i", opts.inputPath,
    ...(opts.keepAudio ? ["-c:a", "aac"] : ["-an"]),
    "-vf", vf,
    ...(opts.vcodecArgs ?? SOURCED_VCODEC_ARGS),
    "-r", String(fps),
    "-force_key_frames", "expr:eq(n,0)",
    // Trim the copy-cut's GOP overshoot back to the asked length. Placed
    // before -movflags so it caps the muxed output. Emitted only when the
    // caller pins a target (the footage path); image/title callers leave it
    // undefined and keep their exact builder length.
    //
    // pinFrames wins over pinDurationSeconds: `-t` keeps every frame whose PTS
    // starts before t, so a mid-frame duration emits ONE MORE frame than the
    // caller intended (the +33ms-per-block leak measured 2026-07-17 in
    // render.concat.timeline — +2.36s of excess video on a 250-block synthetic
    // render, silently chopped off the tail by the final mux). `-frames:v`
    // emits an exact count and has no such ambiguity.
    ...(typeof opts.pinFrames === "number" && opts.pinFrames > 0
      ? ["-frames:v", String(Math.round(opts.pinFrames))]
      : typeof opts.pinDurationSeconds === "number" && opts.pinDurationSeconds > 0
        ? ["-t", String(opts.pinDurationSeconds)]
        : []),
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Palette of xfade transitions we use between consecutive image segments. The
// renderer rotates through this list deterministically by boundary index so a
// long slideshow doesn't repeat the same dissolve every time. All names are
// ffmpeg xfade `transition=` values (https://ffmpeg.org/ffmpeg-filters.html#xfade).
export const IMAGE_XFADE_PALETTE = [
  "fade",
  "fadeblack",
  "slideleft",
  "slideright",
  "wiperight",
  "circleopen",
] as const;
export type XfadeStyle = (typeof IMAGE_XFADE_PALETTE)[number];

// Crossfade two already-normalized segments into a single segment. Used only
// for image→image boundaries so consecutive stills dissolve into each other
// instead of hard-cutting. The two inputs MUST share codec params with
// normalizeClip/buildStillVideo — they do, since both inputs come from
// buildStillVideo. Output is re-encoded with the same params, so the merged
// segment is still concat-compatible with -c:v copy in the final mux.
//
// The xfade filter requires an explicit `offset` measured from the start of
// input A: the transition begins at `offset` and lasts `duration` seconds,
// during which A fades out while B fades in. Total output length is
// (durA + durB - duration). Caller is responsible for having rendered A and B
// with `duration` seconds of headroom baked in, so the visible hold time of
// each image matches the planned timeline duration.
export async function xfadePair(opts: {
  inputAPath: string;
  inputBPath: string;
  outputPath: string;
  inputADurationSeconds: number;
  transitionDurationSeconds: number;
  style?: XfadeStyle;
  fps?: number;
  vcodecArgs?: string[];
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const fps = opts.fps ?? 30;
  const style: XfadeStyle = opts.style ?? "fade";
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const xfadeOffset = Math.max(0, opts.inputADurationSeconds - opts.transitionDurationSeconds);
  // Keep encoder flags byte-identical to normalizeClip / buildStillVideo so the
  // merged segment stays stream-copy-concatable downstream. Forcing a keyframe
  // at frame 0 is essential — without it the final concat falls back to a
  // re-encode (or fails outright on strict demuxers).
  const filter =
    `[0:v]settb=AVTB,fps=${fps},setsar=1[a];` +
    `[1:v]settb=AVTB,fps=${fps},setsar=1[b];` +
    `[a][b]xfade=transition=${style}:duration=${opts.transitionDurationSeconds}:offset=${xfadeOffset},format=yuv420p[v]`;
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-i", opts.inputAPath,
    "-i", opts.inputBPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-an",
    ...(opts.vcodecArgs ?? SOURCED_VCODEC_ARGS),
    "-r", String(fps),
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Merge two normalized segments through a dip-to-black transition in a single
// libx264 pass. Used at image↔video and video↔image boundaries: the tail of A
// fades to black while the head of B fades from black, meeting at full black
// at the boundary midpoint. Replaces the older two-pass approach (tail
// re-encode + head re-encode) — same visual result, half the encode work.
//
// Caller is responsible for pre-baking `transitionDurationSeconds / 2` of
// headroom on the image side (see renderProcessor's image-block headroom
// logic). The video side keeps its exact cut length: xfade just multiplies
// the last `transitionDurationSeconds` frames of A toward black and the
// first frames of B from black, no extra frames consumed.
//
// Encoder flags match normalizeClip / buildStillVideo so the merged segment
// remains stream-copy-concatable in the final mux.
export async function xfadeFadeBlack(opts: {
  inputAPath: string;
  inputBPath: string;
  outputPath: string;
  inputADurationSeconds: number;
  transitionDurationSeconds: number;
  fps?: number;
  vcodecArgs?: string[];
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const fps = opts.fps ?? 30;
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const xfadeOffset = Math.max(0, opts.inputADurationSeconds - opts.transitionDurationSeconds);
  // `transition=fadeblack` is the xfade built-in that does exactly the visual
  // we want — A multiplies toward black, B multiplies from black, with peak
  // darkness at the midpoint. No separate fade filters needed.
  const filter =
    `[0:v]settb=AVTB,fps=${fps},setsar=1[a];` +
    `[1:v]settb=AVTB,fps=${fps},setsar=1[b];` +
    `[a][b]xfade=transition=fadeblack:duration=${opts.transitionDurationSeconds}:offset=${xfadeOffset},format=yuv420p[v]`;
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-i", opts.inputAPath,
    "-i", opts.inputBPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-an",
    ...(opts.vcodecArgs ?? SOURCED_VCODEC_ARGS),
    "-r", String(fps),
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Burn a fade-out at the tail and/or a fade-in at the head of an already-
// normalized segment. Used at image↔video boundaries so the still doesn't
// hard-cut into footage (and vice versa). Unlike xfadePair this does NOT need
// a partner segment or extra headroom — it just darkens the existing frames
// at the edge, so it's safe to apply to a video clip we cut to exact length
// without re-cutting with overlap.
//
// The resulting segment is the same length as the input (a tail fade does
// not shorten the clip — frames are still emitted, they're just multiplied
// toward black). Encoder flags match normalizeClip / buildStillVideo so the
// segment stays concat-compatible with -c:v copy.
export async function applyEdgeFade(opts: {
  inputPath: string;
  outputPath: string;
  inputDurationSeconds: number;
  fadeInSeconds?: number;    // 0 disables; default 0
  fadeOutSeconds?: number;   // 0 disables; default 0
  fps?: number;
  vcodecArgs?: string[];
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const fps = opts.fps ?? 30;
  const fadeIn = Math.max(0, opts.fadeInSeconds ?? 0);
  const fadeOut = Math.max(0, opts.fadeOutSeconds ?? 0);
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  // Build the filter chain. Use ffmpeg's `fade` filter which multiplies pixel
  // values toward black over a window. `st` = start time, `d` = duration.
  // A tail fade-out starts at (inputDur - fadeOut). Both fades coexist fine
  // when chained.
  const parts: string[] = [`fps=${fps}`, `setsar=1`];
  if (fadeIn > 0) parts.push(`fade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) {
    const start = Math.max(0, opts.inputDurationSeconds - fadeOut);
    parts.push(`fade=t=out:st=${start}:d=${fadeOut}`);
  }
  parts.push("format=yuv420p");
  const vf = parts.join(",");
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-i", opts.inputPath,
    "-an",
    "-vf", vf,
    ...(opts.vcodecArgs ?? SOURCED_VCODEC_ARGS),
    "-r", String(fps),
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

export interface SfxCue {
  // Local file path to a short audio clip (any audio/* ffmpeg can decode).
  path: string;
  // Timeline position to play the cue at, in seconds, measured from the
  // start of the final video (i.e. INCLUDING any intro that gets prepended).
  atSeconds: number;
  // 0..1, defaults to 0.7. Sits above bg music (0.15) but under voiceover (1.0).
  gain?: number;
}

export interface ConcatOptions {
  inputPaths: string[]; // already-normalized clips, same codec/res/fps
  outputPath: string;
  voiceoverPath?: string;     // optional audio overlay
  voiceoverGain?: number;     // 0..1
  bgMusicPath?: string;       // optional background bed
  bgMusicGain?: number;       // 0..1, default 0.15
  // Intro audio segment — plays for the first introDurationSeconds of the
  // final video, with a 0.3s crossfade into the voiceover. The intro VIDEO
  // is expected to already be the first item in inputPaths; this option
  // controls only the audio side.
  introAudioPath?: string;
  introDurationSeconds?: number;
  // Optional one-shot SFX cues layered on top of the final audio mix at
  // specific timeline offsets. Each cue is added as its own ffmpeg input,
  // padded to its start time via adelay, then merged into the existing
  // voiceover/bg-music output.
  sfxCues?: SfxCue[];
  // Outro audio fade in seconds. When set, the final audio mix fades to
  // silence over the last `outroFadeSeconds` of the output. The video-side
  // fade-to-black is applied by the caller before concat (so concat can keep
  // the cheap -c:v copy mux), but the audio fade lives here because the mix
  // graph is the only place the final track exists. Caller must pass the
  // total output duration so afade knows when to start.
  outroFadeSeconds?: number;
  outroFadeStartSeconds?: number;
  // Total video timeline duration in seconds (intro + all merged segments).
  // When provided, the audio mix is padded with apad to match this length and
  // the encoder uses `-t` to pin output duration instead of `-shortest`. This
  // prevents the audio from getting truncated when the mix is fractionally
  // shorter than the video — e.g. the intro acrossfade trims 0.3s from the
  // voiceover tail, which used to make `-shortest` cut the last few seconds
  // of narration off the final file.
  totalVideoDurationSeconds?: number;
  signal?: AbortSignal;
  // Fired on each ffmpeg stderr status line so the caller can heartbeat job
  // liveness during this (long) re-encode pass. See runFFmpeg's onProgress.
  onProgress?: () => void;
}

export async function concatNormalizedClips(opts: ConcatOptions): Promise<void> {
  const env = getEnv();
  if (opts.inputPaths.length === 0) throw new Error("concat: no inputs");
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  const listPath = `${opts.outputPath}.concat.txt`;
  // ffmpeg's concat demuxer resolves `file` entries relative to the list
  // file's directory, so we must write absolute paths here — otherwise a
  // relative outputPath causes the list dir to be prepended twice.
  const listBody = opts.inputPaths
    .map((p) => `file '${path.resolve(p).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listPath, listBody, "utf8");

  // We re-encode during concat to dodge the strict-codec requirements of -c copy.
  const args: string[] = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
  ];

  // Concat input is silent video (clips are normalized with -an). Final audio
  // is always built from external sources only: voiceover + optional bg music.
  // We never read audio from input 0.
  const hasIntro = !!(opts.introAudioPath && opts.introDurationSeconds && opts.introDurationSeconds > 0);
  let audioMap: string[] = [];
  let hasAudioOutput = false;
  // Background music behavior: loop forever via `-stream_loop -1` (input-side,
  // before -i) so a short bed repeats to cover the full voiceover. In the
  // filter graph we mix with `duration=first` keyed on the voiceover/main
  // mix, which means a long bed gets cut at the voiceover's end instead of
  // extending the audio past the video. The final encode's `-shortest` then
  // pins everything to the silent-video length as a final guard.
  if (hasIntro && opts.voiceoverPath) {
    // Intro mode: input 0 = silent video, 1 = intro audio, 2 = voiceover,
    // (3 = bg music if provided). Final audio plays the intro for the first
    // introDurationSeconds, then the voiceover starts EXACTLY at intro end —
    // no overlap (FIX #1).
    //
    // The old build used `acrossfade=d=0.3`, which OVERLAPS the two streams:
    // the voiceover began 0.3s BEFORE intro end and the combined length was
    // introDur + voiceoverDur - 0.3s. The client needs the narrator to start
    // precisely when the intro music ends, so we instead:
    //   • trim the intro to introDur and fade its tail out over 0.2s so the
    //     cut to the voiceover isn't a hard click,
    //   • delay the voiceover by introDur (adelay) so it begins at intro end,
    //     with a tiny 0.15s fade-in to soften its head,
    //   • amix the two non-overlapping streams (duration=longest) so the
    //     combined length is introDur + voiceoverDur (no deduction).
    const introDur = opts.introDurationSeconds!;
    const introDurMs = Math.round(introDur * 1000);
    const introFadeOut = 0.2;
    const introFadeStart = Math.max(0, introDur - introFadeOut);
    const voFadeIn = 0.15;
    args.push("-i", opts.introAudioPath!);
    args.push("-i", opts.voiceoverPath);
    let filter = "";
    // Trim intro audio to its declared duration so a longer source file
    // can't bleed into the voiceover section, then fade its tail out.
    filter += `[1:a]atrim=duration=${introDur},asetpts=PTS-STARTPTS,volume=1.0,afade=t=out:st=${introFadeStart.toFixed(3)}:d=${introFadeOut}[intro];`;
    // Delay the voiceover so it starts exactly at intro end (introDur), with a
    // short fade-in beginning at introDur to avoid a hard onset.
    filter += `[2:a]volume=${opts.voiceoverGain ?? 1.0},asetpts=PTS-STARTPTS,adelay=${introDurMs}|${introDurMs},afade=t=in:st=${introDur.toFixed(3)}:d=${voFadeIn}[vo];`;
    // No overlap: intro plays 0..introDur, voiceover plays introDur..end.
    filter += `[intro][vo]amix=inputs=2:duration=longest:dropout_transition=0[mainmix]`;
    if (opts.bgMusicPath) {
      args.push("-stream_loop", "-1", "-i", opts.bgMusicPath);
      // Bg music must NOT play during the intro — only the intro audio is
      // heard for the first introDur seconds. Now that there's no crossfade,
      // the bg music starts exactly at intro end (introDur), fading in over a
      // short window matching the voiceover's onset.
      const bgStart = introDur;
      const bgStartMs = Math.round(bgStart * 1000);
      filter += `;[3:a]asetpts=PTS-STARTPTS,volume=${opts.bgMusicGain ?? 0.15},adelay=${bgStartMs}|${bgStartMs}:all=1,afade=t=in:st=${bgStart.toFixed(3)}:d=${voFadeIn}[bg];`;
      filter += `[mainmix][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
    } else {
      filter += `;[mainmix]anull[aout]`;
    }
    args.push("-filter_complex", filter);
    audioMap = ["-map", "0:v:0", "-map", "[aout]"];
    hasAudioOutput = true;
  } else if (opts.voiceoverPath && opts.bgMusicPath) {
    args.push("-i", opts.voiceoverPath);
    args.push("-stream_loop", "-1", "-i", opts.bgMusicPath);
    // input 0 = silent video, 1 = voiceover, 2 = bg music (looped).
    // duration=first → mix length = voiceover length, so a long bed is
    // cut at voiceover end and a short bed loops to fill.
    args.push(
      "-filter_complex",
      `[1:a]volume=${opts.voiceoverGain ?? 1.0}[vo];` +
      `[2:a]volume=${opts.bgMusicGain ?? 0.15}[bg];` +
      `[vo][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`
    );
    audioMap = ["-map", "0:v:0", "-map", "[aout]"];
    hasAudioOutput = true;
  } else if (opts.voiceoverPath) {
    args.push("-i", opts.voiceoverPath);
    audioMap = ["-map", "0:v:0", "-map", "1:a:0"];
    hasAudioOutput = true;
  } else if (opts.bgMusicPath) {
    // No voiceover: bg music carries the whole video. Loop it; -shortest
    // on the encoder pins length to the silent video.
    args.push("-stream_loop", "-1", "-i", opts.bgMusicPath);
    args.push(
      "-filter_complex",
      `[1:a]volume=${opts.bgMusicGain ?? 0.15}[bg]`
    );
    audioMap = ["-map", "0:v:0", "-map", "[bg]"];
    hasAudioOutput = true;
  } else {
    // No external audio at all — produce a silent video (SFX-only case is
    // handled below as a graft onto this branch).
    audioMap = ["-map", "0:v:0"];
  }

  // SFX cues: each cue becomes an extra input, padded to its start time via
  // adelay. Cues are summed into [sfxmix], then folded into the existing
  // audio output. When there's no other audio (silent video), we synthesize
  // a silent base via anullsrc so the cues have something to mix onto and
  // the encoder still gets a stereo audio stream of the correct duration.
  const sfxCues = (opts.sfxCues ?? []).filter((c) => c && c.path && Number.isFinite(c.atSeconds) && c.atSeconds >= 0);
  if (sfxCues.length > 0) {
    // Track the audio-input index ffmpeg will assign to each SFX file.
    // Inputs added so far (input 0 is always the concat list):
    //   - hasIntro+voiceover branch: intro=1, voiceover=2, [bg=3]
    //   - voiceover+bg branch: voiceover=1, bg=2
    //   - voiceover only branch: voiceover=1
    //   - bg only branch: bg=1
    //   - silent branch: (none beyond input 0)
    // Walk the existing args to find the count of -i flags so we don't have
    // to maintain a parallel counter.
    let inputCount = 0;
    for (const a of args) if (a === "-i") inputCount++;

    // Append SFX inputs.
    for (const cue of sfxCues) {
      args.push("-i", cue.path);
    }

    // Find the existing -filter_complex (if any) and append the SFX graph
    // to it. If there isn't one yet (voiceover-only or silent branches),
    // we'll add one.
    const filterIdx = args.indexOf("-filter_complex");
    const existingFilter = filterIdx >= 0 ? args[filterIdx + 1] : "";

    // Per-cue: delay to start time, set per-cue gain.
    const cueLabels: string[] = [];
    let sfxGraph = "";
    sfxCues.forEach((cue, i) => {
      const ffIdx = inputCount + i;
      const delayMs = Math.max(0, Math.round(cue.atSeconds * 1000));
      const gain = cue.gain ?? 0.7;
      const label = `sfx${i}`;
      // adelay pads with silence on every channel; all=1 covers stereo without
      // having to know the source layout. apad lets a very short cue sit in an
      // amix that's keyed off a longer track without being cut prematurely.
      sfxGraph += `[${ffIdx}:a]adelay=${delayMs}:all=1,volume=${gain}[${label}];`;
      cueLabels.push(`[${label}]`);
    });

    // Sum SFX cues into [sfxmix]. amix with normalize=0 keeps each cue at its
    // tagged volume instead of dividing by N.
    if (cueLabels.length === 1) {
      sfxGraph += `${cueLabels[0]}anull[sfxmix]`;
    } else {
      sfxGraph += `${cueLabels.join("")}amix=inputs=${cueLabels.length}:duration=longest:normalize=0[sfxmix]`;
    }

    if (hasAudioOutput) {
      // Existing graph produces [aout]. Rewire its output label to [aoutpre]
      // and graft an amix that adds SFX on top, re-emitting [aout].
      // duration=first keys the final length to [aoutpre] (the voiceover/bg
      // mix) so SFX at the tail can't extend audio past the video.
      //
      // Voiceover-only branch is special: it has no -filter_complex at all
      // and maps 1:a:0 directly. In that case we have to synthesize the
      // [aoutpre] label from 1:a:0 ourselves — otherwise the filter graph
      // starts with a bare ";" (parsed as an empty filter → "No such filter:
      // ''") and the amix references an undefined [aoutpre] label.
      let baseFilter: string;
      if (filterIdx >= 0) {
        baseFilter = existingFilter.replace(/\[aout\]\s*$/, "[aoutpre]");
      } else {
        baseFilter = `[1:a:0]anull[aoutpre]`;
        audioMap = ["-map", "0:v:0", "-map", "[aout]"];
      }
      const newFilter =
        baseFilter +
        (baseFilter.endsWith(";") ? "" : ";") +
        sfxGraph +
        `;[aoutpre][sfxmix]amix=inputs=2:duration=first:normalize=0[aout]`;
      if (filterIdx >= 0) {
        args[filterIdx + 1] = newFilter;
      } else {
        args.push("-filter_complex", newFilter);
      }
    } else {
      // Silent base case: synthesize a silent stereo track using anullsrc,
      // sized to the video duration via -shortest at the encoder, then mix
      // SFX on top. We can't reference 0:a because input 0 (concat) has no
      // audio. Using a lavfi anullsrc input means an extra -i, which would
      // bump every later input index — so add it BEFORE the SFX inputs we
      // just appended. Easiest: rebuild the SFX indices off (inputCount+1).
      // To avoid the rebuild, splice the anullsrc input in at the right spot.
      const anullIdx = inputCount;
      // Insert anullsrc input ahead of the SFX inputs we just pushed.
      // SFX inputs were appended starting at position (args.length - 2*sfxCues.length).
      const sfxInsertAt = args.length - 2 * sfxCues.length;
      args.splice(sfxInsertAt, 0, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      // SFX indices shift up by 1 because of the inserted anullsrc input.
      const shiftedSfxGraph = sfxGraph.replace(/\[(\d+):a\]/g, (_m, n) => `[${Number(n) + 1}:a]`);
      const filter =
        shiftedSfxGraph +
        `;[${anullIdx}:a][sfxmix]amix=inputs=2:duration=first:normalize=0[aout]`;
      args.push("-filter_complex", filter);
      audioMap = ["-map", "0:v:0", "-map", "[aout]"];
      hasAudioOutput = true;
    }
  }

  // Outro audio fade: apply afade to the final audio output so the mix
  // doesn't get hard-cut by -shortest at the same moment the video fades
  // to black. Two cases:
  //   1) There's already a -filter_complex (every branch except voiceover-
  //      only-no-SFX). Rewire its [aout] label to [aoutpre2] and append
  //      afade — same splice pattern the SFX path uses.
  //   2) Voiceover-only-no-SFX maps 1:a:0 directly. Add a tiny graph that
  //      fades input 1's audio and remap to [aout].
  // No-op when outroFadeSeconds or outroFadeStartSeconds is missing/zero,
  // or when there's no audio output to fade.
  const outroFade = Math.max(0, opts.outroFadeSeconds ?? 0);
  const outroFadeStart = Math.max(0, opts.outroFadeStartSeconds ?? 0);
  if (outroFade > 0 && hasAudioOutput && outroFadeStart > 0) {
    const filterIdx2 = args.indexOf("-filter_complex");
    if (filterIdx2 >= 0) {
      const existing = args[filterIdx2 + 1];
      const rerouted = existing.replace(/\[aout\]\s*$/, "[aoutpre2]");
      args[filterIdx2 + 1] =
        rerouted +
        (rerouted.endsWith(";") ? "" : ";") +
        `[aoutpre2]afade=t=out:st=${outroFadeStart}:d=${outroFade}[aout]`;
    } else {
      // Voiceover-only-no-SFX. Build a tiny graph and rewire audioMap.
      args.push(
        "-filter_complex",
        `[1:a]afade=t=out:st=${outroFadeStart}:d=${outroFade}[aout]`,
      );
      for (let k = 0; k < audioMap.length - 1; k++) {
        if (audioMap[k] === "-map" && audioMap[k + 1] === "1:a:0") {
          audioMap[k + 1] = "[aout]";
          break;
        }
      }
    }
  }

  // Pad the final audio mix with silence so it can never be the limiting
  // stream at encode time. Two ways the mix can come up short vs the video:
  //   (a) the intro acrossfade subtracts 0.3s from voiceover+intro
  //   (b) per-clip duration rounding leaves small gaps the reclaim step
  //       couldn't fully absorb
  // Without a pad, the encoder's -shortest would clip the final seconds of
  // narration off the file (audio ends at 9:54 even though the video and
  // voiceover are both 10:00). apad with whole_dur lets us extend to the
  // exact video length; the encoder then uses -t to pin the output. apad
  // must come AFTER afade so we don't fade into silence we just added.
  const totalDur = opts.totalVideoDurationSeconds ?? 0;
  if (hasAudioOutput && totalDur > 0) {
    const filterIdx3 = args.indexOf("-filter_complex");
    if (filterIdx3 >= 0) {
      const existing = args[filterIdx3 + 1];
      const rerouted = existing.replace(/\[aout\]\s*$/, "[aoutpre3]");
      args[filterIdx3 + 1] =
        rerouted +
        (rerouted.endsWith(";") ? "" : ";") +
        `[aoutpre3]apad=whole_dur=${totalDur.toFixed(3)}[aout]`;
    } else {
      // Voiceover-only-no-SFX, no outro fade. Same rewire pattern as above.
      args.push(
        "-filter_complex",
        `[1:a]apad=whole_dur=${totalDur.toFixed(3)}[aout]`,
      );
      for (let k = 0; k < audioMap.length - 1; k++) {
        if (audioMap[k] === "-map" && audioMap[k + 1] === "1:a:0") {
          audioMap[k + 1] = "[aout]";
          break;
        }
      }
    }
  }

  // Final concat: stream-copy the video (no re-encode). All input segments
  // are already H.264 1280x720 30fps yuv420p with identical encoder params
  // (see normalizeClip + buildStillVideo) and start with an IDR keyframe,
  // which is exactly what the concat demuxer needs for -c:v copy to work.
  //
  // On shared-cpu-4x this changes the concat call from a ~15 minute libx264
  // pass on 30 minutes of 720p output to a ~30 second mux. The audio side
  // still has to be encoded because we mix voiceover + bg music + intro
  // crossfade live in the filter graph — that work is unavoidable.
  //
  // If a future code path emits a non-conforming segment, ffmpeg will fail
  // with "non monotonically increasing dts" or similar. The fix is to
  // either re-encode that path through normalizeClip first, or fall back
  // to re-encoding here. We don't fall back automatically because a silent
  // 15× slowdown is worse than a clear failure.
  args.push(
    ...audioMap,
    "-c:v", "copy",
  );
  if (hasAudioOutput) {
    args.push("-c:a", "aac", "-b:a", "192k");
    // When the caller passed totalVideoDurationSeconds we apad'd the audio
    // to that exact length, so pin output duration with -t. Falling back to
    // -shortest only when the duration is unknown preserves the old behavior
    // for any caller that hasn't been updated.
    if (totalDur > 0) {
      args.push("-t", totalDur.toFixed(3));
    } else {
      args.push("-shortest");
    }
  } else {
    args.push("-an");
  }
  args.push("-movflags", "+faststart", opts.outputPath);

  try {
    await runFFmpeg(env.FFMPEG_PATH, args, opts.signal, undefined, opts.onProgress);
  } finally {
    try { await fs.unlink(listPath); } catch { /* ignore */ }
  }
}

// Screen-blend a looping effect clip over an already-finished MP4. Run as a
// post-pass on the concat output (final_<projectId>.mp4). The effect is a
// short clip of bright particles/dust/flares on a PURE-BLACK background;
// `blend=all_mode=screen` keeps only the bright pixels and makes the black
// background vanish, so the particles float over the content with no dark
// wash. Black contributes nothing under screen, so even high opacity is safe.
//
// Compositing two video layers is impossible with -c:v copy, so this RE-
// ENCODES the video (one libx264 pass over the whole timeline). Audio is
// stream-copied — the finished mix already lives in the input file.
//
// The effect is looped on the input side (-stream_loop -1) to cover videos
// longer than the effect clip; `shortest=1` on the blend pins the output to
// the base video's length so the looped (effectively infinite) effect can't
// extend it. Scale + setsar + fps match the effect to the base stream so the
// blend lines up frame-for-frame.
export async function overlayEffectVideo(opts: {
  inputPath: string;       // finished MP4 to overlay onto
  effectPath: string;      // the effect clip (particles on black)
  outputPath: string;
  width?: number;          // default 1280
  height?: number;         // default 720
  fps?: number;            // default 30
  opacity?: number;        // 0..1, default 0.7
  gain?: number;           // >=1 pre-blend brightness boost on particles, default 1.0
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  const opacity = Math.min(1, Math.max(0, opts.opacity ?? 0.7));
  const gain = Math.max(1, opts.gain ?? 1.0);
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  // Screen-blend in RGB, NOT YUV. This is the crux of getting the color right.
  //
  // `blend=all_mode=screen` operates per-plane on whatever the input format is.
  // In YUV that means it screens the CHROMA planes (U,V) too — and screening
  // chroma pushes U/V toward 255 wherever the effect's chroma isn't perfectly
  // neutral, tinting the ENTIRE base video a flat color (the magenta/pink wash
  // bug we hit). Per-plane YUV tricks don't fix it cleanly: forcing U/V to
  // `normal` at opacity 0 doesn't pass the base chroma through — blend emits
  // neutral 128, i.e. a GRAYSCALE video.
  //
  // Converting both layers to RGB (gbrp) and screening there is the correct,
  // standard recipe. Screen on RGB is `255 - (255-base)*(255-fx)/255` per R,G,B
  // channel: a BLACK effect pixel (0,0,0) leaves the base exactly unchanged, and
  // a WHITE/gray particle (R=G=B) adds equal light to all channels — which is a
  // pure brightness lift with NO hue shift. Verified on the client asset: base
  // chroma is preserved (UAVG/VAVG within ~0.4 of the source) while luma rises
  // where particles land. Output is converted back to yuv420p so the encode
  // matches the rest of the pipeline.
  //
  // BLACK-FLOOR (lutyuv on Y, applied while still in YUV before the gbrp
  // conversion): screen lifts the base by ANY non-zero effect value, and real
  // exports are limited-range (TV) — their "black" sits at luma ~16, not 0 —
  // which would add a uniform ~6% veil. Map luma at/below BLACK_FLOOR to 0 so
  // only genuine bright specks survive; pin chroma to neutral 128 so the floored
  // background carries no color into the RGB conversion. BLACK_FLOOR=24 clears
  // the ~16 TV-black floor with headroom for compression noise while staying far
  // below particle brightness (measured YMAX ~125 on the client asset).
  //
  // GAIN: above the floor the luma is multiplied by `gain` (clamped to 255) so
  // particles read brighter/whiter and survive even on bright scenes — plain
  // screen vanishes as the base nears white, and opacity alone can't fix that.
  // Background pixels are already 0 (floored), and 0 × gain = 0, so the boost
  // never re-adds a veil. gain=1.0 is a no-op (original brightness).
  const BLACK_FLOOR = 24;
  const g = gain.toFixed(3);
  // min(255, val*gain) above the floor, 0 at/below it. `*` and `,` inside the
  // expression are escaped for the filtergraph lexer.
  const fxBlackFloor =
    `lutyuv=y='if(lte(val\\,${BLACK_FLOOR})\\,0\\,min(255\\,val*${g}))':u=128:v=128`;
  const op = opacity.toFixed(3);
  const filter =
    `[1:v]scale=${w}:${h},setsar=1,fps=${fps},${fxBlackFloor},format=gbrp[fx];` +
    `[0:v]format=gbrp[bg];` +
    `[bg][fx]blend=all_mode=screen:all_opacity=${op}:shortest=1,format=yuv420p[v]`;

  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-i", opts.inputPath,
    "-stream_loop", "-1", "-i", opts.effectPath,
    "-filter_complex", filter,
    "-map", "[v]",
    // Keep the finished audio mix if the input has one (silent renders won't).
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-c:a", "copy",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Low-fi "vlogging" video degrade (client requirement 2026-06). One re-encode
// pass over the finished video that lowers TEXTURE quality — grain, a touch of
// softness, and stronger compression — so the footage reads as a real phone
// vlog instead of a clean AI render. RESOLUTION IS UNCHANGED (the client still
// wants 1080p): we scale to the same w×h and only degrade quality, never size.
//
// Filter chain:
//   gblur=sigma   — subtle softness (skipped when sigma<=0)
//   noise=alls=N  — luminance grain with temporal variation (allf=t), the real-
//                   sensor-noise feel AI never adds (skipped when N<=0)
// Stronger compression comes from running libx264 at SYNTHETIC_X264_CRF +
// VIDEO_CRF_DELTA. Audio is stream-copied — the mix is already baked in.
export async function degradeVideoLowFi(opts: {
  inputPath: string;
  outputPath: string;
  width?: number;   // default 1920
  height?: number;  // default 1080
  fps?: number;     // default 30
  signal?: AbortSignal;
  onProgress?: () => void;
}): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1920;
  const h = opts.height ?? 1080;
  const fps = opts.fps ?? 30;
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  const blur = env.SYNTHETIC_DEGRADE_BLUR_SIGMA;
  const noise = env.SYNTHETIC_DEGRADE_VIDEO_NOISE;
  const crf = Math.min(51, env.SYNTHETIC_X264_CRF + env.SYNTHETIC_DEGRADE_VIDEO_CRF_DELTA);

  const vf = [
    `scale=${w}:${h}`,
    `fps=${fps}`,
    ...(blur > 0 ? [`gblur=sigma=${blur.toFixed(2)}`] : []),
    ...(noise > 0 ? [`noise=alls=${Math.round(noise)}:allf=t`] : []),
    "format=yuv420p",
  ].join(",");

  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-i", opts.inputPath,
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", env.SYNTHETIC_X264_PRESET,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-c:a", "copy",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal, undefined, opts.onProgress);
}

// AI-GENERATED SALES PITCH (migration 0026). Normalize ONE source video (the
// HeyGen avatar clip, or the website scroll-recording .webm) into a canvas-sized
// H.264 mp4 for the pitch concat. Unlike normalizeClip (which is -an, for the
// silent render timeline), this KEEPS or SYNTHESIZES an audio track so the two
// pitch parts can be concatenated with their own audio intact:
//   • keepAudio=true  → copy the source's audio, re-encoded to AAC (the avatar
//                       clip carries the pitch TTS narration).
//   • keepAudio=false → attach a SILENT AAC track (the website scroll has no
//                       audio, but the concat needs every part to have a matching
//                       stream layout or it drops audio partway through).
// scale-to-fit + pad keeps the real aspect ratio (a portrait avatar or an
// oversized website capture is letterboxed, never stretched). The output codec
// is a plain, widely-compatible H.264/AAC mp4 — this file is a standalone pitch
// video (it becomes pitch_video_url), NOT a segment in the -c:v copy render
// concat, so it does not need to match segmentVcodecArgs.
export async function buildPitchClip(opts: {
  inputPath: string;
  outputPath: string;
  keepAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  // Trim this many seconds off the FRONT of the input (input-side -ss seek).
  // Used for the website recording, whose front holds static top-of-page dead-
  // air (page load + settle) before the scroll begins — the recorder reports the
  // scroll-start offset so we open the clip on the motion, not the dead-air.
  startSeconds?: number;
  // Pin the output to EXACTLY this many seconds. The client rule is that the
  // pitch always shows the website for a fixed window (default 10s) at the end,
  // so the website clip must be exactly that long: if the (trimmed) recording is
  // longer it's cut to length; if it's a touch shorter its last frame is held
  // (tpad=clone) up to the target. Ignored when unset (natural length).
  durationSeconds?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  const seek = opts.startSeconds && opts.startSeconds > 0 ? ["-ss", opts.startSeconds.toFixed(3)] : [];
  const pinDur = opts.durationSeconds && opts.durationSeconds > 0 ? opts.durationSeconds : null;
  // When pinning an exact duration, hold the last frame (tpad clone) so a
  // slightly-short recording fills the full window, then the output-side -t caps
  // it. When not pinning, no tpad and no -t.
  const vfBase = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1:color=black,fps=${fps},setsar=1`;
  const vf = pinDur ? `${vfBase},tpad=stop_mode=clone:stop_duration=${pinDur.toFixed(3)}` : vfBase;
  const durArgs = pinDur ? ["-t", pinDur.toFixed(3)] : [];
  const args: string[] = ["-y", "-threads", String(env.FFMPEG_THREADS)];
  if (opts.keepAudio) {
    // Input 0 supplies both video and its own audio. -ss before -i seeks the input.
    args.push(...seek, "-i", opts.inputPath, "-vf", vf, "-c:a", "aac", "-b:a", "160k");
  } else {
    // Input 0 = video only (seeked); input 1 = a synthesized silent stereo track.
    // With a pinned duration, -t caps both streams; otherwise -shortest keys the
    // (infinite) silent track off the video length.
    args.push(
      ...seek, "-i", opts.inputPath,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", vf,
      "-c:a", "aac", "-b:a", "160k",
      ...(pinDur ? [] : ["-shortest"]),
    );
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    ...durArgs,
    "-movflags", "+faststart",
    opts.outputPath,
  );
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// AI-GENERATED SALES PITCH (migration 0026). Concatenate the pitch parts (avatar
// clip, then website scroll-recording) into ONE mp4. Uses the concat FILTER (not
// the demuxer) with a re-encode so parts that differ slightly in codec params
// still join cleanly. All inputs must already be canvas-sized with an audio track
// (produced by buildPitchClip), which the filter assumes.
//
// Audio comes in two modes:
//   • default              → each part contributes its OWN audio (concat v=1:a=1).
//   • masterAudioPath set  → the parts' audio is IGNORED and this single track
//                            (the pitch TTS narration) plays continuously across
//                            the whole video, so the voiceover keeps going over
//                            the website scroll instead of cutting to silence.
//                            The track is silence-padded (apad) and keyed off the
//                            video length, so a narration slightly shorter than
//                            the video never truncates the final frames.
export async function concatPitchParts(opts: {
  inputPaths: string[];
  outputPath: string;
  masterAudioPath?: string;
  // Known TOTAL output length (seconds) = sum of the part durations. Only used
  // with masterAudioPath: it bounds the narration's silence-pad and caps the
  // encode with an explicit `-t`, so the pass ENDS deterministically instead of
  // relying on `-shortest`. On the worker's ffmpeg 5.1 (Debian 12), `-shortest`
  // does NOT reliably stop a video-only concat fed by an `apad`-padded (infinite)
  // audio track — ffmpeg keeps encoding silence past the video and the job dies
  // at the FFMPEG_TIMEOUT_SECONDS watchdog (240s). Passing this is what makes the
  // pitch concat terminate. When unset we fall back to `-shortest` (fine for the
  // per-part-audio branch, whose streams are all finite).
  totalDurationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const n = opts.inputPaths.length;
  if (n === 0) throw new Error("concatPitchParts: no inputs");
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  const totalDur =
    opts.totalDurationSeconds && opts.totalDurationSeconds > 0 ? opts.totalDurationSeconds : null;
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  const args: string[] = ["-y", "-threads", String(env.FFMPEG_THREADS)];
  for (const p of opts.inputPaths) args.push("-i", p);
  if (opts.masterAudioPath) args.push("-i", opts.masterAudioPath);
  // Re-assert a common size/fps/sar per input so a mismatched part can't break
  // the concat filter.
  let filter = "";
  for (let i = 0; i < n; i++) {
    filter +=
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:-1:-1:color=black,fps=${fps},setsar=1[v${i}];`;
  }
  if (opts.masterAudioPath) {
    // Video-only concat; the narration (last input) is the sole audio track.
    // Pad it with silence so a narration slightly SHORTER than the video never
    // truncates the final frames — but bound the pad to the exact output length
    // (`apad=whole_dur`) so the audio stream is FINITE, and cap the encode with
    // `-t` below. Both bounds are absent-safe: with no totalDur we pad
    // unbounded + `-shortest` (see totalDurationSeconds note re: ffmpeg 5.1).
    const apad = totalDur ? `apad=whole_dur=${totalDur.toFixed(3)}` : "apad";
    for (let i = 0; i < n; i++) filter += `[v${i}]`;
    filter += `concat=n=${n}:v=1:a=0[v];`;
    filter += `[${n}:a]aresample=44100,asetpts=PTS-STARTPTS,${apad}[a]`;
  } else {
    for (let i = 0; i < n; i++) {
      filter += `[${i}:a]aresample=44100,asetpts=PTS-STARTPTS[a${i}];`;
    }
    for (let i = 0; i < n; i++) filter += `[v${i}][a${i}]`;
    filter += `concat=n=${n}:v=1:a=1[v][a]`;
  }
  args.push(
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[a]",
    // Deterministic stop: an explicit -t when we know the length, else -shortest
    // (only reached on the finite per-part-audio branch or when no length given).
    ...(opts.masterAudioPath
      ? totalDur
        ? ["-t", totalDur.toFixed(3)]
        : ["-shortest"]
      : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    opts.outputPath,
  );
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

function runFFmpeg(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  // Optional per-call timeout override. Used for short ops (e.g. single-frame
  // image transcode) where the global FFMPEG_TIMEOUT_SECONDS would let a
  // hung input burn the whole render budget before failing.
  timeoutOverrideSeconds?: number,
  // Optional liveness callback, fired on each stderr chunk from ffmpeg (which
  // emits a `frame=/time=` status line ~once a second during encoding). The
  // render processor uses this to heartbeat the job's updated_at DURING a long
  // pass (the final whole-video concat re-encode can run 10-20 min), so the
  // stall sweeper never mistakes an actively-encoding job for a dead one.
  // Best-effort and throttled by the caller — must not throw.
  onProgress?: () => void,
): Promise<void> {
  const env = getEnv();
  const timeoutSeconds = timeoutOverrideSeconds ?? env.FFMPEG_TIMEOUT_SECONDS;
  // On Linux, drop ffmpeg's scheduling priority via `nice` so a busy encoder
  // can't starve Redis or the worker process. Skipped when NICE_LEVEL=0 or
  // on platforms where `nice` isn't reliably available (Windows dev).
  const useNice = env.NICE_LEVEL > 0 && process.platform === "linux";
  const finalBin = useNice ? "nice" : bin;
  const finalArgs = useNice ? ["-n", String(env.NICE_LEVEL), bin, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(finalBin, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    // Ring-buffer the last STDERR_KEEP bytes of ffmpeg's stderr. The previous
    // implementation concatenated every chunk into one ever-growing string,
    // which crashed the worker with `RangeError: Invalid string length` on
    // long-running operations (V8's max string is ~512 MB). The final concat
    // for a 100+ item timeline can emit hundreds of MB of stderr — warnings
    // per input, per-frame status, per-segment codec notices — and once that
    // limit is hit the stream `data` callback throws, the unhandled error
    // tears the worker down, Fly auto-restarts, BullMQ marks the in-flight
    // job stalled. We only ever surface the tail anyway (the catch block
    // below slices the last 2000 bytes), so dropping older bytes is free.
    const STDERR_KEEP = 16_384; // 16 KB — generous tail for diagnostics
    let stderrTail = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    child.stderr.on("data", (c: Buffer) => {
      // Append then trim. Working with strings (not buffers) keeps the
      // existing slice-from-end semantics for error messages.
      stderrTail += c.toString();
      if (stderrTail.length > STDERR_KEEP) {
        stderrTail = stderrTail.slice(-STDERR_KEEP);
      }
      // Liveness signal — ffmpeg writes a status line here roughly every
      // second while encoding. Guard so a throwing callback can't crash the
      // ffmpeg wrapper.
      if (onProgress) {
        try { onProgress(); } catch { /* ignore */ }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`ffmpeg timed out after ${timeoutSeconds}s`));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderrTail.slice(-2000)}`));
    });
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });
}

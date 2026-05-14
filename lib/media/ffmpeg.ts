import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { getEnv } from "@/lib/env";

// All FFmpeg invocations use spawn with an argument array — no shell strings.
// This is critical when input filenames are derived from external IDs/URLs.

export interface CutClipOptions {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  signal?: AbortSignal;
}

export async function cutClip(opts: CutClipOptions): Promise<void> {
  const env = getEnv();
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

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
  // -an because source downloads are video-only — final voiceover is mixed in
  // during concat, not from clip audio.
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-ss", String(opts.startSeconds),
    "-i", opts.inputPath,
    "-t", String(opts.durationSeconds),
    "-an",
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
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
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

  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-loop", "1",
    "-t", String(opts.durationSeconds),
    "-i", actualInput,
    "-an",
    "-vf",
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1:color=black,fps=${fps},setsar=1`,
    // IMPORTANT: keep these encoder flags identical to normalizeClip(). The
    // final concat uses -c:v copy (mux-only, no re-encode) which requires
    // every input segment to share codec params, GOP structure, and SPS/PPS.
    // Adding "-tune stillimage" here would diverge from normalizeClip and
    // cause concat to fall back to re-encoding (or fail outright on strict
    // demuxers). The ~5% extra bitrate that "tune stillimage" would save on
    // image segments is dwarfed by the 30× speedup from skipping concat
    // re-encode, so we deliberately use the same plain ultrafast/crf 25.
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "25",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
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

// Cut a window of audio out of a longer audio file. Used by the intro
// pipeline to extract the [start, end] segment of the source's audio that
// matches the chosen intro video clip. AAC re-encode is fast and keeps the
// container compatible with the renderer's filter graph.
export async function cutAudio(opts: {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-ss", String(opts.startSeconds),
    "-i", opts.inputPath,
    "-t", String(opts.durationSeconds),
    "-vn",
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
  // burned in via ffmpeg's drawtext filter for the first ~3 seconds with a
  // fade in/out, sitting in the lower-third zone with a translucent bar.
  lowerThird?: { text: string };
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

// Build the drawtext filter chain for a 3-second lower-third with fade in/out
// and a translucent bar. Pinned to the lower-third zone (≈ 78% of frame
// height), 36px bold text with a black drop-shadow for legibility against
// busy footage. Returns null if no font is available on the host.
async function buildLowerThirdFilter(text: string, width: number, height: number): Promise<string | null> {
  const font = await resolveLowerThirdFont();
  if (!font) return null;
  // Show for the first 3 seconds of the clip with 0.4s fade in/out. The
  // alpha expression evaluates per-frame: 0→1 over [0, 0.4], 1 through 2.6,
  // 1→0 over [2.6, 3.0], 0 after.
  const start = 0;
  const fadeIn = 0.4;
  const hold = 2.6;
  const fadeOut = 0.4;
  const end = start + fadeIn + hold + fadeOut;
  const alphaExpr =
    `'if(lt(t,${start}),0,` +
    `if(lt(t,${start + fadeIn}),(t-${start})/${fadeIn},` +
    `if(lt(t,${start + fadeIn + hold}),1,` +
    `if(lt(t,${end}),(${end}-t)/${fadeOut},0))))'`;
  const fontPath = font.replace(/\\/g, "/").replace(/'/g, "\\'").replace(/:/g, "\\:");
  const escaped = escapeDrawtextValue(text);

  // Bar geometry: full-width translucent black behind the text, 90px tall,
  // sitting ~78% down the frame. drawbox uses the same alpha expression so
  // bar + text fade together as one element.
  const barY = Math.round(height * 0.78);
  const textY = barY + 22;
  const fontsize = Math.round(height / 20);  // 36 at 720p

  return (
    `drawbox=x=0:y=${barY}:w=${width}:h=90:color=black@0.55:t=fill:enable='between(t,${start},${end})',` +
    `drawtext=fontfile='${fontPath}':text='${escaped}':` +
    `fontcolor=white:fontsize=${fontsize}:` +
    `borderw=2:bordercolor=black@0.85:` +
    `x=60:y=${textY}:` +
    `alpha=${alphaExpr}`
  );
}

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
    const lt = await buildLowerThirdFilter(opts.lowerThird.text, w, h);
    // If the host has no usable font, ship the clip without the overlay
    // rather than failing the render. The match.lower_thirds log already
    // tells operators a lower-third was requested.
    if (lt) vf = `${vf},${lt}`;
  }
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-i", opts.inputPath,
    "-an",
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "25",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

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
  fps?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const env = getEnv();
  const fps = opts.fps ?? 30;
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const xfadeOffset = Math.max(0, opts.inputADurationSeconds - opts.transitionDurationSeconds);
  // Keep encoder flags byte-identical to normalizeClip / buildStillVideo so the
  // merged segment stays stream-copy-concatable downstream. Forcing a keyframe
  // at frame 0 is essential — without it the final concat falls back to a
  // re-encode (or fails outright on strict demuxers).
  const filter =
    `[0:v]settb=AVTB,fps=${fps},setsar=1[a];` +
    `[1:v]settb=AVTB,fps=${fps},setsar=1[b];` +
    `[a][b]xfade=transition=fade:duration=${opts.transitionDurationSeconds}:offset=${xfadeOffset},format=yuv420p[v]`;
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-i", opts.inputAPath,
    "-i", opts.inputBPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "25",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-force_key_frames", "expr:eq(n,0)",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
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
  signal?: AbortSignal;
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
    // (3 = bg music if provided). Final audio plays the intro for the
    // first introDurationSeconds, crossfades 0.3s into the voiceover.
    //
    // acrossfade with curve1=tri:curve2=tri is a linear/triangular fade —
    // smooth, inaudible, the standard production cut. The full duration
    // of the output equals introDur + voiceoverDur - 0.3s overlap.
    const introDur = opts.introDurationSeconds!;
    const xfade = 0.3;
    args.push("-i", opts.introAudioPath!);
    args.push("-i", opts.voiceoverPath);
    let filter = "";
    // Trim intro audio to its declared duration so a longer source file
    // can't bleed into the voiceover section.
    filter += `[1:a]atrim=duration=${introDur},asetpts=PTS-STARTPTS,volume=1.0[intro];`;
    filter += `[2:a]volume=${opts.voiceoverGain ?? 1.0},asetpts=PTS-STARTPTS[vo];`;
    filter += `[intro][vo]acrossfade=d=${xfade}:c1=tri:c2=tri[mainmix]`;
    if (opts.bgMusicPath) {
      args.push("-stream_loop", "-1", "-i", opts.bgMusicPath);
      filter += `;[3:a]volume=${opts.bgMusicGain ?? 0.15},asetpts=PTS-STARTPTS[bg];`;
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
    // No external audio at all — produce a silent video.
    audioMap = ["-map", "0:v:0"];
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
    args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  } else {
    args.push("-an");
  }
  args.push("-movflags", "+faststart", opts.outputPath);

  try {
    await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
  } finally {
    try { await fs.unlink(listPath); } catch { /* ignore */ }
  }
}

function runFFmpeg(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  // Optional per-call timeout override. Used for short ops (e.g. single-frame
  // image transcode) where the global FFMPEG_TIMEOUT_SECONDS would let a
  // hung input burn the whole render budget before failing.
  timeoutOverrideSeconds?: number,
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

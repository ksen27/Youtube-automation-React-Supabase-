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

  // -ss before -i is fastest (input-side seek). We re-encode to ensure clean
  // GOP boundaries and consistent codec across clips for the final render.
  // -an because source downloads are video-only — final voiceover is mixed in
  // during concat, not from clip audio.
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-ss", String(opts.startSeconds),
    "-i", opts.inputPath,
    "-t", String(opts.durationSeconds),
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
}

// Build a still-image video segment of `durationSeconds` length. Used for
// image blocks in the timeline — the same image is held for the block's
// duration. Output codec/res/fps matches normalizeClip so the segment can
// be concatenated alongside footage clips without re-encoding mismatches.
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
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-loop", "1",
    "-t", String(opts.durationSeconds),
    "-i", opts.inputImagePath,
    "-an",
    "-vf",
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1:color=black,fps=${fps},setsar=1`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-movflags", "+faststart",
    opts.outputPath,
  ];
  await runFFmpeg(env.FFMPEG_PATH, args, opts.signal);
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
  signal?: AbortSignal;
}

export async function normalizeClip(opts: NormalizeOptions): Promise<void> {
  const env = getEnv();
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-i", opts.inputPath,
    "-an",
    "-vf",
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1:color=black,fps=${fps},setsar=1`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
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

  args.push(
    ...audioMap,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
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
  signal?: AbortSignal
): Promise<void> {
  const env = getEnv();
  const timeoutSeconds = env.FFMPEG_TIMEOUT_SECONDS;
  // On Linux, drop ffmpeg's scheduling priority via `nice` so a busy encoder
  // can't starve Redis or the worker process. Skipped when NICE_LEVEL=0 or
  // on platforms where `nice` isn't reliably available (Windows dev).
  const useNice = env.NICE_LEVEL > 0 && process.platform === "linux";
  const finalBin = useNice ? "nice" : bin;
  const finalArgs = useNice ? ["-n", String(env.NICE_LEVEL), bin, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(finalBin, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`ffmpeg timed out after ${timeoutSeconds}s`));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });
}

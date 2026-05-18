import { spawn } from "node:child_process";
import { getEnv } from "@/lib/env";

// Detect scene-change boundaries in a video using ffmpeg's `select=gt(scene,X)`
// filter. Returns an array of timestamps (seconds) where ffmpeg believes a
// visual cut happened.
//
// Why this exists:
//   The blind uniform-sampling cutter often lands mid-shot — half a face,
//   the back of a panning camera, the moment a transition wipe is on
//   screen. Cutting at a scene-change boundary instead gives us a clean
//   shot with a usable thumbnail and a coherent 5-second window.
//
// How the filter works:
//   `gt(scene,T)` is true when ffmpeg's scene-change metric crosses
//   threshold T (range 0..1, where 0 = identical frames, 1 = totally
//   different). 0.35 catches most hard cuts while ignoring lighting
//   flicker. 0.4–0.5 is "stricter, fewer false positives." We start at
//   0.35 and let the caller tune.
//
// Implementation note:
//   We use `-f null -` (decode-only output) plus `showinfo` so ffmpeg
//   prints a `pts_time:<seconds>` line for each frame the filter passes.
//   Parsing stderr is the only way — ffmpeg doesn't expose this through
//   a structured channel. We pipe stdout to /dev/null since we never
//   write a real output file.

export interface DetectScenesOptions {
  inputPath: string;
  threshold?: number;          // default 0.35
  signal?: AbortSignal;
}

export async function detectSceneTimestamps(opts: DetectScenesOptions): Promise<number[]> {
  const env = getEnv();
  const threshold = opts.threshold ?? env.SCENE_DETECT_THRESHOLD;

  // Downscale to 320 wide before running the scene filter. Scene detection
  // compares frame-to-frame differences, which is a coarse signal that does
  // not need full-res pixels — decoding 320p instead of 1080p is 5–10× faster
  // on shared-CPU hosts and produces near-identical scene timestamps. `-an`
  // skips audio decoding which the filter doesn't read.
  //
  // SCENE_DETECT_MAX_INPUT_SECONDS=0 (the default) means scan the full
  // source — the previous 10-min cap meant every clip from a 30-min source
  // came from minutes 0–10, which broke matching for long interviews. We
  // rely on the 320p downscale + SCENE_DETECT_TIMEOUT_SECONDS to bound
  // wall-time on long sources.
  const args = [
    "-hide_banner",
    "-nostats",
    ...(env.SCENE_DETECT_MAX_INPUT_SECONDS > 0
      ? ["-t", String(env.SCENE_DETECT_MAX_INPUT_SECONDS)]
      : []),
    "-i", opts.inputPath,
    "-an",
    "-vf", `scale=320:-2,select=gt(scene\\,${threshold}),showinfo`,
    "-f", "null",
    "-",
  ];

  const stderr = await runCapturingStderr(env.FFMPEG_PATH, args, opts.signal);
  return parsePtsTimes(stderr);
}

// Pull `pts_time:<float>` values from ffmpeg's `showinfo` stderr lines. Each
// line that ffmpeg printed corresponds to a frame the scene-detect filter
// passed — i.e. a scene-change boundary.
export function parsePtsTimes(stderr: string): number[] {
  const out: number[] = [];
  // Example line:
  //   [Parsed_showinfo_1 @ 0x...] n: 0 pts:  240 pts_time:0.04 ...
  const re = /pts_time:([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t > 0) out.push(t);
  }
  // showinfo can emit duplicate pts_times under odd codecs — dedupe.
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function runCapturingStderr(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  // Use a dedicated, shorter timeout for scene-detect rather than the global
  // FFMPEG_TIMEOUT_SECONDS. Scene-detect failing means we fall back to
  // uniform sampling — a perfectly fine outcome that costs nothing to retry.
  // The longer ffmpeg timeout exists for clip cuts and the final concat,
  // where a timeout means a real failure.
  const timeoutSeconds = getEnv().SCENE_DETECT_TIMEOUT_SECONDS;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
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
      if (timedOut) return reject(new Error(`scene-detect timed out after ${timeoutSeconds}s`));
      // ffmpeg returns non-zero on certain "expected" conditions (no audio
      // stream, etc) but still emits useful stderr. Accept any exit if we
      // got pts_time hits; otherwise treat as failure.
      if (code === 0 || /pts_time:/.test(stderr)) resolve(stderr);
      else reject(new Error(`scene-detect exited ${code}: ${stderr.slice(-1500)}`));
    });
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });
}

export interface SceneClipWindow {
  start: number;
  // Duration the clip should be cut to. Computed so the clip ends at — or
  // just before — the next scene boundary, clamped to [minDuration, maxDuration].
  // This prevents the "first 3.5s is Dave, last 1.5s bleeds into a logo"
  // problem that fixed-duration clips had.
  duration: number;
}

// Pick clip windows (start + duration) from a list of scene timestamps.
// Enforces:
//   - skip the first `skipLeadSeconds` (intros)
//   - leave room for at least `minDuration` at the tail
//   - require at least `minGapSeconds` between consecutive picks (so we
//     don't over-cut a section with rapid cuts — e.g. a music-video
//     intro with cuts every 0.5s)
//
// For each picked start, the clip duration is set by walking forward
// through boundaries and choosing the latest one that lands in
// [start + minDuration, start + maxDuration]. On rapid-cut sources the
// clip will span 2-4 source scenes — the alternative was every clip
// pinning at minDuration, which left the matcher unable to fill long-
// sentence footage blocks and made the timeline come up short of the
// voiceover. The intra-clip cuts read as a normal multi-shot B-roll
// montage.
export function pickFromScenes(opts: {
  scenes: number[];
  duration: number;
  targetCount: number;
  minDuration: number;
  maxDuration: number;
  minGapSeconds?: number;
  skipLeadSeconds?: number;
}): SceneClipWindow[] {
  const minGap = opts.minGapSeconds ?? 20;
  const skipLead = opts.skipLeadSeconds ?? 10;
  const tailLimit = opts.duration - opts.minDuration - 1;
  if (tailLimit <= skipLead) return [];

  // Filter scenes to the usable window, then enforce minimum gap.
  const sorted = [...opts.scenes].sort((a, b) => a - b);
  const eligible = sorted.filter((t) => t >= skipLead && t <= tailLimit);

  const spaced: number[] = [];
  let lastPick = -Infinity;
  for (const t of eligible) {
    if (t - lastPick >= minGap) {
      spaced.push(Math.round(t * 100) / 100);
      lastPick = t;
    }
  }

  // Cap to targetCount by subsampling evenly (preserve full-source coverage,
  // don't clump at the start).
  let picked: number[];
  if (spaced.length <= opts.targetCount) {
    picked = spaced;
  } else {
    const stride = spaced.length / opts.targetCount;
    const out: number[] = [];
    for (let i = 0; i < opts.targetCount; i++) {
      const idx = Math.min(spaced.length - 1, Math.floor(i * stride));
      out.push(spaced[idx]);
    }
    picked = Array.from(new Set(out)).sort((a, b) => a - b);
  }

  // For each picked start, find a scene boundary that gives a usable clip
  // duration. Rather than snapping to the *immediate* next boundary (which
  // on rapid-cut sources collapses every clip to minDuration), we walk
  // forward through the boundaries and pick the latest one that still
  // fits in [minDuration, maxDuration] — preferring closer-to-max so the
  // clip can cover a long-sentence footage block. On sources with cuts
  // every 1-2s this means a clip spans 2-4 source scenes (some visual
  // cuts inside the clip), which is acceptable: the alternative is every
  // clip being exactly minDuration, leaving long sentences unfillable.
  return picked.map((start) => {
    const tailRoom = opts.duration - start - 0.25;
    const hardMax = Math.min(opts.maxDuration, tailRoom);
    // Scan boundaries after `start`. Track the latest boundary that lands
    // within [start + minDuration, start + hardMax]. If none exists (a
    // very long takes-no-cuts gap, or the very end of the source), fall
    // back to hardMax. If hardMax itself is below minDuration (source is
    // ending), fall back to minDuration with the bleed the legacy path
    // already accepted.
    let chosenEnd = -1;
    for (const t of sorted) {
      if (t <= start + opts.minDuration) continue;
      if (t > start + hardMax) break;
      chosenEnd = t;
    }
    let dur: number;
    if (chosenEnd > 0) {
      dur = chosenEnd - start;
    } else if (hardMax >= opts.minDuration) {
      // No boundary in the usable window — extend to hardMax. The clip
      // will bleed past one or more scene boundaries; that's fine for a
      // generic interview clip and matches how viewers experience B-roll.
      dur = hardMax;
    } else {
      dur = opts.minDuration;
    }
    return { start, duration: Math.round(dur * 100) / 100 };
  });
}

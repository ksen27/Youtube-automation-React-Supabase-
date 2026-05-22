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
  // Direction of the slow zoom applied to the still so it doesn't read as a
  // frozen frame. "in" crops a shrinking window over time (zoom-in feel);
  // "out" crops an expanding window (zoom-out feel). Caller alternates per
  // image so consecutive stills don't move identically. Defaults to "in".
  motionDirection?: "in" | "out";
  // Optional lower-third overlay. Same semantics as normalizeClip — when the
  // matcher's minute-cadence picker lands on an image block, the renderer
  // burns the proper-noun text in via the shared drawtext recipe.
  lowerThird?: { text: string };
  signal?: AbortSignal;
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
  const zStart = direction === "in" ? 1.0 : ZOOM_MAX;
  const zEnd = direction === "in" ? ZOOM_MAX : 1.0;
  // Linear time ramp on the on-frame counter `on` (0..totalFrames-1).
  // Clamped so the very last frame doesn't overshoot past zEnd due to
  // rounding of totalFrames.
  const tRamp = `min(on/${totalFrames - 1}\\,1)`;
  const zExpr = `${zStart}+(${zEnd}-${zStart})*${tRamp}`;

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
    ? await buildLowerThirdFilter(opts.lowerThird.text, h)
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
      `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` +
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
  lowerThird?: { text: string };
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
    ? await buildLowerThirdFilter(opts.lowerThird.text, h)
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
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "25",
    "-pix_fmt", "yuv420p",
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
  const escapeDrawtext = (s: string): string =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/'/g, "'\\''");
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
          const enableExpr = `between(t,${tStart},${tEnd})`;
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
        const tailEnable = `between(t,${tailStart},${tailEnd})`;
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

  const args = [
    "-y",
    "-threads", String(env.FFMPEG_THREADS),
    "-f", "lavfi",
    "-i", `color=c=black:s=${w}x${h}:r=${fps}:d=${opts.durationSeconds}`,
    "-vf", vfChain,
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "25",
    "-pix_fmt", "yuv420p",
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

// Build the drawtext filter chain for a 3-second lower-third with fade in/out.
// Broadcast-chyron style: solid blue rectangle, white bold all-caps text
// inside, anchored to the lower-third zone (≈ 80% of frame height). Padding
// around the glyphs comes from drawtext's `boxborderw`. Pinned bottom-left
// with a small left margin so the box reads like a TV news caption.
// Returns null if no font is available on the host.
async function buildLowerThirdFilter(text: string, height: number): Promise<string | null> {
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

  // Blue (#1E5BC9) matches the reference screenshot; white bold text inside.
  // boxcolor's alpha applies the same fade as the text via the chain's alpha.
  const filter = (
    `drawtext=fontfile='${fontPath}':text='${escaped}':` +
    `fontcolor=white:fontsize=${fontsize}:` +
    `box=1:boxcolor=0x1E5BC9:boxborderw=${boxPad}:` +
    `x=${leftMargin}:y=${yExpr}:` +
    `alpha=${alphaExpr}`
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
    const lt = await buildLowerThirdFilter(opts.lowerThird.text, h);
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
      // Bg music must NOT play during the intro — only the intro audio is
      // heard for the first introDur seconds. We delay the bg music so it
      // starts at the crossfade point (introDur - xfade) and fades in over
      // the xfade window, matching the voiceover's ramp-up.
      const bgStart = Math.max(0, introDur - xfade);
      const bgStartMs = Math.round(bgStart * 1000);
      filter += `;[3:a]asetpts=PTS-STARTPTS,volume=${opts.bgMusicGain ?? 0.15},adelay=${bgStartMs}|${bgStartMs}:all=1,afade=t=in:st=${bgStart.toFixed(3)}:d=${xfade}[bg];`;
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

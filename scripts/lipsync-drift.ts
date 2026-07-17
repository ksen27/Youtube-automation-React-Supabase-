import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { spawn } from "node:child_process";
import { promises as fs, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { getServerSupabase } from "@/lib/supabase/server";
import { getEnv } from "@/lib/env";

// Lip-sync drift report for an AI-Avatar (synthetic) project.
//
// The renderer stitches ~hundreds of HeyGen/AI clips into one video, then
// overlays a single continuous 69labs voiceover. Lip-sync stays correct only
// if the video's presentation timeline tracks the voiceover timeline. Two
// independent drift sources have bitten this pipeline (see the
// avatar-lipsync-* memories):
//   A) TIMEBASE SLIP — the final concat is `-c:v copy`, so the muxed stream
//      can play back at ~29.998fps instead of 30.000, stretching the timeline
//      past what the frame count implies (a constant per-render offset).
//   B) SLOT-SUM RESIDUAL — per-clip frame quantization + computed xfade
//      durations make the summed rendered slots differ from the true
//      voiceover, and the audio is padded to fit the VIDEO length rather than
//      the video being reconciled to the voiceover.
//
// This script measures both directly from the shipped final mp4 + the
// voiceover, with NO reliance on worker stdout logs (logJob is console-only).
// It's read-only: it downloads to a temp dir and probes; it writes nothing.
//
//   npx tsx --env-file=.env.local scripts/lipsync-drift.ts <projectId> [--keep]
//   npx tsx --env-file=.env.local scripts/lipsync-drift.ts <finalMp4Url> <voiceoverUrl> [--keep]
//
// --keep leaves the downloaded files in the temp dir (printed at the end) so
// you can re-probe them by hand.

// A drift under this is inaudible; over it, lips visibly lead/lag the words.
const TOLERANCE_MS = 250;
// The interior lip-sync error is dominated by video-vs-voiceover: video
// position drives the lips, the voiceover drives the words.

interface StreamProbe {
  containerDurationSec: number;
  videoDurationSec: number | null;
  audioDurationSec: number | null;
  frameCount: number | null;
  rFrameRate: string | null;   // declared (e.g. "30/1")
  avgFrameRate: string | null; // real average (e.g. "30000/1001")
  timeBase: string | null;     // container tick size (e.g. "1/15360")
  durationTs: number | null;   // stream duration in timebase ticks
  videoCodec: string | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
}

function fpsToNumber(fr: string | null): number | null {
  if (!fr) return null;
  const [n, d] = fr.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

function runFFprobe(args: string[]): Promise<string> {
  const env = getEnv();
  return new Promise((resolve, reject) => {
    const child = spawn(env.FFPROBE_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`ffprobe exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

// Full per-stream probe. Counts PACKETS (-count_packets), not decoded frames:
// for H.264 one packet == one frame, and packet counting walks the container
// index rather than decoding, so it's both faster and exact. `-count_frames`
// was tried first and silently UNDER-counted on a long file (47880 vs the true
// 50057), which corrupted the whole decomposition — don't switch back.
async function probe(localPath: string, countPackets: boolean): Promise<StreamProbe> {
  const args = [
    "-v", "error",
    "-print_format", "json",
    ...(countPackets ? ["-count_packets"] : []),
    "-show_format",
    "-show_streams",
    localPath,
  ];
  const parsed = JSON.parse(await runFFprobe(args));
  const streams: any[] = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const num = (v: unknown): number | null => {
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  };
  // nb_frames and nb_read_packets agree on a well-formed H.264 mp4; prefer the
  // counted packets when present, else the container's declared nb_frames.
  const packets = video?.nb_read_packets != null ? Number(video.nb_read_packets) : null;
  const declaredFrames = video?.nb_frames != null ? Number(video.nb_frames) : null;
  return {
    containerDurationSec: num(parsed.format?.duration) ?? 0,
    videoDurationSec: num(video?.duration),
    audioDurationSec: num(audio?.duration),
    frameCount: packets ?? declaredFrames,
    rFrameRate: video?.r_frame_rate ?? null,
    avgFrameRate: video?.avg_frame_rate ?? null,
    timeBase: video?.time_base ?? null,
    durationTs: video?.duration_ts != null ? Number(video.duration_ts) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    audioSampleRate: audio?.sample_rate != null ? Number(audio.sample_rate) : null,
  };
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

const ms = (sec: number | null | undefined): string =>
  sec == null ? "n/a" : `${(sec * 1000 >= 0 ? "+" : "")}${Math.round(sec * 1000)}ms`;
const s3 = (sec: number | null | undefined): string =>
  sec == null ? "n/a" : `${sec.toFixed(3)}s`;

async function resolveInputs(argv: string[]): Promise<{
  label: string;
  finalUrl: string;
  voiceoverUrl: string | null;
  voiceoverDurationSec: number | null;
}> {
  // Two URLs → direct mode.
  const urls = argv.filter((a) => /^https?:\/\//.test(a));
  if (urls.length >= 2) {
    return { label: "(direct urls)", finalUrl: urls[0], voiceoverUrl: urls[1], voiceoverDurationSec: null };
  }
  // Otherwise treat the first non-flag arg as a projectId.
  const projectId = argv.find((a) => !a.startsWith("--") && !/^https?:\/\//.test(a));
  if (!projectId) throw new Error("usage: lipsync-drift.ts <projectId> | <finalUrl> <voiceoverUrl>");

  const sb = getServerSupabase();
  const { data: project, error: pErr } = await sb
    .from("projects")
    .select("id, title, engine, voiceover_url, voiceover_duration_seconds")
    .eq("id", projectId)
    .single();
  if (pErr || !project) throw new Error(`project ${projectId} not found: ${pErr?.message ?? "no row"}`);

  // Most recent completed render's output.
  const { data: jobs, error: jErr } = await sb
    .from("render_jobs")
    .select("id, status, output_url, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (jErr) throw new Error(`render_jobs query failed: ${jErr.message}`);
  const withOutput = (jobs ?? []).filter((j: any) => typeof j.output_url === "string" && j.output_url);
  if (withOutput.length === 0) throw new Error(`no render_jobs with an output_url for project ${projectId}`);
  const latest = withOutput[0] as any;
  if (withOutput.length > 1) {
    console.log(`note: ${withOutput.length} renders with output; probing the newest (${latest.created_at}). Others:`);
    for (const j of withOutput.slice(1)) console.log(`  - ${j.created_at}  ${j.status}  ${j.output_url}`);
    console.log("");
  }

  return {
    label: `${project.title ?? projectId} [${project.engine}]`,
    finalUrl: latest.output_url as string,
    voiceoverUrl: (project.voiceover_url as string | null) ?? null,
    voiceoverDurationSec: project.voiceover_duration_seconds != null
      ? Number(project.voiceover_duration_seconds)
      : null,
  };
}

(async () => {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const { label, finalUrl, voiceoverUrl, voiceoverDurationSec: voDurFromDb } = await resolveInputs(argv);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lipsync-drift-"));
  const finalLocal = path.join(tmp, "final.mp4");
  const voLocal = voiceoverUrl ? path.join(tmp, "voiceover.audio") : null;

  console.log(`project : ${label}`);
  console.log(`final   : ${finalUrl}`);
  console.log(`voiceover: ${voiceoverUrl ?? "(none — using DB voiceover_duration_seconds)"}`);
  console.log(`tmp     : ${tmp}`);
  console.log("downloading… (final is ~hundreds of MB; counting frames takes a few s)\n");

  await download(finalUrl, finalLocal);
  if (voiceoverUrl && voLocal) await download(voiceoverUrl, voLocal);

  const fp = await probe(finalLocal, /*countPackets*/ true);

  // True voiceover duration: prefer a probed voiceover file, fall back to the
  // DB column. This is the reference lip-sync must track.
  let voDur = voDurFromDb;
  if (voLocal) {
    const vp = await probe(voLocal, /*countPackets*/ false);
    voDur = vp.audioDurationSec ?? vp.containerDurationSec ?? voDur;
  }

  const declaredFps = fpsToNumber(fp.rFrameRate);
  const realFps = fpsToNumber(fp.avgFrameRate);
  // What the frame count SHOULD take at exactly the declared fps.
  const framesAtDeclaredFps =
    fp.frameCount != null && declaredFps ? fp.frameCount / declaredFps : null;
  // Timebase slip = how much longer the presentation timeline runs than the
  // frame count implies at the declared fps. This is drift source A (the
  // ~29.998fps problem), independent of content length: `-c:v copy` preserves a
  // fine timebase (e.g. 1/15360) whose per-frame rounding accumulates.
  const timebaseSlipSec =
    framesAtDeclaredFps != null ? fp.containerDurationSec - framesAtDeclaredFps : null;
  // Corroborating tick math: at 30fps on a 1/15360 timebase each frame is
  // exactly 512 ticks, so N frames should span N*512 ticks. Any excess in
  // duration_ts is the slip, measured without relying on fps arithmetic.
  const tbDen = fp.timeBase ? Number(fp.timeBase.split("/")[1]) : null;
  const ticksPerFrame = tbDen && declaredFps ? tbDen / declaredFps : null;
  const expectedTs =
    ticksPerFrame != null && fp.frameCount != null ? ticksPerFrame * fp.frameCount : null;

  console.log("── FINAL VIDEO ─────────────────────────────────────────────");
  console.log(`container duration : ${s3(fp.containerDurationSec)}`);
  console.log(`video stream       : ${s3(fp.videoDurationSec)}   codec=${fp.videoCodec}`);
  console.log(`audio stream       : ${s3(fp.audioDurationSec)}   codec=${fp.audioCodec} @ ${fp.audioSampleRate ?? "?"}Hz`);
  console.log(`declared fps       : ${fp.rFrameRate} (${declaredFps?.toFixed(5) ?? "?"})`);
  console.log(`real avg fps       : ${fp.avgFrameRate} (${realFps?.toFixed(5) ?? "?"})`);
  console.log(`frames (packets)   : ${fp.frameCount ?? "?"}`);
  console.log(`  frames/declaredFps = ${s3(framesAtDeclaredFps)}`);
  console.log(`time_base          : ${fp.timeBase ?? "?"}   duration_ts=${fp.durationTs ?? "?"}`);
  if (expectedTs != null && fp.durationTs != null) {
    console.log(`  expected_ts = ${fp.frameCount} frames x ${ticksPerFrame} ticks = ${expectedTs}  (excess ${fp.durationTs - expectedTs} ticks)`);
  }

  console.log("\n── DRIFT DECOMPOSITION ─────────────────────────────────────");
  console.log(`reference voiceover: ${s3(voDur)}${voLocal ? " (probed)" : " (DB column)"}`);
  if (voDur != null) {
    const videoVsVo = fp.containerDurationSec - voDur;
    const audioVsVo = fp.audioDurationSec != null ? fp.audioDurationSec - voDur : null;
    const videoVsAudio = fp.audioDurationSec != null ? fp.containerDurationSec - fp.audioDurationSec : null;
    // Content residual = total video overrun minus the constant timebase slip.
    const contentResidualSec =
      timebaseSlipSec != null ? videoVsVo - timebaseSlipSec : null;

    console.log(`A) timebase slip (fps)   : ${ms(timebaseSlipSec)}   ← constant per render; from -c:v copy at ~${realFps?.toFixed(3)}fps`);
    console.log(`B) content slot residual : ${ms(contentResidualSec)}   ← summed clip over/under-run vs voiceover`);
    console.log(`   ─────────────────────────`);
    console.log(`   VIDEO vs voiceover    : ${ms(videoVsVo)}   ← lips lead(+)/lag(-) the words at the tail`);
    console.log(`   AUDIO vs voiceover    : ${ms(audioVsVo)}   ← voiceover held to true length? (0 = yes)`);
    console.log(`   video vs audio        : ${ms(videoVsAudio)}`);

    const worst = Math.abs(Math.round(videoVsVo * 1000));
    const pass = worst <= TOLERANCE_MS;
    console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}  (video-vs-voiceover ${ms(videoVsVo)}, tolerance ±${TOLERANCE_MS}ms)`);
    if (!pass) {
      console.log("  Interior lip-sync drifts progressively; the number above is the tail error.");
      if (timebaseSlipSec != null && Math.abs(timebaseSlipSec * 1000) > 30)
        console.log(`  • ${ms(timebaseSlipSec)} is timebase (fix: pin exact 30/1 timescale on the mux).`);
      if (contentResidualSec != null && Math.abs(contentResidualSec * 1000) > 30)
        console.log(`  • ${ms(contentResidualSec)} is slot residual (fix: reconcile totalVideoDurationSeconds to voiceover, redistribute in body).`);
    }
  } else {
    console.log("no reference voiceover duration available — cannot compute drift. Pass a voiceover URL or set voiceover_duration_seconds.");
  }

  // ── INTERIOR DRIFT ────────────────────────────────────────────────────────
  // Everything above measures the TAIL: whole-file video-vs-voiceover. That
  // number is exactly what renderProcessor's final-length pin is designed to
  // force to ~zero (it holds the last frame until the video matches the audio),
  // so it can report PASS while every avatar in the body is visibly out of sync.
  // That blind spot is why this bug survived three separate fixes.
  //
  // Interior drift is where an avatar block STARTS in the assembled video versus
  // where its words start in the master voiceover. The renderer lays the
  // voiceover down as one continuous track while building video by summing slot
  // durations, so a block's video start is Σ(durations before it) — and the
  // voiceover position it should line up with is the same sum computed from the
  // TRUE (unquantized) durations. The gap between those is the lip-sync error a
  // viewer actually sees at that avatar. Negative = lips lead the words.
  const projectId = argv.find((a) => !a.startsWith("--") && !/^https?:\/\//.test(a));
  if (projectId) {
    const sb = getServerSupabase();
    const { data: items } = await sb
      .from("timeline_items")
      .select("position, type, duration")
      .eq("project_id", projectId)
      .order("position", { ascending: true });

    if (items?.length) {
      const FPS = 30;
      let exact = 0;    // running sum of stored (float) durations = voiceover position
      let rendered = 0; // running sum of what `-t` actually emits = video position
      let worstMs = 0;
      const avatars: Array<{ pos: number; atSec: number; driftMs: number }> = [];
      let offGrid = 0;

      for (const it of items as Array<{ position: number; type: string; duration: number | string }>) {
        const d = Number(it.duration) || 0;
        if (Math.abs(d * FPS - Math.round(d * FPS)) > 1e-6) offGrid++;
        // A block's start is the sum of everything BEFORE it — measure drift at
        // the moment the avatar appears, before its own duration is added.
        if (it.type === "avatar") {
          const driftMs = (rendered - exact) * 1000;
          avatars.push({ pos: it.position, atSec: rendered, driftMs });
          worstMs = Math.max(worstMs, Math.abs(driftMs));
        }
        exact += d;
        // ffmpeg's `-t` floors to whole frames; an on-grid duration is a no-op.
        rendered += Math.floor(d * FPS + 1e-9) / FPS;
      }

      console.log("\n── INTERIOR DRIFT (per avatar, from timeline durations) ────");
      console.log(`blocks: ${items.length}   off-frame-grid: ${offGrid}   ${offGrid === 0 ? "(all snapped ✓)" : "(each leaks up to 33ms one-way)"}`);
      if (avatars.length === 0) {
        console.log("no avatar blocks in this project.");
      } else {
        for (const a of avatars) {
          const mmss = `${String(Math.floor(a.atSec / 60)).padStart(2, "0")}:${String(Math.floor(a.atSec % 60)).padStart(2, "0")}`;
          const bar = Math.abs(a.driftMs) < 34 ? "ok" : (a.driftMs < 0 ? "LIPS LEAD" : "LIPS LAG");
          console.log(`  pos=${String(a.pos).padStart(3)}  at ${mmss}  drift=${(a.driftMs >= 0 ? "+" : "") + a.driftMs.toFixed(0).padStart(5)}ms  ${bar}`);
        }
        const pass = worstMs <= 34; // one frame at 30fps
        console.log(`\nINTERIOR RESULT: ${pass ? "PASS" : "FAIL"}  (worst ${worstMs.toFixed(0)}ms, tolerance ±34ms = 1 frame)`);
        if (!pass) {
          console.log("  Off-grid block durations are truncated by `-t` and the loss compounds;");
          console.log("  drift grows with position and every later avatar's lips run ahead of its words.");
        }
      }
    }
  }

  if (keep) {
    console.log(`\nkept downloads in ${tmp}`);
  } else {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => {
  console.error("lipsync-drift failed:", (e as Error).message);
  process.exit(1);
});

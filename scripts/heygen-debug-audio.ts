import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

// Watch ONE *audio-driven* avatar generation in a VISIBLE browser, end to end,
// on your own machine — independent of the queue and the Fly worker. This is the
// audio-upload counterpart of heygen:debug-gen: instead of typing the script,
// it UPLOADS an audio file so HeyGen lip-syncs the avatar to it (the fix for the
// avatar / voiceover duration mismatch). Use it to validate the new "↑ Upload"
// button + "Upload Audio" modal selectors against the live DOM before deploying.
//
//   # Real segment: slices the segment's window out of the project master
//   # voiceover (exactly what the worker does) and uploads it:
//   npm run heygen:debug-audio <projectId> <segmentId>
//
//   # Ad-hoc: your own image + a local audio file:
//   npm run heygen:debug-audio --image <url> --audio <path-to-local.mp3>
//
// Forces HEYGEN_DEBUG=true so the browser is headed + slow-mo, then calls the
// SAME generateAvatar() the worker calls with audioFilePath set — so what you
// watch is exactly the production audio-upload flow, selectors and all.
//
// NOTE: this pulls one account from the pool and may flip its status on failure
// (same disposition logic as the worker). Re-connect with
// `npm run heygen:connect <email>` if it needs re-auth.

// Force the headed/slow-mo browser regardless of .env.local.
process.env.HEYGEN_DEBUG = "true";

import path from "node:path";
import { promises as fs } from "node:fs";
import { getServerSupabase } from "@/lib/supabase/server";
import { fetchOrThrow } from "@/lib/synthetic/http";
import { generateAvatar } from "@/lib/synthetic/heygen";
import { ensureTmp, safeUnlink } from "@/lib/storage";
import { cutAudio } from "@/lib/media/ffmpeg";
import { probeFile } from "@/lib/media/probe";

function parseArgs(argv: string[]) {
  const out: { projectId?: string; segmentId?: string; image?: string; audio?: string } = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--image") out.image = argv[++i];
    else if (a === "--audio") out.audio = argv[++i];
    else positional.push(a);
  }
  out.projectId = out.projectId ?? positional[0];
  out.segmentId = out.segmentId ?? positional[1];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const projectId = args.projectId ?? "debug";
  const segmentId = args.segmentId ?? "debug-segment";
  let avatarImageUrl = args.image;
  let script = "Audio-driven debug avatar generation test.";
  let audioPath = args.audio;
  let stagedAudio: string | null = null; // staged slice we own + must clean up

  // Real project+segment: reproduce the worker path — load the avatar image +
  // script, fetch the project master voiceover, and slice the segment's spoken
  // window [start_time, end_time] out of it (this is what avatarProcessor does).
  if (args.projectId && args.segmentId && !args.audio) {
    const sb = getServerSupabase();
    const [{ data: seg, error: segErr }, { data: project, error: projErr }] = await Promise.all([
      sb
        .from("synthetic_segments")
        .select("id, script, start_time, end_time")
        .eq("id", args.segmentId)
        .single(),
      sb.from("projects").select("avatar_image_url, voiceover_url").eq("id", args.projectId).single(),
    ]);
    if (segErr || !seg) throw new Error(`segment ${args.segmentId} not found: ${segErr?.message}`);
    if (projErr || !project?.avatar_image_url) {
      throw new Error(`project ${args.projectId} has no avatar_image_url: ${projErr?.message}`);
    }
    const voiceoverUrl = (project as { voiceover_url?: string | null }).voiceover_url ?? null;
    if (!voiceoverUrl) throw new Error(`project ${args.projectId} has no voiceover_url to slice`);

    avatarImageUrl = project.avatar_image_url as string;
    script = (seg.script as string) ?? script;

    const start = Math.max(0, Number(seg.start_time));
    const end = Number(seg.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= 0.1) {
      throw new Error(`segment has no valid window: start=${seg.start_time} end=${seg.end_time}`);
    }

    console.log(`Slicing voiceover [${start.toFixed(2)}s → ${end.toFixed(2)}s] (${(end - start).toFixed(2)}s)…`);
    const tmp = await ensureTmp(`avatar-audio-debug/${projectId}`);
    const masterPath = path.join(tmp, `${segmentId}_master.mp3`);
    const slicePath = path.join(tmp, `${segmentId}.mp3`);
    const res = await fetchOrThrow(voiceoverUrl, { timeoutMs: 120_000 });
    await fs.writeFile(masterPath, Buffer.from(await res.arrayBuffer()));
    try {
      await cutAudio({ inputPath: masterPath, outputPath: slicePath, startSeconds: start, durationSeconds: end - start, format: "mp3" });
    } finally {
      await safeUnlink(masterPath);
    }
    audioPath = slicePath;
    stagedAudio = slicePath;
  }

  if (!avatarImageUrl) {
    throw new Error("Need an image. Pass a real <projectId> <segmentId>, or --image <url> --audio <path>.");
  }
  if (!audioPath) {
    throw new Error("Need audio. Pass a real <projectId> <segmentId>, or --audio <path-to-local.mp3>.");
  }

  // Confirm the audio file exists + probe its duration (also what we report for
  // billing). A clear error here beats a confusing failure inside the browser.
  await fs.access(audioPath).catch(() => {
    throw new Error(`audio file not found: ${audioPath}`);
  });
  let audioDurationSeconds = 0;
  try {
    const p = await probeFile(audioPath);
    if (p.durationSeconds > 0) audioDurationSeconds = p.durationSeconds;
  } catch {
    /* probe is best-effort; generateAvatar still works without it */
  }

  console.log("\nDebug AUDIO-DRIVEN avatar generation (HEADED browser — watch it):");
  console.log(`  projectId : ${projectId}`);
  console.log(`  segmentId : ${segmentId}`);
  console.log(`  image     : ${avatarImageUrl}`);
  console.log(`  audio     : ${audioPath} (${audioDurationSeconds.toFixed(2)}s)`);
  console.log(`  script    : ${script.slice(0, 80)}${script.length > 80 ? "…" : ""}`);
  console.log("\nFetching image bytes…");

  const imgRes = await fetchOrThrow(avatarImageUrl, { timeoutMs: 60_000 });
  const imageBytes = Buffer.from(await imgRes.arrayBuffer());
  console.log(`  ${imageBytes.length} bytes. Launching browser…\n`);

  try {
    const result = await generateAvatar(
      {
        projectId,
        segmentId,
        jobId: `debug-audio-${segmentId}`,
        avatarImageUrl,
        script,
        audioFilePath: audioPath,
        audioDurationSeconds: audioDurationSeconds || undefined,
      },
      imageBytes,
      1, // single account — don't burn the whole pool while debugging
    );
    console.log("\n✓ SUCCESS");
    console.log(`  videoUrl : ${result.videoUrl}`);
    console.log(`  account  : ${result.accountId}`);
    console.log(`  seconds  : ${result.seconds}`);
    if (audioDurationSeconds > 0) {
      const drift = Math.abs(result.seconds - audioDurationSeconds);
      console.log(
        `  audio    : ${audioDurationSeconds.toFixed(2)}s  →  video/audio match within ~${drift.toFixed(2)}s`,
      );
    }
    process.exit(0);
  } catch (err) {
    console.error("\n✗ FAILED");
    console.error(`  ${(err as Error).message}`);
    console.error(
      "\nThe browser window showed where it stalled. Diagnostics (screenshot + HTML)\n" +
        "were captured to HEYGEN_LOG_DIR / R2 (heygen-shots: look for the *_audio_uploaded\n" +
        "shot to see the composer right after the audio upload).",
    );
    process.exit(1);
  } finally {
    if (stagedAudio) await safeUnlink(stagedAudio);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

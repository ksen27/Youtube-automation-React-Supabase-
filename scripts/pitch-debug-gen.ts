import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

// Build ONE AI sales-pitch video END TO END on your own machine — TTS → HeyGen
// avatar (VISIBLE browser) → website scroll-recording → concat → a local mp4.
// Independent of the queue, the Fly worker, and the DB (migration 0026 is NOT
// required — nothing here reads/writes the pitch_* project columns). Use it to
// confirm the pitch pipeline and inspect the output before deploying.
//
//   npm run pitch:debug-gen -- \
//     --image <avatarPhotoUrl> \
//     --website https://themechanicbible.com/ \
//     --script "Hey, let me show you this site…" \
//     --account you@example.com \
//     [--voice <69labsVoiceId>] [--name <heygenAvatarName>] [--out ./tmp/pitch.mp4]
//
// --account pins the HeyGen account whose saved avatar you want (recommended, so
// the run doesn't pull a random pool account). --voice makes the pitch speak in
// that 69labs voice (the same field the real feature reads from the project's
// tts_voice_id); omit for the default voice. Forces HEYGEN_DEBUG=true so you
// WATCH the real HeyGen page the worker would drive.
//
// This calls the SAME building blocks the production processor uses
// (generateVoice, generateAvatar/attemptOnAccount, recordWebsiteScroll,
// buildPitchClip, concatPitchParts) so a green run here means the processor's
// path is sound; only the queue/DB wiring is exercised separately (Option A).

process.env.HEYGEN_DEBUG = "true";

import path from "node:path";
import { promises as fs } from "node:fs";
import { fetchOrThrow } from "@/lib/synthetic/http";
import { generateAvatar, attemptOnAccount } from "@/lib/synthetic/heygen";
import { getAccountByEmail } from "@/lib/synthetic/heygen-accounts";
import { generateVoice } from "@/lib/synthetic/sixtynine-labs";
import { recordWebsiteScroll } from "@/lib/synthetic/website-recorder";
import { buildPitchClip, concatPitchParts } from "@/lib/media/ffmpeg";
import { probeFile } from "@/lib/media/probe";
import { SYNTHETIC_WIDTH, SYNTHETIC_HEIGHT, SYNTHETIC_FPS } from "@/lib/synthetic/constants";

function parseArgs(argv: string[]) {
  const out: {
    image?: string; website?: string; script?: string;
    account?: string; voice?: string; name?: string; out?: string;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--image") out.image = argv[++i];
    else if (a === "--website") out.website = argv[++i];
    else if (a === "--script") out.script = argv[++i];
    else if (a === "--account") out.account = argv[++i];
    else if (a === "--voice") out.voice = argv[++i];
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const website = args.website;
  const avatarImageUrl = args.image;
  const script = args.script ?? "Hey there — let me quickly show you what this website is all about.";
  const outPath = path.resolve(args.out ?? "./tmp/pitch-debug.mp4");

  if (!avatarImageUrl) throw new Error("Need --image <avatarPhotoUrl>.");
  if (!website) throw new Error("Need --website <url>.");

  const tmp = path.resolve("./tmp/pitch-debug");
  await fs.mkdir(tmp, { recursive: true });

  console.log("AI sales-pitch debug build (HEADED browser — watch the avatar step):");
  console.log(`  website : ${website}`);
  console.log(`  image   : ${avatarImageUrl}`);
  console.log(`  voice   : ${args.voice ?? "(default)"}`);
  console.log(`  account : ${args.account ?? "(pool)"}`);
  console.log(`  script  : ${script.slice(0, 80)}${script.length > 80 ? "…" : ""}`);
  console.log(`  out     : ${outPath}\n`);

  // --- 1) TTS the pitch script (same voice as the project voiceover) ---
  console.log("[1/5] Generating pitch voiceover (69labs)…");
  const voice = await generateVoice({ text: script, voiceId: args.voice });
  const audioPath = path.join(tmp, "pitch.mp3");
  await fs.writeFile(audioPath, voice.audio);
  let audioSeconds = 0;
  try { audioSeconds = (await probeFile(audioPath)).durationSeconds; } catch { /* best-effort */ }
  console.log(`      audio ${audioSeconds.toFixed(2)}s (${voice.chars} chars)\n`);

  // --- 2) Render the avatar half via HeyGen (audio-driven, Avatar III) ---
  console.log("[2/5] Rendering avatar half via HeyGen (watch the browser)…");
  const imgRes = await fetchOrThrow(avatarImageUrl, { timeoutMs: 60_000 });
  const imageBytes = Buffer.from(await imgRes.arrayBuffer());
  const genInput = {
    projectId: "pitch-debug",
    segmentId: "pitch-debug",
    jobId: "pitch-debug",
    avatarImageUrl,
    script,
    audioFilePath: audioPath,
    audioDurationSeconds: audioSeconds || undefined,
    aspectRatio: "landscape" as const,
    avatarModel: "avatar_iii" as const,
    heygenAvatarName: args.name ?? null,
  };
  let avatarResult;
  if (args.account) {
    const account = await getAccountByEmail(args.account);
    if (!account) throw new Error(`no HeyGen account found for ${args.account} (connect it first).`);
    avatarResult = await attemptOnAccount(account, genInput, imageBytes, false);
  } else {
    avatarResult = await generateAvatar(genInput, imageBytes, 1);
  }
  console.log(`      avatar ok: ${avatarResult.videoUrl} (${avatarResult.seconds}s, ${avatarResult.accountId})\n`);

  const avatarRaw = path.join(tmp, "avatar_raw.mp4");
  const avatarClip = path.join(tmp, "avatar.mp4");
  const avRes = await fetchOrThrow(avatarResult.videoUrl, { timeoutMs: 120_000 });
  await fs.writeFile(avatarRaw, Buffer.from(await avRes.arrayBuffer()));
  // Mirrors the processor: avatar audio is dropped; the narration mp3 becomes
  // the master track at concat so the voiceover continues over the website.
  const websiteOverlapSeconds = Math.min(10, Math.max(0, audioSeconds - 5));
  const avatarShowSeconds = audioSeconds > 0 ? audioSeconds - websiteOverlapSeconds : 0;
  await buildPitchClip({
    inputPath: avatarRaw, outputPath: avatarClip, keepAudio: false,
    durationSeconds: avatarShowSeconds > 0 ? avatarShowSeconds : undefined,
    width: SYNTHETIC_WIDTH, height: SYNTHETIC_HEIGHT, fps: SYNTHETIC_FPS,
  });

  // --- 3) Record the website scroll ---
  console.log("[3/5] Recording website scroll…");
  const webRaw = path.join(tmp, "website_raw.webm");
  const webClip = path.join(tmp, "website.mp4");
  await recordWebsiteScroll({ url: website, outputPath: webRaw, width: SYNTHETIC_WIDTH, height: SYNTHETIC_HEIGHT });
  await buildPitchClip({ inputPath: webRaw, outputPath: webClip, keepAudio: false, width: SYNTHETIC_WIDTH, height: SYNTHETIC_HEIGHT, fps: SYNTHETIC_FPS });
  console.log("      website recorded\n");

  // --- 4) Concat avatar -> website ---
  console.log("[4/5] Concatenating avatar → website…");
  await concatPitchParts({ inputPaths: [avatarClip, webClip], outputPath: outPath, masterAudioPath: audioPath, width: SYNTHETIC_WIDTH, height: SYNTHETIC_HEIGHT, fps: SYNTHETIC_FPS });

  // --- 5) Report ---
  const fin = await probeFile(outPath);
  console.log(`[5/5] DONE → ${outPath}`);
  console.log(`      ${fin.durationSeconds.toFixed(2)}s  ${fin.width}x${fin.height}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ PITCH DEBUG FAILED");
  console.error(`  ${(err as Error).message}`);
  process.exit(1);
});

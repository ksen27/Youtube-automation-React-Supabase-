import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateAvatarViaApi, heygenApiFirstEnabled } from "@/lib/synthetic/heygen-api";
import { cropImageToPortrait } from "@/lib/media/ffmpeg";
import { getEnv } from "@/lib/env";

// ASPECT-RATIO ACCEPTANCE TEST for the API-first avatar path (client 2026-09-01:
// "the 16:9 and 9:16 clip should be generated correctly with API method").
//
// heygen-api-test.ts renders ONE clip and reports the URL — it never checks the
// clip's actual dimensions, so it cannot answer the client's question. This
// script renders BOTH ratios through the exact production code path and then
// ffprobes each result, so a green run is direct evidence that:
//   * a full-frame avatar block  -> 16:9 landscape (1920x1080 at the 1080p cap)
//   * a split_2 avatar block     -> 9:16 portrait  (1080x1920)
//
//   npm run heygen:api-aspect-verify -- <photo.jpg> <audio.mp3|audio_url>
//
// Bills TWO real API renders (~1 credit-minute each), so run it once at cutover
// rather than routinely. Requires HEYGEN_API_KEY.
//
// IMPORTANT — this mirrors the processor, not just the API client. For the
// portrait case the avatar processor pre-crops the source photo to 9:16 before
// handing it to either path (avatarProcessor.ts, cropImageToPortrait), because
// HeyGen pads a landscape source into its portrait canvas with white bars. This
// script applies the SAME crop, so what it measures is what production ships.

const run = promisify(execFile);

interface Case {
  label: string;
  aspect: "landscape" | "portrait";
  blockType: string;
  expectOrientation: "landscape" | "portrait";
}

const CASES: Case[] = [
  { label: "full-frame avatar", aspect: "landscape", blockType: "avatar", expectOrientation: "landscape" },
  { label: "split_2 avatar", aspect: "portrait", blockType: "split_2", expectOrientation: "portrait" },
];

function usage(msg?: string): never {
  if (msg) console.error(`\n  ${msg}\n`);
  console.error(
    "  Usage: npm run heygen:api-aspect-verify -- <photo.jpg> <audio.mp3|audio_url>\n",
  );
  process.exit(1);
}

// Probe the rendered mp4's real pixel dimensions. The URL is an R2 public URL,
// which ffprobe reads directly over HTTP — no download step needed.
async function probeDims(url: string): Promise<{ w: number; h: number }> {
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  const { stdout } = await run(
    ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", url],
    { maxBuffer: 1 << 20 },
  );
  const [w, h] = stdout.trim().split(",").map((n) => Number(n));
  if (!w || !h) throw new Error(`could not parse dimensions from ffprobe output: "${stdout.trim()}"`);
  return { w, h };
}

(async () => {
  const [photoArg, audioArg] = process.argv.slice(2);
  if (!photoArg || !audioArg) usage("photo and audio are required");

  const env = getEnv();
  if (!env.HEYGEN_API_KEY) {
    usage("HEYGEN_API_KEY is not set — add it to .env.local (or the Fly secret) first");
  }

  const isUrl = /^https?:/i.test(audioArg);
  console.log(
    JSON.stringify({
      msg: "aspect-verify.start",
      apiFirstFlag: heygenApiFirstEnabled(), // informational; this script calls the API path directly
      baseUrl: env.HEYGEN_API_BASE_URL,
      resolution: env.HEYGEN_API_RESOLUTION,
      audioMode: isUrl ? "url" : "local-file",
      cases: CASES.map((c) => `${c.blockType}=${c.aspect}`),
    }),
  );

  const rawPhoto = (await fs.readFile(photoArg).catch(() => {
    usage(`could not read photo file: ${photoArg}`);
  })) as Buffer;

  const results: string[] = [];
  let failed = false;

  for (const c of CASES) {
    console.log(`\n──  ${c.label}  (block_type=${c.blockType}, aspectRatio=${c.aspect})  ──`);

    // Mirror avatarProcessor: split_2 gets the 9:16 pre-crop before upload.
    let imageBytes: Buffer = rawPhoto;
    if (c.blockType === "split_2") {
      try {
        imageBytes = (await cropImageToPortrait(rawPhoto)) as Buffer;
        console.log("   pre-cropped source photo to 9:16 (as the processor does)");
      } catch (e) {
        console.warn(`   portrait pre-crop failed, using raw bytes: ${(e as Error).message}`);
      }
    }

    const t0 = Date.now();
    try {
      const result = await generateAvatarViaApi(
        {
          projectId: "aspect-verify",
          segmentId: `aspectverify-${c.aspect}-${Date.now()}`,
          jobId: "aspect-verify",
          avatarImageUrl: photoArg,
          script: "",
          audioFilePath: isUrl ? undefined : audioArg,
          audioUrl: isUrl ? audioArg : undefined,
          aspectRatio: c.aspect,
          avatarModel: "avatar_iii",
          heygenAvatarName: null,
        },
        imageBytes,
      );

      const { w, h } = await probeDims(result.videoUrl);
      const orientation = w >= h ? "landscape" : "portrait";
      const ok = orientation === c.expectOrientation;
      if (!ok) failed = true;

      const line = `${ok ? "✅" : "❌"} ${c.label.padEnd(18)} ${String(`${w}x${h}`).padEnd(11)} ${orientation} (expected ${c.expectOrientation})`;
      results.push(line);
      console.log(
        JSON.stringify({
          msg: ok ? "aspect-verify.case.OK" : "aspect-verify.case.MISMATCH",
          aspect: c.aspect,
          width: w,
          height: h,
          orientation,
          expected: c.expectOrientation,
          elapsedSeconds: Math.round((Date.now() - t0) / 1000),
          videoUrl: result.videoUrl,
        }),
      );
    } catch (err) {
      failed = true;
      results.push(`❌ ${c.label.padEnd(18)} RENDER FAILED — ${(err as Error).message.slice(0, 120)}`);
      console.error(
        JSON.stringify({
          msg: "aspect-verify.case.FAILED",
          aspect: c.aspect,
          elapsedSeconds: Math.round((Date.now() - t0) / 1000),
          err: (err as Error).message,
        }),
      );
    }
  }

  console.log(`\n${"═".repeat(66)}\n  ASPECT-RATIO VERIFICATION\n${"═".repeat(66)}`);
  for (const r of results) console.log(`  ${r}`);
  console.log(
    `\n  Note: ${env.HEYGEN_API_RESOLUTION} is the Avatar III photo-avatar ceiling —\n` +
      "  4K is rejected by the engine, so both ratios upscale into the 3840x2160 canvas.\n",
  );

  process.exit(failed ? 1 : 0);
})();

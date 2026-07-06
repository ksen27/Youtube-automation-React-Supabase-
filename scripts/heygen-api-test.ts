import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { promises as fs } from "node:fs";
import { generateAvatarViaApi, heygenApiFallbackEnabled } from "@/lib/synthetic/heygen-api";
import { getEnv } from "@/lib/env";

// End-to-end smoke test for the HeyGen API avatar fallback (lib/synthetic/heygen-api.ts).
// Runs the SAME code path generateAvatar() uses when the browser pool is exhausted,
// but in isolation — so you can confirm the API key + request shapes work BEFORE
// relying on the fallback in production. Bills ONE API render (real credits).
//
//   npm run heygen:api-test -- <photo.jpg> <audio.mp3> [landscape|portrait]
//   npm run heygen:api-test -- ./face.jpg https://media.celebforge.org/....mp3 portrait
//
// The photo is always read as local bytes. The audio may be a LOCAL path or a
// public URL — a URL exercises the preferred `audio_url` path (no upload), a local
// file exercises the asset-upload path. This mirrors exactly what the real fallback
// does, so a green run here means the fallback will work.
//
// Requires HEYGEN_API_KEY set. HEYGEN_API_FALLBACK does NOT need to be true (that
// flag only gates the AUTOMATIC fallback inside generateAvatar; this script calls
// the API path directly on purpose).

function usage(msg?: string): never {
  if (msg) console.error(`\n  ${msg}\n`);
  console.error(
    "  Usage: npm run heygen:api-test -- <photo.jpg> <audio.mp3|audio_url> [landscape|portrait]\n",
  );
  process.exit(1);
}

(async () => {
  const [photoArg, audioArg, aspectArg = "landscape"] = process.argv.slice(2);
  if (!photoArg || !audioArg) usage("photo and audio are required");
  if (aspectArg !== "landscape" && aspectArg !== "portrait") {
    usage(`aspect must be 'landscape' or 'portrait' (got '${aspectArg}')`);
  }

  const env = getEnv();
  if (!env.HEYGEN_API_KEY) {
    usage("HEYGEN_API_KEY is not set — add it to .env.local (or the Fly secret) first");
  }
  console.log(
    JSON.stringify({
      msg: "heygen-api-test.start",
      fallbackEnabledFlag: heygenApiFallbackEnabled(), // informational; this script calls directly
      baseUrl: env.HEYGEN_API_BASE_URL,
      resolution: env.HEYGEN_API_RESOLUTION,
      aspect: aspectArg,
      audioMode: /^https?:/i.test(audioArg) ? "url" : "local-file",
    }),
  );

  // Photo: always local bytes.
  const imageBytes = await fs.readFile(photoArg).catch(() => {
    usage(`could not read photo file: ${photoArg}`);
  });

  // Audio: a URL uses the preferred audio_url path; a local file uploads the asset.
  const isUrl = /^https?:/i.test(audioArg);
  const input = {
    projectId: "api-test",
    segmentId: `apitest-${aspectArg}`,
    jobId: "api-test",
    avatarImageUrl: photoArg,
    script: "",
    audioFilePath: isUrl ? undefined : audioArg,
    audioUrl: isUrl ? audioArg : undefined,
    aspectRatio: aspectArg as "landscape" | "portrait",
    avatarModel: "avatar_iv" as const,
    heygenAvatarName: null,
  };

  const t0 = Date.now();
  try {
    const result = await generateAvatarViaApi(input, imageBytes as Buffer);
    console.log(
      JSON.stringify({
        msg: "heygen-api-test.OK",
        elapsedSeconds: Math.round((Date.now() - t0) / 1000),
        videoUrl: result.videoUrl,
        seconds: result.seconds,
        accountId: result.accountId,
      }),
    );
    console.log(`\n  ✅ Success — rendered avatar is at:\n     ${result.videoUrl}\n`);
    process.exit(0);
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: "heygen-api-test.FAILED",
        elapsedSeconds: Math.round((Date.now() - t0) / 1000),
        err: (err as Error).message,
      }),
    );
    console.error(
      "\n  ❌ Failed. If this is a field-name mismatch (e.g. HeyGen changed a request field),\n" +
        "     the fix is in lib/synthetic/heygen-api.ts — the error message above from\n" +
        "     fetchOrThrow includes the API's response body, which usually names the bad field.\n",
    );
    process.exit(1);
  }
})();

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { writeFileSync } from "node:fs";
import { generateLtxVideo, isLtxConfigured, snapDuration } from "@/lib/synthetic/ltx";

// Live, single-call smoke test for the LTX-2 image-to-video provider. Hits the
// REAL api.ltx.video, so it costs one generation (~a few seconds of video).
// Use it to confirm the wire format the integration was coded against — the
// submit -> poll -> result.video_url contract — before running a full project.
//
//   npx tsx --env-file=.env.local scripts/test-ltx.ts <imageUrl> [duration] [prompt...]
//
//   imageUrl  REQUIRED. A PUBLICLY reachable still (e.g. an R2 URL). LTX
//             fetches it server-side, so localhost/private URLs won't work.
//   duration  Optional seconds (default 6). Snapped to LTX's nearest tier.
//   prompt    Optional motion prompt (default a gentle push-in).
//
// On success it writes ltx-test-output.mp4 in the cwd and prints the provider +
// duration. On failure it prints the exact error — most usefully, a
// "no result.video_url" message means the completed-response field is named
// differently than assumed, which is a one-line fix in lib/synthetic/ltx.ts.

async function main() {
  if (!isLtxConfigured()) {
    console.error("LTX_API_KEY is not set. Add it to .env.local and retry.");
    process.exit(2);
  }

  const imageUrl = process.argv[2]?.trim();
  if (!imageUrl) {
    console.error(
      "Usage: npx tsx --env-file=.env.local scripts/test-ltx.ts <imageUrl> [duration] [prompt...]",
    );
    process.exit(2);
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    console.error(`imageUrl must be a public http(s) URL (got: ${imageUrl})`);
    process.exit(2);
  }

  const durationArg = Number(process.argv[3]);
  const requested = Number.isFinite(durationArg) && durationArg > 0 ? durationArg : 6;
  const prompt =
    process.argv.slice(4).join(" ").trim() ||
    "Subtle natural motion, slow cinematic push-in.";

  console.log("LTX-2 image-to-video smoke test");
  console.log(`  imageUrl : ${imageUrl}`);
  console.log(`  requested: ${requested}s -> snapped: ${snapDuration(requested, 20)}s`);
  console.log(`  prompt   : ${prompt}`);
  console.log("  submitting (this polls until completed; may take a minute)...");

  const t0 = Date.now();
  try {
    const clip = await generateLtxVideo({ imageUrl, prompt, durationSeconds: requested });
    const out = "ltx-test-output.mp4";
    writeFileSync(out, clip.video);
    console.log("  ✓ success");
    console.log(`    provider   : ${clip.provider}`);
    console.log(`    billed secs: ${clip.seconds}`);
    console.log(`    contentType: ${clip.contentType}`);
    console.log(`    bytes      : ${clip.video.length.toLocaleString()}`);
    console.log(`    elapsed    : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`    saved      : ${out}`);
  } catch (e) {
    console.error("  ✗ failed");
    console.error(`    ${(e as Error).message}`);
    console.error(
      "\n  If this says 'no result.video_url', the completed-response shape differs\n" +
      "  from what lib/synthetic/ltx.ts expects — adjust the field path there.",
    );
    process.exit(1);
  }
}

void main();

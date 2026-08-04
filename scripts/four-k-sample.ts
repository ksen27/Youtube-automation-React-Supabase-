// Generate a REAL 4K sample (still + animated clip) using the production
// generators, so the 4K change can be judged by eye before it ships.
//
//   npx tsx --env-file=.env.local scripts/four-k-sample.ts
//
// Writes to ./four-k-sample/. Resolution overrides are applied to process.env
// BEFORE the libs are imported — getEnv() caches on first read, so the imports
// must be dynamic and must come after these assignments.
import fs from "node:fs/promises";
import path from "node:path";

process.env.SIXTYNINE_LABS_IMAGE_RESOLUTION = "4k";
process.env.LTX_RESOLUTION = "3840x2160";

const OUT_DIR = path.join(process.cwd(), "four-k-sample");

// Fine detail (hair, stubble, fabric weave, background depth) is what actually
// reveals whether 4K buys real resolution rather than a bigger file.
const PROMPT =
  "A weathered fisherman in a knitted wool sweater stands on a harbour dock at " +
  "golden hour, close-up three-quarter portrait, deep wrinkles and stubble, " +
  "individual strands of grey hair catching the light, coiled rope and rusted " +
  "boat hull behind him, shallow depth of field, photorealistic, cinematic";

const MOTION = "Slow subtle push-in on the subject's face. No camera shake.";

async function main() {
  const { generateImage } = await import("@/lib/synthetic/sixtynine-labs");
  const { generateLtxVideo } = await import("@/lib/synthetic/ltx");

  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(`image resolution = ${process.env.SIXTYNINE_LABS_IMAGE_RESOLUTION}`);
  console.log(`ltx resolution   = ${process.env.LTX_RESOLUTION}`);

  const t0 = Date.now();
  const img = await generateImage(PROMPT);
  const imgPath = path.join(OUT_DIR, "sample-4k.jpg");
  await fs.writeFile(imgPath, img.image);
  console.log(`\nIMAGE  ${imgPath}`);
  console.log(`  bytes=${img.image.length}  ${(Date.now() - t0) / 1000}s`);

  // LTX accepts a data: URI directly (per its own validator message), so the
  // sample needs no R2 upload.
  const dataUri = `data:${img.contentType || "image/jpeg"};base64,${img.image.toString("base64")}`;
  const t1 = Date.now();
  const clip = await generateLtxVideo({
    imageUrl: dataUri,
    prompt: MOTION,
    durationSeconds: 6,
  });
  const clipPath = path.join(OUT_DIR, "sample-4k.mp4");
  await fs.writeFile(clipPath, clip.video);
  console.log(`\nCLIP   ${clipPath}`);
  console.log(`  bytes=${clip.video.length}  provider=${clip.provider}  seconds=${clip.seconds}  ${(Date.now() - t1) / 1000}s`);
}

void main().catch((err) => {
  console.error("FAILED:", err?.message || err);
  process.exitCode = 1;
});

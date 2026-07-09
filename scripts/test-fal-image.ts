// One-off smoke test for the fal.ai FLUX text-to-image fallback.
//
// Generates a SINGLE image via generateFalImage() and writes it to disk so you
// can eyeball the result and confirm the API contract (submit -> poll -> download)
// works end to end. Does NOT touch 69labs, the DB, or any queue.
//
// Run with the fal.ai key available in the environment, e.g.:
//   FAL_AI_API_KEY=xxxx npx tsx scripts/test-fal-image.ts
// or, if the key is in an env file:
//   npx tsx --env-file=.env.local scripts/test-fal-image.ts
//
// Optional: pass a custom prompt as the first arg.
import { writeFile } from "node:fs/promises";
import { generateFalImage, isFalImageConfigured } from "@/lib/synthetic/falai";

async function main() {
  if (!isFalImageConfigured()) {
    console.error("FAL_AI_API_KEY not configured — set it in the environment or env file.");
    process.exit(1);
  }
  const prompt =
    process.argv[2] ||
    "A candid, amateur-shot photo of a vintage car engine bay in a home garage, natural light, slightly grainy like real phone footage.";
  console.log("Submitting to fal.ai FLUX with prompt:\n ", prompt, "\n");

  const t0 = Date.now();
  const out = await generateFalImage(prompt);
  const ms = Date.now() - t0;

  const ext = out.contentType.includes("png") ? "png" : "jpg";
  const path = `fal-test-image.${ext}`;
  await writeFile(path, out.image);

  console.log("SUCCESS");
  console.log("  provider   :", out.provider);
  console.log("  contentType:", out.contentType);
  console.log("  bytes      :", out.image.length);
  console.log("  took       :", ms, "ms");
  console.log("  saved to   :", path);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("FAILED:", (e as Error).message);
  process.exit(1);
});

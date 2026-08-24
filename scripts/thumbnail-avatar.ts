/**
 * Make an AI AVATAR face for the /thumbnails feature and host it on R2.
 *
 *   npx tsx --env-file=.env.local scripts/thumbnail-avatar.ts "<description>"
 *
 * Prints the public URL, which is exactly what the generate screen's subject
 * field takes. Uses the video engine's image provider (ai33 / 69labs, gpt-image-2)
 * because that is the model already provisioned for real-looking people here.
 *
 * The avatar is a PLAIN, WELL-LIT PORTRAIT on purpose: it is an identity source,
 * not a thumbnail. Pikzels reads the face from it and puts that person into the
 * generated scene, so any drama baked into the portrait only fights the scene.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { uploadBuffer } from "@/lib/storage";

const OUT_DIR = path.join(process.cwd(), "tmp", "thumbnail-probe");

async function main(): Promise<void> {
  const description = process.argv[2];
  if (!description) throw new Error('usage: thumbnail-avatar.ts "<person description>"');

  const prompt =
    `A photorealistic head-and-shoulders portrait of ${description}. ` +
    "Neutral friendly expression, looking straight at the camera, even soft daylight, " +
    "plain uncluttered background, sharp focus on the face, no text, no graphics, no logos. " +
    "The whole face is visible and unobstructed.";

  // rawPrompt: this must NOT pick up the video engine's cinematic style suffix —
  // it is a reference face, not a scene.
  const out = await generateImage(prompt, undefined, { rawPrompt: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  const local = path.join(OUT_DIR, "avatar.png");
  await fs.writeFile(local, out.image);

  const key = `thumbnails/references/avatar-${out.image.length}.png`;
  const up = await uploadBuffer(out.image, key, out.contentType || "image/png");
  console.log(JSON.stringify({ provider: out.provider, local, url: up.publicUrl }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

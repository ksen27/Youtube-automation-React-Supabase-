// Clip quality, measured by eye: ONE still, animated at several settings, so
// the resolution question can be judged instead of argued.
//
//   npx tsx --env-file=.env.local scripts/clip-quality-sample.ts
//
// WHY THIS EXISTS. The 2026-08-22 GPU cutover (f926156) changed four things at
// once, and its own commit message says: "NOT YET VERIFIED: no full video has
// been generated end-to-end on the GPU ... Requires a side-by-side quality check
// before customer output." That check is this script.
//
// The comparison that matters:
//   1080p   what the client had BEFORE the cutover (api.ltx.video, native)
//   720p    the cutover's new resolution -- isolates resolution from every
//           other change in that commit
//
// Both clips animate the SAME still with the SAME prompt for the SAME duration,
// so the only variable is the one in the filename.
//
// TO TEST THE SELF-HOSTED GPU INSTEAD, point it at the pod:
//   LTX_BASE_URL=https://<pod>-8000.proxy.runpod.net \
//   LTX_API_KEY=<LTX_SELFHOST_TOKEN> \
//   npx tsx --env-file=.env.local scripts/clip-quality-sample.ts
//
// NOTE ON THE SELF-HOST AT 1080p: asking it for 1920x1080 does NOT give a 1080p
// render. TWO_STAGE_MIN_PIXELS routes 1080p through the two-stage path, which
// generates 960x544 (522k real pixels) and upsamples -- LESS real detail than
// its own native 720p (922k pixels). So on the pod, 720p should look BETTER than
// 1080p. That inversion is the finding; this script is how to confirm it.
//
// Talks to the /v2 contract directly rather than going through lib/synthetic/ltx
// so that resolution is a per-request argument -- getEnv() caches on first read
// and cannot be re-read per variant within one process.

import fs from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "clip-quality-sample");
const BASE = (process.env.LTX_BASE_URL || "https://api.ltx.video").replace(/\/$/, "");
const KEY = process.env.LTX_API_KEY || "";
const MODEL = process.env.LTX_MODEL || "ltx-2-3-fast";
const FPS = Number(process.env.LTX_FPS || 25);
const DURATION = Number(process.env.SAMPLE_DURATION || 4);

// Fine detail is what reveals real resolution: hair, stubble, fabric weave,
// background depth. The motion is deliberate too -- the client's complaint is
// specifically "when it moves, the quality is so bad", so the subject has to be
// doing something with her hands.
const IMAGE_PROMPT =
  "A woman in her sixties kneading bread dough on a worn wooden kitchen table, " +
  "close three-quarter view, flour on her forearms, a knitted cardigan with " +
  "visible stitches, strands of grey hair loose at her temple, a window behind " +
  "her, ordinary home kitchen, photographed on a phone";

const MOTION_PROMPT =
  "She kneads the dough steadily with both hands, pressing it forward and " +
  "folding it back, a complete kneading motion from the first frame to the " +
  "last. The camera is locked off on a tripod and never moves; only she moves. " +
  "Handheld phone video look, slightly grainy like a real home vlog clip.";

const VARIANTS = [
  { name: "1080p", resolution: "1920x1080" },
  { name: "720p", resolution: "1280x720" },
];

async function submit(imageUri: string, resolution: string): Promise<string> {
  const res = await fetch(`${BASE}/v2/image-to-video`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt: MOTION_PROMPT,
      image_uri: imageUri,
      resolution,
      fps: FPS,
      duration: DURATION,
    }),
  });
  if (!res.ok) throw new Error(`submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const { id } = (await res.json()) as { id?: string };
  if (!id) throw new Error("submit returned no job id");
  return id;
}

async function poll(id: string, timeoutMs = 900_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/v2/image-to-video/${id}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) throw new Error(`poll ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      status?: string;
      result?: { video_url?: string };
      error?: unknown;
    };
    if (body.status === "completed" && body.result?.video_url) return body.result.video_url;
    if (body.status === "failed") throw new Error(`job failed: ${JSON.stringify(body.error).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("timed out waiting for the clip");
}

async function main() {
  if (!KEY) throw new Error("LTX_API_KEY is not set");
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log(`\nendpoint : ${BASE}`);
  console.log(`model    : ${MODEL}`);
  console.log(`duration : ${DURATION}s @ ${FPS}fps\n`);

  const { generateImage } = await import("@/lib/synthetic/sixtynine-labs");
  const t0 = Date.now();
  const img = await generateImage(IMAGE_PROMPT);
  const imgPath = path.join(OUT_DIR, "source-still.jpg");
  await fs.writeFile(imgPath, img.image);
  console.log(
    `STILL  ${imgPath}  ${img.image.length} bytes  ${((Date.now() - t0) / 1000).toFixed(1)}s  (${img.provider})`,
  );

  // LTX accepts a data: URI directly, so a sample needs no R2 upload.
  const dataUri = `data:${img.contentType || "image/jpeg"};base64,${img.image.toString("base64")}`;

  for (const v of VARIANTS) {
    const t = Date.now();
    try {
      const id = await submit(dataUri, v.resolution);
      const url = await poll(id);
      const dl = await fetch(url);
      if (!dl.ok) throw new Error(`download ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const out = path.join(OUT_DIR, `${v.name}.mp4`);
      await fs.writeFile(out, buf);
      console.log(
        `CLIP   ${out}  ${v.resolution}  ${buf.length} bytes  ${((Date.now() - t) / 1000).toFixed(1)}s`,
      );
    } catch (e) {
      console.log(`CLIP   ${v.name} (${v.resolution})  FAILED: ${(e as Error).message?.slice(0, 250)}`);
    }
  }

  console.log(`\nCompare the files in ${OUT_DIR} full-screen.`);
  console.log("Look at the MOVING region (her hands and the dough), not the background —");
  console.log("that is where both the resolution loss and the encoder smear show up.\n");
}

void main().catch((err) => {
  console.error("FAILED:", err?.message || err);
  process.exitCode = 1;
});

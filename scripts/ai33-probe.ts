// End-to-end probe for the ai33.pro provider through the REAL engine entry
// points (lib/synthetic/sixtynine-labs generateImage / generateVoice), so what
// it exercises is exactly what the workers run: provider order, the style
// prompt, resume-pointer plumbing, and the Redis concurrency slot.
//
//   npx tsx --env-file=.env.local scripts/ai33-probe.ts image  # -> tmp/ai33-probe/*.png
//   npx tsx --env-file=.env.local scripts/ai33-probe.ts voice  # -> tmp/ai33-probe/*.mp3
//   npx tsx --env-file=.env.local scripts/ai33-probe.ts both   # (default)
//
// Costs real credits on whichever provider answers, so keep the samples small.
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateImage, generateVoice } from "@/lib/synthetic/sixtynine-labs";
import { isAi33Configured } from "@/lib/synthetic/ai33";
import { getEnv } from "@/lib/env";

const OUT_DIR = path.join(process.cwd(), "tmp", "ai33-probe");

const SCENE =
  "An older man in a plain kitchen pouring hot water from a kettle into a mug " +
  "on the counter, morning light through the window";

async function probeImage(): Promise<void> {
  const t0 = Date.now();
  // No rawPrompt: this goes through withStylePrompt, i.e. the exact prompt the
  // avatar/image lanes send in production.
  const out = await generateImage(SCENE);
  const file = path.join(OUT_DIR, `still-${out.provider}.png`);
  await fs.writeFile(file, out.image);
  console.log(
    JSON.stringify({
      msg: "probe.image.ok",
      provider: out.provider,
      contentType: out.contentType,
      bytes: out.image.length,
      seconds: Math.round((Date.now() - t0) / 1000),
      file,
    }),
  );
}

// Pass a BARE ElevenLabs voice id (the form project rows store) as argv[3] —
// that also exercises the ai33 `elevenlabs_` prefixing. Without one the engine
// falls back to SIXTYNINE_LABS_DEFAULT_VOICE, which is a placeholder ("narrator")
// that BOTH providers reject.
async function probeVoice(voiceId?: string): Promise<void> {
  const t0 = Date.now();
  const out = await generateVoice({
    text: "This is a short test of the voiceover provider used by the video pipeline.",
    voiceId,
  });
  const file = path.join(OUT_DIR, `voice-${out.provider}.mp3`);
  await fs.writeFile(file, out.audio);
  console.log(
    JSON.stringify({
      msg: "probe.voice.ok",
      provider: out.provider,
      contentType: out.contentType,
      bytes: out.audio.length,
      chars: out.chars,
      seconds: Math.round((Date.now() - t0) / 1000),
      file,
    }),
  );
}

async function main(): Promise<void> {
  const mode = (process.argv[2] || "both").toLowerCase();
  const env = getEnv();
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(
    JSON.stringify({
      msg: "probe.config",
      ai33: isAi33Configured() ? "primary" : "disabled/unkeyed",
      ai33Model: env.AI33_IMAGE_MODEL,
      ai33Resolution: env.AI33_IMAGE_RESOLUTION,
      ai33Quality: env.AI33_IMAGE_QUALITY,
      sixtynineModel: env.SIXTYNINE_LABS_IMAGE_MODEL,
      sixtynineResolution: env.SIXTYNINE_LABS_IMAGE_RESOLUTION,
    }),
  );

  if (mode === "image" || mode === "both") await probeImage();
  if (mode === "voice" || mode === "both") await probeVoice(process.argv[3]);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(JSON.stringify({ msg: "probe.failed", err: (e as Error).message }));
    process.exit(1);
  });

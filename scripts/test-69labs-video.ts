import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { writeFileSync } from "node:fs";
import { generateImage } from "@/lib/synthetic/sixtynine-labs";
import { degradeImageLowFi } from "@/lib/synthetic/degrade";
import { uploadBuffer } from "@/lib/storage";

// SAMPLE GENERATOR for the client's "action clip" request (Loom, 2026-08-17):
// a clip in which a PERSON VISIBLY PERFORMS the action the voiceover describes
// (stirring, pouring milk) — instead of the current ai_clip, which is a still
// with a barely-perceptible push-in.
//
// End-to-end, exactly the way the real lane would run it:
//   1. still  : generateImage() — the house STYLE_PROMPT is applied, so the
//               frame is already "amateur phone photo", not a stock render.
//   2. degrade: degradeImageLowFi() — grain + softness + JPEG artifacts, so the
//               VIDEO inherits real-footage texture from its source frame
//               rather than Veo's glossy default look.
//   3. clip   : 69labs POST /api/v1/videos/generate (Veo 3.1 Lite, image input)
//               with an ACTION prompt, then poll + download.
//   4. upload : both the still and the mp4 go to R2 so they can be shared.
//
// The submit field names are NOT documented to us, so submit() tries a short
// list of plausible payload shapes and reports which one the API accepted —
// that answer is what the real provider module gets coded against.
//
//   npx tsx scripts/test-69labs-video.ts ["scene prompt"] ["action prompt"]

const BASE = (process.env.SIXTYNINE_LABS_BASE_URL || "https://69labs.vip").replace(/\/$/, "");
const KEY = (process.env.SIXTYNINE_LABS_API_KEY || "").trim();
const MODEL = process.env.SIXTYNINE_LABS_VIDEO_MODEL || "veo-video";

// The client's own reference: the voiceover says "add the milk", and you SEE
// her add it. Deliberately a hands-on kitchen action, not a static product shot.
const DEFAULT_SCENE =
  "A woman's hands pouring milk from a glass bottle into a large mixing bowl of " +
  "dry oats on a cluttered home kitchen counter, seen from just over her shoulder";

// The action prompt. This is the OPPOSITE of the current ai_clip animation
// prompt (which forbids motion): here the whole point is a single, clearly
// readable human action carried through the shot. The low-fi cues are kept so
// the motion doesn't arrive looking like a polished commercial.
const DEFAULT_ACTION =
  "The woman pours the milk steadily from the bottle into the bowl; the milk " +
  "streams down and soaks into the oats, and she tilts the bottle back upright " +
  "as she finishes. One single continuous everyday action, filmed casually. " +
  "Handheld phone video with small natural wobble, slightly low quality and " +
  "grainy like a real home vlog clip — NOT smooth, NOT cinematic, no slow " +
  "motion, no dramatic camera move, no colour grading, no on-screen text.";

interface SubmitAttempt {
  label: string;
  body: Record<string, unknown>;
}

// Plausible submit shapes, most-likely first. 69labs' tts/images lanes both use
// POST /<lane>/generate with a `model` field, so that shape leads.
function attempts(prompt: string, imageUrl: string): SubmitAttempt[] {
  return [
    {
      label: "model + imageUrls[] + mode:keyframes",
      body: { model: MODEL, prompt, imageUrls: [imageUrl], aspectRatio: "16:9", mode: "keyframes" },
    },
    {
      label: "model + imageUrls[] (no mode)",
      body: { model: MODEL, prompt, imageUrls: [imageUrl], aspectRatio: "16:9" },
    },
    {
      label: "model + imageUrl (singular)",
      body: { model: MODEL, prompt, imageUrl, aspectRatio: "16:9" },
    },
    {
      label: "modelId + imageUrls[]",
      body: { modelId: MODEL, prompt, imageUrls: [imageUrl], aspectRatio: "16:9" },
    },
  ];
}

async function submit(prompt: string, imageUrl: string): Promise<string> {
  for (const a of attempts(prompt, imageUrl)) {
    const res = await fetch(`${BASE}/api/v1/videos/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(a.body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (res.ok) {
      const parsed = JSON.parse(text) as { id?: string; jobId?: string };
      const id = parsed.id || parsed.jobId;
      if (!id) throw new Error(`submit ok but no job id: ${text.slice(0, 300)}`);
      console.log(`  ✓ accepted shape: ${a.label}`);
      console.log(`    payload: ${JSON.stringify(a.body)}`);
      return id;
    }
    console.log(`  ✗ [${res.status}] ${a.label} :: ${text.slice(0, 300)}`);
  }
  throw new Error("every submit shape was rejected — see the errors above");
}

async function poll(jobId: string): Promise<void> {
  const deadline = Date.now() + 15 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/v1/videos/status/${jobId}`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    const st = (await res.json()) as {
      status?: string;
      userMessage?: string;
      error?: string;
      queuePosition?: number;
    };
    const s = (st.status || "").toUpperCase();
    if (s !== last) {
      console.log(`    status: ${s}${st.queuePosition != null ? ` (queue ${st.queuePosition})` : ""}`);
      last = s;
    }
    if (s === "COMPLETED") return;
    if (["FAILED", "CANCELLED", "CENSORED"].includes(s)) {
      throw new Error(`video job ${s}${st.userMessage || st.error ? ` — ${st.userMessage || st.error}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`video job poll timed out (job ${jobId})`);
}

async function main() {
  if (!KEY) {
    console.error("SIXTYNINE_LABS_API_KEY not set");
    process.exit(2);
  }
  const scene = process.argv[2]?.trim() || DEFAULT_SCENE;
  const action = process.argv[3]?.trim() || DEFAULT_ACTION;
  const stamp = Date.now();

  console.log("69labs ACTION-CLIP sample (Veo 3.1 Lite)\n");
  console.log(`  scene : ${scene}\n`);
  console.log(`  action: ${action}\n`);

  // --- 1) the source still, in the house style ---
  console.log("[1/4] generating the source still (house style applied)…");
  const t0 = Date.now();
  const img = await generateImage(scene);
  console.log(`  ✓ ${img.provider}, ${img.image.length.toLocaleString()} bytes, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // --- 2) low-fi degrade, so the CLIP inherits real-footage texture ---
  console.log("[2/4] applying the low-fi degrade…");
  const deg = await degradeImageLowFi(img.image);
  console.log(`  ✓ degraded=${deg.degraded}, ${deg.image.length.toLocaleString()} bytes`);
  writeFileSync(`action-sample-${stamp}-still.jpg`, deg.image);

  const upImg = await uploadBuffer(
    deg.image,
    `samples/action-clip/${stamp}-still.jpg`,
    deg.degraded ? deg.contentType : img.contentType,
  );
  console.log(`  ✓ still: ${upImg.publicUrl}`);

  // --- 3) the action clip ---
  console.log("[3/4] submitting the Veo action clip…");
  const jobId = await submit(action, upImg.publicUrl);
  console.log(`  job: ${jobId}`);
  await poll(jobId);

  console.log("[4/4] downloading…");
  const dl = await fetch(`${BASE}/api/v1/videos/download/${jobId}`, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(180_000),
  });
  if (!dl.ok) throw new Error(`download failed: HTTP ${dl.status} ${(await dl.text()).slice(0, 300)}`);
  const video = Buffer.from(await dl.arrayBuffer());
  const outFile = `action-sample-${stamp}.mp4`;
  writeFileSync(outFile, video);

  const upVid = await uploadBuffer(video, `samples/action-clip/${stamp}.mp4`, "video/mp4");
  console.log(`\n  ✓ DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`    local : ${outFile} (${video.length.toLocaleString()} bytes)`);
  console.log(`    shared: ${upVid.publicUrl}`);
}

void main().catch((e) => {
  console.error(`\n  ✗ ${(e as Error).message}`);
  process.exit(1);
});

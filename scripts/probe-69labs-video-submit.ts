import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

// Pins down the EXACT submit contract for 69labs' video lane. The end-to-end
// sample proved one of several candidate payload shapes works, but its output
// was lost, so this re-establishes which one — and, more usefully, prints the
// VALIDATION ERRORS for the rejected shapes, which is where the real field
// names come from. Reuses an already-uploaded still, so no image is generated.
//
// Costs at most 1 video credit (the first shape that is accepted). The job is
// left to run; we don't poll or download.
//
//   npx tsx scripts/probe-69labs-video-submit.ts

const BASE = (process.env.SIXTYNINE_LABS_BASE_URL || "https://69labs.vip").replace(/\/$/, "");
const KEY = (process.env.SIXTYNINE_LABS_API_KEY || "").trim();
const MODEL = "veo-video";
const IMAGE = "https://media.celebforge.org/samples/action-clip/1786958603040-still.jpg";
const PROMPT = "The woman pours milk into the bowl. Locked-off camera, only the person moves.";

const SHAPES: Array<{ label: string; body: Record<string, unknown> }> = [
  { label: "A: model + imageUrls[] + mode",  body: { model: MODEL, prompt: PROMPT, imageUrls: [IMAGE], aspectRatio: "16:9", mode: "keyframes" } },
  { label: "B: model + imageUrls[]",         body: { model: MODEL, prompt: PROMPT, imageUrls: [IMAGE], aspectRatio: "16:9" } },
  { label: "C: model + imageUrl",            body: { model: MODEL, prompt: PROMPT, imageUrl: IMAGE, aspectRatio: "16:9" } },
  { label: "D: modelId + imageUrls[]",       body: { modelId: MODEL, prompt: PROMPT, imageUrls: [IMAGE], aspectRatio: "16:9" } },
  // No image at all — establishes whether text-to-video is allowed, which
  // decides if the still is mandatory for the veo lane.
  { label: "E: text-only (no image)",        body: { model: MODEL, prompt: PROMPT, aspectRatio: "16:9" } },
];

async function main() {
  if (!KEY) {
    console.error("SIXTYNINE_LABS_API_KEY not set");
    process.exit(2);
  }
  let accepted = false;
  for (const s of SHAPES) {
    // Stop spending credits once we know the shape; keep probing ONLY to
    // collect rejection messages, which is free.
    if (accepted) {
      console.log(`\n--- ${s.label}: skipped (contract already established)`);
      continue;
    }
    const res = await fetch(`${BASE}/api/v1/videos/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(s.body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    console.log(`\n[${res.status}] ${s.label}`);
    console.log(`  sent: ${JSON.stringify(s.body).slice(0, 200)}`);
    console.log(`  recv: ${text.slice(0, 500)}`);
    if (res.ok) accepted = true;
  }
}

void main();

/* eslint-disable no-console */
// FEASIBILITY PROBE: can we put a SPECIFIC person (the project's uploaded
// avatar) into a generated b-roll scene?
//
//   npx tsx --env-file=.env.local scripts/probe-face-reference.ts            # self-test
//   npx tsx --env-file=.env.local scripts/probe-face-reference.ts <face.jpg|url> ["scene"]
//
// Why this exists: the client wants the narrating avatar to appear as a
// character in a small number of clips. Today that is impossible — every
// ACTIVE image provider (ai33 / 69labs, both gpt-image-2) is TEXT-TO-IMAGE
// only, and projects.avatar_image_url never leaves the HeyGen processor.
//
// gemini-2.5-flash-image DOES accept image parts as an identity reference, and
// lib/synthetic/gemini-image.ts already wraps that model — but it sends
// `contents: prompt` (a bare string), so the capability is unreachable, and the
// module is dead code (dropped from the chain 2026-08-15).
//
// With no argument this self-tests: generate a plain portrait, then generate a
// SCENE conditioned on that portrait. Step 2 is the capability the feature
// needs. Writes both files so the face can be compared by eye.
import { readFileSync, writeFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { getEnv } from "@/lib/env";

interface Img { data: string; mimeType: string }

const PORTRAIT_PROMPT =
  "A plain, well-lit frontal portrait photograph of a man in his fifties with a " +
  "short grey beard, weathered face, plain dark work shirt, neutral grey " +
  "background, looking directly at the camera.";

const DEFAULT_SCENE =
  "This exact person, same face, at the wheel of a pickup truck on a long empty " +
  "rural highway, seen from the passenger side, late afternoon light. Candid " +
  "documentary photograph, not a portrait.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function imageFrom(response: any, label: string): Img {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = response.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img?.inlineData?.data) {
    const text = parts.map((p) => p.text).filter(Boolean).join(" ");
    throw new Error(
      `${label}: no image part (finishReason=${response.candidates?.[0]?.finishReason}) ${text.slice(0, 300)}`,
    );
  }
  return { data: img.inlineData.data, mimeType: img.inlineData.mimeType || "image/png" };
}

async function loadFace(src: string): Promise<Img> {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch face: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString("base64"), mimeType: res.headers.get("content-type") || "image/jpeg" };
  }
  const buf = readFileSync(src);
  return { data: buf.toString("base64"), mimeType: src.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg" };
}

async function main() {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const model = env.GEMINI_IMAGE_MODEL;
  console.log(`model: ${model}`);

  const src = process.argv[2];
  const scene = process.argv[3] ?? DEFAULT_SCENE;

  let face: Img;
  if (src) {
    face = await loadFace(src);
    console.log(`face: ${src}`);
  } else {
    console.log("[1/2] self-test — generating a reference portrait…");
    const r = await ai.models.generateContent({
      model,
      contents: PORTRAIT_PROMPT,
      config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
    });
    face = imageFrom(r, "portrait");
    writeFileSync("face-source.png", Buffer.from(face.data, "base64"));
    console.log("      wrote face-source.png");
  }

  console.log("[2/2] generating a SCENE conditioned on that face…");
  const r2 = await ai.models.generateContent({
    model,
    // THE POINT: an image part alongside the text. generateGeminiImage() sends
    // `contents: prompt` today and so can never do this.
    contents: [{
      role: "user",
      parts: [{ inlineData: { data: face.data, mimeType: face.mimeType } }, { text: scene }],
    }],
    config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
  });
  const out = imageFrom(r2, "scene");
  writeFileSync("face-in-scene.png", Buffer.from(out.data, "base64"));
  console.log("      wrote face-in-scene.png");
  console.log("\nSUCCESS — image-conditioned generation works on this model and key.");
}

main().catch((e) => {
  console.error("PROBE FAILED: " + (e as Error).message);
  process.exit(1);
});

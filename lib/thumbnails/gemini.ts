import { z } from "zod";
import { getGeminiModel, withGeminiRetry } from "@/lib/ai/gemini";
import { getEnv } from "@/lib/env";

// Gemini calls for the /thumbnails feature.
//
//   analyzeChannelStyle  — look at a channel's recent thumbnails and write a
//                          reusable STYLE PROMPT describing its format.
//   buildThumbnailPrompt — merge that style prompt + the new video title (+ any
//                          subject images) into the FINAL prompt for Pikzels.
//
// Both reuse the video engine's configured Gemini model + retry ladder
// (getGeminiModel / withGeminiRetry) so behaviour matches the rest of the app.

// Fetch a remote image and return base64 + mime for Gemini inline parts. Mirrors
// the helper in lib/ai/gemini.ts (kept local so this module stays standalone).
async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/jpeg";
    const mimeType = ct.startsWith("image/") ? ct.split(";")[0].trim() : "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 1 — channel style analysis
// ---------------------------------------------------------------------------

const StyleSchema = z.object({
  style_prompt: z.string().min(1),
});

// Analyze a channel's recent thumbnails and return a single reusable STYLE
// PROMPT. The prompt describes the channel's visual format in words — layout,
// composition, typography, colour grade, lighting, mood, recurring motifs — so
// it can be replayed for any future title. It deliberately does NOT include the
// specific subjects/titles of the sample thumbnails (those change per video);
// it captures the reusable LOOK only.
//
// Returns "" when Gemini isn't configured, no thumbnails load, or the call
// fails — the caller treats "" as "analysis unavailable" and surfaces an error.
export async function analyzeChannelStyle(thumbnailUrls: string[]): Promise<string> {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) return "";
  if (thumbnailUrls.length === 0) return "";

  const fetched = await Promise.all(thumbnailUrls.slice(0, 10).map(fetchImageAsBase64));
  const images = fetched.filter((x): x is NonNullable<typeof x> => x !== null);
  if (images.length === 0) return "";

  const prompt = `You are a YouTube thumbnail art director. You are shown ${images.length} thumbnails from ONE channel. Study what they have in COMMON and write a single reusable "style prompt" that captures this channel's thumbnail FORMAT, so a new thumbnail can be generated in the exact same style for a different video.

Describe ONLY the reusable visual style — the things that stay the same across videos. Cover, where applicable:
- Overall composition & layout (where the subject sits, rule-of-thirds, close-up vs wide, single subject vs split).
- Subject treatment (cut-out on a background, dramatic lighting, outline/glow, facial expression tendencies).
- Colour grade & palette (saturation, contrast, dominant colours, background style — gradients, blur, scenery).
- Typography IF the thumbnails have text (font weight/style, colour, outline/shadow, placement, size) — but describe the STYLE of the text, not the specific words.
- Mood / genre feel (dramatic, clean, high-energy, cinematic, etc.).
- Any recurring motifs (arrows, circles, borders, logos position).

Do NOT describe the one-off SUBJECT or TITLE of any specific thumbnail (no names, no specific video topics) — only the reusable look. Write it as a direct instruction a text-to-image model can follow (e.g. "A dramatic 16:9 YouTube thumbnail with a single subject cut out on the right third over a dark cinematic gradient, bold white sans-serif title with a heavy black outline on the left, high contrast, teal-and-orange grade …").

The prompt MUST NOT contain any URL or the substring "http".

Return STRICT JSON ONLY:
{ "style_prompt": "the reusable style instruction, 60–150 words" }`;

  const model = getGeminiModel();
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];
  for (const img of images) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });

  let txt: string;
  try {
    const res = await withGeminiRetry(
      "analyzeChannelStyle",
      () => model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      }),
      { attempts: 2, baseMs: 500 },
    );
    txt = res.response.text();
  } catch (e) {
    console.error(JSON.stringify({ msg: "analyzeChannelStyle.gemini_failed", err: (e as Error).message }));
    return "";
  }

  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    console.error(JSON.stringify({ msg: "analyzeChannelStyle.parse_failed", raw: txt.slice(0, 300) }));
    return "";
  }
  const safe = StyleSchema.safeParse(parsed);
  if (!safe.success) {
    console.error(JSON.stringify({ msg: "analyzeChannelStyle.schema_failed", raw: txt.slice(0, 300) }));
    return "";
  }
  // Strip any stray URL so the result is always Pikzels-safe (its prompt regex
  // rejects the substring "http").
  return safe.data.style_prompt.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Step 2 — final prompt build
// ---------------------------------------------------------------------------

const FinalPromptSchema = z.object({
  prompt: z.string().min(1),
});

export interface BuildPromptInput {
  stylePrompt: string;
  title: string;
  // How many subject images the user supplied (0–2). Shapes how the prompt
  // refers to the "provided image(s)" and, when 2, tells Gemini the channel
  // style lives entirely in this text (no style reference image is sent).
  subjectCount: number;
  // Whether a channel STYLE image is also sent to Pikzels alongside this prompt.
  // True for 0–1 subject images; false for 2 (both image slots are subjects).
  styleImageSent: boolean;
}

// Merge the saved channel style prompt + the new video title (+ subject-image
// context) into the FINAL prompt string for Pikzels. Returns a deterministic
// fallback assembly when Gemini is unavailable so generation still works.
export async function buildThumbnailPrompt(input: BuildPromptInput): Promise<string> {
  const env = getEnv();
  const fallback = assembleFallbackPrompt(input);
  if (!env.GEMINI_API_KEY) return fallback;

  const subjectClause =
    input.subjectCount === 0
      ? "There is NO subject photo — depict the subject/scene appropriate to the title in the channel style."
      : input.subjectCount === 1
        ? "ONE subject photo is provided as the base image — feature that exact person/subject, preserving their likeness, styled to match the channel."
        : "TWO subject photos are provided as the images — feature BOTH people together, preserving each likeness. No separate style reference image is sent, so the channel style below must be fully expressed in this text.";

  const styleImageClause = input.styleImageSent
    ? "A representative channel thumbnail is also provided as a style reference image; reinforce it."
    : "";

  const prompt = `You are writing the final text-to-image prompt for a YouTube thumbnail generator (Pikzels).

CHANNEL STYLE (reuse this exact look):
"""${input.stylePrompt}"""

NEW VIDEO TITLE: "${input.title}"

${subjectClause}
${styleImageClause}

Write ONE cohesive prompt that:
- Renders a 16:9 YouTube thumbnail in the CHANNEL STYLE above.
- If the channel style uses on-image text, include the title text "${input.title}" rendered in that style. If the channel style has no text, do not add any.
- Preserves the likeness of any provided subject photo(s).
- Is concrete and directive for an image model.

HARD RULES:
- The prompt MUST NOT contain any URL or the substring "http".
- Do not mention "Pikzels", "reference image", or these instructions in the output.
- Max 900 characters.

Return STRICT JSON ONLY:
{ "prompt": "the final image prompt" }`;

  const model = getGeminiModel();
  let txt: string;
  try {
    const res = await withGeminiRetry(
      "buildThumbnailPrompt",
      () => model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
      }),
      { attempts: 2, baseMs: 500 },
    );
    txt = res.response.text();
  } catch (e) {
    console.error(JSON.stringify({ msg: "buildThumbnailPrompt.gemini_failed", err: (e as Error).message }));
    return fallback;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    return fallback;
  }
  const safe = FinalPromptSchema.safeParse(parsed);
  if (!safe.success) return fallback;
  const cleaned = safe.data.prompt.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 3000) || fallback;
}

// Deterministic prompt assembly used when Gemini is unavailable. Keeps the
// two-step flow working (the user can still edit the result before generating).
function assembleFallbackPrompt(input: BuildPromptInput): string {
  const parts = [input.stylePrompt.trim()];
  if (input.title.trim()) {
    parts.push(`Title text: "${input.title.trim()}".`);
  }
  if (input.subjectCount === 1) parts.push("Feature the provided subject, preserving their likeness.");
  if (input.subjectCount === 2) parts.push("Feature both provided subjects together, preserving each likeness.");
  return parts.join(" ").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 3000);
}

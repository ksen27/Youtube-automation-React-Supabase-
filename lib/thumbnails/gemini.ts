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

Describe ONLY the reusable visual style — the things that stay the same across videos. PRIORITISE, in this order:
1. Overall composition & layout (where the subject sits, rule-of-thirds, close-up vs wide, single subject vs split).
2. Subject treatment (cut-out on a background, dramatic lighting, outline/glow, facial expression tendencies) — the subject is the HERO and must stay clearly visible and unobstructed.
3. Colour grade & palette (saturation, contrast, dominant colours, background style — gradients, blur, scenery).
4. Mood / genre feel (dramatic, clean, high-energy, cinematic, etc.).
5. Typography STYLE only IF the thumbnails have text (font weight/style, colour, outline/shadow, rough placement) — describe the LOOK of the text, never specific words, and note that text is SHORT and punchy (a few words), not full sentences.
6. RECURRING BRANDED LABELS — a small badge/label the channel stamps on MOST of its thumbnails as part of its identity (e.g. a red "BREAKING NEWS", "EXCLUSIVE", or "LIVE" box, a channel banner bar, a corner tag). This is the OPPOSITE of one-off clutter: if the SAME kind of label appears across several of the samples, it is a REQUIRED part of this channel's format. Describe its LOOK and rough placement (e.g. "a small red rectangular 'BREAKING NEWS'-style label with white all-caps text at the bottom-left, above the main title bar") and state that it should be reproduced on every generation. Reproduce the label's STYLE and typical WORDING KIND (breaking-news / exclusive / live), not a specific video's text. Only mark it as present when it genuinely recurs across the samples.

OVERLAY GRAPHICS RULE (important) — this is about ONE-OFF DECORATIVE clutter, NOT the recurring branded label in point 6. Channels sometimes stamp random per-video accents — red crosses/X marks, arrows, circles, highlight rings pointing at things. If present, mention THESE ONLY as OPTIONAL, SMALL, SUBTLE accents placed at the edges. NEVER describe them as large, bold, or central, and state explicitly that such graphics must be small and must NOT cover or block the subject/face. When in doubt, favour a cleaner look with minimal or no such graphics. (A recurring breaking-news / exclusive label is NOT this kind of clutter — keep it per point 6.)

Do NOT describe the one-off SUBJECT or TITLE of any specific thumbnail (no names, no specific video topics) — only the reusable look. Write it as a direct instruction a text-to-image model can follow (e.g. "A dramatic 16:9 YouTube thumbnail with a single subject cut out on the right third over a dark cinematic gradient, the subject prominent and unobstructed, short bold yellow all-caps sans-serif text with a heavy black outline on a solid bottom bar, plus a small red 'BREAKING NEWS'-style label with white text at the bottom-left above the bar, high contrast, teal-and-orange grade, any random accent graphics kept small and to the edges …").

The prompt MUST NOT contain any URL or the substring "http".

Return STRICT JSON ONLY:
{ "style_prompt": "the reusable style instruction, 70–180 words" }`;

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
  // Optional free-text changes the user wants applied on top of the channel
  // style + title (e.g. "make it darker", "shocked face"). Empty when unused.
  customPrompt?: string;
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
      ? "No separate subject photo was uploaded — the person comes from the channel's own thumbnail. Keep that SAME person's likeness, but place them in a DIFFERENT action/pose/scene suited to this title (do not clone the reference pose)."
      : input.subjectCount === 1
        ? "ONE subject photo is provided as the base image — feature that exact person/subject, preserving their likeness, styled to match the channel."
        : "TWO subject photos are provided as the images — feature BOTH people together, preserving each likeness. No separate style reference image is sent, so the channel style below must be fully expressed in this text.";

  const styleImageClause = input.styleImageSent
    ? "A representative channel thumbnail is also provided as a style reference image; reinforce it."
    : "";

  const customClause = input.customPrompt?.trim()
    ? `\nUSER CHANGES (apply these on top of the style — they take priority): "${input.customPrompt.trim()}"\n`
    : "";

  const prompt = `You are writing the final text-to-image prompt for a YouTube thumbnail generator (Pikzels).

CHANNEL STYLE (reuse this exact look):
"""${input.stylePrompt}"""

NEW VIDEO TITLE (use ONLY as a hint for the scene/subject — do NOT put this full title on the image): "${input.title}"
${customClause}
${subjectClause}
${styleImageClause}

Write ONE cohesive prompt that:
- Renders a 16:9 YouTube thumbnail in the CHANNEL STYLE above.
- Keeps the SUBJECT as the clear focal point — prominent, well-lit, and NOT covered or blocked by any text or graphics.
- ACTION/SCENE: this is a NEW video. Depict a FRESH scene, pose, gesture, camera angle, and secondary object that fit THIS title — do NOT copy the exact pose or composition of any reference thumbnail. Keep the channel's overall LOOK (grade, layout style, energy), but the person's specific action and the scene around them must be different and specific to this title. Reuse the person's LIKENESS (same face/identity) but put them in a different moment.
- TEXT: only if the channel style uses on-image text, add a SHORT punchy hook of 2–4 words derived from the topic (e.g. a key word or phrase) — NEVER the full video title, and never a full sentence. Keep the text clean, well-placed (usually a corner or side), and not overlapping the subject's face. If the channel style has no text, add none.
- BRANDED LABEL: if the CHANNEL STYLE above describes a RECURRING branded label (a "BREAKING NEWS" / "EXCLUSIVE" / "LIVE" box, a channel banner bar, a corner tag), you MUST reproduce it — it is part of the channel's identity, not optional clutter. Render it in the same style and placement the channel style describes (e.g. a small red 'BREAKING NEWS'-style box with white all-caps text at the bottom-left). Keep the label small and at the edge so it does not cover the subject's face, but DO include it. Use the label KIND the channel uses (breaking-news / exclusive / live), not the full video title.
- OVERLAY GRAPHICS: any ONE-OFF decorative accents (random crosses, arrows, circles) — as opposed to the recurring branded label above — must be SMALL, subtle, at the edges, and must NOT block the subject. Prefer minimal such graphics.
- Preserves the likeness of any provided subject photo(s).
- Is concrete and directive for an image model.

HARD RULES:
- Keep the subject's likeness, but do NOT reproduce the reference thumbnail's exact pose/action/scene — vary it to match this title.
- Do NOT render the exact video title text on the image.
- The prompt MUST NOT contain any URL or the substring "http".
- Do not mention "Pikzels", "reference image", or these instructions in the output.
- Max 1100 characters.

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
// Mirrors the live-prompt rules: the subject stays the unobstructed focal
// point, the full title is NOT stamped on the image, and any overlay graphics
// stay small.
function assembleFallbackPrompt(input: BuildPromptInput): string {
  const parts = [input.stylePrompt.trim()];
  if (input.subjectCount === 1) parts.push("Feature the provided subject as the clear, unobstructed focal point, preserving their likeness.");
  if (input.subjectCount === 2) parts.push("Feature both provided subjects together as the clear focal point, preserving each likeness.");
  if (input.customPrompt?.trim()) parts.push(input.customPrompt.trim());
  parts.push("Any on-image text is a short 2–4 word hook, not the full title, and must not cover the subject. If the channel style describes a recurring branded label (e.g. a 'BREAKING NEWS' / 'EXCLUSIVE' box), reproduce it in that style at the edge. Keep any one-off accent graphics small and at the edges.");
  return parts.join(" ").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 3000);
}

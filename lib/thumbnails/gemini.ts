import { z } from "zod";
import { withGeminiModelFallback } from "@/lib/ai/gemini";
import { getEnv } from "@/lib/env";

// Gemini calls for the /thumbnails feature.
//
//   analyzeChannelStyle  — look at a channel's recent thumbnails and write a
//                          reusable STYLE PROMPT describing its format.
//   buildThumbnailPrompt — merge that style prompt + the new video title (+ any
//                          subject images) into the FINAL prompt for Pikzels.
//
// Both reuse the video engine's configured Gemini model + retry/fallback ladder
// (withGeminiModelFallback) so behaviour matches the rest of the app — including
// failing over to GEMINI_FALLBACK_MODEL when the primary model is overloaded.

// How many of a channel's recent thumbnails we send to Gemini when learning its
// style. Client asked to expand beyond the original 10 for a more representative
// sample; kept under YouTube's 50-per-page playlist limit so no pagination is
// needed (see fetchChannelThumbnails). Analyze fetches this many; the fetch
// helper defaults to the same value.
export const STYLE_SAMPLE_LIMIT = 35;

// How many "format" reference images a user may upload to teach a SPECIFIC
// thumbnail layout (e.g. a two-celebrity split, a breaking-news banner). Small
// on purpose — a few clear examples define a format; more just cost quota.
export const MAX_FORMAT_IMAGES = 3;

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

  const fetched = await Promise.all(thumbnailUrls.slice(0, STYLE_SAMPLE_LIMIT).map(fetchImageAsBase64));
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

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];
  for (const img of images) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });

  let txt: string;
  try {
    const { result: res } = await withGeminiModelFallback(
      "analyzeChannelStyle",
      (model) => model.generateContent({
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
// Step 1b — specific FORMAT analysis (optional, from user-uploaded examples)
// ---------------------------------------------------------------------------

const FormatSchema = z.object({
  format_prompt: z.string().min(1),
});

// Learn ONE specific thumbnail FORMAT from 1–3 example images the user uploaded.
//
// The channel-style analysis above averages a channel's whole look. Many
// channels run SEVERAL distinct formats (a two-celebrity split with yellow
// text, a red "BREAKING NEWS" banner, a single shocked face, …) that an average
// blurs together. This learns ONE of those layouts from concrete examples so a
// new thumbnail can be generated in that EXACT format for a new title.
//
// Returns "" when Gemini isn't configured, no images load, or the call fails —
// the caller treats "" as "format learning unavailable" and surfaces an error.
export async function analyzeFormatImages(imageUrls: string[]): Promise<string> {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) return "";
  if (imageUrls.length === 0) return "";

  const fetched = await Promise.all(imageUrls.slice(0, MAX_FORMAT_IMAGES).map(fetchImageAsBase64));
  const images = fetched.filter((x): x is NonNullable<typeof x> => x !== null);
  if (images.length === 0) return "";

  const prompt = `You are a YouTube thumbnail art director. You are shown ${images.length} example thumbnail(s) that all use ONE specific FORMAT. Write a single reusable "format prompt" that captures this exact LAYOUT/FORMAT, so a new thumbnail can be generated in the identical format for a different video.

Capture the reusable FORMAT precisely — the structural things that define this layout:
1. Composition & layout: how many subjects and WHERE they sit (e.g. two people side-by-side each filling half the frame; one subject on the right third; a centred close-up). Be specific about the split/arrangement.
2. Subject treatment: cut-out vs in-scene, framing (head-and-shoulders vs full), expression tendencies. The subject(s) stay the clear, unobstructed HERO.
3. Text: IF present, the text's LOOK and PLACEMENT (font weight/style, colour, outline/shadow, where it sits — e.g. "large yellow all-caps text with a black outline across the bottom"). Describe the style, never the specific words, and note text is SHORT (a few words), not a sentence.
4. Branded label / banner: any recurring badge or bar that is part of the format (e.g. a red "BREAKING NEWS" box, a "VS" divider between two people, a corner tag). Describe its LOOK and placement and state it must be reproduced.
5. Colour grade & background: palette, contrast, background style (blur, gradient, scenery).

Describe ONLY the reusable format — NOT the one-off subjects or titles of the examples (no names, no specific topics). Write it as a direct instruction a text-to-image model can follow.

The prompt MUST NOT contain any URL or the substring "http".

Return STRICT JSON ONLY:
{ "format_prompt": "the reusable format instruction, 60–160 words" }`;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];
  for (const img of images) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });

  let txt: string;
  try {
    const { result: res } = await withGeminiModelFallback(
      "analyzeFormatImages",
      (model) => model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      }),
      { attempts: 2, baseMs: 500 },
    );
    txt = res.response.text();
  } catch (e) {
    console.error(JSON.stringify({ msg: "analyzeFormatImages.gemini_failed", err: (e as Error).message }));
    return "";
  }

  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    console.error(JSON.stringify({ msg: "analyzeFormatImages.parse_failed", raw: txt.slice(0, 300) }));
    return "";
  }
  const safe = FormatSchema.safeParse(parsed);
  if (!safe.success) {
    console.error(JSON.stringify({ msg: "analyzeFormatImages.schema_failed", raw: txt.slice(0, 300) }));
    return "";
  }
  return safe.data.format_prompt.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
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
  // Optional SPECIFIC format learned from user-uploaded example images
  // (analyzeFormatImages). When present it OVERRIDES the averaged channel style
  // for layout/composition — the user picked this exact format on purpose.
  // Empty when the user didn't upload a format.
  formatPrompt?: string;
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

// Result of a prompt build. `usedFallback` is TRUE whenever Gemini could not
// produce the prompt (unconfigured, or the call/parse/validate failed) and we
// fell back to the deterministic assembly — which does NOT weave in the title.
// The caller surfaces this so a title-less copy is never mistaken for a real
// AI build (the "it just copies the style prompt" bug the client reported).
export interface BuildPromptResult {
  prompt: string;
  usedFallback: boolean;
  // Short machine-ish reason when usedFallback is true (for the UI + logs).
  fallbackReason?: "gemini_not_configured" | "gemini_failed" | "parse_failed" | "invalid_output";
}

// Merge the saved channel style prompt + the new video title (+ an optional
// learned format + subject-image context) into the FINAL prompt for Pikzels.
// Falls back to a deterministic assembly when Gemini is unavailable so
// generation still works — but flags it via usedFallback so the UI can warn
// that the title was NOT applied (see BuildPromptResult).
export async function buildThumbnailPrompt(input: BuildPromptInput): Promise<BuildPromptResult> {
  const env = getEnv();
  const fallback = assembleFallbackPrompt(input);
  if (!env.GEMINI_API_KEY) {
    return { prompt: fallback, usedFallback: true, fallbackReason: "gemini_not_configured" };
  }

  const subjectClause =
    input.subjectCount === 0
      ? "No separate subject photo was uploaded — the person comes from the channel's own thumbnail. Keep that SAME person's likeness, but place them in a DIFFERENT action/pose/scene suited to this title (do not clone the reference pose)."
      : input.subjectCount === 1
        ? "ONE subject photo is provided as the base image — feature THAT EXACT person, preserving their likeness precisely. This uploaded face is the ONLY identity source: do NOT blend in, revert to, or borrow the face of any person from the channel's own thumbnails — the channel supplies STYLE only, never the face. No separate style reference image is sent, so the channel style below must be fully expressed in this text."
        : "TWO subject photos are provided as the images — feature BOTH people together, preserving each likeness precisely. These uploaded faces are the ONLY identity sources: do NOT blend in or revert to any face from the channel's own thumbnails — the channel supplies STYLE only. No separate style reference image is sent, so the channel style below must be fully expressed in this text.";

  const styleImageClause = input.styleImageSent
    ? "A representative channel thumbnail is also provided as a style reference image; reinforce it."
    : "";

  const customClause = input.customPrompt?.trim()
    ? `\nUSER CHANGES (apply these on top of the style — they take priority): "${input.customPrompt.trim()}"\n`
    : "";

  // When the user uploaded a specific format, it takes priority over the
  // averaged channel style for LAYOUT/composition. The channel style still
  // supplies grade/mood; the format dictates the arrangement.
  const formatClause = input.formatPrompt?.trim()
    ? `\nCHOSEN FORMAT (the user picked this SPECIFIC layout — its composition/arrangement OVERRIDES the channel style above; follow it exactly for layout, subject placement, text placement, and any banner/label):\n"""${input.formatPrompt.trim()}"""\n`
    : "";

  const prompt = `You are writing the final text-to-image prompt for a YouTube thumbnail generator (Pikzels).

CHANNEL STYLE (reuse this look — grade, mood, energy):
"""${input.stylePrompt}"""
${formatClause}
NEW VIDEO TITLE (use ONLY as a hint for the scene/subject — do NOT put this full title on the image): "${input.title}"
${customClause}
${subjectClause}
${styleImageClause}

Write ONE cohesive prompt that:
- Renders a 16:9 YouTube thumbnail in the CHANNEL STYLE above${input.formatPrompt?.trim() ? ", using the CHOSEN FORMAT's layout/composition" : ""}.
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

  let txt: string;
  try {
    // Retry the primary model, then fail over to GEMINI_FALLBACK_MODEL on a
    // genuine outage (503 "high demand" / 429 / truncation). The primary
    // gemini-flash-latest intermittently returns 503s that exhausted the retry
    // ladder and dropped the build to a title-less fallback — the "just copies
    // the style" bug. withGeminiModelFallback rides those out on the secondary
    // model instead.
    const { result: res } = await withGeminiModelFallback(
      "buildThumbnailPrompt",
      async (model) => {
        // Cap output so a chatty model can't run past its budget and truncate
        // the JSON mid-string (a second cause of the same bug). A thumbnail
        // prompt is ~1100 chars (~400 tokens); 2048 is ample. On MAX_TOKENS,
        // throw GEMINI_TRUNCATED so the retry/fallback ladder handles it.
        const r = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.4,
            maxOutputTokens: 2048,
          },
        });
        if (r.response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
          throw new Error("GEMINI_TRUNCATED buildThumbnailPrompt hit MAX_TOKENS");
        }
        return r;
      },
      { attempts: 3, baseMs: 500 },
    );
    txt = res.response.text();
  } catch (e) {
    console.error(JSON.stringify({ msg: "buildThumbnailPrompt.gemini_failed", err: (e as Error).message }));
    return { prompt: fallback, usedFallback: true, fallbackReason: "gemini_failed" };
  }

  let parsed: unknown;
  try { parsed = JSON.parse(txt); } catch {
    // Salvage a truncated response: if the JSON was cut off mid-string, the
    // "prompt" field value is still usable text. Pull it out rather than losing
    // the whole (title-woven) prompt to the fallback. Only when it's long
    // enough to be a real prompt, not a stub.
    const salvaged = salvagePromptField(txt);
    if (salvaged && salvaged.length >= 80) {
      console.error(JSON.stringify({ msg: "buildThumbnailPrompt.parse_salvaged", chars: salvaged.length }));
      return { prompt: salvaged.slice(0, 3000), usedFallback: false };
    }
    console.error(JSON.stringify({ msg: "buildThumbnailPrompt.parse_failed", raw: txt.slice(0, 300) }));
    return { prompt: fallback, usedFallback: true, fallbackReason: "parse_failed" };
  }
  const safe = FinalPromptSchema.safeParse(parsed);
  if (!safe.success) {
    console.error(JSON.stringify({ msg: "buildThumbnailPrompt.schema_failed", raw: txt.slice(0, 300) }));
    return { prompt: fallback, usedFallback: true, fallbackReason: "invalid_output" };
  }
  const cleaned = safe.data.prompt.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 3000);
  if (!cleaned) return { prompt: fallback, usedFallback: true, fallbackReason: "invalid_output" };
  return { prompt: cleaned, usedFallback: false };
}

// Best-effort extraction of the "prompt" string field from a JSON response that
// was CUT OFF mid-stream (no closing quote/brace), so JSON.parse threw. Matches
// the opening `"prompt": "` and takes everything after it, dropping a dangling
// trailing quote/brace and any URL. Returns "" when the field isn't present.
function salvagePromptField(raw: string): string {
  const m = /"prompt"\s*:\s*"/.exec(raw);
  if (!m) return "";
  let body = raw.slice(m.index + m[0].length);
  // Cut at an unescaped closing quote if the field actually terminated.
  const end = body.search(/(?<!\\)"/);
  if (end !== -1) body = body.slice(0, end);
  return body
    .replace(/\\"/g, '"')
    .replace(/\\n/g, " ")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Deterministic prompt assembly used when Gemini is unavailable. Keeps the
// two-step flow working (the user can still edit the result before generating).
// Mirrors the live-prompt rules: the subject stays the unobstructed focal
// point, the full title is NOT stamped on the image, and any overlay graphics
// stay small.
function assembleFallbackPrompt(input: BuildPromptInput): string {
  const parts = [input.stylePrompt.trim()];
  if (input.formatPrompt?.trim()) parts.push(`Use this exact layout/format: ${input.formatPrompt.trim()}`);
  if (input.subjectCount === 1) parts.push("Feature the provided subject as the clear, unobstructed focal point, preserving their likeness.");
  if (input.subjectCount === 2) parts.push("Feature both provided subjects together as the clear focal point, preserving each likeness.");
  if (input.customPrompt?.trim()) parts.push(input.customPrompt.trim());
  parts.push("Any on-image text is a short 2–4 word hook, not the full title, and must not cover the subject. If the channel style describes a recurring branded label (e.g. a 'BREAKING NEWS' / 'EXCLUSIVE' box), reproduce it in that style at the edge. Keep any one-off accent graphics small and at the edges.");
  return parts.join(" ").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 3000);
}

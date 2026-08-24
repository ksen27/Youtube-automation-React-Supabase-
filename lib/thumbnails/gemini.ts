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

OVERLAY MARKS RULE (important) — many channels stamp pointing/marking accents on their thumbnails: red arrows, crosses/X marks, circles, highlight rings. When these recur across the samples they are part of the channel's identity and MUST be captured. Describe their LOOK and typical placement (colour, weight, size, where they sit).

Crucially, also describe WHAT THEY DO: in the samples these marks POINT AT or RING the thing the video is about — the animal, the object, the detail in the scene that matters. Say so explicitly, e.g. "a bold red arrow pointing directly at the main subject of the action" or "a red circle ringing the key detail in the scene". Never describe them as free-floating decoration, and never as covering the subject's face. This matters because a mark that is described only as a shape gets drawn in a random empty spot, which reads as meaningless clutter — a real defect the channel owner reported. A mark that is described as POINTING AT THE SUBJECT gets drawn doing its job. (A recurring breaking-news / exclusive label is a different thing — keep it per point 6.)

Do NOT describe the one-off SUBJECT or TITLE of any specific thumbnail (no names, no specific video topics) — only the reusable look. Write it as a direct instruction a text-to-image model can follow (e.g. "A dramatic 16:9 YouTube thumbnail with a single subject cut out on the right third over a dark cinematic gradient, the subject prominent and unobstructed, short bold yellow all-caps sans-serif text with a heavy black outline on a solid bottom bar, plus a small red 'BREAKING NEWS'-style label with white text at the bottom-left above the bar, high contrast, teal-and-orange grade, a bold red arrow pointing directly at the main subject of the action …").

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

CHANNEL STYLE — this governs the channel's LOOK ONLY: colour grade, palette, contrast, lighting, typography, the text box, the branded label, the pointing marks. It does NOT govern what happens in the picture.

Where it describes COMPOSITION — "a single subject", "medium close-up", "clean", "simple", "unobstructed", "wide-shot background" — treat that as the channel's DEFAULT for an ordinary video, not a limit on this one. The ACTION, STAKES and FULL FRAME rules below OVERRIDE it: this thumbnail may hold two or more figures locked together, may be busy, may be close and chaotic, and must carry foreground and background layers. Keep the channel's grade and typography exactly; do not let its calm composition flatten the event.

CHANNEL STYLE (reuse this look — grade, mood, energy):
"""${input.stylePrompt}"""
${formatClause}
NEW VIDEO TITLE — this is WHAT THE IMAGE MUST SHOW, not a mood hint. Read it, decide what is literally HAPPENING in it, and build the scene around that event: "${input.title}"
(Do NOT render this title text on the image — DEPICT it.)
${customClause}
${subjectClause}
${styleImageClause}

Write ONE cohesive prompt that:
- Renders a 16:9 YouTube thumbnail in the CHANNEL STYLE above${input.formatPrompt?.trim() ? ", using the CHOSEN FORMAT's layout/composition" : ""}.
- Keeps the SUBJECT as the clear focal point — prominent, well-lit, and NOT covered or blocked by any text or graphics. "Focal point" does NOT mean alone in the frame: the animal, opponent, or object they are dealing with is equally present and equally sharp.
- SHOW THE SUBJECT NAMED IN THE TITLE (check this before anything else): every concrete thing the title names — the animal, the vehicle, the object, the person — must be VISIBLE IN THE FRAME, large, in focus, and instantly recognisable. A title about a polar bear attack must show the POLAR BEAR, prominent and unmistakable. A thumbnail that names a creature or object and then does not show it is the single worst failure this generator makes: the viewer came for that thing. If the title names both a person and a creature/object, show BOTH in the same frame, interacting. Never imply the subject through mood, tracks, scenery, or an empty landscape — show the subject itself.
- PUT THEM IN THE SAME FIGHT (when the title implies a confrontation): the person and the animal/opponent must be ENGAGED WITH EACH OTHER in one continuous action, at CLOSE RANGE, in the same plane of the image — not a person posing in front while the animal does something in the background. Show the clash at its peak: the bear reared up over the hunter or lunging within arm's reach, the hunter braced and driving back at it with his spear raised, both bodies leaning into each other, snow and ice spraying, the gap between them nearly closed. Their eyelines must meet or both must be fixed on the point of contact. If you could crop one of them out and still have a sensible picture, the composition has FAILED — they must overlap and collide.
- ACTION (equally important): SOMETHING MUST BE HAPPENING. Name the concrete activity from the title and show it MID-ACTION — the subject actively doing it, caught in the middle of the moment, with the real setting and the real objects/animals/equipment that activity involves around them (e.g. a title about seal hunting shows the hunter out on the sea ice, over the breathing hole, harpoon in hand, catch visible — NOT a portrait of a hunter on a gradient). A thumbnail where the subject is merely posing, cut out, or standing against a backdrop is a FAILURE of this prompt, no matter how good the grade and typography are. Build the scene first, then apply the channel's look to it.
- STAKES — SHOW THE PREDICAMENT, NOT JUST THE ACTIVITY: something must be going WRONG or about to. Give the moment a visible trap: an escape route that is closing or already cut off, a corner with nothing behind it, a gap that is nearly shut, ice giving way underfoot, a catch slipping away, a threat arriving from a second direction. Make the constraint physically visible in the frame — the narrow hole the seal cannot fit back through and the solid ice ringing it, the crack running between the hunter and safety, the pack closing from behind. The viewer must be able to see WHY this is difficult without reading a word. A picture of someone simply performing a task, however well lit, is what the channel owner means by "too simple" — it has no jeopardy in it.
- BUILD A FULL FRAME (this is the other half of "too simple"): compose in DEPTH, not as a subject on a backdrop. Put something in the FOREGROUND (broken ice slabs, spray, gear, an edge we look past), the main clash in the MIDDLE, and real context BEHIND (the rest of the pack, the sled and dogs, the camp, the storm coming in). Add the physical evidence of the moment — flying snow, water surging, breath fogging, churned ice, a rope pulled tight. Two isolated figures on clean snow reads empty; a frame with layers reads like a real event caught mid-happening.
- SETTING: place the action in the actual environment the title implies (location, weather, time of day, terrain). The background must be a real place where this event happens, not a studio gradient or an abstract blur — unless the CHANNEL STYLE explicitly requires a cut-out treatment, in which case keep the cut-out but still show the action and its objects.
- FRESH EVERY TIME: do NOT copy the pose, camera angle, or composition of any reference thumbnail. Reuse the person's LIKENESS (same face/identity) only — the moment must be new and specific to THIS title.
- TEXT: only if the channel style uses on-image text, add a SHORT punchy hook of 2–4 words derived from the topic (e.g. a key word or phrase) — NEVER the full video title, and never a full sentence. Keep the text clean, well-placed (usually a corner or side), and not overlapping the subject's face. If the channel style has no text, add none.
- BRANDED LABEL: if the CHANNEL STYLE above describes a RECURRING branded label (a "BREAKING NEWS" / "EXCLUSIVE" / "LIVE" box, a channel banner bar, a corner tag), you MUST reproduce it — it is part of the channel's identity, not optional clutter. Render it in the same style and placement the channel style describes (e.g. a small red 'BREAKING NEWS'-style box with white all-caps text at the bottom-left). Keep the label small and at the edge so it does not cover the subject's face, but DO include it. Use the label KIND the channel uses (breaking-news / exclusive / live), not the full video title.
- POINTING MARKS: if the CHANNEL STYLE uses arrows, red crosses, circles or highlight rings, INCLUDE them — they are part of this channel's look. But EVERY such mark must have a TARGET, and you must say what it is: the arrow points AT the animal/object/action named in the title, the circle RINGS that same subject or the key detail of the moment. Write it into the prompt that way ("a bold red arrow pointing directly at the polar bear", not "a red arrow in the corner"). A mark floating over empty sky, ocean, snow or a blank background is the defect the channel owner complained about — never place one there. Keep marks clear of the subject's face, and use at most two.
- Preserves the likeness of any provided subject photo(s).
- Is concrete and directive for an image model.

HARD RULES:
- The prompt MUST name and place every concrete subject from the title IN THE FRAME. Re-read the title before you answer: if it names a creature, vehicle, or object and your prompt does not describe that thing visibly in the image, the prompt is INVALID — rewrite it.
- The prompt MUST describe a specific action in progress drawn from the title. A prompt that only describes a person, a look and a colour grade is INVALID — rewrite it until something is happening.
- Any pointing mark you include MUST have a named target in the prompt. "A red arrow" alone is INVALID; "a red arrow pointing at the polar bear" is correct.
- Keep the subject's likeness, but do NOT reproduce the reference thumbnail's exact pose/action/scene — vary it to match this title.
- Do NOT render the exact video title text on the image.
- The prompt MUST NOT contain any URL or the substring "http".
- Do not mention "Pikzels", "reference image", or these instructions in the output.
- Max 1500 characters.

MODERATION-SAFE LANGUAGE (critical — the image model REJECTS prompts that put a NAMED real person in an explicit distressing or violent state). Keep the names and the dramatic, high-energy YouTube look, but phrase expressions and scenes in NEUTRAL, non-graphic terms:
- Describe faces with restrained emotion words: "serious", "tense", "intense", "surprised", "somber", "stern", "concerned", "focused" — NOT "crying", "sobbing", "distressed", "in tears", "terrified", "screaming", "shouting", "furious", "enraged", "in pain", "devastated".
- Do NOT depict a named real person as a victim, injured, weeping, humiliated, arrested, dead/dying, bleeding, or in any graphic emotional breakdown. Convey drama through LIGHTING, COLOUR GRADE, COMPOSITION, and a restrained facial expression instead.
- No gore, blood, wounds, or a body in graphic distress. No sexual content. No minors in unsafe situations.
- A DANGEROUS-WILDLIFE CONFRONTATION IS ALLOWED and must be depicted at FULL INTENSITY when the title is about one: the animal charging, lunging, rearing over the person, roaring at close range, and the person fighting back — braced, swinging, driving a spear or paddle at it, holding it off. A struggle at the point of collision is fine and is what the title promises. What stays barred is the AFTERMATH and the GORE: no blood, no wounds, no torn flesh, no mauling, no jaws closed on a person, nobody pinned, limp, or injured. Peak struggle, never damage. This is how the whole genre shoots these thumbnails and it renders fine; a tame standoff, or leaving the animal out, is not an acceptable alternative.
- Tools and equipment that a lawful outdoor or work activity genuinely involves (a harpoon or rifle carried on a hunt, a fishing spear, a work knife, an axe, machinery) ARE allowed when the title is about that activity — show them in NORMAL WORKING USE, held or carried, never mid-strike and never aimed at a person. Animals in a hunting/fishing scene are shown intact and non-graphic (a fish on a line, a catch on the ice) — never wounded, bleeding, or being killed.
- Keep it a tabloid-style attention-grabbing thumbnail, just without graphic distress language.

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
        // the JSON mid-string (a second cause of the same bug). Raised 2048 ->
        // 4096 on 2026-08-24: the scene/action rules make the model reason at
        // length before it writes, and it was hitting MAX_TOKENS on the first
        // attempt (observed on "Polar bear attack"). The retry saved it, but a
        // second truncation would have dropped the build to the title-less
        // fallback. Headroom is cheap; a wrong thumbnail is not.
        const r = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.4,
            maxOutputTokens: 4096,
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
  // The title is the SUBJECT of the image. Without this the fallback produced a
  // generic channel-style portrait with no connection to the video — the
  // "they don't show anything" complaint. We cannot reason about the title here
  // (no model), so we hand it to the image model as the scene to depict.
  if (input.title.trim()) {
    parts.push(
      `The image must SHOW what this video is about: "${input.title.trim()}". Every concrete thing that title names — the animal, object, or vehicle — must be visible in the frame, large and unmistakable, with the activity clearly in progress in its real setting. Depict it: do not render this text on the image, do not imply the subject through scenery or mood, and do not settle for a posed portrait.`,
    );
  }
  if (input.subjectCount === 1) parts.push("Feature the provided subject as the clear, unobstructed focal point, preserving their likeness.");
  if (input.subjectCount === 2) parts.push("Feature both provided subjects together as the clear focal point, preserving each likeness.");
  if (input.customPrompt?.trim()) parts.push(input.customPrompt.trim());
  parts.push("Any on-image text is a short 2–4 word hook, not the full title, and must not cover the subject. If the channel style describes a recurring branded label (e.g. a 'BREAKING NEWS' / 'EXCLUSIVE' box), reproduce it in that style at the edge. If the channel style uses a pointing mark (a red arrow, cross, circle or highlight ring), place it so it points directly at the main subject of the action named above — never floating over empty sky, water, or blank background.");
  return parts.join(" ").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 3000);
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import { resolveReferenceUrl } from "@/lib/thumbnails/youtube";
import { buildThumbnailPrompt, analyzeFormatImages, MAX_FORMAT_IMAGES } from "@/lib/thumbnails/gemini";
import { buildChannelReferenceUrls, pickStyleImage } from "@/lib/thumbnails/pikzels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 2a of the thumbnail flow — BUILD the final prompt (for user review/edit
// before generating). Given a saved channel + a new title + 0–2 subject image
// urls, resolve the image-slot rule and ask Gemini to merge the channel style
// prompt + title into the final prompt. Returns the prompt (editable) plus the
// styleImageSent flag so the generate step reproduces the same slot layout.

const BodySchema = z.object({
  channelId: z.string().uuid(),
  title: z.string().trim().min(1, "title is required").max(300),
  // Optional free-text changes to apply on top of the channel style + title.
  customPrompt: z.string().trim().max(1000).optional().default(""),
  // 0–2 subject images (celebrity/person or AI avatar), each a YouTube/image URL.
  subjects: z.array(z.string().trim().min(1)).max(2).default([]),
  // Optional 1–3 uploaded example images teaching a SPECIFIC format to reproduce
  // (already re-hosted to R2 URLs by /api/thumbnails/upload). Empty = use the
  // averaged channel style only.
  formatImages: z.array(z.string().trim().url()).max(MAX_FORMAT_IMAGES).default([]),
});

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400 },
    );
  }
  const { channelId, title, customPrompt, subjects, formatImages } = parsed.data;

  const sb = getServerSupabase();
  const { data: channel, error } = await sb
    .from("thumbnail_channels")
    .select("style_prompt, sample_urls")
    .eq("id", channelId)
    .single();
  if (error || !channel) {
    return NextResponse.json({ error: "channel not found — analyze it first" }, { status: 404 });
  }

  // Resolve subject inputs to image urls.
  const subjectUrls: string[] = [];
  for (const raw of subjects) {
    const url = resolveReferenceUrl(raw);
    if (!url) {
      return NextResponse.json(
        { error: `Not a YouTube link or image URL: "${raw.slice(0, 80)}"` },
        { status: 400 },
      );
    }
    subjectUrls.push(url);
  }

  // Whether a channel style image will be sent depends only on whether samples
  // exist + the subject count (which specific sample is chosen — rotated for
  // pose variety — is decided at generate time). Use pickStyleImage(…, 0) here
  // purely to detect presence.
  const samples = Array.isArray(channel.sample_urls) ? (channel.sample_urls as string[]) : [];
  const styleImageUrl = pickStyleImage(samples, 0);
  const { styleImageSent } = buildChannelReferenceUrls({ subjectUrls, styleImageUrl });

  // If the user uploaded example images of a specific format, learn that layout
  // and let it override the averaged channel style for composition. If learning
  // fails we surface it (the format was requested but couldn't be applied).
  let formatPrompt = "";
  let formatFailed = false;
  if (formatImages.length > 0) {
    formatPrompt = await analyzeFormatImages(formatImages);
    formatFailed = formatPrompt === "";
  }

  const built = await buildThumbnailPrompt({
    stylePrompt: (channel.style_prompt as string) ?? "",
    title,
    formatPrompt,
    customPrompt,
    subjectCount: subjectUrls.length,
    styleImageSent,
  });

  // Tell the UI when the title was NOT actually woven in (Gemini fell back), or
  // when a requested format couldn't be learned — so a title-less/format-less
  // copy is never mistaken for a real build.
  return NextResponse.json(
    {
      prompt: built.prompt,
      styleImageSent,
      usedFallback: built.usedFallback,
      fallbackReason: built.fallbackReason ?? null,
      formatApplied: formatImages.length > 0 && !formatFailed,
      formatFailed,
    },
    { status: 200 },
  );
}

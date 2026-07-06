import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import { resolveReferenceUrl } from "@/lib/thumbnails/youtube";
import { buildThumbnailPrompt } from "@/lib/thumbnails/gemini";
import { buildChannelReferenceUrls } from "@/lib/thumbnails/pikzels";

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
  // 0–2 subject images (celebrity/person or AI avatar), each a YouTube/image URL.
  subjects: z.array(z.string().trim().min(1)).max(2).default([]),
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
  const { channelId, title, subjects } = parsed.data;

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

  // A representative channel thumbnail is the style image (first sample).
  const samples = Array.isArray(channel.sample_urls) ? (channel.sample_urls as string[]) : [];
  const styleImageUrl = samples[0] ?? null;
  const { styleImageSent } = buildChannelReferenceUrls({ subjectUrls, styleImageUrl });

  const prompt = await buildThumbnailPrompt({
    stylePrompt: (channel.style_prompt as string) ?? "",
    title,
    subjectCount: subjectUrls.length,
    styleImageSent,
  });

  return NextResponse.json({ prompt, styleImageSent }, { status: 200 });
}

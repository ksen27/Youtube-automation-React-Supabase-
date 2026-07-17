import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import { resolveReferenceUrl } from "@/lib/thumbnails/youtube";
import {
  buildChannelReferenceUrls,
  pickStyleImage,
  isPikzelsConfigured,
  promptContainsUrl,
} from "@/lib/thumbnails/pikzels";
import { renderThumbnailRow } from "@/lib/thumbnails/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 2b of the thumbnail flow — GENERATE.
//
// Given a saved channel, the new title, 0–2 subject image urls, and the FINAL
// (user-edited) prompt: resolve the Pikzels image slots per the channel rule
// (see buildChannelReferenceUrls), insert a `pending` row, call Pikzels,
// download the returned CDN image (expires ~24h) and re-host to R2 for a
// permanent link, then mark the row `completed`. On failure the row is marked
// `failed` with the error so the gallery can show it.

const BodySchema = z.object({
  channelId: z.string().uuid(),
  title: z.string().trim().min(1, "title is required").max(300),
  // The final prompt (Gemini-generated, possibly user-edited).
  prompt: z.string().trim().min(1, "prompt is required").max(3000),
  // 0–2 subject images (celebrity/person or AI avatar), each a YouTube/image URL.
  subjects: z.array(z.string().trim().min(1)).max(2).default([]),
});

export async function POST(req: NextRequest) {
  if (!isPikzelsConfigured()) {
    return NextResponse.json(
      { error: "Thumbnail generation is not configured (PIKZELS_API_KEY missing)." },
      { status: 503 },
    );
  }
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
  const { channelId, title, prompt, subjects } = parsed.data;

  if (promptContainsUrl(prompt)) {
    return NextResponse.json(
      { error: 'The prompt cannot contain a URL (the text "http").' },
      { status: 400 },
    );
  }

  const sb = getServerSupabase();
  const { data: channel, error: chErr } = await sb
    .from("thumbnail_channels")
    .select("sample_urls")
    .eq("id", channelId)
    .single();
  if (chErr || !channel) {
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

  // Build the Pikzels image slots per the channel rule: subject photo(s) fill
  // the slots first; a representative channel thumbnail fills any remaining slot
  // as a style reference (dropped entirely when two subjects are supplied).
  //
  // Rotate WHICH channel thumbnail is used as the style/base image so repeated
  // generations don't all inherit the same pose. Rotation = how many thumbnails
  // already exist for this channel, so each generation advances to a different
  // sample pose (same person, different action).
  const samples = Array.isArray(channel.sample_urls) ? (channel.sample_urls as string[]) : [];
  const { count: priorCount } = await sb
    .from("thumbnails")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", channelId);
  const styleImageUrl = pickStyleImage(samples, priorCount ?? 0);
  const { referenceUrls } = buildChannelReferenceUrls({ subjectUrls, styleImageUrl });
  if (referenceUrls.length === 0) {
    return NextResponse.json(
      { error: "No image to base the thumbnail on. Add a subject image or re-analyze the channel." },
      { status: 400 },
    );
  }

  const { data: row, error: insErr } = await sb
    .from("thumbnails")
    .insert({
      channel_id: channelId,
      title,
      prompt,
      subject_urls: subjectUrls,
      reference_urls: referenceUrls,
      status: "pending",
    })
    .select("id")
    .single();
  if (insErr || !row) {
    return NextResponse.json({ error: insErr?.message ?? "failed to create row" }, { status: 500 });
  }

  // Render synchronously via the shared renderer (persona face-lock, Pikzels,
  // R2 re-host, terminal status write all live there — the batch route reuses
  // the same unit). The row already holds channel/title/prompt/subjects, so the
  // renderer rebuilds its own references; it never throws.
  const result = await renderThumbnailRow(sb, row.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "generation failed" }, { status: 502 });
  }

  const { data: updated } = await sb
    .from("thumbnails")
    .select("id, channel_id, title, prompt, subject_urls, reference_urls, output_url, status, error, created_at")
    .eq("id", row.id)
    .single();
  return NextResponse.json({ thumbnail: updated }, { status: 200 });
}

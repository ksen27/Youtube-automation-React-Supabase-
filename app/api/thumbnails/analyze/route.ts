import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import { fetchChannelThumbnails } from "@/lib/thumbnails/youtube";
import { analyzeChannelStyle } from "@/lib/thumbnails/gemini";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 1 of the thumbnail flow — ANALYZE a channel.
//
// Given a YouTube channel URL/@handle, resolve it, pull ~10 recent thumbnails,
// and ask Gemini to extract a reusable STYLE PROMPT. Upsert the channel + style
// prompt (one saved style per channel) and return it so the UI can show the
// editable prompt. Generation happens later via /api/thumbnails/generate.

const BodySchema = z.object({
  channel: z.string().trim().min(1, "channel URL is required"),
});

export async function POST(req: NextRequest) {
  if (!getEnv().GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "Channel analysis is not configured (GEMINI_API_KEY missing)." },
      { status: 503 },
    );
  }
  if (!getEnv().YOUTUBE_API_KEY) {
    return NextResponse.json(
      { error: "Channel analysis is not configured (YOUTUBE_API_KEY missing)." },
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

  let channel;
  try {
    channel = await fetchChannelThumbnails(parsed.data.channel, 10);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to read channel" },
      { status: 400 },
    );
  }

  const stylePrompt = await analyzeChannelStyle(channel.thumbnailUrls);
  if (!stylePrompt) {
    return NextResponse.json(
      { error: "Could not analyze the channel's thumbnail style. Try another channel." },
      { status: 502 },
    );
  }

  const sb = getServerSupabase();
  const { data: saved, error } = await sb
    .from("thumbnail_channels")
    .upsert(
      {
        channel_input: parsed.data.channel,
        channel_id: channel.channelId,
        channel_title: channel.channelTitle,
        style_prompt: stylePrompt,
        sample_urls: channel.thumbnailUrls,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "channel_id" },
    )
    .select("id, channel_input, channel_id, channel_title, style_prompt, sample_urls, created_at")
    .single();
  if (error || !saved) {
    return NextResponse.json({ error: error?.message ?? "failed to save channel" }, { status: 500 });
  }

  return NextResponse.json({ channel: saved }, { status: 200 });
}

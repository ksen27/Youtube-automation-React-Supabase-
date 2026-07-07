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
//
// QUOTA GUARD: a channel's style is SAVED and reusable, so re-analyzing one we
// already have wastes YouTube + Gemini quota for no benefit. We reuse a saved
// channel instead of re-fetching, UNLESS `force: true` is passed (the user
// explicitly wants to re-learn the style, e.g. the channel changed its look).
// The exact pasted-input match short-circuits BEFORE any API call; if the input
// differs but resolves to a channel we already have, we still reuse after the
// cheap (~1 unit) resolve rather than spending Gemini vision calls.

const BodySchema = z.object({
  channel: z.string().trim().min(1, "channel URL is required"),
  // Re-analyze even if this channel is already saved (spends quota).
  force: z.boolean().optional().default(false),
});

export async function POST(req: NextRequest) {
  if (!getEnv().GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "Channel analysis is not configured (GEMINI_API_KEY missing)." },
      { status: 503 },
    );
  }
  if (!getEnv().YOUTUBE_API_KEY_THUMBNAILS && !getEnv().YOUTUBE_API_KEY) {
    return NextResponse.json(
      { error: "Channel analysis is not configured (YOUTUBE_API_KEY_THUMBNAILS or YOUTUBE_API_KEY missing)." },
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

  const sb = getServerSupabase();
  const CHANNEL_COLS = "id, channel_input, channel_id, channel_title, style_prompt, sample_urls, created_at";

  // Quota guard 1 (zero API calls): the exact same input was analyzed before.
  if (!parsed.data.force) {
    const { data: byInput } = await sb
      .from("thumbnail_channels")
      .select(CHANNEL_COLS)
      .eq("channel_input", parsed.data.channel)
      .maybeSingle();
    if (byInput) return NextResponse.json({ channel: byInput, reused: true }, { status: 200 });
  }

  // Resolve + pull thumbnails (cheap: ~2 units for an @handle / channel URL).
  let channel;
  try {
    channel = await fetchChannelThumbnails(parsed.data.channel, 10);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to read channel" },
      { status: 400 },
    );
  }

  // Quota guard 2 (after the cheap resolve, before the Gemini vision calls):
  // a different input string that resolves to a channel we already saved.
  if (!parsed.data.force) {
    const { data: byId } = await sb
      .from("thumbnail_channels")
      .select(CHANNEL_COLS)
      .eq("channel_id", channel.channelId)
      .maybeSingle();
    if (byId) return NextResponse.json({ channel: byId, reused: true }, { status: 200 });
  }

  const stylePrompt = await analyzeChannelStyle(channel.thumbnailUrls);
  if (!stylePrompt) {
    return NextResponse.json(
      { error: "Could not analyze the channel's thumbnail style. Try another channel." },
      { status: 502 },
    );
  }

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
    .select(CHANNEL_COLS)
    .single();
  if (error || !saved) {
    return NextResponse.json({ error: error?.message ?? "failed to save channel" }, { status: 500 });
  }

  return NextResponse.json({ channel: saved }, { status: 200 });
}

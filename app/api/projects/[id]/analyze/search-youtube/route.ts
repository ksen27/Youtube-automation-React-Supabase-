import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { searchYoutubeFast } from "@/lib/youtube/search";

// In-app YouTube search for the analyze screen's manual source picker. The user
// types a query; we return lightweight thumbnail results for them to pick from.
// This endpoint is READ-ONLY — it persists nothing. Adding a picked video to the
// project is a separate call to /analyze/add-source.
//
// SPEED: this uses the FAST path — a single search.list call rendered straight
// from the snippet, with NO videos.list hydration and NO per-reference-channel
// loop. That makes it near-instant (one round-trip) like a typical search
// picker. Duration + origin (reference vs YouTube) are resolved at add-time,
// where add-source already hydrates full metadata. On quota exhaustion the lib
// falls back to a yt-dlp scrape.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UuidSchema = z.string().uuid();
const BodySchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(40).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.flatten() }, { status: 400 });
  }
  const { query } = parsed.data;
  const limit = parsed.data.limit ?? 24;

  try {
    const found = await searchYoutubeFast(query, limit);
    // Origin (reference-channel vs whole-YouTube) isn't computed on the fast
    // path — it's resolved at add-time. The UI just shows the result; the badge
    // appears once the video is added to a pool.
    const results = found.map((r) => ({
      videoId: r.videoId,
      url: r.url,
      title: r.title,
      channelTitle: r.channelTitle,
      durationSeconds: 0, // resolved at add-time
      thumbnailUrl: r.thumbnailUrl,
      from_reference_channel: false,
    }));
    return NextResponse.json({ query, results });
  } catch (e) {
    return NextResponse.json(
      { error: `YouTube search failed: ${(e as Error).message.slice(0, 160)}` },
      { status: 502 },
    );
  }
}

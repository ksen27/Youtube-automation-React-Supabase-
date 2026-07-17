import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
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
// Each Pikzels render is ~30–60s; a batch of 4 runs them concurrently in the
// `after()` callback, so give the invocation room past the response.
export const maxDuration = 300;

// Batch generate — the FIRE-AND-POLL entry point for generating several
// independent thumbnails at once (up to MAX_BATCH). Unlike the single
// /generate route (which renders synchronously and returns the finished image),
// this route:
//   1. Validates + inserts N `pending` rows synchronously, then
//   2. returns their ids IMMEDIATELY, and
//   3. renders all N concurrently AFTER the response via next/server `after()`.
// The client polls /api/thumbnails/status?ids=… to watch each row flip
// pending → completed/failed, so no request blocks for the full render time.
//
// Each item is fully independent: its own channel, title, subjects, and final
// (user-edited) prompt — mirroring the single route's per-item validation.

// Client requested up to 4 at a time.
const MAX_BATCH = 4;

const ItemSchema = z.object({
  channelId: z.string().uuid(),
  title: z.string().trim().min(1, "title is required").max(300),
  prompt: z.string().trim().min(1, "prompt is required").max(3000),
  subjects: z.array(z.string().trim().min(1)).max(2).default([]),
});

const BodySchema = z.object({
  items: z.array(ItemSchema).min(1, "at least one item is required").max(MAX_BATCH),
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
  const { items } = parsed.data;

  const sb = getServerSupabase();

  // Validate and prepare every item BEFORE inserting any row, so a bad item
  // (unknown channel, URL in prompt, unresolvable subject) fails the whole
  // batch with a clear message instead of half-creating rows.
  const prepared: Array<{
    channelId: string;
    title: string;
    prompt: string;
    subjectUrls: string[];
    referenceUrls: string[];
  }> = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const where = `Row ${i + 1}`;

    if (promptContainsUrl(it.prompt)) {
      return NextResponse.json(
        { error: `${where}: the prompt cannot contain a URL (the text "http").` },
        { status: 400 },
      );
    }

    const { data: channel } = await sb
      .from("thumbnail_channels")
      .select("sample_urls")
      .eq("id", it.channelId)
      .maybeSingle();
    if (!channel) {
      return NextResponse.json(
        { error: `${where}: channel not found — analyze it first.` },
        { status: 404 },
      );
    }

    const subjectUrls: string[] = [];
    for (const raw of it.subjects) {
      const url = resolveReferenceUrl(raw);
      if (!url) {
        return NextResponse.json(
          { error: `${where}: not a YouTube link or image URL: "${raw.slice(0, 80)}"` },
          { status: 400 },
        );
      }
      subjectUrls.push(url);
    }

    // Resolve the style pose the same way the single route does — rotate off the
    // channel's current thumbnail count. buildReferences in the renderer will
    // recompute this at render time too, but computing it here lets us reject an
    // item with NO possible reference image up front rather than after insert.
    const samples = Array.isArray(channel.sample_urls) ? (channel.sample_urls as string[]) : [];
    const { count } = await sb
      .from("thumbnails")
      .select("id", { count: "exact", head: true })
      .eq("channel_id", it.channelId);
    const styleImageUrl = pickStyleImage(samples, count ?? 0);
    const { referenceUrls } = buildChannelReferenceUrls({ subjectUrls, styleImageUrl });
    if (referenceUrls.length === 0) {
      return NextResponse.json(
        {
          error: `${where}: no image to base the thumbnail on. Add a subject image or re-analyze the channel.`,
        },
        { status: 400 },
      );
    }

    prepared.push({
      channelId: it.channelId,
      title: it.title,
      prompt: it.prompt,
      subjectUrls,
      referenceUrls,
    });
  }

  // Insert all N pending rows in one shot.
  const { data: rows, error: insErr } = await sb
    .from("thumbnails")
    .insert(
      prepared.map((p) => ({
        channel_id: p.channelId,
        title: p.title,
        prompt: p.prompt,
        subject_urls: p.subjectUrls,
        reference_urls: p.referenceUrls,
        status: "pending" as const,
      })),
    )
    .select("id, channel_id, title, prompt, reference_urls, output_url, status, error, created_at");
  if (insErr || !rows) {
    return NextResponse.json({ error: insErr?.message ?? "failed to create rows" }, { status: 500 });
  }

  const ids = rows.map((r) => r.id as string);

  // Render all rows CONCURRENTLY after the response is sent. renderThumbnailRow
  // never throws — a failure is recorded on its own row — so one bad render
  // can't reject the whole batch. On a self-hosted Node server `after()` keeps
  // the invocation alive until these settle. If the server restarts mid-render,
  // the stuck-row sweep in /status marks any long-`pending` row failed so its
  // card never spins forever.
  after(async () => {
    await Promise.all(ids.map((id) => renderThumbnailRow(sb, id)));
  });

  // Return the freshly-inserted rows so the client can render "Generating…"
  // cards immediately and start polling by id.
  return NextResponse.json({ thumbnails: rows, ids }, { status: 202 });
}

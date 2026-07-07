import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import { uploadBuffer, removeFiles } from "@/lib/storage";
import { resolveReferenceUrl } from "@/lib/thumbnails/youtube";
import {
  generateThumbnailFromReferences,
  buildChannelReferenceUrls,
  pickStyleImage,
  isPikzelsConfigured,
  promptContainsUrl,
  pikzelsErrorMessage,
} from "@/lib/thumbnails/pikzels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-thumbnail actions for the gallery:
//   DELETE — remove the thumbnail row AND its R2 output object.
//   POST   — EDIT: re-run Pikzels with an edited prompt for an existing
//            thumbnail (same channel + subjects), producing a new image.
//
// The generated output object key mirrors the generate route:
//   thumbnails/output/<id>.<ext>  (ext derived from the output url).

const THUMB_COLS =
  "id, channel_id, title, prompt, subject_urls, reference_urls, output_url, status, error, created_at";

// Derive the R2 object key for a thumbnail's stored output from its public url.
// The generate/regenerate routes always upload to thumbnails/output/<id>.<ext>,
// so we reconstruct that key from the url's extension (default jpg).
function outputKeyFor(id: string, outputUrl: string | null): string {
  const m = outputUrl?.match(/\.(png|webp|jpg|jpeg)(?:\?|$)/i);
  const ext = (m?.[1] ?? "jpg").toLowerCase();
  return `thumbnails/output/${id}.${ext}`;
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const sb = getServerSupabase();
  const { data: row } = await sb
    .from("thumbnails")
    .select("id, output_url")
    .eq("id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Remove the R2 object first (best-effort — a leftover object is harmless,
  // but we don't want to delete the row and then fail on storage).
  await removeFiles([outputKeyFor(row.id as string, row.output_url as string | null)]);

  const { error } = await sb.from("thumbnails").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

const RegenSchema = z.object({
  // The edited prompt to re-generate with.
  prompt: z.string().trim().min(1, "prompt is required").max(3000),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isPikzelsConfigured()) {
    return NextResponse.json(
      { error: "Thumbnail generation is not configured (PIKZELS_API_KEY missing)." },
      { status: 503 },
    );
  }
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const parsed = RegenSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400 },
    );
  }
  const { prompt } = parsed.data;
  if (promptContainsUrl(prompt)) {
    return NextResponse.json(
      { error: 'The prompt cannot contain a URL (the text "http").' },
      { status: 400 },
    );
  }

  const sb = getServerSupabase();
  const { data: row } = await sb.from("thumbnails").select(THUMB_COLS).eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Rebuild the Pikzels image slots exactly as the original generation did:
  // the same subject images, plus a rotated channel style image.
  const subjectUrls: string[] = [];
  for (const raw of (row.subject_urls as string[] | null) ?? []) {
    const url = resolveReferenceUrl(raw);
    if (url) subjectUrls.push(url);
  }
  let styleImageUrl: string | null = null;
  if (row.channel_id) {
    const { data: channel } = await sb
      .from("thumbnail_channels")
      .select("sample_urls")
      .eq("id", row.channel_id)
      .maybeSingle();
    const samples = Array.isArray(channel?.sample_urls) ? (channel!.sample_urls as string[]) : [];
    // Rotate off the current thumbnail count so a re-generate can land on a
    // different sample pose than the original.
    const { count } = await sb
      .from("thumbnails")
      .select("id", { count: "exact", head: true })
      .eq("channel_id", row.channel_id);
    styleImageUrl = pickStyleImage(samples, count ?? 0);
  }
  const { referenceUrls } = buildChannelReferenceUrls({ subjectUrls, styleImageUrl });
  if (referenceUrls.length === 0) {
    return NextResponse.json(
      { error: "No image to base the thumbnail on. Add a subject image or re-analyze the channel." },
      { status: 400 },
    );
  }

  // Mark regenerating so the gallery shows a spinner if it re-reads mid-flight.
  await sb.from("thumbnails").update({ status: "pending", error: null, prompt }).eq("id", id);

  try {
    const result = await generateThumbnailFromReferences({ prompt, referenceUrls });
    const imgRes = await fetch(result.outputUrl);
    if (!imgRes.ok) throw new Error(`failed to download generated image (${imgRes.status})`);
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const key = `thumbnails/output/${id}.${ext}`;
    const up = await uploadBuffer(buf, key, contentType);

    const { data: updated, error: updErr } = await sb
      .from("thumbnails")
      .update({
        status: "completed",
        output_url: up.publicUrl,
        request_id: result.requestId,
        reference_urls: referenceUrls,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select(THUMB_COLS)
      .single();
    if (updErr) throw new Error(updErr.message);
    return NextResponse.json({ thumbnail: updated }, { status: 200 });
  } catch (err) {
    const message = pikzelsErrorMessage(err);
    await sb
      .from("thumbnails")
      .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", id);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

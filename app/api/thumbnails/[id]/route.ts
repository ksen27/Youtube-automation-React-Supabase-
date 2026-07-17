import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import { removeFiles } from "@/lib/storage";
import {
  isPikzelsConfigured,
  promptContainsUrl,
} from "@/lib/thumbnails/pikzels";
import { renderThumbnailRow } from "@/lib/thumbnails/render";

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
  const { data: row } = await sb.from("thumbnails").select("id").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Store the edited prompt and mark pending, then re-render via the shared
  // renderer. The renderer rebuilds references (same subjects + a rotated
  // channel style pose) and persona from the row, so a re-generate can land on
  // a different sample pose than the original. It never throws.
  await sb.from("thumbnails").update({ status: "pending", error: null, prompt }).eq("id", id);

  const result = await renderThumbnailRow(sb, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "generation failed" }, { status: 502 });
  }

  const { data: updated } = await sb.from("thumbnails").select(THUMB_COLS).eq("id", id).single();
  return NextResponse.json({ thumbnail: updated }, { status: 200 });
}

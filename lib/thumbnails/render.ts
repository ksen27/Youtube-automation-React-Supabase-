import type { SupabaseClient } from "@supabase/supabase-js";
import { uploadBuffer } from "@/lib/storage";
import { resolveReferenceUrl } from "@/lib/thumbnails/youtube";
import {
  generateThumbnailFromReferences,
  buildChannelReferenceUrls,
  pickStyleImage,
  pikzelsErrorMessage,
} from "@/lib/thumbnails/pikzels";
import { resolvePersonaForFace } from "@/lib/thumbnails/persona";

// Shared thumbnail renderer — the single unit of "turn a `pending` thumbnails
// row into a `completed` (or `failed`) one". Both the synchronous generate /
// regenerate routes and the fire-and-poll batch route call this so the Pikzels
// call, persona face-lock, R2 re-host, and terminal status write live in ONE
// place instead of being copy-pasted per route.
//
// Contract: the caller has already inserted (or updated to) a `pending` row and
// stored `channel_id`, `title`, `prompt`, and `subject_urls` on it. This
// function rebuilds the Pikzels image slots from that row, renders, and writes
// the terminal status. It NEVER throws — a failure is recorded on the row as
// status='failed' and returned as { ok: false } so a detached (fire-and-poll)
// caller can't leave an unhandled rejection.

export interface RenderResult {
  ok: boolean;
  // Present on success — the permanent R2 url of the generated image.
  outputUrl?: string;
  // Present on failure — the user-facing error already written to the row.
  error?: string;
}

// Rebuild the Pikzels reference slots for a row exactly as the original
// single-generate flow does: resolved subject image(s) plus a rotated channel
// style image (rotation = current thumbnail count for the channel, so repeated
// renders start from a different sample pose). Mirrors the logic previously
// inlined in both thumbnail routes.
async function buildReferences(
  sb: SupabaseClient,
  row: { channel_id: string | null; subject_urls: string[] | null },
): Promise<{ referenceUrls: string[]; subjectUrls: string[] }> {
  const subjectUrls: string[] = [];
  for (const raw of row.subject_urls ?? []) {
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
    const { count } = await sb
      .from("thumbnails")
      .select("id", { count: "exact", head: true })
      .eq("channel_id", row.channel_id);
    styleImageUrl = pickStyleImage(samples, count ?? 0);
  }

  const { referenceUrls } = buildChannelReferenceUrls({ subjectUrls, styleImageUrl });
  return { referenceUrls, subjectUrls };
}

// Render a single pending thumbnail row to completion. Reads the row, resolves
// references + persona, calls Pikzels, re-hosts the (~24h-expiring) CDN output
// to R2, and writes status='completed' with the permanent url — or, on any
// failure, status='failed' with a short user-facing message. Returns the
// outcome; never throws.
export async function renderThumbnailRow(sb: SupabaseClient, id: string): Promise<RenderResult> {
  const markFailed = async (message: string): Promise<RenderResult> => {
    await sb
      .from("thumbnails")
      .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", id);
    return { ok: false, error: message };
  };

  try {
    const { data: row } = await sb
      .from("thumbnails")
      .select("id, channel_id, title, prompt, subject_urls")
      .eq("id", id)
      .maybeSingle();
    if (!row) return { ok: false, error: "row not found" };

    const prompt = (row.prompt as string | null) ?? "";
    if (!prompt.trim()) return markFailed("no prompt to generate from");

    const { referenceUrls, subjectUrls } = await buildReferences(sb, {
      channel_id: row.channel_id as string | null,
      subject_urls: row.subject_urls as string[] | null,
    });
    if (referenceUrls.length === 0) {
      return markFailed(
        "No image to base the thumbnail on. Add a subject image or re-analyze the channel.",
      );
    }

    // Identity lock: when a face was uploaded, build/reuse its persona so the
    // EXACT face is preserved. Null = silent fallback to face-as-base.
    let personaId: string | null = null;
    if (subjectUrls.length > 0) {
      personaId = await resolvePersonaForFace(sb, subjectUrls[0], (row.title as string) || "avatar");
    }

    const result = await generateThumbnailFromReferences({ prompt, referenceUrls, personaId });

    // Re-host the CDN output to R2 — the Pikzels url expires in ~24h.
    const imgRes = await fetch(result.outputUrl);
    if (!imgRes.ok) throw new Error(`failed to download generated image (${imgRes.status})`);
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const key = `thumbnails/output/${id}.${ext}`;
    const up = await uploadBuffer(buf, key, contentType);

    const { error: updErr } = await sb
      .from("thumbnails")
      .update({
        status: "completed",
        output_url: up.publicUrl,
        request_id: result.requestId,
        reference_urls: referenceUrls,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (updErr) throw new Error(updErr.message);

    return { ok: true, outputUrl: up.publicUrl };
  } catch (err) {
    return markFailed(pikzelsErrorMessage(err));
  }
}

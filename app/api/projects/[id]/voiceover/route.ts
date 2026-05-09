import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import {
  ensureTmp,
  safeUnlink,
  uploadBuffer,
  headObject,
  publicUrlForKey,
} from "@/lib/storage";
import { transcribeAudio, transcribeAudioFromUrl } from "@/lib/ai/deepgram";
import { probeFile } from "@/lib/media/probe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Multipart fallback cap. Vercel's edge layer rejects request bodies above
// ~4.5MB, so anything larger must use the presigned-upload flow (JSON branch).
const MAX_BYTES_MULTIPART = 4 * 1024 * 1024;
// Hard ceiling for direct uploads. R2 can handle multi-GB objects; this is
// just a sanity guard so a runaway client doesn't kick off transcription on
// a 10GB file.
const MAX_BYTES_DIRECT = 2 * 1024 * 1024 * 1024;

const NotifySchema = z.object({
  storageKey: z.string().min(1).max(500),
  contentType: z.string().min(1).max(100).regex(/^audio\//),
  filename: z.string().min(1).max(255).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  // Branch on Content-Type. JSON = "I already PUT to R2, here's the key"
  // (preferred path for files >4MB). multipart = legacy small-file upload.
  const ct = req.headers.get("content-type") ?? "";

  if (ct.startsWith("application/json")) {
    return await handleDirectUpload(id, req);
  }
  return await handleMultipartUpload(id, req);
}

// Direct (presigned) upload path. The browser already PUT the audio to R2;
// we never see the bytes. Deepgram fetches the audio by URL — so this route
// stays small in memory regardless of audio length, sidestepping Vercel's
// 4.5MB request-body limit and the function's RAM ceiling.
async function handleDirectUpload(id: string, req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = NotifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  // Lock the key to this project's prefix so callers can't point us at
  // arbitrary objects (e.g. another project's audio).
  const expectedPrefix = `projects/${id}/voiceover/`;
  if (!parsed.data.storageKey.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: "storageKey outside project prefix" }, { status: 400 });
  }

  // Confirm the upload actually landed before we run downstream work.
  const head = await headObject(parsed.data.storageKey);
  if (!head) return NextResponse.json({ error: "uploaded object not found" }, { status: 404 });
  if (head.size <= 0) return NextResponse.json({ error: "uploaded object is empty" }, { status: 400 });
  if (head.size > MAX_BYTES_DIRECT) return NextResponse.json({ error: "uploaded object too large" }, { status: 413 });

  const voiceoverPublicUrl = publicUrlForKey(parsed.data.storageKey);

  let transcript: string;
  let durationSeconds: number | null = null;
  try {
    // Deepgram pulls the audio itself from the public R2 URL. Our function
    // never holds the bytes, so a 30-min file takes the same memory as a
    // 30-second one.
    const result = await transcribeAudioFromUrl(voiceoverPublicUrl);
    transcript = result.transcript;
    if (result.durationSeconds != null && result.durationSeconds > 0) {
      durationSeconds = Math.round(result.durationSeconds);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "transcription failed";
    return NextResponse.json(
      { error: `transcription failed: ${message}`, voiceover_url: voiceoverPublicUrl },
      { status: 502 },
    );
  }

  return await persistAndReturn(id, voiceoverPublicUrl, transcript, durationSeconds);
}

// Legacy multipart path. Kept for small files (<4MB) where the round-trip
// through Vercel is fine and avoids the two-step presigned-upload flow.
async function handleMultipartUpload(id: string, req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing file" }, { status: 400 });
  if (file.size > MAX_BYTES_MULTIPART) {
    return NextResponse.json({
      error: "file too large for direct POST — use the presigned upload flow",
    }, { status: 413 });
  }
  if (!file.type.startsWith("audio/")) return NextResponse.json({ error: "must be audio/*" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  const ext = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "mp3";
  const dest = `projects/${id}/voiceover/${Date.now()}.${ext}`;
  const up = await uploadBuffer(buf, dest, mimeType);

  // Probe duration locally (ffprobe). Best-effort — if it fails we fall back
  // to Deepgram's reported duration below.
  let durationSeconds: number | null = null;
  const tmp = await ensureTmp(`voiceover/${id}`);
  const tmpPath = path.join(tmp, `vo_${Date.now()}.${ext}`);
  try {
    await fs.writeFile(tmpPath, new Uint8Array(buf));
    const probe = await probeFile(tmpPath);
    if (probe.durationSeconds && probe.durationSeconds > 0) {
      durationSeconds = Math.round(probe.durationSeconds);
    }
  } catch { /* ignore */ }
  finally { await safeUnlink(tmpPath); }

  let transcript: string;
  try {
    const result = await transcribeAudio(buf, mimeType);
    transcript = result.transcript;
    if (durationSeconds == null && result.durationSeconds != null) {
      durationSeconds = Math.round(result.durationSeconds);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "transcription failed";
    return NextResponse.json(
      { error: `transcription failed: ${message}`, voiceover_url: up.publicUrl },
      { status: 502 },
    );
  }

  return await persistAndReturn(id, up.publicUrl, transcript, durationSeconds);
}

async function persistAndReturn(
  id: string,
  voiceoverUrl: string,
  transcript: string,
  durationSeconds: number | null,
) {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("projects")
    .update({
      voiceover_url: voiceoverUrl,
      transcript,
      voiceover_duration_seconds: durationSeconds,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    project: data,
    voiceover_url: voiceoverUrl,
    transcript,
    voiceover_duration_seconds: durationSeconds,
  });
}

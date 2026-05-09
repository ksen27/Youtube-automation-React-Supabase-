import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { ensureTmp, safeUnlink, uploadBuffer } from "@/lib/storage";
import { transcribeAudio } from "@/lib/ai/deepgram";
import { probeFile } from "@/lib/media/probe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Cap kept generous since the Gemini Files API path tolerates large files.
const MAX_BYTES = 500 * 1024 * 1024; // 500MB

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });
  if (!file.type.startsWith("audio/")) return NextResponse.json({ error: "must be audio/*" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "mp3";
  const dest = `projects/${id}/voiceover/${Date.now()}.${ext}`;
  const up = await uploadBuffer(buf, dest, file.type || "application/octet-stream");

  // Probe duration locally (ffprobe). Best-effort — if it fails we fall back
  // to the word-count estimate downstream when planning the timeline.
  let voiceoverDurationSeconds: number | null = null;
  const tmp = await ensureTmp(`voiceover/${id}`);
  const tmpPath = path.join(tmp, `vo_${Date.now()}.${ext}`);
  try {
    await fs.writeFile(tmpPath, new Uint8Array(buf));
    const probe = await probeFile(tmpPath);
    if (probe.durationSeconds && probe.durationSeconds > 0) {
      voiceoverDurationSeconds = Math.round(probe.durationSeconds);
    }
  } catch { /* ignore — duration is optional */ }
  finally { await safeUnlink(tmpPath); }

  // Transcribe with Deepgram. If this fails we keep the uploaded audio and
  // return an error so the user can retry without re-uploading the file.
  let transcript: string;
  try {
    const result = await transcribeAudio(buf, file.type);
    transcript = result.transcript;
    // Deepgram is the source of truth for duration on hosts without ffprobe
    // (Vercel). When ffprobe succeeded above we trust it; otherwise fall back
    // to Deepgram's reported duration so the timeline planner gets a real
    // value instead of null (which would floor the project clip cap to MIN).
    if (voiceoverDurationSeconds == null && result.durationSeconds != null) {
      voiceoverDurationSeconds = Math.round(result.durationSeconds);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "transcription failed";
    return NextResponse.json(
      { error: `transcription failed: ${message}`, voiceover_url: up.publicUrl },
      { status: 502 },
    );
  }

  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("projects")
    .update({
      voiceover_url: up.publicUrl,
      transcript,
      voiceover_duration_seconds: voiceoverDurationSeconds,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    project: data,
    voiceover_url: up.publicUrl,
    transcript,
    voiceover_duration_seconds: voiceoverDurationSeconds,
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { estimateDurationSeconds } from "@/lib/ai/segments";

// We need the Node runtime for any code path that ends up touching FFmpeg /
// yt-dlp / Supabase storage uploads. Keep all our routes Node-only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateProject = z.object({
  title: z.string().trim().min(1).max(200),
  transcript: z.string().max(50_000).optional(),
});

export async function GET(_req: NextRequest) {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("projects")
    .select("id, title, status, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ projects: data ?? [] });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = CreateProject.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }
  const sb = getServerSupabase();
  // When the create form supplies a transcript inline, estimate voiceover
  // duration from word count so downstream clip planning has a real cap to
  // size against. Without this, projects created via this route start with
  // voiceover_duration_seconds=null and the clip cap floors to MIN_CLIP_CAP.
  // A later voiceover upload (Deepgram-probed) overrides this estimate.
  const transcript = parsed.data.transcript ?? null;
  const voiceoverDurationSeconds = transcript
    ? (estimateDurationSeconds(transcript) || null)
    : null;
  const { data, error } = await sb
    .from("projects")
    .insert({
      title: parsed.data.title,
      transcript,
      voiceover_duration_seconds: voiceoverDurationSeconds,
      status: "draft",
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data }, { status: 201 });
}

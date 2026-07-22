import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { enqueuePitchGen } from "@/lib/jobs/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Standalone Sales Pitch tool (migration 0029). A generated pitch is INDEPENDENT
// of any project — it's built here and downloaded, then uploaded to an avatar
// project via that project's existing sales-pitch upload field.
//
//   GET  — list recent generated pitches (the gallery).
//   POST — create a pitch_videos row from the inputs (website / avatar image /
//          script / optional voice+name) and enqueue the build job.

const CreateSchema = z.object({
  title: z.string().trim().max(200).optional(),
  websiteUrl: z.string().trim().min(1).max(2000),
  avatarImageUrl: z.string().trim().url().max(2000),
  script: z.string().trim().min(1).max(5000),
  // Required: the pitch voiceover is generated in this 69labs voice (the avatar
  // is then lip-synced to it), so the caller must always supply a voice.
  ttsVoiceId: z.string().trim().min(1).max(200),
  avatarName: z.string().trim().max(200).optional(),
});

export async function GET() {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("pitch_videos")
    .select("id, title, website_url, output_url, duration_seconds, status, error, created_at")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ pitchVideos: data ?? [] }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  // Normalize the website URL to include a scheme (Playwright's goto needs one).
  let websiteUrl = parsed.data.websiteUrl;
  if (!/^https?:\/\//i.test(websiteUrl)) websiteUrl = `https://${websiteUrl}`;

  const sb = getServerSupabase();
  const { data: row, error } = await sb
    .from("pitch_videos")
    .insert({
      title: parsed.data.title || "",
      website_url: websiteUrl,
      avatar_image_url: parsed.data.avatarImageUrl,
      avatar_name: parsed.data.avatarName || null,
      script: parsed.data.script,
      tts_voice_id: parsed.data.ttsVoiceId || null,
      status: "generating",
    })
    .select("id")
    .single();
  if (error || !row) {
    return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  }

  await enqueuePitchGen({ pitchVideoId: row.id });
  return NextResponse.json({ id: row.id, status: "generating" }, { status: 202 });
}

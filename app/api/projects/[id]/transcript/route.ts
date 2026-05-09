import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { estimateDurationSeconds } from "@/lib/ai/segments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  transcript: z.string().min(1).max(50_000),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }
  const sb = getServerSupabase();
  // Pasted-transcript flow has no audio file, so Deepgram never runs and
  // voiceover_duration_seconds would otherwise stay null — flooring the clip
  // cap to MIN_CLIP_CAP downstream. Estimate from word count (≈150 wpm) so
  // computeProjectClipCap scales to the script length. We only fill it when
  // the project doesn't already have a real probed duration from a prior
  // voiceover upload — overwriting Deepgram's accurate value with an estimate
  // would degrade the cap.
  const { data: existing } = await sb
    .from("projects")
    .select("voiceover_duration_seconds")
    .eq("id", id)
    .single();
  const hasProbedDuration = existing && Number(existing.voiceover_duration_seconds) > 0;
  const estimatedDuration = estimateDurationSeconds(parsed.data.transcript);
  const update: { transcript: string; voiceover_duration_seconds?: number } = {
    transcript: parsed.data.transcript,
  };
  if (!hasProbedDuration && estimatedDuration > 0) {
    update.voiceover_duration_seconds = estimatedDuration;
  }
  const { data, error } = await sb
    .from("projects")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data });
}

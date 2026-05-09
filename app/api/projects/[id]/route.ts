import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { estimateDurationSeconds } from "@/lib/ai/segments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UuidSchema = z.string().uuid();

// Next.js 16 — params is a Promise.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const idCheck = UuidSchema.safeParse(id);
  if (!idCheck.success) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const sb = getServerSupabase();
  const { data, error } = await sb.from("projects").select("*").eq("id", id).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  const [{ data: entities }, { data: searchResults }, { data: sources }] = await Promise.all([
    sb.from("project_entities").select("*").eq("project_id", id).order("created_at", { ascending: true }),
    sb.from("youtube_search_results").select("*").eq("project_id", id).order("score", { ascending: false }).limit(50),
    sb.from("video_sources").select("*").eq("project_id", id).order("created_at", { ascending: true }),
  ]);

  return NextResponse.json({
    project: data,
    entities: entities ?? [],
    search_results: searchResults ?? [],
    video_sources: sources ?? [],
  });
}

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  transcript: z.string().max(50_000).optional(),
}).strict();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "no fields" }, { status: 400 });
  }

  const sb = getServerSupabase();
  // If the patch includes a transcript and the project has no probed
  // voiceover duration yet, fill it from a word-count estimate so downstream
  // clip planning gets a real cap. A real Deepgram-probed duration always
  // takes precedence and is never overwritten here.
  const update: { title?: string; transcript?: string; voiceover_duration_seconds?: number } = {
    ...parsed.data,
  };
  if (parsed.data.transcript) {
    const { data: existing } = await sb
      .from("projects")
      .select("voiceover_duration_seconds")
      .eq("id", id)
      .single();
    const hasProbedDuration = existing && Number(existing.voiceover_duration_seconds) > 0;
    if (!hasProbedDuration) {
      const est = estimateDurationSeconds(parsed.data.transcript);
      if (est > 0) update.voiceover_duration_seconds = est;
    }
  }
  const { data, error } = await sb.from("projects").update(update).eq("id", id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data });
}

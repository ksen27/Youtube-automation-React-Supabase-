import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Saved channel styles for the /thumbnails feature.
//   GET   — list all saved channels (newest-first) for the picker.
//   PATCH — update a channel's (user-editable) style prompt.

export async function GET() {
  if (!isSupabaseConfigured()) return NextResponse.json({ channels: [] });
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("thumbnail_channels")
    .select("id, channel_input, channel_id, channel_title, style_prompt, sample_urls, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ channels: data ?? [] });
}

const PatchSchema = z.object({
  id: z.string().uuid(),
  style_prompt: z.string().trim().min(1).max(3000),
});

export async function PATCH(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400 },
    );
  }
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("thumbnail_channels")
    .update({ style_prompt: parsed.data.style_prompt, updated_at: new Date().toISOString() })
    .eq("id", parsed.data.id)
    .select("id, channel_input, channel_id, channel_title, style_prompt, sample_urls, created_at")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "channel not found" }, { status: 404 });
  }
  return NextResponse.json({ channel: data });
}

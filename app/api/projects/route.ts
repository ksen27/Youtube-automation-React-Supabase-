import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";

// We need the Node runtime for any code path that ends up touching FFmpeg /
// yt-dlp / Supabase storage uploads. Keep all our routes Node-only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Creation is title-only now. Transcript comes from the Google Doc ingest
// on the intake screen — the doc's blue-bold title cards are the source of
// truth for chapter structure, and uploading audio is also an intake step.
// Old callers passing a transcript get a 400 so they update.
const CreateProject = z.object({
  title: z.string().trim().min(1).max(200),
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
  const { data, error } = await sb
    .from("projects")
    .insert({
      title: parsed.data.title,
      status: "draft",
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data }, { status: 201 });
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";

// We need the Node runtime for any code path that ends up touching FFmpeg /
// yt-dlp / Supabase storage uploads. Keep all our routes Node-only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Creation is title-only for the SOURCED engine. Transcript comes from the
// Google Doc ingest on the intake screen — the doc's blue-bold title cards are
// the source of truth for chapter structure, and uploading audio is also an
// intake step. Old callers passing a transcript get a 400 so they update.
//
// For the SYNTHETIC engine the caller may set engine='synthetic'; the synthetic
// inputs (transcript/voiceover/avatar/voice) are supplied later via the
// dedicated intake routes, so creation stays title+engine only here.
const CreateProject = z.object({
  title: z.string().trim().min(1).max(200),
  engine: z.enum(["sourced", "synthetic"]).optional().default("sourced"),
});

export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  // Scope the list to one product. Celebrity (sourced) and AI Avatar (synthetic)
  // are separate features and must never list each other's projects. Defaults to
  // 'sourced' so legacy/no-param callers keep seeing the celebrity list exactly
  // as before; pass ?engine=synthetic for the AI Avatar list, ?engine=all to
  // opt into a mixed list explicitly.
  const engineParam = new URL(req.url).searchParams.get("engine") ?? "sourced";
  let query = sb
    .from("projects")
    .select("id, title, status, engine, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (engineParam === "synthetic") {
    query = query.eq("engine", "synthetic");
  } else if (engineParam !== "all") {
    // 'sourced' (default): include legacy rows where engine is null.
    query = query.or("engine.eq.sourced,engine.is.null");
  }
  const { data, error } = await query;
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
  // Synthetic projects start at 'created' (the first synthetic status) so the
  // workspace routes them to the synthetic intake; sourced projects keep the
  // existing 'draft' start exactly as before.
  const isSynthetic = parsed.data.engine === "synthetic";
  const { data, error } = await sb
    .from("projects")
    .insert({
      title: parsed.data.title,
      engine: parsed.data.engine,
      status: isSynthetic ? "created" : "draft",
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data }, { status: 201 });
}

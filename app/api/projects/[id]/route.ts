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

// Accept a YouTube URL in any of the common shapes the scriptwriter might
// paste. Returns the 11-char video id, or null if the string isn't a
// recognisable YouTube URL. We accept the bare id too so the user can just
// type "dQw4w9WgXcQ" without the full URL.
function extractYoutubeId(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      // /shorts/<id> and /embed/<id> forms
      const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  transcript: z.string().max(50_000).optional(),
  // Intro source. All three are optional and accepted together — passing
  // null on any of them clears the user-provided intro and the renderer
  // falls back to its auto-pick path. The URL is validated as a real
  // YouTube link below so the worker doesn't blow up on garbage input.
  intro_source_youtube_url: z.string().trim().max(500).nullable().optional(),
  intro_source_start_seconds: z.number().min(0).max(36_000).nullable().optional(),
  intro_duration_seconds: z.number().min(1).max(15).nullable().optional(),
  // AI-Avatar (synthetic) only: the NAME of the HeyGen saved avatar to drive the
  // Avatar III (orange-mark) flow. The user creates that avatar in HeyGen and
  // enters its exact name here. Empty string clears it.
  heygen_avatar_name: z.string().trim().max(200).nullable().optional(),
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

  // Validate the URL before touching the DB — pass-through of bad input
  // would surface as a yt-dlp failure deep in the render. We do this
  // before the supabase call so the user sees the error inline.
  if (parsed.data.intro_source_youtube_url) {
    const id = extractYoutubeId(parsed.data.intro_source_youtube_url);
    if (!id) {
      return NextResponse.json(
        { error: "intro_source_youtube_url is not a recognisable YouTube URL" },
        { status: 400 },
      );
    }
  }

  const sb = getServerSupabase();
  // If the patch includes a transcript and the project has no probed
  // voiceover duration yet, fill it from a word-count estimate so downstream
  // clip planning gets a real cap. A real Deepgram-probed duration always
  // takes precedence and is never overwritten here.
  const update: {
    title?: string;
    transcript?: string;
    voiceover_duration_seconds?: number;
    intro_source_youtube_url?: string | null;
    intro_source_start_seconds?: number | null;
    intro_duration_seconds?: number | null;
    heygen_avatar_name?: string | null;
  } = {
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

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const sb = getServerSupabase();

  // Delete the children EXPLICITLY, in dependency order, instead of leaning on
  // ON DELETE CASCADE from the parent row alone.
  //
  // Why: one `delete from projects` runs every child cleanup inside a SINGLE
  // statement, and each referential-integrity trigger fires once per child row
  // keyed on the REFERENCING column (timeline_items.synthetic_segment_id,
  // timeline_items.clip_id, timeline_items.source_job_id). For a synthetic
  // project that is thousands of tiny queries inside one statement, and the
  // whole thing dies on PostgREST's 8s statement_timeout — "canceling statement
  // due to statement timeout". Migration 0039 indexes those columns, which is
  // the actual fix; deleting bottom-up here additionally makes each statement a
  // single indexed project_id range delete with almost no cascade work left,
  // and gives each one its own timeout budget instead of sharing one.
  //
  // Order matters: rows that POINT AT other rows of this project go first.
  const childTables = [
    "timeline_items",        // -> video_clips, synthetic_segments, media_jobs
    "synthetic_segments",
    "video_clips",           // -> video_sources.id, projects.intro_clip_id
    "media_jobs",
    "render_jobs",
    "project_script_markers",
    "face_references",
    "youtube_search_results",
    "project_entities",
  ];
  for (const table of childTables) {
    const { error } = await sb.from(table).delete().eq("project_id", id);
    // Schema drift between environments (table absent) must not block the
    // delete — the parent cascade still covers whatever we could not reach.
    if (error && error.code !== "42P01") {
      return NextResponse.json({ error: `${table}: ${error.message}` }, { status: 500 });
    }
  }

  // video_sources is ON DELETE SET NULL (rows are deduped across projects), so
  // it is deliberately left to the FK.
  const { error } = await sb.from("projects").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob, logJob } from "@/lib/jobs/db";
import { enqueueMatch } from "@/lib/jobs/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Re-run the match step against the project's current clips. Used when an
// earlier match degraded — e.g. Gemini hit a 503 spike and every score
// silently fell back to "downgrade to image". We wipe the previous draft
// timeline so the new match isn't mixed in with stale rows.
//
// Safety: refuses to run if a match job is already queued or running so the
// user can't double-trigger and end up with two writers racing on
// timeline_items.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const sb = getServerSupabase();

  // Need clips to align — bail with a clear message if there are none.
  const { count: clipCount } = await sb
    .from("video_clips")
    .select("id", { count: "exact", head: true })
    .eq("project_id", id)
    .eq("status", "ready");
  if (!clipCount || clipCount === 0) {
    return NextResponse.json({ error: "no ready clips to match yet" }, { status: 400 });
  }

  const { data: openMatches } = await sb
    .from("media_jobs")
    .select("id")
    .eq("project_id", id)
    .eq("type", "match")
    .in("status", ["queued", "running"]);
  if ((openMatches ?? []).length > 0) {
    return NextResponse.json({ error: "a match job is already in progress" }, { status: 409 });
  }

  // Wipe previous draft timeline. Approved rows would be lost too, but match
  // resets `approved=false` anyway — so this is consistent with how the
  // initial match behaves.
  const { error: delErr } = await sb.from("timeline_items").delete().eq("project_id", id);
  if (delErr) {
    return NextResponse.json({ error: `clear timeline: ${delErr.message}` }, { status: 500 });
  }

  const newJobId = await createMediaJob({
    projectId: id,
    type: "match",
    metadata: { rematch: true },
  });
  await enqueueMatch({ projectId: id, mediaJobId: newJobId });

  await logJob({ projectId: id, jobId: newJobId }, "rematch.enqueued", { clipCount });
  return NextResponse.json({ ok: true, mediaJobId: newJobId });
}

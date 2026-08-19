import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { headObject, publicUrlForKey } from "@/lib/storage";
import { logJob } from "@/lib/jobs/db";
import { ensurePitchTimelineItem } from "@/lib/synthetic/pitch-timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Notify route for the synthetic "sales pitch" video. The browser has already
// PUT the file to R2 via the presigned URL; here we only verify the object
// landed and record its public URL + duration on the project. We never hold the
// bytes (the file is large), so duration is taken from the client-measured
// value (HTMLVideoElement.duration) rather than running ffprobe on Vercel —
// ffprobe isn't available in the web runtime, which is why the voiceover route
// likewise sources duration from its transcription provider instead.
//
// The render worker re-probes the real file when it downloads it, so a wrong or
// missing client duration only affects the planner's pre-render shift estimate,
// never the final cut's correctness.
const NotifySchema = z.object({
  storageKey: z.string().min(1).max(500),
  contentType: z.string().min(1).max(100).regex(/^video\//),
  filename: z.string().min(1).max(255).optional(),
  // Seconds, as read from the <video> element in the browser. Best-effort.
  durationSeconds: z.number().positive().max(60 * 60).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const parsed = NotifySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  const sb = getServerSupabase();
  const { data: project, error: projErr } = await sb
    .from("projects")
    .select("id, engine")
    .eq("id", id)
    .single();
  if (projErr || !project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  if (project.engine !== "synthetic") {
    return NextResponse.json({ error: "pitch video only applies to synthetic projects" }, { status: 400 });
  }

  // Lock the key to this project's prefix so callers can't claim arbitrary
  // objects as this project's pitch video.
  const expectedPrefix = `projects/${id}/pitch-video/`;
  if (!parsed.data.storageKey.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: "storageKey outside project prefix" }, { status: 400 });
  }

  // Confirm the upload actually landed.
  const head = await headObject(parsed.data.storageKey);
  if (!head) return NextResponse.json({ error: "uploaded object not found" }, { status: 404 });
  if (head.size <= 0) return NextResponse.json({ error: "uploaded object is empty" }, { status: 400 });

  const pitchUrl = publicUrlForKey(parsed.data.storageKey);
  const durationSeconds = parsed.data.durationSeconds != null
    ? Math.round(parsed.data.durationSeconds * 100) / 100
    : null;

  const { data, error } = await sb
    .from("projects")
    .update({
      pitch_video_url: pitchUrl,
      pitch_video_duration_seconds: durationSeconds,
    })
    .eq("id", id)
    .select("id, pitch_video_url, pitch_video_duration_seconds")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Place the pitch on the timeline NOW if the project already has one.
  //
  // ensurePitchTimelineItem otherwise only ever runs from maybeFinalizeSynthetic,
  // which fires on asset-job completion during generation and never again (no
  // reconcile sweep calls it). That is fine for the intended order — upload at
  // intake, then build — but the standalone generator (/sales-pitch, migration
  // 0029) produces a pitch mp4 the user uploads to a project that is typically
  // ALREADY generated and sitting at review. In that order nothing ever created
  // the timeline row, so the pitch silently never appeared in the render.
  //
  // Safe to call unconditionally: it is idempotent, and it no-ops when the
  // project has no segments materialised yet (the pre-generation case, where
  // finalize will place it later as before).
  try {
    await ensurePitchTimelineItem(id);
  } catch (e) {
    // Placement failure must not fail the upload — the file is stored and
    // recorded, and the next finalize (or a re-upload) will place it. Reported
    // so a pitch that never shows up in the render is diagnosable.
    await logJob({ projectId: id }, "synthetic.pitch_video.place_on_upload_failed", {
      err: e instanceof Error ? e.message : String(e),
    });
  }

  return NextResponse.json({ project: data, pitch_video_url: pitchUrl }, { status: 200 });
}

// Remove the pitch video from the project (the "Remove" button in intake).
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const sb = getServerSupabase();
  const { error } = await sb
    .from("projects")
    .update({ pitch_video_url: null, pitch_video_duration_seconds: null })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Drop the timeline row too. Clearing only the project columns left the
  // pitch_video row behind, and the renderer reads the ROW (it renders any
  // pitch_video row carrying a video_url) — so a "removed" pitch still played in
  // the finished video. ensurePitchTimelineItem cannot clean this up either: it
  // returns early when pitch_video_url is null, which is exactly the state
  // Remove leaves behind.
  const { error: rowErr } = await sb
    .from("timeline_items")
    .delete()
    .eq("project_id", id)
    .eq("type", "pitch_video");
  if (rowErr) return NextResponse.json({ error: rowErr.message }, { status: 500 });

  return NextResponse.json({ ok: true }, { status: 200 });
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob } from "@/lib/jobs/db";
import { enqueueRender } from "@/lib/jobs/queue";
import { estimateDurationSeconds } from "@/lib/ai/segments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Render-side validation tolerance — ±1s per the planner spec, but we allow a
// little slack for rounding noise across many blocks.
const DURATION_TOLERANCE_SECONDS = 1.5;

// Block types that consume timeline duration (overlays don't). The intro is
// rendered as a separate prefix segment by the renderer (see renderProcessor —
// it pulls intro_clip_id from the projects table directly), and the matcher
// inserts a UI-only intro row whose duration overlaps that prefix. Including
// it here would double-count the intro and push the timeline outside the
// ±1.5s tolerance, blocking the render with no clear feedback.
const DURATION_BEARING_TYPES = new Set([
  "footage",
  "image",
  "split_2",
  "split_4",
]);

const VALIDATION_FAILED_MSG =
  "Timeline duration must match voiceover and use unique clips.";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("render_jobs")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ render_jobs: data ?? [] });
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const sb = getServerSupabase();

  // Pull project for voiceover duration (drives the validation tolerance).
  const { data: project, error: projErr } = await sb
    .from("projects")
    .select("transcript, voiceover_duration_seconds")
    .eq("id", id)
    .single();
  if (projErr || !project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }
  const voiceoverSeconds =
    Number(project.voiceover_duration_seconds) ||
    estimateDurationSeconds(project.transcript ?? "") ||
    0;

  // Require approved timeline with at least some clips
  const { data: items, error: itemsErr } = await sb
    .from("timeline_items")
    .select("id, type, duration, approved, clip_id")
    .eq("project_id", id);
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  if (!items?.length) return NextResponse.json({ error: "timeline is empty" }, { status: 400 });

  const renderable = items.filter((it) => !!it.clip_id);
  if (renderable.length === 0) {
    return NextResponse.json({ error: "no clips on timeline" }, { status: 400 });
  }
  if (!renderable.every((it) => it.approved)) {
    return NextResponse.json({ error: "approve timeline before rendering" }, { status: 400 });
  }

  // ---- Dynamic-duration validation -------------------------------------
  // 1) Sum of duration-bearing blocks must be within tolerance of voiceover.
  // 2) No clip_id appears twice on the timeline.
  const durationBearing = items.filter((it) =>
    DURATION_BEARING_TYPES.has(String(it.type)),
  );
  const timelineDuration = durationBearing.reduce(
    (s, it) => s + (Number(it.duration) || 0),
    0,
  );
  const clipIds = renderable.map((it) => String(it.clip_id));
  const uniqueClipCount = new Set(clipIds).size;
  const hasDuplicateClips = uniqueClipCount !== clipIds.length;

  const durationDelta = voiceoverSeconds
    ? Math.abs(timelineDuration - voiceoverSeconds)
    : 0;
  const durationOutOfRange =
    voiceoverSeconds > 0 && durationDelta > DURATION_TOLERANCE_SECONDS;

  if (hasDuplicateClips || durationOutOfRange) {
    return NextResponse.json(
      {
        error: VALIDATION_FAILED_MSG,
        details: {
          timelineDuration: Math.round(timelineDuration * 10) / 10,
          voiceoverSeconds,
          tolerance: DURATION_TOLERANCE_SECONDS,
          durationDelta: Math.round(durationDelta * 10) / 10,
          duplicateClipCount: clipIds.length - uniqueClipCount,
        },
      },
      { status: 400 },
    );
  }

  // Refuse if a render is already running
  const { data: open } = await sb
    .from("render_jobs").select("id, status").eq("project_id", id)
    .in("status", ["queued", "running"]).limit(1);
  if ((open ?? []).length > 0) {
    return NextResponse.json({ error: "render already in progress" }, { status: 409 });
  }

  const { data: rj, error: rjErr } = await sb
    .from("render_jobs")
    .insert({ project_id: id, status: "queued", progress: 0 })
    .select("*").single();
  if (rjErr) return NextResponse.json({ error: rjErr.message }, { status: 500 });

  const mediaJobId = await createMediaJob({
    projectId: id, type: "render", metadata: { renderJobId: rj.id },
  });
  await enqueueRender({ projectId: id, mediaJobId, renderJobId: rj.id });

  return NextResponse.json({ render_job: rj, media_job_id: mediaJobId }, { status: 202 });
}

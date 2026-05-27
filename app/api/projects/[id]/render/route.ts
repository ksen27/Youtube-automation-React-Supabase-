import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { createMediaJob } from "@/lib/jobs/db";
import { enqueueRender } from "@/lib/jobs/queue";
import { estimateDurationSeconds } from "@/lib/ai/segments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Render-side validation tolerance. The concat pass uses ffmpeg's `-shortest`
// flag, so excess on either side is clipped: if the timeline is longer the
// tail plays silent, if the voiceover is longer its last words are cut off.
// ±3s is forgiving enough for operator-built timelines while still catching
// gross mismatches (e.g. wrong voiceover uploaded).
const DURATION_TOLERANCE_SECONDS = 3;

// Block types that consume timeline duration (overlays don't). Must stay in
// sync with renderProcessor.processItem — every type the renderer turns into
// a visible segment with non-zero duration belongs here. The intro is the
// one deliberate exclusion: it's rendered as a separate prefix segment
// (renderProcessor pulls intro_clip_id from the projects table) and plays
// the celebrity's source audio, not the voiceover. The matcher inserts a
// UI-only intro row whose duration overlaps that prefix, so including it
// here would double-count.
const DURATION_BEARING_TYPES = new Set([
  "footage",
  "image",
  "split_2",
  "split_4",
  "title_card",
]);

const VALIDATION_FAILED_MSG =
  "Timeline duration must match voiceover.";

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
  // intro_duration_seconds is the prefix segment the renderer plays with the
  // celebrity's source audio before the voiceover starts; the duration-bearing
  // timeline rows are planned to cover (voiceover − intro), so we subtract
  // the intro here for the same reason DURATION_BEARING_TYPES excludes it.
  const { data: project, error: projErr } = await sb
    .from("projects")
    .select("transcript, voiceover_duration_seconds, intro_duration_seconds")
    .eq("id", id)
    .single();
  if (projErr || !project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }
  const rawVoiceoverSeconds =
    Number(project.voiceover_duration_seconds) ||
    estimateDurationSeconds(project.transcript ?? "") ||
    0;
  const introSeconds = Math.max(0, Number(project.intro_duration_seconds) || 0);
  const voiceoverSeconds = Math.max(0, rawVoiceoverSeconds - introSeconds);

  // Require approved timeline with at least some clips. We also pull
  // metadata so forced doc clips (metadata.forced_clip.youtube_url) are
  // approve-able without clip_id and are excluded from the voiceover-
  // duration comparison below.
  const { data: items, error: itemsErr } = await sb
    .from("timeline_items")
    .select("id, type, duration, approved, clip_id, metadata")
    .eq("project_id", id);
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  if (!items?.length) return NextResponse.json({ error: "timeline is empty" }, { status: 400 });

  function isForcedClip(it: { type: string; metadata: unknown }): boolean {
    if (it.type !== "footage") return false;
    const meta = (it.metadata ?? {}) as Record<string, unknown>;
    const fc = meta.forced_clip as { youtube_url?: unknown } | undefined;
    return !!fc?.youtube_url;
  }

  const renderable = items.filter((it) => !!it.clip_id || isForcedClip(it as { type: string; metadata: unknown }));
  if (renderable.length === 0) {
    return NextResponse.json({ error: "no clips on timeline" }, { status: 400 });
  }
  if (!renderable.every((it) => it.approved)) {
    return NextResponse.json({ error: "approve timeline before rendering" }, { status: 400 });
  }

  // ---- Dynamic-duration validation -------------------------------------
  // Sum of duration-bearing blocks must be within tolerance of voiceover.
  // Per user direction (2026-05-27): forced doc clips now play SILENT under
  // a continuing narrator voiceover (the mid-timeline audio splice is
  // disabled in renderProcessor), so they consume voiceover time like any
  // other footage row and MUST be included in this sum. Without this, the
  // validator under-counts by the forced-clip total and reports a false
  // "Timeline duration must match voiceover" error even when the actual
  // timeline matches the voiceover exactly.
  // Duplicate clip_ids are permitted — the same source clip may legitimately
  // appear on the timeline more than once.
  const durationBearing = items.filter((it) =>
    DURATION_BEARING_TYPES.has(String(it.type)),
  );
  const timelineDuration = durationBearing.reduce(
    (s, it) => s + (Number(it.duration) || 0),
    0,
  );

  const durationDelta = voiceoverSeconds
    ? Math.abs(timelineDuration - voiceoverSeconds)
    : 0;
  const durationOutOfRange =
    voiceoverSeconds > 0 && durationDelta > DURATION_TOLERANCE_SECONDS;

  if (durationOutOfRange) {
    return NextResponse.json(
      {
        error: VALIDATION_FAILED_MSG,
        details: {
          timelineDuration: Math.round(timelineDuration * 10) / 10,
          voiceoverSeconds,
          tolerance: DURATION_TOLERANCE_SECONDS,
          durationDelta: Math.round(durationDelta * 10) / 10,
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

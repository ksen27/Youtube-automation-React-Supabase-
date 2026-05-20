import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { estimateDurationSeconds } from "@/lib/ai/segments";
import { extractDocumentId, fetchGoogleDoc, GoogleDocsFetchError } from "@/lib/gdocs/fetch";
import { parseScriptDoc, type ScriptMarker } from "@/lib/gdocs/parse";
import { createMediaJob, logJob } from "@/lib/jobs/db";
import { enqueueScriptClip } from "@/lib/jobs/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  // Accepts a full Google Docs URL or a bare document ID.
  doc: z.string().min(5).max(2000),
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

  const documentId = extractDocumentId(parsed.data.doc);
  if (!documentId) {
    return NextResponse.json(
      { error: "Could not extract a Google Doc ID from the provided URL." },
      { status: 400 },
    );
  }

  let parsedScript;
  try {
    const doc = await fetchGoogleDoc(documentId);
    parsedScript = parseScriptDoc(doc);
  } catch (err) {
    if (err instanceof GoogleDocsFetchError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "failed to read Google Doc";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (!parsedScript.transcript) {
    return NextResponse.json(
      { error: "The doc parsed but contained no script text — check the doc isn't empty." },
      { status: 400 },
    );
  }

  const sb = getServerSupabase();

  // Build the projects update. Intro fields are populated when the doc had
  // a leading title+timestamp+url block; otherwise we leave them null so
  // the existing intro auto-pick can still run (it just won't have a
  // user-supplied source).
  const updates: Record<string, unknown> = { transcript: parsedScript.transcript };

  // Estimate duration from word count if the project has no probed audio
  // yet — the existing /transcript route did the same so the clip cap
  // downstream isn't floored to MIN_CLIP_CAP.
  const { data: existing } = await sb
    .from("projects")
    .select("voiceover_duration_seconds")
    .eq("id", id)
    .single();
  const hasProbedDuration = existing && Number(existing.voiceover_duration_seconds) > 0;
  if (!hasProbedDuration) {
    const est = estimateDurationSeconds(parsedScript.transcript);
    if (est > 0) updates.voiceover_duration_seconds = est;
  }

  // Always null the legacy single-intro columns — new ingests express
  // intros as a list of project_script_markers (kind='intro_card') so
  // multi-clip pre-rolls work. The renderer reads from markers first and
  // only falls back to projects.intro_source_* for old projects that
  // haven't been re-ingested. Clearing here makes the source of truth
  // unambiguous: if any intro_card markers exist for this project, those
  // are what the renderer plays.
  updates.intro_source_youtube_url = null;
  updates.intro_source_start_seconds = null;
  updates.intro_duration_seconds = null;

  // Mark the project as having received a Google Doc ingest. The workspace
  // uses this together with voiceover_url to gate the move from intake to
  // analyze — without this column an audio-only project advanced as soon
  // as Deepgram filled in transcript, letting the user skip the doc.
  updates.script_doc_ingested_at = new Date().toISOString();

  const { data: project, error: projErr } = await sb
    .from("projects")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });

  // Wipe and re-write the marker table for this project. Re-running the
  // script-doc ingest replaces the previous markers — and BullMQ jobs
  // referencing the deleted markerIds will no-op when the processor's
  // load step finds them missing.
  await sb.from("project_script_markers").delete().eq("project_id", id);

  const markerRows = [
    ...parsedScript.introCards.map(markerToRow.bind(null, id)),
    ...parsedScript.titleCards.map(markerToRow.bind(null, id)),
    ...parsedScript.lowerThirds.map(markerToRow.bind(null, id)),
  ];
  let insertedMarkers: Array<{ id: string; kind: string; youtube_url: string | null; ordinal: number }> = [];
  if (markerRows.length > 0) {
    const { data: inserted, error: markersErr } = await sb
      .from("project_script_markers")
      .insert(markerRows)
      .select("id, kind, youtube_url, ordinal");
    if (markersErr) {
      return NextResponse.json({ error: markersErr.message }, { status: 500 });
    }
    insertedMarkers = (inserted ?? []) as typeof insertedMarkers;
  }

  // Dispatch one script_clip job per marker that has a YouTube URL. The
  // worker handles the download/cut/upload and writes the result back onto
  // the marker row. We do this here (synchronously dispatching, asynchronously
  // processing) instead of waiting in the request because some docs have 10+
  // clips that would blow past the request timeout.
  let jobsEnqueued = 0;
  for (const m of insertedMarkers) {
    if (!m.youtube_url) continue;
    try {
      const mediaJobId = await createMediaJob({
        projectId: id,
        type: "script_clip",
        metadata: { markerId: m.id, kind: m.kind, ordinal: m.ordinal },
      });
      await enqueueScriptClip({ projectId: id, mediaJobId, markerId: m.id });
      jobsEnqueued++;
    } catch (e) {
      // A queue-side failure here means the marker stays at 'pending' —
      // the UI's retry button can recover it. We don't fail the whole
      // ingest because the markers themselves are persisted.
      await logJob({ projectId: id }, "script_doc.enqueue_failed", {
        markerId: m.id,
        kind: m.kind,
        err: (e as Error).message,
      });
    }
  }

  return NextResponse.json({
    project,
    introCards: parsedScript.introCards,
    titleCards: parsedScript.titleCards,
    lowerThirds: parsedScript.lowerThirds,
    jobsEnqueued,
  });
}

function markerToRow(projectId: string, m: ScriptMarker) {
  return {
    project_id: projectId,
    kind: m.kind,
    text: m.text,
    ordinal: m.ordinal,
    paragraph_index: m.paragraphIndex ?? null,
    char_offset: m.charOffset ?? null,
    youtube_url: m.youtubeUrl ?? null,
    start_seconds: m.startSeconds ?? null,
    end_seconds: m.endSeconds ?? null,
  };
}

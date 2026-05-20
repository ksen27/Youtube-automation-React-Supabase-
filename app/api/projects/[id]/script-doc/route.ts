import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { estimateDurationSeconds } from "@/lib/ai/segments";
import { extractDocumentId, fetchGoogleDoc, GoogleDocsFetchError } from "@/lib/gdocs/fetch";
import { parseScriptDoc, type ScriptMarker } from "@/lib/gdocs/parse";

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

  if (parsedScript.intro && parsedScript.intro.youtubeUrl) {
    updates.intro_source_youtube_url = parsedScript.intro.youtubeUrl;
    updates.intro_source_start_seconds = parsedScript.intro.startSeconds ?? 0;
    const introDuration =
      parsedScript.intro.endSeconds != null && parsedScript.intro.startSeconds != null
        ? Math.max(1, parsedScript.intro.endSeconds - parsedScript.intro.startSeconds)
        : 6;
    updates.intro_duration_seconds = introDuration;
  } else {
    // Doc didn't have a leading title block — clear any prior intro so the
    // user doesn't get a stale value from a previous upload.
    updates.intro_source_youtube_url = null;
    updates.intro_source_start_seconds = null;
    updates.intro_duration_seconds = null;
  }

  const { data: project, error: projErr } = await sb
    .from("projects")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });

  // Wipe and re-write the marker table for this project. Re-running the
  // script-doc ingest replaces the previous markers.
  await sb.from("project_script_markers").delete().eq("project_id", id);

  const markerRows = [
    ...parsedScript.titleCards.map(markerToRow.bind(null, id)),
    ...parsedScript.lowerThirds.map(markerToRow.bind(null, id)),
  ];
  if (markerRows.length > 0) {
    const { error: markersErr } = await sb.from("project_script_markers").insert(markerRows);
    if (markersErr) {
      return NextResponse.json({ error: markersErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    project,
    intro: parsedScript.intro,
    titleCards: parsedScript.titleCards,
    lowerThirds: parsedScript.lowerThirds,
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

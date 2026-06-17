import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { checkProjectEngine, logJob } from "@/lib/jobs/db";
import { estimateDurationSeconds } from "@/lib/ai/segments";
import { fetchAndExtractAvatarDoc } from "@/lib/synthetic/doc-marks";
import { GoogleDocsFetchError } from "@/lib/gdocs/fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// AI-Avatar Google-Doc ingest. Fetches the doc, extracts the plain transcript
// plus the RED/ORANGE char-ranges (avatar marks), and stores both on the
// project. Synthetic engine only — celebrity docs use /script-doc.
const Body = z.object({
  doc: z.string().min(5).max(2000), // Google Doc URL or bare id
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const eng = await checkProjectEngine(id, "synthetic");
  if (!eng.ok) {
    return eng.status === 404
      ? NextResponse.json({ error: "project not found" }, { status: 404 })
      : NextResponse.json({ error: "not an AI Avatar (synthetic) project" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  let extracted;
  try {
    extracted = await fetchAndExtractAvatarDoc(parsed.data.doc);
  } catch (err) {
    if (err instanceof GoogleDocsFetchError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const sb = getServerSupabase();
  // Estimate duration from the transcript so the planner has a cap before the
  // real Deepgram duration lands (TTS path). A real probed duration always
  // wins later and is never overwritten here.
  const { data: existing } = await sb
    .from("projects").select("voiceover_duration_seconds").eq("id", id).single();
  const update: Record<string, unknown> = {
    transcript: extracted.transcript,
    avatar_mark_ranges: extracted.avatarRanges,
    script_doc_url: parsed.data.doc,
  };
  if (!(existing && Number(existing.voiceover_duration_seconds) > 0)) {
    const est = estimateDurationSeconds(extracted.transcript);
    if (est > 0) update.voiceover_duration_seconds = est;
  }

  const { data, error } = await sb
    .from("projects").update(update).eq("id", id)
    .select("id, transcript, avatar_mark_ranges, script_doc_url").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logJob({ projectId: id }, "synthetic.script_doc.ingested", {
    chars: extracted.transcript.length,
    avatarRanges: extracted.avatarRanges.length,
  });
  return NextResponse.json({
    project: data,
    transcript: extracted.transcript,
    avatar_ranges: extracted.avatarRanges,
  });
}

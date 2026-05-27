import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { logJob } from "@/lib/jobs/db";
import { extractYoutubeVideoId } from "@/lib/youtube/url";
import {
  fetchYoutubeVideoMeta,
  rankCandidate,
  loadChannelRules,
} from "@/lib/youtube/search";
import { verifyPoolAsset } from "@/lib/ai/pool-verification";
import { classifySourceType } from "@/lib/youtube/source-type";
import { getEnv } from "@/lib/env";

// Manually add a YouTube URL to a specific segment's candidate pool.
//
// The user pastes a link in the analyze picker; this endpoint:
//   1. Parses the videoId out of the URL.
//   2. Hydrates the video's metadata via YouTube videos.list.
//   3. Runs the same rankCandidate + verifyPoolAsset filters the AI
//      search uses, per the client's "Run full filters" choice — even
//      a user-pasted URL goes through quality gates so we don't end up
//      with a known-bad video in the pool just because someone pasted
//      it.
//   4. On accept, persists the row to youtube_search_results and
//      patches the saved analyze payload's segment.candidates array.
//   5. On reject (Shorts / wrong-person face-verify / etc.), returns
//      the reason so the UI can show "this URL didn't pass quality
//      checks" instead of silently dropping it.
//
// Rejection returns 200 with `{ accepted: false, reason }` — not a 4xx
// — because the URL itself is valid; only its content failed the
// ranker. The picker UI can decide whether to surface the reason as
// a warning toast or refuse-with-explanation.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UuidSchema = z.string().uuid();

const BodySchema = z.object({
  videoUrl: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const parsedBody = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "invalid body", issues: parsedBody.error.flatten() }, { status: 400 });
  }
  const { videoUrl, segmentIndex } = parsedBody.data;
  const videoId = extractYoutubeVideoId(videoUrl);
  if (!videoId) {
    return NextResponse.json({ accepted: false, reason: "not a valid YouTube URL" });
  }

  const sb = getServerSupabase();
  // Load the most recent analyze job so we can append the new candidate
  // to its saved payload AND make sure the segment index is valid.
  const { data: latest } = await sb
    .from("media_jobs")
    .select("id, metadata")
    .eq("project_id", id)
    .eq("type", "analyze")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) {
    return NextResponse.json({ error: "run analyze first" }, { status: 409 });
  }
  const mediaJobId = latest.id as string;
  const meta = (latest.metadata ?? {}) as Record<string, unknown>;
  const payload = (meta.payload ?? null) as null | {
    segments: Array<{
      index: number;
      understanding: {
        mainTopic?: string;
        people?: string[];
        places?: string[];
        events?: string[];
        relatedKeywords?: string[];
        segmentSubject?: string;
        segmentTopic?: string;
        inheritedSubject?: boolean;
      };
      candidates: Array<Record<string, unknown>>;
      plan: { generatedClips: number; requiredClips: number };
    }>;
  };
  if (!payload) {
    return NextResponse.json({ error: "no analyze payload to amend" }, { status: 409 });
  }
  const segment = payload.segments.find((s) => s.index === segmentIndex);
  if (!segment) {
    return NextResponse.json({ error: `segment ${segmentIndex} not found` }, { status: 400 });
  }
  // Already in this segment? Refuse to add a duplicate; the user is
  // probably re-pasting a URL they already have.
  if (segment.candidates.some((c) => (c as { videoId?: string }).videoId === videoId)) {
    return NextResponse.json({ accepted: false, reason: "already in this segment's pool" });
  }

  let cand: Awaited<ReturnType<typeof fetchYoutubeVideoMeta>>;
  try {
    cand = await fetchYoutubeVideoMeta(videoId);
  } catch (e) {
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.add_source.meta_failed", {
      videoId, err: (e as Error).message?.slice(0, 200),
    });
    return NextResponse.json({ accepted: false, reason: "YouTube metadata fetch failed" });
  }
  if (!cand) {
    return NextResponse.json({ accepted: false, reason: "video unavailable (private / deleted / region-blocked)" });
  }

  // Run the ranker with the same inputs analyze used. We pull the
  // project's main celebrity + context terms from the existing entity
  // rows so the score reflects the same per-segment signal the AI's
  // automatic picks had.
  const u = segment.understanding ?? {};
  const segmentEntities = Array.from(new Set([
    ...(u.people ?? []),
    ...(u.places ?? []),
    ...(u.events ?? []),
  ].filter(Boolean)));

  // Look up celebrity + aliases + context terms from project_entities,
  // matching the analyze pipeline's behaviour.
  const { data: entRows } = await sb
    .from("project_entities")
    .select("type, value")
    .eq("project_id", id);
  const celebrityFromEnts = (entRows ?? []).find((r) => r.type === "celebrity")?.value as string | undefined;
  const mainCelebrity = celebrityFromEnts ?? (u.segmentSubject || undefined);
  const subjectAliases = mainCelebrity ? [mainCelebrity] : [];
  const contextTerms = (entRows ?? [])
    .filter((r) => r.type === "company")
    .map((r) => String(r.value))
    .slice(0, 10);

  const { approved, blocked } = await loadChannelRules();
  const env = getEnv();

  const ranked = rankCandidate({
    candidate: cand,
    mainCelebrity,
    aliases: subjectAliases,
    contextTerms,
    segmentEntities,
    segmentTopic: u.segmentTopic || u.mainTopic || "",
    matchedQuery: videoUrl,
    inheritedSegment: u.inheritedSubject ?? false,
    keywords: u.relatedKeywords ?? [],
    approvedChannelIds: approved,
    blockedChannelIds: blocked,
    intentType: "talking_head",
  });
  if (ranked.rejected) {
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.add_source.rejected", {
      videoId, reason: ranked.rejectReason, reasons: ranked.reasons,
    });
    return NextResponse.json({
      accepted: false,
      reason: ranked.rejectReason ?? "did not pass ranker",
      reasons: ranked.reasons,
    });
  }

  // Face / body verify — gated by the analyze flag like the AI search.
  if (env.ANALYZE_FACE_VERIFY_ENABLED && mainCelebrity) {
    const thumb = `https://i.ytimg.com/vi/${cand.videoId}/mqdefault.jpg`;
    let thumbVerdict;
    try {
      thumbVerdict = await verifyPoolAsset({
        projectId: id,
        entityType: "person",
        entityName: mainCelebrity,
        candidateUrl: thumb,
      });
    } catch (e) {
      await logJob({ projectId: id, jobId: mediaJobId }, "analyze.add_source.verify_failed", {
        videoId, err: (e as Error).message?.slice(0, 200),
      });
      thumbVerdict = null;
    }
    if (thumbVerdict?.verdict === "no") {
      await logJob({ projectId: id, jobId: mediaJobId }, "analyze.add_source.verify_rejected", {
        videoId, verdict: thumbVerdict.verdict, reason: thumbVerdict.reason?.slice(0, 200),
      });
      return NextResponse.json({
        accepted: false,
        reason: `face verify says the celebrity is not in the thumbnail: ${thumbVerdict.reason?.slice(0, 120) ?? ""}`,
      });
    }
  }

  // Accepted. Build the candidate row in the same shape the analyze
  // route persists.
  const thumbnailUrl = `https://i.ytimg.com/vi/${cand.videoId}/mqdefault.jpg`;
  const sourceType = classifySourceType({
    channelTitle: cand.channelTitle,
    videoTitle: cand.title,
  });
  const newCandidate = {
    videoId: cand.videoId,
    url: cand.url,
    title: cand.title,
    channelTitle: cand.channelTitle,
    durationSeconds: cand.durationSeconds,
    thumbnailUrl,
    score: ranked.score,
    displayScore: ranked.displayScore,
    reasons: [...ranked.reasons, "user-added"],
    rejected: false,
    matched_query: videoUrl,
    intended_subject: mainCelebrity ?? null,
    source_intent: "person" as const,
    source_type: sourceType,
  };

  // Persist to youtube_search_results — same row shape as the analyze
  // route. Upsert on (project_id, youtube_video_id) so re-adding the
  // same URL doesn't error on the unique index.
  const dbRow = {
    project_id: id,
    youtube_video_id: cand.videoId,
    url: cand.url,
    title: cand.title,
    description: cand.description,
    channel_id: cand.channelId,
    channel_title: cand.channelTitle,
    duration_seconds: cand.durationSeconds,
    score: ranked.score,
    status: "candidate" as const,
    metadata: {
      segment_index: segmentIndex,
      thumbnail_url: thumbnailUrl,
      reasons: newCandidate.reasons,
      display_score: ranked.displayScore,
      matched_query: videoUrl,
      intended_subject: mainCelebrity ?? null,
      source_intent: "person",
      source_type: sourceType,
      user_added: true,
    },
  };
  // Plain insert — youtube_search_results has no unique constraint on
  // (project_id, youtube_video_id), so we can't upsert against it. The
  // duplicate-in-segment check above already guards against pasting the
  // same URL twice into the same segment; pasting the same URL into a
  // DIFFERENT segment legitimately produces a second row (each row is
  // scoped to a segment_index via metadata).
  const { error: insErr } = await sb
    .from("youtube_search_results")
    .insert(dbRow);
  if (insErr) {
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.add_source.save_failed", {
      videoId, err: insErr.message,
    });
    return NextResponse.json({ error: "could not persist candidate" }, { status: 500 });
  }

  // Patch the saved payload so a refresh sees the new candidate
  // without re-running analyze.
  segment.candidates.push(newCandidate as unknown as Record<string, unknown>);
  segment.plan.generatedClips = segment.candidates.length;
  const newMetadata = { ...meta, payload };
  const { error: mdErr } = await sb
    .from("media_jobs")
    .update({ metadata: newMetadata })
    .eq("id", mediaJobId);
  if (mdErr) {
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.add_source.payload_save_failed", {
      videoId, err: mdErr.message,
    });
    // Non-fatal: the row is in youtube_search_results, just the saved
    // payload didn't update. A re-render will pick it up via the row.
  }

  await logJob({ projectId: id, jobId: mediaJobId }, "analyze.add_source.accepted", {
    videoId, segment: segmentIndex, score: ranked.score,
  });
  return NextResponse.json({ accepted: true, candidate: newCandidate });
}

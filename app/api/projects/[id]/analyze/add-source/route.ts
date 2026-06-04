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

// Accepts EITHER an entityValue (entity-driven payloads — the primary path) OR
// a segmentIndex (legacy per-segment payloads). Exactly one is required.
const BodySchema = z.object({
  videoUrl: z.string().min(1),
  entityValue: z.string().min(1).optional(),
  segmentIndex: z.number().int().nonnegative().optional(),
  // When true, skip the ranker + face-verify gates and add the video as-is.
  // Used by the in-app YouTube search picker: the user explicitly chose the
  // thumbnail, so their pick wins over the automated quality filters. The
  // candidate is still hydrated (so we have real metadata) and deduped.
  skipFilters: z.boolean().optional(),
}).refine((b) => b.entityValue != null || b.segmentIndex != null, {
  message: "entityValue or segmentIndex required",
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
  const { videoUrl, segmentIndex, entityValue, skipFilters } = parsedBody.data;
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
    entities?: Array<{
      value: string;
      type: string;
      target: number;
      candidates: Array<Record<string, unknown>>;
    }>;
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

  // Locate the target pool. Entity-driven payloads amend payload.entities[];
  // legacy payloads amend payload.segments[]. We resolve `segment` (the
  // understanding source for the ranker) and `targetPool` (where the new
  // candidate is appended) up front so the rest of the handler is path-agnostic.
  const entityGroup = entityValue
    ? (payload.entities ?? []).find((e) => e.value.toLowerCase() === entityValue.toLowerCase())
    : undefined;
  const segment = entityValue
    ? undefined
    : payload.segments.find((s) => s.index === segmentIndex);
  if (entityValue && !entityGroup) {
    return NextResponse.json({ error: `entity "${entityValue}" not found` }, { status: 400 });
  }
  if (!entityValue && !segment) {
    return NextResponse.json({ error: `segment ${segmentIndex} not found` }, { status: 400 });
  }
  const targetPool = (entityGroup?.candidates ?? segment!.candidates) as Array<Record<string, unknown>>;
  // Already in this pool? Refuse a duplicate (user re-pasting a known URL).
  if (targetPool.some((c) => (c as { videoId?: string }).videoId === videoId)) {
    return NextResponse.json({ accepted: false, reason: "already in this pool" });
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

  // Run the ranker with the same inputs analyze used. The subject differs by
  // path: entity-driven payloads rank against the entity the user is adding to;
  // legacy segment payloads rank against the project celebrity + segment
  // understanding.
  const u = segment?.understanding ?? {};

  // Look up celebrity + aliases + context terms from project_entities,
  // matching the analyze pipeline's behaviour.
  const { data: entRows } = await sb
    .from("project_entities")
    .select("type, value")
    .eq("project_id", id);
  const celebrityFromEnts = (entRows ?? []).find((r) => r.type === "celebrity")?.value as string | undefined;
  const projectCompanies = (entRows ?? [])
    .filter((r) => r.type === "company")
    .map((r) => String(r.value))
    .slice(0, 10);

  // Subject = the entity (entity path) or the project celebrity (legacy path).
  const mainCelebrity = entityGroup?.value ?? celebrityFromEnts ?? (u.segmentSubject || undefined);
  const subjectAliases = mainCelebrity ? [mainCelebrity] : [];
  // Context/segment anchors only apply on the legacy segment path; the entity
  // path is a clean "footage of this person" search with no segment context.
  const contextTerms = entityGroup ? [] : projectCompanies;
  const segmentEntities = entityGroup
    ? []
    : Array.from(new Set([
        ...(u.people ?? []),
        ...(u.places ?? []),
        ...(u.events ?? []),
      ].filter(Boolean)));

  const { approved, blocked } = await loadChannelRules();
  const env = getEnv();

  const ranked = rankCandidate({
    candidate: cand,
    mainCelebrity,
    aliases: subjectAliases,
    contextTerms,
    segmentEntities,
    segmentTopic: entityGroup ? "" : (u.segmentTopic || u.mainTopic || ""),
    matchedQuery: videoUrl,
    inheritedSegment: entityGroup ? false : (u.inheritedSubject ?? false),
    keywords: entityGroup ? [] : (u.relatedKeywords ?? []),
    approvedChannelIds: approved,
    blockedChannelIds: blocked,
    intentType: "talking_head",
  });
  // Quality gates are skipped for explicit manual picks (the in-app YouTube
  // search picker). The user chose this thumbnail; their choice overrides the
  // ranker/face-verify. We still hydrated real metadata above, so the row is
  // well-formed. A score of 0 from the ranker is fine — it just sorts low.
  if (ranked.rejected && !skipFilters) {
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.add_source.rejected", {
      videoId, reason: ranked.rejectReason, reasons: ranked.reasons,
    });
    return NextResponse.json({
      accepted: false,
      reason: ranked.rejectReason ?? "did not pass ranker",
      reasons: ranked.reasons,
    });
  }

  // Face / body verify — gated by the analyze flag like the AI search. Skipped
  // for manual picks.
  if (!skipFilters && env.ANALYZE_FACE_VERIFY_ENABLED && mainCelebrity) {
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
    // Entity-path candidates carry the same provenance the AI search emits so
    // the UI badges + confirm-sources approval recording work identically.
    ...(entityGroup
      ? { entity_value: entityGroup.value, entity_type: entityGroup.type, from_reference_channel: false, from_approved: false }
      : {}),
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
      segment_index: entityGroup ? null : segmentIndex,
      entity_value: entityGroup?.value ?? null,
      entity_type: entityGroup?.type ?? null,
      from_reference_channel: false,
      from_approved: false,
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

  // Patch the saved payload so a refresh sees the new candidate without
  // re-running analyze. Push into whichever pool we resolved (entity or
  // segment); update the segment plan counter only on the legacy path.
  targetPool.push(newCandidate as unknown as Record<string, unknown>);
  if (segment) segment.plan.generatedClips = segment.candidates.length;
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

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { setProjectStatus, createMediaJob, setMediaJob, logJob } from "@/lib/jobs/db";
import {
  splitTranscriptIntoSegments,
  estimateDurationSeconds,
  analyzeSegment,
  findPersonRunsAcrossSegments,
  SECONDARY_PERSON_CLIP_THRESHOLD,
  type SegmentUnderstanding,
} from "@/lib/ai/segments";
import { planTimeline } from "@/lib/ai/timeline-plan";
import {
  rankCandidate,
  loadChannelRules,
  loadReferenceChannels,
  searchYoutubeCached,
  loadApprovedSourceVideos,
  hydrateVideoIds,
  type IntentType,
} from "@/lib/youtube/search";
import { extractEntities, extractProjectContext, buildSearchQueries, type ExtractedEntity } from "@/lib/ai/gemini";
import {
  buildReferenceRoster,
  type ReferenceEntity,
  type ReferenceEntityType,
} from "@/lib/ai/face-references";
import { verifyPoolAsset } from "@/lib/ai/pool-verification";
import { getEnv, computeSourceVideoTarget } from "@/lib/env";
import { classifySourceType } from "@/lib/youtube/source-type";

// Synchronous "Analyze & Search" — does Gemini segmentation/understanding plus
// a YouTube preview search. No FFmpeg, no yt-dlp, no downloads. The user
// confirms the resulting candidates via /confirm-sources before any heavy work.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UuidSchema = z.string().uuid();
const PER_INTENT_RESULTS = 6;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const sb = getServerSupabase();
  const { data: latest } = await sb
    .from("media_jobs")
    .select("id, status, progress, error, metadata, created_at")
    .eq("project_id", id)
    .eq("type", "analyze")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return NextResponse.json({ analyze: null, payload: null, selectedVideoIds: null });
  // The full AnalyzeResponse is persisted in metadata.payload by the POST
  // handler so the workspace can re-render saved results without re-running
  // Gemini + YouTube search on every navigation.
  //
  // selectedVideoIds is the user's last-saved picker selection — persisted
  // by the PUT handler below as the user toggles cards. Returning it here
  // lets the analyze screen restore exactly what was checked when the user
  // last looked at this project, instead of falling back to "top 5 of
  // every segment" (which silently overwrote the user's actual choice
  // every time they navigated away and back).
  const md = (latest.metadata ?? {}) as Record<string, unknown>;
  const payload = (md.payload ?? null) as unknown;
  const selectedVideoIds = Array.isArray(md.selectedVideoIds)
    ? (md.selectedVideoIds as unknown[]).filter((v): v is string => typeof v === "string")
    : null;
  return NextResponse.json({ analyze: latest, payload, selectedVideoIds });
}

// Persist the user's current source-video selection set so re-visiting
// the analyze screen restores the exact cards they last had checked.
// We write to media_jobs.metadata.selectedVideoIds (sibling of .payload)
// to avoid a schema migration — the analyze job row is the natural home
// for everything related to that run's pick state.
//
// The frontend debounces this call so a burst of rapid toggles produces
// at most one write every ~500ms. We don't validate the IDs against the
// payload here — a stale ID that's no longer in the candidates list is
// harmless (it just won't render checked), and validating would add
// complexity for no real safety benefit (the confirm-sources endpoint
// already re-validates against youtube_search_results before queueing
// downloads).
const PutBodySchema = z.object({
  selectedVideoIds: z.array(z.string()).max(500),
});

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const parsed = PutBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.flatten() }, { status: 400 });
  }
  const sb = getServerSupabase();
  const { data: latest } = await sb
    .from("media_jobs")
    .select("id, metadata")
    .eq("project_id", id)
    .eq("type", "analyze")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) {
    return NextResponse.json({ error: "no analyze job to save against" }, { status: 409 });
  }
  const md = (latest.metadata ?? {}) as Record<string, unknown>;
  const next = { ...md, selectedVideoIds: parsed.data.selectedVideoIds };
  const { error } = await sb
    .from("media_jobs")
    .update({ metadata: next })
    .eq("id", latest.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, count: parsed.data.selectedVideoIds.length });
}

interface PreviewCandidate {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  durationSeconds: number;
  thumbnailUrl: string;
  score: number;          // raw score
  displayScore: number;   // 0–100 normalized for the UI bar
  reasons: string[];
  rejected: boolean;
  rejectReason?: string;
  // Phase B: provenance — drives the matcher's +50 person-first bonus.
  // Tracks which search query found this candidate and who/what it was
  // about. Same shape as the standalone searchProcessor's metadata.
  matched_query: string;
  intended_subject: string | null;
  source_intent: "person" | "broll" | "archival" | "generic";
  // Editorial bucket for the picker UI. Lets the user spot at a glance
  // when too many redundant news-style sources are showing up for the
  // same story. See lib/youtube/source-type.ts for the heuristic.
  source_type: "interview" | "news" | "archival" | "other";
}

interface SegmentAnalysis {
  index: number;
  startSeconds: number;
  endSeconds: number;
  wordCount: number;
  textPreview: string;
  understanding: SegmentUnderstanding;
  candidates: PreviewCandidate[];
  plan: {
    durationSeconds: number;
    blockCount: number;
    footageNeeded: number;
    imagesNeeded: number;
    generatedClips: number;     // unique candidates currently selected for preview
    requiredClips: number;      // == footageNeeded
  };
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const sb = getServerSupabase();
  const { data: project, error: projErr } = await sb
    .from("projects").select("id, transcript, status, voiceover_duration_seconds").eq("id", id).single();
  if (projErr || !project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const transcript = (project.transcript ?? "").trim();
  if (!transcript) {
    return NextResponse.json({ error: "transcript required before analysis" }, { status: 400 });
  }

  // Block if downstream pipeline already running.
  const { data: openJobs } = await sb
    .from("media_jobs")
    .select("id")
    .eq("project_id", id)
    .in("type", ["search", "download", "clip", "match", "render"])
    .in("status", ["queued", "running"])
    .limit(1);
  if ((openJobs ?? []).length > 0) {
    return NextResponse.json({ error: "generation already in progress" }, { status: 409 });
  }

  // Reset prior preview state — re-running analyze should produce a clean view.
  await sb.from("youtube_search_results").delete().eq("project_id", id);
  await sb.from("project_entities").delete().eq("project_id", id);

  const mediaJobId = await createMediaJob({ projectId: id, type: "analyze" });
  await setMediaJob(mediaJobId, { status: "running", progress: 5 });
  await setProjectStatus(id, "extracting");

  try {
    // Load any script-doc title_card markers up-front. When present, their
    // text doubles as topic boundaries for the transcript splitter — the
    // analyzer cuts a new segment at each title so each Gemini analysis
    // call sees a focused chapter ("the lawsuit", "the wedding") instead
    // of an arbitrary 5-minute slice that may span two unrelated topics.
    // This also keeps the matcher's first-block-of-segment title_card
    // promotion aligned with the actual blue-bold title positions in the
    // source doc. Falls back to the legacy word-count split when no titles
    // align.
    const { data: titleCardRows } = await sb
      .from("project_script_markers")
      .select("text, ordinal")
      .eq("project_id", id)
      .eq("kind", "title_card")
      .order("ordinal");
    const topicBoundaries = (titleCardRows ?? [])
      .map((r) => (r.text as string | null) ?? "")
      .filter((s) => s.trim().length > 0);
    const segments = splitTranscriptIntoSegments(transcript, { topicBoundaries });
    const estimatedDurationSeconds = estimateDurationSeconds(transcript);
    // Prefer the probed voiceover duration; fall back to the word-count
    // estimate so the UI can still show a plan before any audio is uploaded.
    const voiceoverDurationSeconds =
      Number(project.voiceover_duration_seconds) || estimatedDurationSeconds;
    const totalDurationSeconds = voiceoverDurationSeconds;
    const plan = planTimeline(voiceoverDurationSeconds);
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.segmented", {
      segments: segments.length,
      totalDurationSeconds,
      avgBlockSeconds: plan.avgBlockSeconds,
      totalBlocks: plan.totalBlocks,
      topicBoundariesProvided: topicBoundaries.length,
      // The splitter falls back to word-count when fewer than 2 topic
      // boundaries land in the transcript. A discrepancy between
      // topicBoundariesProvided > 0 and a non-topic split here is the
      // signal that the matcher couldn't align the doc's titles to what
      // Deepgram heard.
      splitStrategy:
        topicBoundaries.length >= 1 && segments.length >= 2 && segments.length === topicBoundaries.length + 1
          ? "topic"
          : "word_count",
    });

    // 1a) Project-level entity extraction. We need this BEFORE segment work
    // so the search ranker knows who the main celebrity is — `related_person`
    // (co-stars, family) is a different bucket and was being mis-used here.
    // We also call extractProjectContext in parallel — a separate, focused
    // prompt that recovers the global subject + aliases + context terms even
    // when extractEntities's strict "full proper noun" rule misses it (e.g.
    // a script that only ever calls Dave Kindig "Dave" or "Kindig").
    const [projectEntities, projectContext] = await Promise.all([
      extractEntities(transcript).catch(async (e) => {
        await logJob({ projectId: id, jobId: mediaJobId }, "analyze.extract_entities.failed", { err: (e as Error).message });
        return [] as Awaited<ReturnType<typeof extractEntities>>;
      }),
      extractProjectContext(transcript).catch(async (e) => {
        await logJob({ projectId: id, jobId: mediaJobId }, "analyze.extract_context.failed", { err: (e as Error).message });
        return { globalMainSubject: "", globalSubjectAliases: [], globalContextTerms: [] };
      }),
    ]);
    const entityCelebrity = projectEntities.find((e) => e.type === "celebrity")?.value;
    // Prefer extractEntities's strict celebrity when present (it's the long-
    // standing source of truth), otherwise fall back to extractProjectContext
    // which is more lenient on partial names.
    const mainCelebrity = entityCelebrity || projectContext.globalMainSubject || undefined;
    const relatedCompanies = projectEntities.filter((e) => e.type === "company").map((e) => e.value);
    const relatedPeople = projectEntities.filter((e) => e.type === "related_person").map((e) => e.value);
    // Merge alias / context-term lists. Project-level companies are strong
    // context anchors too — fold them in deduped, lowercase-equivalent.
    const aliasSet = new Set<string>();
    for (const a of projectContext.globalSubjectAliases) if (a) aliasSet.add(a);
    if (mainCelebrity) aliasSet.add(mainCelebrity);
    const subjectAliases = Array.from(aliasSet);
    const contextSet = new Set<string>();
    for (const t of projectContext.globalContextTerms) if (t) contextSet.add(t);
    for (const c of relatedCompanies) if (c) contextSet.add(c);
    const contextTerms = Array.from(contextSet).slice(0, 10);
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.main_celebrity", {
      mainCelebrity: mainCelebrity ?? null,
      celebrityCount: projectEntities.filter((e) => e.type === "celebrity").length,
      totalEntities: projectEntities.length,
      subjectAliases,
      contextTerms,
      // Surface which extractor produced the subject so we can audit when
      // extractEntities silently misses one and extractProjectContext saves us.
      mainCelebritySource:
        entityCelebrity ? "extractEntities" :
        projectContext.globalMainSubject ? "extractProjectContext" : "none",
    });

    // 1b) Per-segment understanding (parallel — Gemini calls are independent).
    // We pass the project subject + aliases + context terms into every segment
    // so Gemini anchors its queries (e.g. "Kindig It Design lawsuit 2016"
    // instead of "Utah court ruling 2016", which pulls unrelated trials).
    const segmentContext = {
      mainSubject: mainCelebrity,
      subjectAliases,
      contextTerms,
      relatedCompanies: relatedCompanies.slice(0, 6),
      relatedPeople: relatedPeople.slice(0, 6),
    };
    const understandings = await Promise.all(segments.map((seg) => analyzeSegment(seg, segmentContext)));
    await setMediaJob(mediaJobId, { progress: 35 });

    // Persist a flat entity list for the existing matchProcessor / workspace UI.
    const entityRows: Array<{ project_id: string; type: string; value: string; confidence: number; metadata: Record<string, unknown> }> = [];
    const seenEntity = new Set<string>();
    function pushEntity(type: string, value: string, segIdx: number, confidence = 0.8) {
      const key = `${type}:${value.toLowerCase()}`;
      if (seenEntity.has(key)) return;
      seenEntity.add(key);
      entityRows.push({ project_id: id, type, value, confidence, metadata: { segment_index: segIdx } });
    }
    // Project-level entities first (segIdx -1 = "applies to whole script").
    // We persist celebrity/movie/tv_show/song/company/year/age too so other
    // surfaces (lower-thirds, future entity-driven matching) can use them.
    for (const e of projectEntities) {
      pushEntity(e.type, e.value, -1, e.confidence);
    }
    understandings.forEach((u, segIdx) => {
      u.people.forEach((v) => pushEntity("related_person", v, segIdx));
      u.places.forEach((v) => pushEntity("place", v, segIdx));
      u.events.forEach((v) => pushEntity("event", v, segIdx));
      u.topics.forEach((v) => pushEntity("topic", v, segIdx));
    });
    if (entityRows.length) {
      const { error } = await sb.from("project_entities").insert(entityRows);
      if (error) await logJob({ projectId: id, jobId: mediaJobId }, "analyze.entities.save_failed", { err: error.message });
    }

    // 1c) Build the face/entity reference roster (Slice 2-3 of the matching
    //     refactor). For every named entity Gemini emitted across the script —
    //     the project celebrity, every other person, every company / TV show /
    //     movie / song / place — fetch a canonical reference image from
    //     Wikipedia and persist it to face_references. The matcher (Slices
    //     5-6) consults this table at fetch time to gate candidates: a
    //     candidate image of "Bruno Tonioli" only enters a David Walliams
    //     block's pool if Gemini's verification gate confirms it's actually
    //     Walliams. We collect entities from THREE sources:
    //       (a) the project celebrity (always needed)
    //       (b) project-level extractEntities output (companies, related
    //           people, tv_shows, movies, songs)
    //       (c) the block_entity field on each block of each segment (the
    //           closed-world entities the matcher will actually try to fill)
    //     Source (c) is the most important — it's the exact set of entities
    //     the matcher will ask about. (a) and (b) are belt-and-suspenders so
    //     the celebrity reference is ready even on segments where Gemini
    //     never emitted block_entity = celebrity_default explicitly.
    const rosterEntities: ReferenceEntity[] = [];
    if (mainCelebrity) {
      rosterEntities.push({ type: "person", name: mainCelebrity });
    }
    for (const e of projectEntities) {
      const mapped: ReferenceEntityType | null =
        e.type === "celebrity" || e.type === "related_person" ? "person" :
        e.type === "company" ? "company" :
        e.type === "tv_show" ? "tv_show" :
        e.type === "movie" ? "movie" :
        e.type === "song" ? "song" :
        e.type === "place" ? "place" :
        null;
      if (mapped) rosterEntities.push({ type: mapped, name: e.value });
    }
    for (const u of understandings) {
      for (const b of u.blocks) {
        const be = b.block_entity;
        if (!be || be.type === "celebrity_default") continue;
        if (!be.name?.trim()) continue;
        rosterEntities.push({ type: be.type, name: be.name });
      }
    }
    const rosterRows = await buildReferenceRoster(id, rosterEntities).catch(async (e) => {
      // Roster failures must NOT block analysis — the matcher tolerates
      // missing references (it just skips the verification gate for those
      // entities). Log and continue.
      await logJob({ projectId: id, jobId: mediaJobId }, "analyze.roster.failed", {
        err: (e as Error).message?.slice(0, 200),
      });
      return [];
    });
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.roster.built", {
      entities_in: rosterEntities.length,
      rows_persisted: rosterRows.length,
      with_reference: rosterRows.filter((r) => !!r.reference_url).length,
    });

    // 1d) Compute secondary-person runs (hybrid clip-vs-photo policy).
    // For every secondary person (anyone other than the project celebrity)
    // we count the max consecutive run of blocks bound to them. Persons
    // with run < SECONDARY_PERSON_CLIP_THRESHOLD will be rendered via
    // their Wikipedia photo at match time — no YouTube clip search and no
    // face verification budget is spent on them here, because the matcher
    // never asks the search pipeline for those clips anyway. Persons with
    // run >= threshold get the full clip-search + verification path.
    //
    // The verification gate later in this loop reads this map to decide
    // WHICH person each candidate's thumbnail should be face-matched
    // against (the named person in the query, when they crossed the
    // threshold) vs the fallback (project celebrity). Short-mention
    // persons whose queries Gemini still emitted are skipped: their
    // queries waste YouTube quota without contributing clips the matcher
    // will use.
    const personRuns = findPersonRunsAcrossSegments(understandings, mainCelebrity ?? "");
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.person_runs", {
      threshold: SECONDARY_PERSON_CLIP_THRESHOLD,
      persons: Array.from(personRuns.entries()).map(([key, v]) => ({
        name: v.displayName,
        key,
        maxRun: v.maxRun,
        path: v.maxRun >= SECONDARY_PERSON_CLIP_THRESHOLD ? "clip_search" : "wikipedia_photo",
      })),
    });

    // 2) SUBJECT-FIRST DISCOVERY (entity-driven, not per-segment).
    //
    // The redesign flips discovery from "search per narration segment" to
    // "find the best source videos of the target entities, then generate clips
    // from them." We build ONE query set per major entity, search three tiers
    // in priority order, pool ALL candidates globally, rank, and group the
    // pool BY ENTITY for review. Segments still exist (the matcher needs their
    // text + understanding downstream) but they no longer drive search.
    //
    // Tiers (priority order, per the spec):
    //   1. Previously-approved sources (cross-project memory) — 0 API units
    //   2. Reference channels (user-curated) — ~1 unit each via playlistItems
    //   3. Open YouTube — 100 units each, yield-capped + cached + yt-dlp fallback
    await setProjectStatus(id, "searching");
    const { approved, blocked } = await loadChannelRules();
    const referenceChannels = await loadReferenceChannels();
    const envDisco = getEnv();

    // Duration-driven target: how many source videos to SELECT, and how many
    // candidates to surface for review. 8 per 5 min, clamped [3, 30]; pool 1.5×.
    const { target: sourceTarget, reviewPoolSize } =
      computeSourceVideoTarget(voiceoverDurationSeconds);

    // The entities we actually search for: the main celebrity + every other
    // person/company/show the matcher will need footage of, deduped. Each
    // becomes a search "subject" with its own query expansion + candidate pool.
    interface SearchEntity { value: string; type: string }
    const searchEntities: SearchEntity[] = [];
    const seenSearchEntity = new Set<string>();
    function pushSearchEntity(value: string, type: string) {
      const k = value.trim().toLowerCase();
      if (!k || seenSearchEntity.has(k)) return;
      seenSearchEntity.add(k);
      searchEntities.push({ value: value.trim(), type });
    }
    if (mainCelebrity) pushSearchEntity(mainCelebrity, "celebrity");
    // Secondary people only get their own pool when their narration footprint
    // crosses the clip threshold — otherwise the matcher fills them from a
    // Wikipedia photo and a YouTube pool would be wasted quota.
    for (const [key, info] of personRuns.entries()) {
      if (key === (mainCelebrity ?? "").toLowerCase()) continue;
      if (info.maxRun >= SECONDARY_PERSON_CLIP_THRESHOLD) {
        pushSearchEntity(info.displayName, "related_person");
      }
    }
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.discovery.entities", {
      entities: searchEntities.map((e) => `${e.type}:${e.value}`),
      sourceTarget, reviewPoolSize,
    });

    // The candidate shape, with the entity it was discovered under so the
    // payload can group by entity for review.
    type EntityCandidate = PreviewCandidate & { entity_value: string; entity_type: string; from_reference_channel: boolean; from_approved: boolean; footage_style: string };
    const globalPool = new Map<string, EntityCandidate>();
    const seenVideo = new Set<string>();

    // Reusable per-candidate verifier (same two-stage thumb+body gate as the
    // old per-segment path, now subject-anchored to the entity being searched).
    // Returns the accepted candidate or null when rejected. Logs rejections.
    async function rankAndVerify(
      c: Awaited<ReturnType<typeof hydrateVideoIds>>[number],
      entity: SearchEntity,
      matchedQuery: string,
      opts: {
        referenceChannel: boolean;
        fromApproved: boolean;
        // Footage style this query targets — drives the variety diversifier and
        // the editorial display. "person" = clean on-camera footage of the
        // subject; "show" = subject within a named show/event (e.g. BGT).
        footageStyle?: string;
        intentType?: IntentType;
        sourceIntent?: PreviewCandidate["source_intent"];
      },
    ): Promise<EntityCandidate | null> {
      const isMain = entity.type === "celebrity";
      const ranked = rankCandidate({
        candidate: c,
        mainCelebrity: entity.value,
        aliases: isMain ? subjectAliases : [entity.value],
        contextTerms: isMain ? contextTerms : [],
        segmentEntities: [],
        segmentTopic: "",
        matchedQuery,
        inheritedSegment: false,
        keywords: isMain ? contextTerms.slice(0, 6) : [],
        approvedChannelIds: approved,
        blockedChannelIds: blocked,
        intentType: opts.intentType ?? "talking_head",
        referenceChannel: opts.referenceChannel,
        // Subject-first discovery ALWAYS requires a real subject anchor so a
        // many-celebrity reference channel can't leak the wrong person.
        requireSubjectAnchor: true,
      });
      if (ranked.rejected) {
        await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.rejected", {
          entity: entity.value, videoId: c.videoId, reason: ranked.rejectReason ?? "unknown",
        });
        return null;
      }
      // Face-verify gate (only when enabled; default off — the ranker + the
      // subject-anchored queries do the filtering, per the env comment).
      if (envDisco.ANALYZE_FACE_VERIFY_ENABLED && entity.type !== "company") {
        const thumb = `https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg`;
        let thumbVerdict;
        try {
          thumbVerdict = await verifyPoolAsset({
            projectId: id, entityType: "person", entityName: entity.value, candidateUrl: thumb,
          });
        } catch { thumbVerdict = null; }
        if (thumbVerdict?.verdict === "no") {
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.verify_rejected", {
            entity: entity.value, videoId: c.videoId, reason: thumbVerdict.reason?.slice(0, 120),
          });
          return null;
        }
        const bodyEnabled = envDisco.ANALYZE_BODY_VERIFY_ENABLED && thumbVerdict?.verdict !== "skipped";
        if (bodyEnabled) {
          const bodyVerdicts: Array<"yes" | "no" | "uncertain" | "skipped"> = [];
          for (const frameUrl of [
            `https://i.ytimg.com/vi/${c.videoId}/1.jpg`,
            `https://i.ytimg.com/vi/${c.videoId}/2.jpg`,
            `https://i.ytimg.com/vi/${c.videoId}/3.jpg`,
          ]) {
            try {
              const bv = await verifyPoolAsset({
                projectId: id, entityType: "person", entityName: entity.value, candidateUrl: frameUrl,
              });
              bodyVerdicts.push(bv.verdict);
              if (thumbVerdict?.verdict === "uncertain" && bv.verdict === "yes") break;
            } catch { bodyVerdicts.push("skipped"); }
          }
          const bodyNoCount = bodyVerdicts.filter((v) => v === "no").length;
          if (bodyNoCount >= 2) {
            await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.verify_rejected", {
              entity: entity.value, videoId: c.videoId, reason: "no_subject_in_body",
              body: bodyVerdicts.join(","),
            });
            return null;
          }
        }
      }
      return {
        videoId: c.videoId,
        url: c.url,
        title: c.title,
        channelTitle: c.channelTitle,
        durationSeconds: c.durationSeconds,
        thumbnailUrl: `https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg`,
        score: ranked.score,
        displayScore: ranked.displayScore,
        reasons: ranked.reasons,
        rejected: false,
        matched_query: matchedQuery,
        intended_subject: entity.value,
        source_intent: opts.sourceIntent ?? "person",
        source_type: classifySourceType({ channelTitle: c.channelTitle, videoTitle: c.title }),
        entity_value: entity.value,
        entity_type: entity.type,
        from_reference_channel: opts.referenceChannel,
        from_approved: opts.fromApproved,
        footage_style: opts.footageStyle ?? "interview",
      };
    }

    // Fold an accepted candidate into the global pool, keeping the higher score
    // on duplicates (a reference/approved hit shouldn't be overwritten by a
    // weaker open-YouTube one).
    function foldIn(cand: EntityCandidate | null) {
      if (!cand) return;
      seenVideo.add(cand.videoId);
      const prev = globalPool.get(cand.videoId);
      if (!prev || cand.score > prev.score) globalPool.set(cand.videoId, cand);
    }

    // Per-entity discovery. We run the three tiers until we have enough
    // candidates for this entity's share of the review pool (yield-based cap on
    // open YouTube to bound quota).
    const perEntityTarget = Math.max(
      reviewPoolSize,
      Math.ceil(reviewPoolSize / Math.max(1, searchEntities.length)) * searchEntities.length,
    );
    const perEntityShare = Math.ceil(perEntityTarget / Math.max(1, searchEntities.length));

    for (let ei = 0; ei < searchEntities.length; ei++) {
      const entity = searchEntities[ei];
      const entityEntities = [{ type: entity.type, value: entity.value } as ExtractedEntity];
      // Reuse buildSearchQueries for footage-style expansion; cap to ~10 to
      // bound quota, ordered highest-signal first.
      const openQueries = buildSearchQueries(entityEntities as ExtractedEntity[], { maxQueries: 10 });
      // Reference channels are searched with a SINGLE bare-subject query, not
      // the footage-suffix set. Reference search lists the channel's uploads and
      // filters by query tokens against title+description — so a suffixed query
      // like "<name> red carpet" would demand "red"+"carpet" literally appear,
      // which channel uploads rarely do, and would return almost nothing.
      // Instead we pull EVERY upload that names the subject (title or
      // description) and let the style-diversifier surface the variety (red
      // carpet / event / talk show …) from whatever that channel actually
      // posted. One query per channel also keeps quota minimal.
      const channelQuery = entity.value;
      const acceptedForEntity = () =>
        Array.from(globalPool.values()).filter((c) => c.entity_value === entity.value).length;

      // Derive a coarse footage style from a query's suffix so the review pool
      // can be diversified by style (interview / red carpet / talk show / event
      // / behind the scenes …) instead of returning 8 interviews. The style is
      // just the query text minus the subject name.
      const footageStyleFor = (q: string): string => {
        const stripped = q.toLowerCase().replace(entity.value.toLowerCase(), "").trim();
        return stripped || "general";
      };

      // Infer a footage style from an upload's OWN title (used for
      // reference-channel results, which are found via a bare-name query so the
      // query itself carries no style). Scans for the known footage-style
      // phrases; falls back to "general" when none match.
      const STYLE_PHRASES = [
        "red carpet", "press conference", "behind the scenes", "talk show",
        "live appearance", "public appearance", "interview", "podcast",
        "documentary", "event", "exclusive", "archive",
      ];
      const footageStyleFromTitle = (title: string): string => {
        const t = title.toLowerCase();
        return STYLE_PHRASES.find((p) => t.includes(p)) ?? "general";
      };

      // SHOW / EVENT lane (main celebrity only). Pair the subject with the
      // script's named shows/events (e.g. "David Walliams Britain's Got
      // Talent") so the pool includes clear footage of the subject WITHIN the
      // show the script is actually about — not just generic interviews. These
      // are tagged broll/archival and given reserved slots in the editorial
      // grouping below so interviews can't crowd them out.
      const showQueries: string[] = [];
      if (entity.type === "celebrity") {
        const showsEvents = projectEntities
          .filter((e) => e.type === "tv_show" || e.type === "movie" || e.type === "event")
          .map((e) => e.value)
          .slice(0, 4);
        for (const se of showsEvents) showQueries.push(`${entity.value} ${se}`);
      }

      // ----- Tier 1: previously-approved sources (0 units) -----
      try {
        const approvedVids = await loadApprovedSourceVideos([entity.value]);
        if (approvedVids.length) {
          const hydrated = await hydrateVideoIds(approvedVids.map((v) => v.youtubeVideoId)).catch(() => []);
          for (const c of hydrated) {
            if (seenVideo.has(c.videoId)) continue;
            foldIn(await rankAndVerify(c, entity, `${entity.value} (approved)`, { referenceChannel: false, fromApproved: true, footageStyle: "approved" }));
          }
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.approved", {
            entity: entity.value, found: approvedVids.length, hydrated: hydrated.length,
          });
        }
      } catch (e) {
        await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.approved_failed", {
          entity: entity.value, err: (e as Error).message?.slice(0, 200),
        });
      }

      // ----- Tier 2: reference channels (~1 unit each via playlistItems) -----
      // One bare-subject query per channel; pull a generous slice of the
      // channel's subject uploads so the diversifier has variety to work with.
      for (const ch of referenceChannels) {
        if (acceptedForEntity() >= perEntityShare) break;
        try {
          const cands = await searchYoutubeCached({ query: channelQuery, channelId: ch.channelId, maxResults: 25 });
          for (const c of cands) {
            if (seenVideo.has(c.videoId)) continue;
            // Footage style is derived from the upload's OWN title (e.g. a
            // "… red carpet …" upload → "red carpet") rather than the query,
            // so the diversifier can still bucket reference-channel results by
            // style even though we searched with a bare name.
            foldIn(await rankAndVerify(c, entity, channelQuery, {
              referenceChannel: true, fromApproved: false,
              footageStyle: footageStyleFromTitle(c.title),
            }));
          }
        } catch (e) {
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.ref_failed", {
            entity: entity.value, channel: ch.channelId, err: (e as Error).message?.slice(0, 160),
          });
        }
      }

      // ----- Tier 3: open YouTube (yield-capped) -----
      for (const q of openQueries) {
        if (acceptedForEntity() >= perEntityShare) break;
        try {
          const cands = await searchYoutubeCached({ query: q, maxResults: PER_INTENT_RESULTS });
          for (const c of cands) {
            if (seenVideo.has(c.videoId)) continue;
            foldIn(await rankAndVerify(c, entity, q, { referenceChannel: false, fromApproved: false, footageStyle: footageStyleFor(q) }));
          }
        } catch (e) {
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.open_failed", {
            entity: entity.value, q, err: (e as Error).message?.slice(0, 160),
          });
        }
      }

      // ----- Show / event lane (reserved-slot footage) -----
      // Always run regardless of the yield cap so the pool gets at least a
      // chance at show-specific footage even when interviews already filled it.
      for (const q of showQueries) {
        try {
          const cands = await searchYoutubeCached({ query: q, maxResults: PER_INTENT_RESULTS });
          for (const c of cands) {
            if (seenVideo.has(c.videoId)) continue;
            foldIn(await rankAndVerify(c, entity, q, {
              referenceChannel: false, fromApproved: false,
              footageStyle: "show", intentType: "broll", sourceIntent: "broll",
            }));
          }
        } catch (e) {
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.show_failed", {
            entity: entity.value, q, err: (e as Error).message?.slice(0, 160),
          });
        }
      }

      await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.entity_done", {
        entity: entity.value, accepted: acceptedForEntity(),
      });
      await setMediaJob(mediaJobId, {
        progress: 40 + Math.floor(((ei + 1) / Math.max(1, searchEntities.length)) * 45),
      });
    }

    // Group the global pool by entity for the review payload, applying the
    // per-entity review-pool cap and the news/non-news editorial balance.
    const poolByEntity = new Map<string, EntityCandidate[]>();
    for (const c of globalPool.values()) {
      const arr = poolByEntity.get(c.entity_value) ?? [];
      arr.push(c);
      poolByEntity.set(c.entity_value, arr);
    }
    interface EntityGroup {
      value: string;
      type: string;
      target: number;        // how many to select for this entity
      candidates: EntityCandidate[];
    }
    const entityGroups: EntityGroup[] = [];
    // Split the project-wide source target across entities (main celebrity gets
    // the lion's share; secondaries get at least 1 each).
    const entityTarget = (e: SearchEntity, idx: number): number => {
      if (searchEntities.length === 1) return sourceTarget;
      if (idx === 0) return Math.max(1, sourceTarget - (searchEntities.length - 1));
      return 1;
    };
    // Reserve a small number of show/event ("clear footage within the show")
    // slots so interviews can't crowd them out, per client direction (keep
    // 1-2 BGT-style sources).
    const SHOW_RESERVED_SLOTS = 2;
    for (let ei = 0; ei < searchEntities.length; ei++) {
      const entity = searchEntities[ei];
      const all = (poolByEntity.get(entity.value) ?? []).sort((a, b) => b.score - a.score);

      // 1) Reserve show-lane footage first (top by score), capped.
      const showPicks = all.filter((c) => c.footage_style === "show").slice(0, SHOW_RESERVED_SLOTS);
      const showIds = new Set(showPicks.map((c) => c.videoId));
      const rest = all.filter((c) => !showIds.has(c.videoId));

      // 2) Diversify the remaining slots ACROSS footage styles via round-robin
      //    so the pool isn't 8 interviews. Bucket by style, then take one from
      //    each style in turn (each bucket already score-sorted). A news cap
      //    still applies so a scandal entity doesn't render as all-news.
      const remainingSlots = Math.max(0, reviewPoolSize - showPicks.length);
      const newsCap = Math.ceil(reviewPoolSize / 2);
      const byStyle = new Map<string, EntityCandidate[]>();
      for (const c of rest) {
        const arr = byStyle.get(c.footage_style) ?? [];
        arr.push(c);
        byStyle.set(c.footage_style, arr);
      }
      // Style order: highest-scoring style first, but then round-robin.
      const styleOrder = Array.from(byStyle.keys()).sort(
        (a, b) => (byStyle.get(b)![0]?.score ?? 0) - (byStyle.get(a)![0]?.score ?? 0),
      );
      const diversified: EntityCandidate[] = [];
      let newsCount = 0;
      let added = true;
      while (diversified.length < remainingSlots && added) {
        added = false;
        for (const style of styleOrder) {
          if (diversified.length >= remainingSlots) break;
          const bucket = byStyle.get(style)!;
          // Pull the next unused candidate of this style, respecting news cap.
          while (bucket.length) {
            const cand = bucket.shift()!;
            if (cand.source_type === "news" && newsCount >= newsCap) continue;
            diversified.push(cand);
            if (cand.source_type === "news") newsCount++;
            added = true;
            break;
          }
        }
      }
      // Show picks lead the list so they're visible; rest sorted by score.
      const candidates = [...showPicks, ...diversified.sort((a, b) => b.score - a.score)];
      entityGroups.push({ value: entity.value, type: entity.type, target: entityTarget(entity, ei), candidates });
    }

    // Build segmentAnalyses for the matcher + back-compat consumers. Segments
    // keep their text/understanding; their candidate pool is the FULL global
    // pool (top reviewPoolSize by score) so any clip can serve any section —
    // the matcher re-ranks per section on labels + provenance anyway.
    const segmentAnalyses: SegmentAnalysis[] = [];
    const globalSorted = Array.from(globalPool.values()).sort((a, b) => b.score - a.score);

    // Build segmentAnalyses for the matcher + back-compat consumers. Each
    // segment keeps its text + understanding; its candidate pool is the global
    // pool's top reviewPoolSize by score. The matcher re-ranks per section on
    // labels + provenance, so any clip can serve any section — segments no
    // longer own a private candidate bucket.
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const u = understandings[i];
      const segDuration = Math.max(0, seg.endSeconds - seg.startSeconds);
      const segBlockCount = Math.max(1, Math.ceil(segDuration / plan.avgBlockSeconds));
      const segFootageNeeded = Math.ceil(segBlockCount * 0.6);
      const segImagesNeeded = Math.ceil(segBlockCount * 0.4);
      const segCandidates = globalSorted.slice(0, reviewPoolSize);
      segmentAnalyses.push({
        index: seg.index,
        startSeconds: seg.startSeconds,
        endSeconds: seg.endSeconds,
        wordCount: seg.wordCount,
        textPreview: seg.text.slice(0, 220),
        understanding: u,
        candidates: segCandidates,
        plan: {
          durationSeconds: segDuration,
          blockCount: segBlockCount,
          footageNeeded: segFootageNeeded,
          imagesNeeded: segImagesNeeded,
          generatedClips: segCandidates.length,
          requiredClips: segFootageNeeded,
        },
      });
    }
    await setMediaJob(mediaJobId, { progress: 88 });

    // 3) Persist all candidates so the workspace can re-render preview state
    //    without re-running the Gemini + YouTube spend. One row per UNIQUE
    //    candidate in the global pool (deduped), tagged with the entity it was
    //    discovered under. segment_index is null — candidates are project-wide
    //    in the entity-driven model; the matcher binds clips to sections later.
    const rows = Array.from(globalPool.values()).map((c) => ({
      project_id: id,
      youtube_video_id: c.videoId,
      url: c.url,
      title: c.title,
      description: null,
      channel_id: null,
      channel_title: c.channelTitle,
      duration_seconds: c.durationSeconds,
      score: c.score,
      status: "candidate" as const,
      metadata: {
        segment_index: null,
        entity_value: c.entity_value,
        entity_type: c.entity_type,
        from_reference_channel: c.from_reference_channel,
        from_approved: c.from_approved,
        thumbnail_url: c.thumbnailUrl,
        reasons: c.reasons,
        display_score: c.displayScore,
        matched_query: c.matched_query,
        intended_subject: c.intended_subject,
        source_intent: c.source_intent,
        source_type: c.source_type,
        footage_style: c.footage_style,
      },
    }));
    if (rows.length) {
      const { error } = await sb.from("youtube_search_results").insert(rows);
      if (error) {
        await logJob({ projectId: id, jobId: mediaJobId }, "analyze.candidates.save_failed", { err: error.message });
      }
    }

    // Entity-grouped review payload. This is the primary view the UI renders:
    // one source-video pool per celebrity/entity, with a per-entity selection
    // target. We strip the internal-only flags the UI doesn't need.
    const entitiesPayload = entityGroups.map((g) => ({
      value: g.value,
      type: g.type,
      target: g.target,
      candidates: g.candidates.map((c) => ({
        videoId: c.videoId,
        url: c.url,
        title: c.title,
        channelTitle: c.channelTitle,
        durationSeconds: c.durationSeconds,
        thumbnailUrl: c.thumbnailUrl,
        score: c.score,
        displayScore: c.displayScore,
        reasons: c.reasons,
        rejected: false,
        matched_query: c.matched_query,
        intended_subject: c.intended_subject,
        source_intent: c.source_intent,
        source_type: c.source_type,
        from_reference_channel: c.from_reference_channel,
        from_approved: c.from_approved,
        footage_style: c.footage_style,
      })),
    }));

    const totalGeneratedClips = globalPool.size;
    const payload = {
      projectId: id,
      totalDurationSeconds,
      voiceoverDurationSeconds,
      estimatedDurationSeconds,
      wordCount: transcript.split(/\s+/).filter(Boolean).length,
      sourceTarget,
      reviewPoolSize,
      plan: {
        voiceoverSeconds: plan.voiceoverSeconds,
        avgBlockSeconds: plan.avgBlockSeconds,
        totalBlocks: plan.totalBlocks,
        footageBlocks: plan.footageBlocks,
        imageBlocks: plan.imageBlocks,
        bucket: plan.bucket,
        generatedClips: totalGeneratedClips,
      },
      // Primary view: source videos grouped by entity.
      entities: entitiesPayload,
      // Retained for the matcher + back-compat consumers (each segment's
      // candidate list is the shared global pool).
      segments: segmentAnalyses,
    };

    await setMediaJob(mediaJobId, {
      status: "completed", progress: 100,
      metadata: {
        segments: segmentAnalyses.length,
        totalDurationSeconds,
        avgBlockSeconds: plan.avgBlockSeconds,
        totalBlocks: plan.totalBlocks,
        footageBlocks: plan.footageBlocks,
        imageBlocks: plan.imageBlocks,
        candidate_count: rows.length,
        // Persist the full payload so GET can rehydrate the analyze screen
        // without re-running Gemini + YouTube search. Saves API spend on
        // every navigation back to a project that's already been analyzed.
        payload,
      },
    });
    await setProjectStatus(id, "ready_for_review");

    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "analyze failed";
    await setMediaJob(mediaJobId, { status: "failed", error: message });
    await setProjectStatus(id, "failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

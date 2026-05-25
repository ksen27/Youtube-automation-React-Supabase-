import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { setProjectStatus, createMediaJob, setMediaJob, logJob } from "@/lib/jobs/db";
import {
  splitTranscriptIntoSegments,
  estimateDurationSeconds,
  analyzeSegment,
  type SegmentUnderstanding,
} from "@/lib/ai/segments";
import { planTimeline } from "@/lib/ai/timeline-plan";
import { searchYoutube, rankCandidate, loadChannelRules } from "@/lib/youtube/search";
import { extractEntities, extractProjectContext } from "@/lib/ai/gemini";
import {
  buildReferenceRoster,
  type ReferenceEntity,
  type ReferenceEntityType,
} from "@/lib/ai/face-references";
import { verifyPoolAsset } from "@/lib/ai/pool-verification";

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
  if (!latest) return NextResponse.json({ analyze: null, payload: null });
  // The full AnalyzeResponse is persisted in metadata.payload by the POST
  // handler so the workspace can re-render saved results without re-running
  // Gemini + YouTube search on every navigation.
  const md = (latest.metadata ?? {}) as Record<string, unknown>;
  const payload = (md.payload ?? null) as unknown;
  return NextResponse.json({ analyze: latest, payload });
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

    // 2) YouTube search per intent. We'll dedupe across the whole project but
    // still attribute the best score to a single segment for the preview UI.
    await setProjectStatus(id, "searching");
    const { approved, blocked } = await loadChannelRules();

    const seenVideo = new Set<string>();
    const segmentAnalyses: SegmentAnalysis[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const u = understandings[i];
      const segCandidates: PreviewCandidate[] = [];
      // Per-segment keywords give the ranker a tight signal — long generic
      // documentaries shouldn't outrank a focused b-roll clip just because
      // they hit more of the project's overall keyword bag.
      const segKeywords = Array.from(new Set([...(u.relatedKeywords ?? []), u.mainTopic].filter(Boolean)));
      const segmentRejectionTotals: Record<string, number> = {};
      let segmentRejectedTotal = 0;
      // Per-segment subject anchor info logged once up front so rejection
      // reasons make sense when paging through the log.
      await logJob({ projectId: id, jobId: mediaJobId }, "analyze.segment.subject", {
        segment: i,
        global_main_subject: mainCelebrity ?? null,
        segment_subject: u.segmentSubject || null,
        inherited_subject: u.inheritedSubject,
        segment_topic: u.segmentTopic || null,
        generated_queries: u.searchIntents.map((it) => it.query),
      });
      for (const intent of u.searchIntents) {
        const intentType = intent.intentType ?? "talking_head";
        // Phase B: per-query provenance. The analyze route classifies
        // source_intent from the searchIntent's own intentType (Gemini
        // already labelled it as talking_head / broll / archival) instead
        // of re-running the regex classifier from searchProcessor. This is
        // strictly better signal — Gemini saw the script context. The
        // intended_subject is the project's main celebrity for every
        // query; broll/archival queries still depict that celebrity's
        // story even when the literal subject is a place or event.
        const sourceIntent: PreviewCandidate["source_intent"] =
          intentType === "broll" ? "broll" :
          intentType === "archival" ? "archival" :
          mainCelebrity && intent.query.toLowerCase().includes(mainCelebrity.toLowerCase()) ? "person" :
          "generic";
        let cands: Awaited<ReturnType<typeof searchYoutube>> = [];
        try {
          cands = await searchYoutube({ query: intent.query, maxResults: PER_INTENT_RESULTS });
        } catch (e) {
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.search.failed", {
            segment: i, query: intent.query, err: (e as Error).message,
          });
          continue;
        }
        const rejectTally: Record<string, number> = {};
        let accepted = 0;
        let dupes = 0;
        for (const c of cands) {
          if (seenVideo.has(c.videoId)) { dupes++; continue; }
          // Flatten the segment's named-entity arrays into a single list
          // the ranker can use as a fallback anchor on inherited segments.
          // Without this, an event-driven section like "the Walliams
          // recording at the London Palladium" hard-rejects any BGT-scandal
          // news result whose title doesn't restate "David Walliams" —
          // exactly the failure mode the user flagged.
          const segmentEntities = Array.from(new Set([
            ...(u.people ?? []),
            ...(u.places ?? []),
            ...(u.events ?? []),
          ].filter(Boolean)));
          const ranked = rankCandidate({
            candidate: c,
            mainCelebrity,
            aliases: subjectAliases,
            contextTerms,
            segmentEntities,
            segmentTopic: u.segmentTopic || u.mainTopic,
            matchedQuery: intent.query,
            inheritedSegment: u.inheritedSubject,
            keywords: segKeywords,
            approvedChannelIds: approved,
            blockedChannelIds: blocked,
            intentType,
          });
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.cand", {
            segment: i,
            query: intent.query,
            intentType,
            videoId: c.videoId,
            title: c.title.slice(0, 100),
            channelTitle: c.channelTitle,
            durationSeconds: c.durationSeconds,
            score: ranked.score,
            rejected: ranked.rejected,
            rejectReason: ranked.rejectReason ?? null,
            reasons: ranked.reasons,
          });
          if (ranked.rejected) {
            const k = ranked.rejectReason ?? "unknown";
            rejectTally[k] = (rejectTally[k] ?? 0) + 1;
            segmentRejectionTotals[k] = (segmentRejectionTotals[k] ?? 0) + 1;
            segmentRejectedTotal++;
            continue;
          }
          // Slice 6: face-verify the candidate's thumbnail against the
          // project celebrity's Wikipedia reference before accepting. This
          // catches the "Bruno Tonioli Golden Buzzer" / "Heartbreaking
          // Tragic Life Of Bruno Tonioli" failure mode at the source — the
          // ranker says the clip is on-topic (BGT context + Bruno in
          // people[]) but face verification can tell that the celebrity
          // isn't actually in the thumbnail.
          //
          // Gating policy:
          //   - Only gate "person" intents — these are the queries asking
          //     for the celebrity directly. Broll / archival / generic
          //     intents intentionally look at non-person footage.
          //   - Skip when no mainCelebrity (no reference to verify against).
          //   - verifyPoolAsset returns accept=true for "skipped" verdicts
          //     (no Wikipedia reference, fetch failure) — those candidates
          //     keep flowing.
          //   - Cache hits are per-process so re-running analysis on the
          //     same project pays for verification only once per thumbnail.
          if (sourceIntent === "person" && mainCelebrity) {
            const thumb = `https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg`;
            const verdict = await verifyPoolAsset({
              projectId: id,
              entityType: "person",
              entityName: mainCelebrity,
              candidateUrl: thumb,
            });
            if (!verdict.accept) {
              const k = `verify_${verdict.verdict}`;
              rejectTally[k] = (rejectTally[k] ?? 0) + 1;
              segmentRejectionTotals[k] = (segmentRejectionTotals[k] ?? 0) + 1;
              segmentRejectedTotal++;
              await logJob({ projectId: id, jobId: mediaJobId }, "analyze.cand_verify.rejected", {
                segment: i, videoId: c.videoId, title: c.title.slice(0, 100),
                verdict: verdict.verdict, reason: verdict.reason.slice(0, 120),
              });
              continue;
            }
          }
          accepted++;
          seenVideo.add(c.videoId);
          segCandidates.push({
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
            matched_query: intent.query,
            intended_subject: mainCelebrity ?? null,
            source_intent: sourceIntent,
          });
        }
        await logJob({ projectId: id, jobId: mediaJobId }, "analyze.query.summary", {
          segment: i,
          query: intent.query,
          intentType,
          mainCelebrity: mainCelebrity ?? null,
          keywords: segKeywords,
          fetched: cands.length,
          accepted,
          dupes,
          rejected: rejectTally,
        });
      }
      await logJob({ projectId: id, jobId: mediaJobId }, "analyze.segment.summary", {
        segment: i,
        global_main_subject: mainCelebrity ?? null,
        segment_subject: u.segmentSubject || null,
        inherited_subject: u.inheritedSubject,
        segment_topic: u.segmentTopic || null,
        generated_queries: u.searchIntents.map((it) => it.query),
        rejected_results_count: segmentRejectedTotal,
        rejection_reason: segmentRejectionTotals,
      });
      segCandidates.sort((a, b) => b.score - a.score);
      const segDuration = Math.max(0, seg.endSeconds - seg.startSeconds);
      const segBlockCount = Math.max(1, Math.ceil(segDuration / plan.avgBlockSeconds));
      const segFootageNeeded = Math.ceil(segBlockCount * 0.6);
      const segImagesNeeded = Math.ceil(segBlockCount * 0.4);
      const trimmedCandidates = segCandidates.slice(0, 8);
      segmentAnalyses.push({
        index: seg.index,
        startSeconds: seg.startSeconds,
        endSeconds: seg.endSeconds,
        wordCount: seg.wordCount,
        textPreview: seg.text.slice(0, 220),
        understanding: u,
        candidates: trimmedCandidates,
        plan: {
          durationSeconds: segDuration,
          blockCount: segBlockCount,
          footageNeeded: segFootageNeeded,
          imagesNeeded: segImagesNeeded,
          generatedClips: trimmedCandidates.length,
          requiredClips: segFootageNeeded,
        },
      });
      await setMediaJob(mediaJobId, {
        progress: 35 + Math.floor(((i + 1) / segments.length) * 55),
      });
    }

    // 3) Persist all candidates so the workspace can re-render preview state
    //    without re-running the Gemini + YouTube spend.
    const rows = segmentAnalyses.flatMap((s) =>
      s.candidates.map((c) => ({
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
          segment_index: s.index,
          thumbnail_url: c.thumbnailUrl,
          reasons: c.reasons,
          display_score: c.displayScore,
          matched_query: c.matched_query,
          intended_subject: c.intended_subject,
          source_intent: c.source_intent,
        },
      }))
    );
    if (rows.length) {
      const { error } = await sb.from("youtube_search_results").insert(rows);
      if (error) {
        await logJob({ projectId: id, jobId: mediaJobId }, "analyze.candidates.save_failed", { err: error.message });
      }
    }

    const totalGeneratedClips = segmentAnalyses.reduce(
      (s, seg) => s + seg.plan.generatedClips,
      0,
    );
    const payload = {
      projectId: id,
      totalDurationSeconds,
      voiceoverDurationSeconds,
      estimatedDurationSeconds,
      wordCount: transcript.split(/\s+/).filter(Boolean).length,
      plan: {
        voiceoverSeconds: plan.voiceoverSeconds,
        avgBlockSeconds: plan.avgBlockSeconds,
        totalBlocks: plan.totalBlocks,
        footageBlocks: plan.footageBlocks,
        imageBlocks: plan.imageBlocks,
        bucket: plan.bucket,
        generatedClips: totalGeneratedClips,
      },
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

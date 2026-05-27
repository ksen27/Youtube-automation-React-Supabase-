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
import { searchYoutube, rankCandidate, loadChannelRules } from "@/lib/youtube/search";
import { extractEntities, extractProjectContext } from "@/lib/ai/gemini";
import {
  buildReferenceRoster,
  type ReferenceEntity,
  type ReferenceEntityType,
} from "@/lib/ai/face-references";
import { verifyPoolAsset } from "@/lib/ai/pool-verification";
import { getEnv } from "@/lib/env";
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

    // Resolve a query → its "primary named person", if any. We scan the
    // query for each roster person's full name; longest match wins (so
    // "Simon Cowell David Walliams" picks Walliams when both are present
    // BUT the celebrity always beats a secondary — that's intentional,
    // we want celebrity-anchored queries to verify against the celebrity
    // even when they also name a secondary character). Returns null when
    // no roster person appears in the query.
    function resolveQueryPerson(query: string): { displayName: string; lower: string } | null {
      const q = query.toLowerCase();
      const celebLower = (mainCelebrity ?? "").toLowerCase();
      if (celebLower && q.includes(celebLower)) {
        return { displayName: mainCelebrity!, lower: celebLower };
      }
      let best: { displayName: string; lower: string; len: number } | null = null;
      for (const [key, v] of personRuns.entries()) {
        if (q.includes(key) && (!best || key.length > best.len)) {
          best = { displayName: v.displayName, lower: key, len: key.length };
        }
      }
      return best ? { displayName: best.displayName, lower: best.lower } : null;
    }

    // 2) YouTube search per intent. We'll dedupe across the whole project but
    // still attribute the best score to a single segment for the preview UI.
    await setProjectStatus(id, "searching");
    const { approved, blocked } = await loadChannelRules();

    const seenVideo = new Set<string>();
    const segmentAnalyses: SegmentAnalysis[] = [];

    // 2a) Character-anchored query lane. Runs ONCE per analyze, independent
    // of segment topics. These queries return videos where the celebrity
    // is the on-screen subject — clean interview / red-carpet / talk-show
    // footage that fills celebrity_default narration blocks ("He was a
    // man known for…", "Three years on the show…") where the matcher
    // doesn't need a specific event, just the person on screen.
    //
    // Each accepted character clip is added to a pool. After the
    // story-aware segment loop runs, the pool is merged into every
    // segment's candidate list — segments with thin pickings get the
    // most benefit, segments already saturated with story-aware
    // candidates use the pool as filler. The existing rankCandidate
    // scoring and per-segment top-8 trim keep the picker manageable.
    //
    // Verification uses the same two-stage pipeline as story-aware
    // candidates (thumb + body frames), so character clips meet the
    // same quality bar.
    const envForCharLane = getEnv();
    const characterPool: PreviewCandidate[] = [];
    if (envForCharLane.ANALYZE_CHARACTER_LANE_ENABLED && mainCelebrity) {
      const characterTemplates = [
        `${mainCelebrity} interview`,
        `${mainCelebrity} talk show`,
        `${mainCelebrity} red carpet`,
        `${mainCelebrity} press junket`,
        `${mainCelebrity} behind the scenes`,
      ];
      await logJob({ projectId: id, jobId: mediaJobId }, "analyze.character_lane.start", {
        mainCelebrity, templates: characterTemplates.length,
      });
      for (const query of characterTemplates) {
        let cands: Awaited<ReturnType<typeof searchYoutube>> = [];
        try {
          cands = await searchYoutube({ query, maxResults: PER_INTENT_RESULTS });
        } catch (e) {
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.character_lane.search_failed", {
            query, err: (e as Error).message,
          });
          continue;
        }
        let accepted = 0;
        let dupes = 0;
        const charRejectTally: Record<string, number> = {};
        // Pre-filter dupes outside the parallel block.
        const charCandsToProcess = cands.filter((c) => {
          if (seenVideo.has(c.videoId)) { dupes++; return false; }
          return true;
        });

        type CharResult =
          | { kind: "rejected_rank"; reason: string }
          | { kind: "rejected_verify"; reason: string }
          | { kind: "accepted"; cand: typeof cands[number]; ranked: ReturnType<typeof rankCandidate> };

        async function processCharCandidate(c: typeof cands[number]): Promise<CharResult> {
          const ranked = rankCandidate({
            candidate: c,
            mainCelebrity,
            aliases: subjectAliases,
            contextTerms,
            segmentEntities: [],
            segmentTopic: "",
            matchedQuery: query,
            inheritedSegment: false,
            keywords: contextTerms.slice(0, 6),
            approvedChannelIds: approved,
            blockedChannelIds: blocked,
            intentType: "talking_head",
          });
          if (ranked.rejected) {
            return { kind: "rejected_rank", reason: ranked.rejectReason ?? "unknown" };
          }
          // Face-verify gate. When ANALYZE_FACE_VERIFY_ENABLED is false the
          // ranker's score is the only filter — story-aware queries now do
          // the work the verify gate used to do (on-topic candidates land
          // first). Returning early here also skips the body-frame loop
          // below, which depends on the thumb verdict.
          if (!envForCharLane.ANALYZE_FACE_VERIFY_ENABLED) {
            return { kind: "accepted", cand: c, ranked };
          }
          const thumb = `https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg`;
          const thumbVerdict = await verifyPoolAsset({
            projectId: id,
            entityType: "person",
            entityName: mainCelebrity!,
            candidateUrl: thumb,
          });
          if (thumbVerdict.verdict === "no") {
            return { kind: "rejected_verify", reason: "verify_no" };
          }
          const bodyEnabled = envForCharLane.ANALYZE_BODY_VERIFY_ENABLED && thumbVerdict.verdict !== "skipped";
          const bodyVerdicts: Array<"yes" | "no" | "uncertain" | "skipped"> = [];
          if (bodyEnabled) {
            for (const frameUrl of [
              `https://i.ytimg.com/vi/${c.videoId}/1.jpg`,
              `https://i.ytimg.com/vi/${c.videoId}/2.jpg`,
              `https://i.ytimg.com/vi/${c.videoId}/3.jpg`,
            ]) {
              try {
                const bv = await verifyPoolAsset({
                  projectId: id,
                  entityType: "person",
                  entityName: mainCelebrity!,
                  candidateUrl: frameUrl,
                });
                bodyVerdicts.push(bv.verdict);
                if (thumbVerdict.verdict === "uncertain" && bv.verdict === "yes") break;
              } catch {
                bodyVerdicts.push("skipped");
              }
            }
          }
          const bodyNoCount = bodyVerdicts.filter((v) => v === "no").length;
          if (thumbVerdict.verdict === "yes" && bodyEnabled && bodyNoCount >= 2) {
            return { kind: "rejected_verify", reason: "verify_thumbnail_bait" };
          }
          // Same loosened rule as the story lane: rejection requires
          // affirmative "no" body evidence, not just absence of "yes".
          // All-uncertain body verdicts now accept (was reject).
          if (thumbVerdict.verdict === "uncertain" && bodyEnabled && bodyNoCount >= 2) {
            return { kind: "rejected_verify", reason: "verify_no_subject_in_body" };
          }
          return { kind: "accepted", cand: c, ranked };
        }

        // Parallel verify across all character candidates for this query.
        const charResults = await Promise.all(charCandsToProcess.map(processCharCandidate));

        // Serial collection: apply seenVideo recheck + tallies + push.
        for (const r of charResults) {
          if (r.kind === "rejected_rank" || r.kind === "rejected_verify") {
            const k = r.reason;
            charRejectTally[k] = (charRejectTally[k] ?? 0) + 1;
            continue;
          }
          if (seenVideo.has(r.cand.videoId)) { dupes++; continue; }
          accepted++;
          seenVideo.add(r.cand.videoId);
          characterPool.push({
            videoId: r.cand.videoId,
            url: r.cand.url,
            title: r.cand.title,
            channelTitle: r.cand.channelTitle,
            durationSeconds: r.cand.durationSeconds,
            thumbnailUrl: `https://i.ytimg.com/vi/${r.cand.videoId}/mqdefault.jpg`,
            score: r.ranked.score,
            displayScore: r.ranked.displayScore,
            reasons: r.ranked.reasons,
            rejected: false,
            matched_query: query,
            intended_subject: mainCelebrity,
            source_intent: "person",
            source_type: classifySourceType({
              channelTitle: r.cand.channelTitle,
              videoTitle: r.cand.title,
            }),
          });
        }
        await logJob({ projectId: id, jobId: mediaJobId }, "analyze.character_lane.query_summary", {
          query, fetched: cands.length, accepted, dupes, rejected: charRejectTally,
        });
      }
      await logJob({ projectId: id, jobId: mediaJobId }, "analyze.character_lane.done", {
        poolSize: characterPool.length,
      });
    }

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

        // Hybrid secondary-person policy. If this intent's primary person
        // is a secondary character whose narration footprint is below the
        // threshold (default: < 4 consecutive blocks), skip the YouTube
        // search entirely — the matcher will fill their block(s) with the
        // Wikipedia reference photo. Burning quota + verification on Bruno
        // clips when the script names him once is pure waste.
        //
        // We still proceed when the intent's person is:
        //   - the project celebrity (always clip-search)
        //   - a secondary person with run >= threshold (longer paragraph)
        //   - null (entity / place / non-person intent — keep going)
        const intentPerson = resolveQueryPerson(intent.query);
        if (
          intentPerson &&
          mainCelebrity &&
          intentPerson.lower !== mainCelebrity.toLowerCase()
        ) {
          const run = personRuns.get(intentPerson.lower)?.maxRun ?? 0;
          if (run < SECONDARY_PERSON_CLIP_THRESHOLD) {
            await logJob({ projectId: id, jobId: mediaJobId }, "analyze.intent.skipped_for_photo_path", {
              segment: i, query: intent.query, person: intentPerson.displayName, maxRun: run,
              threshold: SECONDARY_PERSON_CLIP_THRESHOLD,
            });
            continue;
          }
        }

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
        // Pre-filter duplicates upfront so we don't burn parallel verify
        // capacity on candidates we'd skip anyway. seenVideo dedup runs
        // serially BEFORE the verify loop (cheap; no Gemini cost) and
        // again AFTER (in case another query inside this segment loop
        // already added the same video — rare across queries).
        const candsToProcess = cands.filter((c) => {
          if (seenVideo.has(c.videoId)) { dupes++; return false; }
          return true;
        });
        // Per-segment data needed inside each candidate's promise. Hoisted
        // so all candidates of this query share it.
        const segmentEntities = Array.from(new Set([
          ...(u.people ?? []),
          ...(u.places ?? []),
          ...(u.events ?? []),
        ].filter(Boolean)));
        const env = getEnv();

        // Per-candidate verifier. Returns a structured result so the
        // serial collection loop below can apply seenVideo + push without
        // races. Pure read-only of shared state; no mutation here.
        type CandResult =
          | { kind: "rejected_rank"; videoId: string; reason: string; reasons: string[]; score: number }
          | { kind: "rejected_verify_thumb"; videoId: string; title: string; verifyTargetName: string; verdict: string; reason: string }
          | { kind: "rejected_verify_body"; videoId: string; title: string; verifyTargetName: string; thumbVerdict: string; bodyVerdicts: string[]; reason: string }
          | { kind: "accepted"; videoId: string; cand: Awaited<ReturnType<typeof searchYoutube>>[number]; ranked: ReturnType<typeof rankCandidate>; verifyTargetName: string | null; thumbVerdict: string | null; bodyVerdicts: string[] };

        async function processCandidate(c: typeof candsToProcess[number]): Promise<CandResult> {
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
          // analyze.cand log fires inside the per-candidate promise. Order
          // across parallel candidates may differ from cands[] order, but
          // each log entry still carries videoId so traces remain readable.
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
            return {
              kind: "rejected_rank",
              videoId: c.videoId,
              reason: ranked.rejectReason ?? "unknown",
              reasons: ranked.reasons,
              score: ranked.score,
            };
          }
          // Same verifyTarget resolution as the serial version. intentPerson
          // is closed over from the outer scope (per-intent constant).
          const verifyTarget = (() => {
            if (
              intentPerson &&
              mainCelebrity &&
              intentPerson.lower !== mainCelebrity.toLowerCase()
            ) {
              return { name: intentPerson.displayName };
            }
            if (mainCelebrity) return { name: mainCelebrity };
            return null;
          })();
          if (!verifyTarget) {
            return { kind: "accepted", videoId: c.videoId, cand: c, ranked, verifyTargetName: null, thumbVerdict: null, bodyVerdicts: [] };
          }
          // Face-verify gate. When ANALYZE_FACE_VERIFY_ENABLED is false we
          // accept the candidate based on rank alone — the new narration-
          // aware queries do the on-topic filtering the verify gate used
          // to do, and we avoid the Gemini Vision spend per candidate.
          if (!env.ANALYZE_FACE_VERIFY_ENABLED) {
            return { kind: "accepted", videoId: c.videoId, cand: c, ranked, verifyTargetName: verifyTarget.name, thumbVerdict: null, bodyVerdicts: [] };
          }
          const thumb = `https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg`;
          const thumbVerdict = await verifyPoolAsset({
            projectId: id,
            entityType: "person",
            entityName: verifyTarget.name,
            candidateUrl: thumb,
          });
          if (thumbVerdict.verdict === "no") {
            return {
              kind: "rejected_verify_thumb",
              videoId: c.videoId,
              title: c.title,
              verifyTargetName: verifyTarget.name,
              verdict: thumbVerdict.verdict,
              reason: thumbVerdict.reason,
            };
          }
          // Body-frame check. Runs SEQUENTIALLY within this candidate's
          // promise (each frame can short-circuit the next on uncertain →
          // yes), but multiple candidates run their body checks in
          // parallel because they're in separate promises.
          const bodyEnabled = env.ANALYZE_BODY_VERIFY_ENABLED && thumbVerdict.verdict !== "skipped";
          const bodyVerdicts: Array<"yes" | "no" | "uncertain" | "skipped"> = [];
          if (bodyEnabled) {
            const bodyFrameUrls = [
              `https://i.ytimg.com/vi/${c.videoId}/1.jpg`,
              `https://i.ytimg.com/vi/${c.videoId}/2.jpg`,
              `https://i.ytimg.com/vi/${c.videoId}/3.jpg`,
            ];
            for (const frameUrl of bodyFrameUrls) {
              try {
                const bv = await verifyPoolAsset({
                  projectId: id,
                  entityType: "person",
                  entityName: verifyTarget.name,
                  candidateUrl: frameUrl,
                });
                bodyVerdicts.push(bv.verdict);
                if (thumbVerdict.verdict === "uncertain" && bv.verdict === "yes") break;
              } catch {
                bodyVerdicts.push("skipped");
              }
            }
          }
          const bodyNoCount = bodyVerdicts.filter((v) => v === "no").length;
          const bodyYesCount = bodyVerdicts.filter((v) => v === "yes").length;
          let bodyReject: string | null = null;
          if (thumbVerdict.verdict === "yes" && bodyEnabled && bodyNoCount >= 2) {
            // Thumbnail says yes, body contradicts → bait (custom thumb
            // shows the celebrity, body shows someone else). Keep this
            // strict — bait is a confident-positive evidence signal.
            bodyReject = "thumbnail_bait";
          } else if (thumbVerdict.verdict === "uncertain" && bodyEnabled && bodyNoCount >= 2) {
            // Thumbnail uncertain AND body has 2+ explicit "no" verdicts →
            // the celebrity is genuinely absent from the body. Earlier
            // rule required a body "yes" to accept, but that turned out
            // to over-reject when Gemini Vision is in a cautious mood
            // (returns "uncertain" for every frame). New rule: require
            // affirmative "no" evidence to reject, not just absence of
            // "yes" evidence. All-uncertain body now accepts.
            bodyReject = "no_subject_in_body";
          }
          if (bodyReject) {
            return {
              kind: "rejected_verify_body",
              videoId: c.videoId,
              title: c.title,
              verifyTargetName: verifyTarget.name,
              thumbVerdict: thumbVerdict.verdict,
              bodyVerdicts,
              reason: bodyReject,
            };
          }
          return {
            kind: "accepted",
            videoId: c.videoId,
            cand: c,
            ranked,
            verifyTargetName: verifyTarget.name,
            thumbVerdict: thumbVerdict.verdict,
            bodyVerdicts,
          };
        }

        // Run all candidates of this query in parallel. Each candidate is
        // independent; the Gemini face-verify cache deduplicates any
        // accidental same-URL calls. Total wall-time per query drops from
        // ~60s (6 candidates × ~10s) to ~10s (max single-candidate time).
        const candResults = await Promise.all(candsToProcess.map(processCandidate));

        // Serial collection pass: apply seenVideo dedup, accumulate tallies,
        // and push accepted candidates. Order follows candResults[] order
        // (which is candsToProcess[] order, which is the YouTube ranking).
        for (const r of candResults) {
          if (r.kind === "rejected_rank") {
            const k = r.reason;
            rejectTally[k] = (rejectTally[k] ?? 0) + 1;
            segmentRejectionTotals[k] = (segmentRejectionTotals[k] ?? 0) + 1;
            segmentRejectedTotal++;
            continue;
          }
          if (r.kind === "rejected_verify_thumb") {
            const k = "verify_no";
            rejectTally[k] = (rejectTally[k] ?? 0) + 1;
            segmentRejectionTotals[k] = (segmentRejectionTotals[k] ?? 0) + 1;
            segmentRejectedTotal++;
            await logJob({ projectId: id, jobId: mediaJobId }, "analyze.cand_verify.rejected", {
              segment: i, videoId: r.videoId, title: r.title.slice(0, 100),
              intentType, sourceIntent, verify_target: r.verifyTargetName,
              verdict: r.verdict, reason: r.reason.slice(0, 120),
              stage: "thumbnail",
            });
            continue;
          }
          if (r.kind === "rejected_verify_body") {
            const k = `verify_${r.reason}`;
            rejectTally[k] = (rejectTally[k] ?? 0) + 1;
            segmentRejectionTotals[k] = (segmentRejectionTotals[k] ?? 0) + 1;
            segmentRejectedTotal++;
            await logJob({ projectId: id, jobId: mediaJobId }, "analyze.cand_verify.rejected", {
              segment: i, videoId: r.videoId, title: r.title.slice(0, 100),
              intentType, sourceIntent, verify_target: r.verifyTargetName,
              thumb_verdict: r.thumbVerdict,
              body_verdicts: r.bodyVerdicts.join(","),
              reason: r.reason,
              stage: "body",
            });
            continue;
          }
          // Accepted. Race-safe seenVideo recheck — possible only if two
          // queries (rare) returned the same videoId; the second drops.
          if (seenVideo.has(r.videoId)) { dupes++; continue; }
          if (r.bodyVerdicts.length > 0) {
            await logJob({ projectId: id, jobId: mediaJobId }, "analyze.cand_verify.accepted", {
              segment: i, videoId: r.videoId, title: r.cand.title.slice(0, 80),
              thumb_verdict: r.thumbVerdict,
              body_verdicts: r.bodyVerdicts.join(","),
            });
          }
          accepted++;
          seenVideo.add(r.videoId);
          segCandidates.push({
            videoId: r.cand.videoId,
            url: r.cand.url,
            title: r.cand.title,
            channelTitle: r.cand.channelTitle,
            durationSeconds: r.cand.durationSeconds,
            thumbnailUrl: `https://i.ytimg.com/vi/${r.cand.videoId}/mqdefault.jpg`,
            score: r.ranked.score,
            displayScore: r.ranked.displayScore,
            reasons: r.ranked.reasons,
            rejected: false,
            matched_query: intent.query,
            intended_subject: mainCelebrity ?? null,
            source_intent: sourceIntent,
            source_type: classifySourceType({
              channelTitle: r.cand.channelTitle,
              videoTitle: r.cand.title,
            }),
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
      // Merge in the character pool — but ONLY a small fixed number of
      // entries per segment. Earlier behaviour spliced every character
      // clip into every segment, which flooded the per-segment pool with
      // generic celebrity content (5 templates × N candidates each) and
      // crowded out the story-aware results. New policy: keep the segment
      // "mostly story" by taking the top CHARACTER_POOL_PER_SEGMENT
      // character clips by score, after the -15 penalty. Story-aware
      // candidates still win when both are present; the character clips
      // serve as visual-variety filler for segments where the story
      // search returns thin pickings.
      //
      // We pick from the highest-scoring character clips first so a single
      // segment doesn't end up with the bottom of the pool. The penalty is
      // applied BEFORE sorting so the comparison is apples-to-apples with
      // story candidates that already accumulated their scores naturally.
      const CHARACTER_POOL_PER_SEGMENT = 2;
      const segVideoIds = new Set(segCandidates.map((c) => c.videoId));
      const candidateCharClips = characterPool
        .filter((c) => !segVideoIds.has(c.videoId))
        .map((c) => ({
          ...c,
          score: Math.max(0, c.score - 15),
          displayScore: Math.max(0, c.displayScore - 10),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, CHARACTER_POOL_PER_SEGMENT);
      for (const charCand of candidateCharClips) segCandidates.push(charCand);
      segCandidates.sort((a, b) => b.score - a.score);
      const segDuration = Math.max(0, seg.endSeconds - seg.startSeconds);
      const segBlockCount = Math.max(1, Math.ceil(segDuration / plan.avgBlockSeconds));
      const segFootageNeeded = Math.ceil(segBlockCount * 0.6);
      const segImagesNeeded = Math.ceil(segBlockCount * 0.4);

      // Editorial balance cap.
      //
      // Per client direction, a per-segment pool should NOT be dominated by
      // news-format videos even when the narration is about a news event.
      // On scandal segments the story-anchored queries naturally pull news
      // hits because words like "lawsuit", "settlement", "scandal", and
      // year tokens are exactly what YouTube treats as news-query signals.
      // Without a cap, every slot ends up tagged source_type:"news" and
      // the final video reads as a news segment, not a documentary.
      //
      // Hard 50/50 rule: of 8 cards per segment, at most NEWS_CAP can be
      // news. Non-news cards (interview / archival / other) get the
      // remaining slots even if their ranker scores are lower. We take
      // both buckets in score-descending order so the BEST news and the
      // BEST non-news land in the picker — we only refuse extra news
      // once the cap is hit.
      //
      // If non-news is thinner than (8 - NEWS_CAP), the leftover slots
      // are filled from any remaining news cards so we never under-fill
      // a segment that genuinely has nothing else available.
      const PICKER_TOTAL = 8;
      const NEWS_CAP = 4;
      const newsCands = segCandidates.filter((c) => c.source_type === "news");
      const otherCands = segCandidates.filter((c) => c.source_type !== "news");
      const pickedNews = newsCands.slice(0, NEWS_CAP);
      const otherTarget = PICKER_TOTAL - pickedNews.length;
      const pickedOther = otherCands.slice(0, otherTarget);
      // If non-news ran out before filling its share, top up with extra news.
      const leftover = PICKER_TOTAL - pickedNews.length - pickedOther.length;
      const extraNews = leftover > 0 ? newsCands.slice(NEWS_CAP, NEWS_CAP + leftover) : [];
      // Re-sort the union by score so the picker UI still shows the
      // strongest matches first within the capped pool.
      const trimmedCandidates = [...pickedNews, ...pickedOther, ...extraNews]
        .sort((a, b) => b.score - a.score);
      await logJob({ projectId: id, jobId: mediaJobId }, "analyze.editorial_cap", {
        segment: i,
        total: trimmedCandidates.length,
        news: trimmedCandidates.filter((c) => c.source_type === "news").length,
        interview: trimmedCandidates.filter((c) => c.source_type === "interview").length,
        archival: trimmedCandidates.filter((c) => c.source_type === "archival").length,
        other: trimmedCandidates.filter((c) => c.source_type === "other").length,
        news_cap: NEWS_CAP,
        dropped_news: Math.max(0, newsCands.length - pickedNews.length - extraNews.length),
      });
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
          source_type: c.source_type,
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

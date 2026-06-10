import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { setProjectStatus, createMediaJob, setMediaJob, logJob } from "@/lib/jobs/db";
import {
  splitTranscriptIntoSegments,
  estimateDurationSeconds,
  analyzeSegment,
  findPersonRunsAcrossSegments,
  mergeDuplicatePersonRuns,
  sameNamedPerson,
  qualifiesForVideoClips,
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
// How many results each open-YouTube query pulls before ranking. Raised from 6
// so the fallback surfaces a deeper pool per query — when reference channels
// are thin, the main celebrity needs a wide open-YouTube net to reach target.
const PER_INTENT_RESULTS = 12;

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
  // Also clear previously-cut clips. The clip processor SKIPS re-cutting a
  // source whose per-source quota is already met (it counts existing
  // video_clips for the project), so without this an old clip — e.g. a
  // disclaimer card cut BEFORE the clean-footage/face gate existed — would
  // survive a re-analyze and reappear in the render. Deleting the clips makes
  // existingForThisSource = 0, forcing a fresh re-cut so the current
  // clip-stage gates run on every clip.
  //
  // We do NOT delete video_sources: those rows are one-per-YouTube-video and
  // SHARED across projects (downloadProcessor re-associates project_id rather
  // than duplicating). Deleting them could strip a source another project
  // relies on. Clearing clips alone is sufficient to force the re-cut.
  await sb.from("video_clips").delete().eq("project_id", id);

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
      // Per-PERSON resolution trail so an ambiguous name ("Williams" →
      // wrong Wikipedia page) is visible in the logs. Shows the name we
      // searched, the Wikipedia title it resolved to, and the page URL.
      // If `name` and `resolved_title` disagree (e.g. name "Williams" →
      // resolved "Brandon Williams (footballer)"), the reference photo is
      // the wrong person and every downstream face/image verify is poisoned.
      person_references: rosterRows
        .filter((r) => r.entity_type === "person")
        .map((r) => ({
          name: r.entity_name,
          resolved_title: (r.metadata as { wikipedia_title?: string } | null)?.wikipedia_title ?? null,
          page_url: r.source_page_url ?? null,
          has_image: !!r.reference_url,
        })),
    });

    // 1d) Compute secondary-person appearance counts (hybrid clip-vs-photo
    // policy). For every secondary person (anyone other than the project
    // celebrity) we count totalBlocks = the number of narration blocks they are
    // the resolved subject of. Persons below SECONDARY_PERSON_VIDEO_THRESHOLD
    // are rendered from their still image at match time — no YouTube clip search
    // and no face-verification budget is spent on them, because the matcher
    // never asks the search pipeline for those clips. Persons at or above the
    // threshold get the full source-video + clip-search + verification path.
    //
    // Gemini emits each person's name verbatim from the script, so the SAME
    // real person can surface under two surface forms ("Camilla" + "Queen
    // Camilla", "Charles" + "King Charles III"). Collapse those into one
    // entry (keeping the fuller name) BEFORE they become separate search
    // entities / picker cards / candidate pools below.
    const personRuns = mergeDuplicatePersonRuns(
      findPersonRunsAcrossSegments(understandings, mainCelebrity ?? ""),
    );
    // Appearance-count gate: a secondary person earns the SOURCE-VIDEO + CLIP
    // path only when they are the resolved subject of at least
    // SECONDARY_PERSON_VIDEO_THRESHOLD narration segments (totalBlocks). Below
    // the threshold they get STILL IMAGES only — the Wikipedia/Brave/CSE pulls
    // below run for everyone regardless. We gate on totalBlocks (whole-script
    // footprint) rather than a consecutive run so a scattered-but-dominant
    // figure (e.g. David Walliams in a "Simon Cowell speaks out about David
    // Walliams" piece) still earns footage. The main celebrity is never in this
    // map and always qualifies.
    const videoThreshold = getEnv().SECONDARY_PERSON_VIDEO_THRESHOLD;
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.person_runs", {
      videoThreshold,
      // totalBlocks drives BOTH the gate (>= threshold → clip_search) and the
      // proportional per-person selection target downstream.
      persons: Array.from(personRuns.entries()).map(([key, v]) => ({
        name: v.displayName,
        key,
        maxRun: v.maxRun,
        totalBlocks: v.totalBlocks,
        path: qualifiesForVideoClips(personRuns, v.displayName, videoThreshold)
          ? "clip_search"
          : "photo_only",
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
    // A secondary person gets their own source-video pool (and picker card)
    // ONLY when their appearance count clears SECONDARY_PERSON_VIDEO_THRESHOLD
    // (gated on totalBlocks via qualifiesForVideoClips). Frequently-appearing
    // supporting cast (Camilla, Catherine, Harry… when the script is genuinely
    // about them) earn footage, with the number of selected sources per person
    // scaled below in entityTarget(); rarely-appearing people are NOT searched
    // here and fall through to the still-image path (Wikipedia/Brave/CSE
    // references built above, which cover everyone). The main celebrity always
    // qualifies (skipped below — it was pushed as "celebrity" already).
    const photoOnlyPeople: string[] = [];
    for (const [key, info] of personRuns.entries()) {
      // Skip the main celebrity — including title variants of them, e.g. a
      // block that named the celebrity "Charles" as "King Charles III". Without
      // the subset check, a regnal/honorific variant of the main subject would
      // get a duplicate related_person card alongside the celebrity card.
      if (key === (mainCelebrity ?? "").toLowerCase()) continue;
      if (mainCelebrity && sameNamedPerson(info.displayName, mainCelebrity)) continue;
      // Appearance-count gate: below the threshold → still images only.
      if (!qualifiesForVideoClips(personRuns, info.displayName, videoThreshold)) {
        photoOnlyPeople.push(info.displayName);
        continue;
      }
      pushSearchEntity(info.displayName, "related_person");
    }
    if (photoOnlyPeople.length > 0) {
      await logJob({ projectId: id, jobId: mediaJobId }, "analyze.video_gate.photo_only", {
        videoThreshold,
        // People below the threshold: no source-video search/download/clips;
        // they render from their still-image reference instead.
        people: photoOnlyPeople,
      });
    }
    await logJob({ projectId: id, jobId: mediaJobId }, "analyze.discovery.entities", {
      entities: searchEntities.map((e) => `${e.type}:${e.value}`),
      sourceTarget, reviewPoolSize,
    });

    // The candidate shape, with the entity it was discovered under so the
    // payload can group by entity for review.
    type EntityCandidate = PreviewCandidate & { entity_value: string; entity_type: string; from_reference_channel: boolean; from_approved: boolean; footage_style: string; channel_id: string };
    const globalPool = new Map<string, EntityCandidate>();
    const seenVideo = new Set<string>();
    // Title → videoId index for cross-ID dedup. Clickbait content is re-uploaded
    // by many channels under the SAME title with DIFFERENT video IDs (e.g. two
    // "Simon Cowell's Emotional Goodbye..." uploads). ID-keyed dedup can't catch
    // those, so they both reach the pool and the user sees the same video twice.
    // We normalise the title (lowercase, strip punctuation, collapse spaces) and
    // keep only the higher-scoring candidate per normalised title.
    const seenTitle = new Map<string, string>();
    const normalizeTitle = (t: string): string =>
      t.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

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
        // Force the thumbnail face-check on/off, overriding the per-tier
        // default. Open-YouTube uses this to face-check ONLY the top-N
        // candidates by score (cost control) rather than every result.
        faceCheck?: boolean;
      },
    ): Promise<EntityCandidate | null> {
      const isMain = entity.type === "celebrity";
      // Per-tier subject policy:
      //   Open YouTube → require the FULL disambiguated name (word-boundary).
      //     This kills "William Shatner" matching a "Prince William" project at
      //     zero Gemini cost — Shatner's title never contains "prince william".
      //   Reference channels → do NOT require the name (a curated royal channel
      //     may title a William clip "Harry interview" and we'd lose it). Recall
      //     is preserved by the FACE-CHECK below instead.
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
        requireSubjectAnchor: !opts.referenceChannel,
      });
      if (ranked.rejected) {
        await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.rejected", {
          entity: entity.value, videoId: c.videoId, reason: ranked.rejectReason ?? "unknown",
        });
        return null;
      }

      // THUMBNAIL FACE-CHECK. The analyze-time face comparison is now fully
      // OPT-IN behind ANALYZE_FACE_VERIFY_ENABLED (default OFF). The user
      // reviews source thumbnails manually in the picker, so we no longer spend
      // per-candidate Gemini face calls just to filter the preview pool — that
      // was the dominant cost making analyze slow, especially now that every
      // character (not just the main subject) is searched. The deeper
      // multi-frame face gate at CLIP-CUT time is still the safety net for the
      // final render. When the flag is explicitly turned back on, the previous
      // behaviour returns: reference-channel + open-YT-top-N + show-lane person
      // candidates get the thumbnail (and optional body-frame) check.
      const isPersonEntity =
        entity.type === "person" || entity.type === "related_person" || entity.type === "celebrity";
      // Master switch: with the env flag off, NO analyze-time face Gemini calls
      // happen regardless of the per-tier opts.faceCheck request. With it on,
      // the per-tier policy decides which candidates get checked.
      const doFaceCheck =
        envDisco.ANALYZE_FACE_VERIFY_ENABLED &&
        (opts.faceCheck !== undefined
          ? (opts.faceCheck && isPersonEntity)
          : (opts.referenceChannel && isPersonEntity) ||
            entity.type !== "company");
      if (doFaceCheck) {
        const thumb = `https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg`;
        let thumbVerdict;
        try {
          thumbVerdict = await verifyPoolAsset({
            projectId: id, entityType: "person", entityName: entity.value, candidateUrl: thumb,
          });
        } catch { thumbVerdict = null; }
        if (thumbVerdict?.verdict === "no") {
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.verify_rejected", {
            entity: entity.value, videoId: c.videoId,
            from_reference_channel: opts.referenceChannel,
            reason: thumbVerdict.reason?.slice(0, 120),
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
        channel_id: c.channelId ?? "",
      };
    }

    // Fold an accepted candidate into the global pool, keeping the higher score
    // on duplicates (a reference/approved hit shouldn't be overwritten by a
    // weaker open-YouTube one).
    function foldIn(cand: EntityCandidate | null) {
      if (!cand) return;
      seenVideo.add(cand.videoId);

      // Cross-ID title dedup: if another video with the SAME normalised title is
      // already pooled under a different ID (a clickbait re-upload), keep only
      // the higher-scoring one so the user doesn't see the same video twice.
      const tkey = normalizeTitle(cand.title);
      if (tkey) {
        const existingId = seenTitle.get(tkey);
        if (existingId && existingId !== cand.videoId) {
          const existing = globalPool.get(existingId);
          if (existing && existing.score >= cand.score) return; // keep existing
          // New one wins — drop the older duplicate from the pool.
          if (existing) globalPool.delete(existingId);
        }
        seenTitle.set(tkey, cand.videoId);
      }

      const prev = globalPool.get(cand.videoId);
      if (!prev || cand.score > prev.score) globalPool.set(cand.videoId, cand);
    }

    // Bounded-concurrency map. rankAndVerify does a per-candidate Gemini
    // face-check (~1-3s each) for reference-channel candidates; running those
    // serially across (channels × 25 candidates) made discovery take minutes.
    // We run them CONCURRENTLY with a small cap (Gemini-friendly) and fold the
    // results serially afterward so the shared pool isn't mutated under a race.
    const VERIFY_CONCURRENCY = 6;
    async function mapWithConcurrency<T, R>(
      items: T[],
      fn: (item: T) => Promise<R>,
      cap = VERIFY_CONCURRENCY,
    ): Promise<R[]> {
      const out: R[] = new Array(items.length);
      let next = 0;
      async function worker(): Promise<void> {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i]);
        }
      }
      await Promise.all(Array.from({ length: Math.min(cap, items.length) }, worker));
      return out;
    }

    // Per-entity discovery. We run the three tiers until we have enough
    // candidates for this entity's share of the review pool (yield-based cap on
    // open YouTube to bound quota).
    //
    // The open-YouTube yield cap is NOT an even split across entities. An even
    // split starves the MAIN celebrity: with 5 people, each entity got only
    // ~reviewPoolSize/5 open-YouTube slots, so when the reference channels were
    // thin the main subject's pool never grew enough to cover the audio. The
    // main subject is the one that needs the deepest pool (most of the
    // narration is about them), so it gets the FULL reviewPoolSize as its open
    // budget while secondaries keep the smaller even share. `openShareFor`
    // returns the per-entity open-YouTube yield cap.
    const evenShare = Math.ceil(reviewPoolSize / Math.max(1, searchEntities.length));
    const openShareFor = (entity: SearchEntity): number =>
      entity.type === "celebrity" ? reviewPoolSize : evenShare;

    for (let ei = 0; ei < searchEntities.length; ei++) {
      const entity = searchEntities[ei];
      const entityEntities = [{ type: entity.type, value: entity.value } as ExtractedEntity];
      // Disambiguating context anchor — ONE strong term tied to the subject so
      // bare-name queries can't return the wrong person. For the main celebrity
      // we use the strongest extracted context term (a recurring proper noun
      // like another royal, the show, the company); if the entity name itself
      // is already multi-word (e.g. "Prince William") it's self-disambiguating
      // and we skip the anchor. Single-token names (the risky case) always get
      // an anchor when one is available. Secondary people reuse the project
      // context too (they share the same world as the celebrity).
      const isSingleTokenName = !entity.value.trim().includes(" ");
      const contextAnchor =
        isSingleTokenName && contextTerms.length > 0 ? contextTerms[0] : "";
      // Reuse buildSearchQueries for footage-style expansion, ordered
      // highest-signal first. The MAIN celebrity gets a wider query set (more
      // footage-style suffixes) so the open-YouTube fallback can actually fill
      // its larger pool when reference channels are thin; secondaries keep the
      // tighter cap for quota control.
      const openQueries = buildSearchQueries(entityEntities as ExtractedEntity[], {
        maxQueries: entity.type === "celebrity" ? 18 : 10,
        contextAnchor,
      });
      // Reference channels are searched with a SINGLE bare-subject query, not
      // the footage-suffix set. Reference search lists the channel's uploads and
      // filters by query tokens against title+description — so a suffixed query
      // like "<name> red carpet" would demand "red"+"carpet" literally appear,
      // which channel uploads rarely do, and would return almost nothing.
      // Instead we pull EVERY upload that names the subject (title or
      // description) and let the style-diversifier surface the variety (red
      // carpet / event / talk show …) from whatever that channel actually
      // posted. One query per channel also keeps quota minimal.
      // Reference-channel query keeps the bare name (the channel filter +
      // thumbnail face-check already narrow to the right person). We do NOT
      // append the context anchor here because the playlist token-filter would
      // then require the anchor word in every upload's title/description and
      // drop most of the channel's footage. Disambiguation for reference
      // channels is handled by the face-check, not the query text.
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
            // Approved sources were human-confirmed for SOME past project, not
            // necessarily for THIS entity — a thumbnail of the wrong person (or
            // clickbait) can carry over. Force the face-check here too; it only
            // rejects a confident "no", so a missing reference still passes.
            foldIn(await rankAndVerify(c, entity, `${entity.value} (approved)`, { referenceChannel: false, fromApproved: true, footageStyle: "approved", faceCheck: true }));
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
      // We search EVERY reference channel (no early-stop cap) — reference search
      // is cheap (~1 quota unit each) and stopping early caused all sources to
      // come from the single highest-priority channel, killing scene variety.
      // The per-channel round-robin in the grouping step below ensures the final
      // pool is spread across all channels rather than dominated by one.
      //
      // The channels are searched CONCURRENTLY (bounded by mapWithConcurrency):
      // each is an independent network call + verify pass, and on a long script
      // with many reference channels × many entities the old serial loop was the
      // dominant analyze-time cost. We collect each channel's verified results
      // and fold them serially AFTERWARD, in channel order, so the shared pool
      // (globalPool / seenVideo / seenTitle) is never mutated under a race and
      // the deterministic dedup ordering is preserved.
      const refResults = await mapWithConcurrency(referenceChannels, async (ch) => {
        try {
          const cands = await searchYoutubeCached({ query: channelQuery, channelId: ch.channelId, maxResults: 25 });
          // Pre-filter dupes, then verify the rest CONCURRENTLY (the face-check
          // per candidate is the slow part). Footage style is derived from each
          // upload's OWN title since we searched with a bare name.
          const fresh = cands.filter((c) => !seenVideo.has(c.videoId));
          return await mapWithConcurrency(fresh, (c) =>
            rankAndVerify(c, entity, channelQuery, {
              referenceChannel: true, fromApproved: false,
              footageStyle: footageStyleFromTitle(c.title),
            }),
          );
        } catch (e) {
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.ref_failed", {
            entity: entity.value, channel: ch.channelId, err: (e as Error).message?.slice(0, 160),
          });
          return [] as Array<EntityCandidate | null>;
        }
      });
      // Fold serially in channel order — single-threaded mutation of the pool.
      for (const verified of refResults) {
        for (const v of verified) foldIn(v);
      }

      // ----- Tier 3: open YouTube (yield-capped) -----
      // TWO-PASS to control Gemini cost: (1) rank ALL candidates WITHOUT the
      // face-check (cheap, deterministic), then (2) face-check ONLY the top-N by
      // ranker score — the ones likely to be shown/selected. The long tail of
      // lower-scored open-YouTube results is skipped, so we don't spend a Gemini
      // call on every result. Reference channels are checked in full (cheap
      // quota, user-curated); only open YouTube gets this top-N cap.
      const OPEN_FACECHECK_TOP_N = 10;
      // Per-entity open-YouTube yield cap — the main celebrity gets the full
      // review pool, secondaries the even share (see openShareFor above).
      const openShare = openShareFor(entity);
      // Pass 1: rank-only (faceCheck:false) across all open queries. Keep the
      // RAW YoutubeCandidate alongside its ranked result so pass 2 can re-run
      // the face-check from the raw candidate (rankAndVerify needs the raw shape,
      // not the reshaped EntityCandidate).
      type RawCand = Awaited<ReturnType<typeof searchYoutubeCached>>[number];
      const openPairs: Array<{ raw: RawCand; q: string; ranked: EntityCandidate }> = [];
      for (const q of openQueries) {
        if (acceptedForEntity() + openPairs.length >= openShare) break;
        try {
          const cands = await searchYoutubeCached({ query: q, maxResults: PER_INTENT_RESULTS });
          const fresh = cands.filter((c) => !seenVideo.has(c.videoId));
          const ranked = await mapWithConcurrency(fresh, async (c) => ({
            raw: c,
            ranked: await rankAndVerify(c, entity, q, {
              referenceChannel: false, fromApproved: false,
              footageStyle: footageStyleFor(q), faceCheck: false,
            }),
          }));
          for (const r of ranked) if (r.ranked) openPairs.push({ raw: r.raw, q, ranked: r.ranked });
        } catch (e) {
          await logJob({ projectId: id, jobId: mediaJobId }, "analyze.disco.open_failed", {
            entity: entity.value, q, err: (e as Error).message?.slice(0, 160),
          });
        }
      }
      // Sort by ranker score, dedupe by videoId, then face-check only the top-N.
      openPairs.sort((a, b) => b.ranked.score - a.ranked.score);
      const openSeen = new Set<string>();
      const openUnique = openPairs.filter((p) => {
        if (openSeen.has(p.raw.videoId)) return false;
        openSeen.add(p.raw.videoId);
        return true;
      });
      const toCheck = openUnique.slice(0, OPEN_FACECHECK_TOP_N);
      const tail = openUnique.slice(OPEN_FACECHECK_TOP_N);
      // Top-N: re-run WITH face-check (from raw candidate); only survivors fold.
      const checked = await mapWithConcurrency(toCheck, (p) =>
        rankAndVerify(p.raw, entity, p.q, {
          referenceChannel: false, fromApproved: false,
          footageStyle: footageStyleFor(p.q), faceCheck: true,
        }),
      );
      for (const v of checked) foldIn(v);
      // Tail: lower-priority, ranked-only (no face-check spend) — fold as-is.
      for (const p of tail) foldIn(p.ranked);

      // ----- Show / event lane (reserved-slot footage) -----
      // Always run regardless of the yield cap so the pool gets at least a
      // chance at show-specific footage even when interviews already filled it.
      for (const q of showQueries) {
        try {
          const cands = await searchYoutubeCached({ query: q, maxResults: PER_INTENT_RESULTS });
          const fresh = cands.filter((c) => !seenVideo.has(c.videoId));
          const verified = await mapWithConcurrency(fresh, (c) =>
            rankAndVerify(c, entity, q, {
              referenceChannel: false, fromApproved: false,
              footageStyle: "show", intentType: "broll", sourceIntent: "broll",
              // Show/event queries match on TITLE only ("<subject> <show>"), so
              // without a face-check a thumbnail that names the subject but does
              // NOT show them (a co-presenter + a dance group) sails through on
              // text rank alone. Force the thumbnail face-check here regardless
              // of ANALYZE_FACE_VERIFY_ENABLED so wrong-person show footage is
              // rejected. (The open-YouTube top-N lane already forces this.)
              faceCheck: true,
            }),
          );
          for (const v of verified) foldIn(v);
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
    // Split the project-wide source target across entities BY HOW MUCH OF THE
    // SCRIPT IS ABOUT EACH PERSON. The selection count should track the audio
    // content: a co-lead the narration spends half its time on (e.g. David
    // Walliams in a "Simon Cowell speaks out about Walliams" piece) deserves
    // several selected videos, not the hardcoded 1 that secondaries used to get.
    //
    // Weight per person = their narration footprint:
    //   - secondary person → totalBlocks bound to them (from personRuns,
    //     computed off the block_entity bindings = the audio script).
    //   - main celebrity   → every remaining block (all narration NOT attributed
    //     to a clip-path secondary), so they keep the lion's share by default.
    // We then hand out sourceTarget slots in proportion to those weights, with a
    // floor of 1 per searched entity (every card group selects at least one).
    const footprintWeight = (e: SearchEntity, idx: number): number => {
      if (idx === 0) {
        // Main celebrity: total narration minus what secondaries claimed.
        const secondaryBlocks = searchEntities
          .slice(1)
          .reduce((sum, se) => sum + (personRuns.get(se.value.toLowerCase())?.totalBlocks ?? 0), 0);
        const total = Array.from(personRuns.values()).reduce((s, v) => s + v.totalBlocks, 0);
        // Celebrity weight = max(secondaries' max, leftover). Falls back to a
        // strong default so a celebrity with no recorded blocks still leads.
        const leftover = Math.max(secondaryBlocks, total) - secondaryBlocks;
        return Math.max(leftover, secondaryBlocks + 1, 1);
      }
      return Math.max(1, personRuns.get(e.value.toLowerCase())?.totalBlocks ?? 1);
    };
    const totalWeight = searchEntities.reduce((s, e, i) => s + footprintWeight(e, i), 0);
    // Guaranteed MAIN-celebrity floor. The proportional split alone let
    // secondaries skim too many slots — a project genuinely about Chuck
    // Connors was selecting only ~7-8 of him while three related people took
    // the rest, so the dominant subject ended up under-covered. We reserve a
    // majority of the project source target for the main celebrity (≥60%, and
    // at least the FLOOR count), then split the remainder across secondaries by
    // footprint. This keeps the main subject's footage front-and-centre, which
    // is what the audio is mostly about, while still giving co-leads real
    // coverage.
    const MAIN_CELEBRITY_SHARE = 0.6;
    const mainTargetFloor =
      searchEntities.length > 1
        ? Math.max(getEnv().SOURCE_TARGET_FLOOR, Math.round(sourceTarget * MAIN_CELEBRITY_SHARE))
        : sourceTarget;
    const secondaryPool = Math.max(0, sourceTarget - mainTargetFloor);
    const secondaryWeight = searchEntities
      .slice(1)
      .reduce((s, e, i) => s + footprintWeight(e, i + 1), 0);
    const entityTarget = (e: SearchEntity, idx: number): number => {
      if (searchEntities.length === 1) return sourceTarget;
      // Main celebrity (idx 0): the reserved majority floor.
      if (idx === 0) return mainTargetFloor;
      // Secondaries split the remaining pool proportionally by footprint,
      // floored at 1 so every searched person's card group has at least one.
      const share = Math.round(
        (footprintWeight(e, idx) / Math.max(1, secondaryWeight)) * secondaryPool,
      );
      return Math.max(1, share);
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

      // 2) Diversify the remaining slots ACROSS CHANNELS via round-robin so the
      //    pool is spread over all reference (and YouTube) channels rather than
      //    dominated by one — the variety problem the user reported. Each
      //    channel's bucket is internally ordered to also spread footage STYLES
      //    (so a single channel doesn't contribute 8 interviews). A news cap
      //    still applies so a scandal entity doesn't render as all-news.
      const remainingSlots = Math.max(0, reviewPoolSize - showPicks.length);
      const newsCap = Math.ceil(reviewPoolSize / 2);

      // Bucket the remaining candidates by channel.
      const byChannel = new Map<string, EntityCandidate[]>();
      for (const c of rest) {
        const key = c.channel_id || c.channelTitle || "unknown";
        const arr = byChannel.get(key) ?? [];
        arr.push(c);
        byChannel.set(key, arr);
      }
      // Within each channel, order by style-spread then score: interleave styles
      // so the first picks from a channel are diverse, not all one format.
      for (const [, arr] of byChannel) {
        arr.sort((a, b) => b.score - a.score);
        const seenStyle = new Set<string>();
        const firstOfStyle: EntityCandidate[] = [];
        const remainder: EntityCandidate[] = [];
        for (const c of arr) {
          if (!seenStyle.has(c.footage_style)) { seenStyle.add(c.footage_style); firstOfStyle.push(c); }
          else remainder.push(c);
        }
        arr.length = 0;
        arr.push(...firstOfStyle, ...remainder);
      }
      // Channel order: highest top-score channel first, then round-robin.
      const channelOrder = Array.from(byChannel.keys()).sort(
        (a, b) => (byChannel.get(b)![0]?.score ?? 0) - (byChannel.get(a)![0]?.score ?? 0),
      );
      const diversified: EntityCandidate[] = [];
      let newsCount = 0;
      let added = true;
      while (diversified.length < remainingSlots && added) {
        added = false;
        for (const chKey of channelOrder) {
          if (diversified.length >= remainingSlots) break;
          const bucket = byChannel.get(chKey)!;
          while (bucket.length) {
            const cand = bucket.shift()!;
            if (cand.source_type === "news" && newsCount >= newsCap) continue;
            diversified.push(cand);
            if (cand.source_type === "news") newsCount++;
            added = true;
            break; // one per channel per round → round-robin across channels
          }
        }
      }
      // Show picks lead the list so they're visible; rest keeps the round-robin
      // ORDER (do NOT re-sort by score — that would re-cluster one channel's
      // high-scoring videos at the top and undo the channel spread).
      const candidates = [...showPicks, ...diversified];
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

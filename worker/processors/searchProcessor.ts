import type { SearchJobData } from "@/lib/jobs/queue";
import { createMediaJob, logJob, setMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { enqueueDownload } from "@/lib/jobs/queue";
import { getServerSupabase } from "@/lib/supabase/server";
import { extractEntities, buildSearchQueries } from "@/lib/ai/gemini";
import { searchYoutube, rankCandidate, loadChannelRules } from "@/lib/youtube/search";
import { getEnv } from "@/lib/env";

export async function processSearchJob(data: SearchJobData): Promise<void> {
  const env = getEnv();
  const sb = getServerSupabase();
  const { projectId, mediaJobId } = data;

  await setMediaJob(mediaJobId, { status: "running", progress: 5 });
  await setProjectStatus(projectId, "extracting");

  const { data: project, error: projErr } = await sb
    .from("projects").select("id, transcript").eq("id", projectId).single();
  if (projErr || !project) throw new Error(`project not found: ${projErr?.message}`);
  if (!project.transcript || !project.transcript.trim()) {
    throw new Error("transcript is empty");
  }

  // 1) Entity extraction
  await logJob({ projectId, jobId: mediaJobId }, "search.extract.start");
  const entities = await extractEntities(project.transcript);
  await logJob({ projectId, jobId: mediaJobId }, "search.extract.done", { count: entities.length });
  await setMediaJob(mediaJobId, { progress: 25 });

  if (entities.length) {
    const rows = entities.map((e) => ({
      project_id: projectId,
      type: e.type,
      value: e.value,
      confidence: e.confidence,
      metadata: e.metadata,
    }));
    const { error } = await sb.from("project_entities").insert(rows);
    if (error) throw new Error(`save entities: ${error.message}`);
  }

  // 2) Build queries
  const queries = buildSearchQueries(entities);
  if (queries.length === 0) {
    await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { note: "no queries" } });
    await setProjectStatus(projectId, "ready_for_review");
    return;
  }

  // 3) Search YouTube
  await setProjectStatus(projectId, "searching");
  const { approved, blocked } = await loadChannelRules();
  const mainCelebrity = entities.find((e) => e.type === "celebrity")?.value;
  const keywords = entities
    .filter((e) => ["movie", "tv_show", "song", "event", "place"].includes(e.type as string))
    .map((e) => e.value);

  // Phase B: track which query produced each candidate AND who/what that
  // query was about. This is the "source intent" trail — it follows the
  // video from search → source → clip and feeds the +50 person-first bonus
  // in the matcher's deterministic scorer. Without this, the matcher only
  // sees the source title (often "Salma Hayek - The Untold Story") and has
  // to guess at who the clip is supposed to depict.
  type RankedWithProvenance = ReturnType<typeof rankCandidate> & {
    matched_query: string;
    intended_subject: string | null;
    source_intent: "person" | "broll" | "archival" | "generic";
  };
  const allCandidates = new Map<string, RankedWithProvenance>();
  // The `buildSearchQueries` helper produces queries shaped like
  // "{celebrity} interview", "{celebrity} {movie}", "{place}", etc. We use
  // a coarse classifier that walks each query's tokens and decides the
  // intent based on whether the celebrity name is present and which
  // keyword bucket the OTHER tokens fall into. Cheap and good enough — the
  // matcher only needs a coarse hint, not a perfect tag.
  const intentFor = (query: string): RankedWithProvenance["source_intent"] => {
    const q = query.toLowerCase();
    if (/\b(news|archive|archival|newsreel|original footage|vintage|1\d{3}|20\d{2})\b/.test(q)) return "archival";
    if (/\b(scene|footage|b-?roll|montage|locations?|cities?|places?|streets?|venue)\b/.test(q)) return "broll";
    if (mainCelebrity && q.includes(mainCelebrity.toLowerCase())) return "person";
    return "generic";
  };
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const intent = intentFor(q);
    try {
      const cands = await searchYoutube({ query: q });
      for (const c of cands) {
        const ranked = rankCandidate({
          candidate: c, mainCelebrity, keywords,
          approvedChannelIds: approved, blockedChannelIds: blocked,
        });
        const provenance: RankedWithProvenance = {
          ...ranked,
          matched_query: q,
          intended_subject: mainCelebrity ?? null,
          source_intent: intent,
        };
        const prev = allCandidates.get(c.videoId);
        // Keep the higher-scoring provenance for duplicates so we don't
        // overwrite a "person" provenance with a later "broll" one.
        if (!prev || ranked.score > prev.score) allCandidates.set(c.videoId, provenance);
      }
    } catch (e) {
      await logJob({ projectId, jobId: mediaJobId }, "search.query.failed", { q, err: (e as Error).message });
    }
    await setMediaJob(mediaJobId, {
      progress: 25 + Math.floor(((i + 1) / queries.length) * 35),
    });
  }

  // 4) Persist all candidates (rejected too — useful for debugging in UI)
  const candidateRows = Array.from(allCandidates.values()).map((c) => ({
    project_id: projectId,
    youtube_video_id: c.videoId,
    url: c.url,
    title: c.title,
    description: c.description.slice(0, 4000),
    channel_id: c.channelId,
    channel_title: c.channelTitle,
    duration_seconds: c.durationSeconds,
    score: c.score,
    status: c.rejected ? "rejected" : "candidate",
    metadata: {
      reasons: c.reasons,
      rejectReason: c.rejectReason ?? null,
      isLive: c.isLive,
      privacyStatus: c.privacyStatus,
      matched_query: c.matched_query,
      intended_subject: c.intended_subject,
      source_intent: c.source_intent,
    },
  }));
  if (candidateRows.length) {
    const { error } = await sb.from("youtube_search_results").insert(candidateRows);
    if (error) throw new Error(`save candidates: ${error.message}`);
  }

  // 5) Pick top N
  const accepted = Array.from(allCandidates.values())
    .filter((c) => !c.rejected)
    .sort((a, b) => b.score - a.score)
    .slice(0, env.MAX_VIDEOS_PER_PROJECT);

  if (accepted.length === 0) {
    await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { note: "no accepted candidates" } });
    await setProjectStatus(projectId, "failed");
    throw new Error("No usable YouTube candidates found");
  }

  // 6) Mark accepted in DB and enqueue downloads (one media_job + bull job per video)
  await setProjectStatus(projectId, "downloading");
  for (const a of accepted) {
    const { error: updErr } = await sb
      .from("youtube_search_results")
      .update({ status: "selected" })
      .eq("project_id", projectId)
      .eq("youtube_video_id", a.videoId);
    if (updErr) await logJob({ projectId, jobId: mediaJobId }, "search.mark_selected.failed", { err: updErr.message });

    const childJobId = await createMediaJob({
      projectId,
      type: "download",
      metadata: { youtube_video_id: a.videoId, youtube_url: a.url, title: a.title },
    });
    await enqueueDownload({
      projectId, mediaJobId: childJobId,
      youtubeVideoId: a.videoId, youtubeUrl: a.url,
    });
  }

  await setMediaJob(mediaJobId, { status: "completed", progress: 100, metadata: { accepted: accepted.length } });
}

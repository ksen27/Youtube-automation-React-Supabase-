import type { MatchJobData } from "@/lib/jobs/queue";
import { logJob, setMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { getServerSupabase } from "@/lib/supabase/server";
import { scoreClipsForSections, type ClipForMatch, type SectionScore } from "@/lib/ai/gemini";
import {
  buildBlockSequence,
  planTimeline,
  pickDuration,
  sumDurations,
  type PlannedBlock,
} from "@/lib/ai/timeline-plan";
import { estimateDurationSeconds } from "@/lib/ai/segments";

// Below this score (0–100), Gemini judged the clip a poor visual fit for the
// section. We'd rather downgrade the block to an image placeholder than burn
// a low-relevance clip there — that's exactly the failure mode that produced
// the "every block shows the same face" screenshot.
const MIN_RELEVANT_SCORE = 25;

// Splits a transcript into ~sentence/paragraph sections. Cheap MVP heuristic.
export function splitTranscript(transcript: string): string[] {
  const cleaned = transcript.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  // Try paragraph splits first
  const paras = transcript.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length >= 4) return paras;
  // Otherwise sentence-ish split
  const sents = cleaned.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).filter(Boolean);
  return sents.length ? sents : [cleaned];
}

export async function processMatchJob(data: MatchJobData): Promise<void> {
  const sb = getServerSupabase();
  const { projectId, mediaJobId } = data;

  await setMediaJob(mediaJobId, { status: "running", progress: 5 });
  await setProjectStatus(projectId, "matching");

  const { data: project } = await sb
    .from("projects")
    .select("transcript, voiceover_duration_seconds")
    .eq("id", projectId)
    .single();
  const transcript = project?.transcript ?? "";
  const sections = splitTranscript(transcript);

  // Voiceover duration drives the whole plan. Prefer the probed audio length;
  // fall back to a word-count estimate if the audio wasn't probed.
  const voiceoverSeconds =
    Number(project?.voiceover_duration_seconds) ||
    estimateDurationSeconds(transcript) ||
    0;

  if (voiceoverSeconds <= 0) {
    await setMediaJob(mediaJobId, {
      status: "failed",
      progress: 100,
      error: "voiceover duration unknown — re-upload the voiceover or paste a transcript",
    });
    await setProjectStatus(projectId, "failed");
    throw new Error("voiceover duration unknown");
  }

  const { data: clipRows } = await sb
    .from("video_clips")
    .select("id, start_time, end_time, labels, video_source_id, status")
    .eq("project_id", projectId)
    .eq("status", "ready");
  const clips = clipRows ?? [];

  if (clips.length === 0) {
    await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: "no ready clips to match" });
    await setProjectStatus(projectId, "failed");
    throw new Error("no ready clips to match");
  }

  // Hydrate source titles for matching prompt
  const sourceIds = Array.from(new Set(clips.map((c) => c.video_source_id))).filter(Boolean);
  const { data: sources } = await sb.from("video_sources").select("id, title").in("id", sourceIds);
  const titleById = new Map<string, string | null>(
    (sources ?? []).map((s) => [s.id as string, (s.title as string | null) ?? null])
  );

  const clipsForMatch: ClipForMatch[] = clips.map((c) => ({
    id: c.id,
    source_title: titleById.get(c.video_source_id) ?? null,
    start_time: c.start_time,
    end_time: c.end_time,
    labels: Array.isArray(c.labels) ? c.labels as string[] : [],
  }));

  // Score every (section, clip) pair so we can pick the best UNUSED clip per
  // section instead of falling back to insertion order when a top pick is
  // already consumed.
  let sectionScores: SectionScore[] = [];
  let geminiFailed = false;
  try {
    sectionScores = await scoreClipsForSections(sections, clipsForMatch);
  } catch (e) {
    geminiFailed = true;
    await logJob({ projectId, jobId: mediaJobId }, "match.gemini.failed", { err: (e as Error).message });
  }
  await setMediaJob(mediaJobId, { progress: 40 });

  // Index scores by section for O(1) lookup during assignment.
  const scoresBySection = new Map<number, SectionScore["candidates"]>();
  for (const s of sectionScores) {
    scoresBySection.set(s.section_index, s.candidates);
  }

  // Diagnostic: how many clips have empty labels? Empty labels mean the
  // Vision labeler failed during clipProcessor and Gemini has nothing to
  // score against — this is the most common cause of "every score is 0".
  const clipsWithLabels = clipsForMatch.filter((c) => (c.labels?.length ?? 0) > 0).length;

  // Diagnostic: distribution of scores so we can see whether scoring
  // produced data but everything fell below MIN_RELEVANT_SCORE.
  const scoreBuckets = { gte75: 0, gte50: 0, gte25: 0, gte1: 0, zero: 0 };
  for (const s of sectionScores) {
    for (const cand of s.candidates) {
      if (cand.score >= 75) scoreBuckets.gte75++;
      else if (cand.score >= 50) scoreBuckets.gte50++;
      else if (cand.score >= 25) scoreBuckets.gte25++;
      else if (cand.score >= 1) scoreBuckets.gte1++;
      else scoreBuckets.zero++;
    }
  }

  await logJob({ projectId, jobId: mediaJobId }, "match.scores", {
    sectionsScored: sectionScores.length,
    totalSections: sections.length,
    totalClips: clips.length,
    clipsWithLabels,
    clipsWithoutLabels: clips.length - clipsWithLabels,
    avgCandidatesPerSection: sectionScores.length
      ? Math.round((sectionScores.reduce((n, s) => n + s.candidates.length, 0) / sectionScores.length) * 10) / 10
      : 0,
    scoreBuckets,
    geminiThrew: geminiFailed,
    // If geminiThrew is false AND sectionsScored is 0, scoring returned []
    // through one of the silent failure paths in lib/ai/gemini.ts (parse
    // error or schema validation failure). That's an invisible degradation.
    silentScoringFailure: !geminiFailed && sectionScores.length === 0 && clips.length > 0,
    minRelevantScore: MIN_RELEVANT_SCORE,
  });

  // Build a plan + block sequence sized to the voiceover.
  const plan = planTimeline(voiceoverSeconds);
  const blocks = buildBlockSequence(plan);

  await logJob({ projectId, jobId: mediaJobId }, "match.plan", {
    voiceoverSeconds,
    avgBlockSeconds: plan.avgBlockSeconds,
    totalBlocks: plan.totalBlocks,
    footageBlocks: plan.footageBlocks,
    imageBlocks: plan.imageBlocks,
    bucket: plan.bucket,
    plannedDurationSum: Math.round(sumDurations(blocks) * 10) / 10,
  });

  // ---- Clip assignment (each clip used at most once) ---------------------
  // For each footage block (in order), pick the highest-scoring unused clip
  // for that block's section. If no scored candidate clears MIN_RELEVANT_SCORE
  // we downgrade to an image placeholder — a clean image beats a misleading
  // shot of the wrong subject.
  const usedClipIds = new Set<string>();

  // Tracks WHY each block got the clip it did, so the post-run log can tell
  // us whether scoring is working or whether everything fell to the fallback.
  const pickSourceCounts = {
    scored_top: 0,            // Gemini-scored clip cleared MIN_RELEVANT_SCORE
    scored_below_threshold: 0, // had a scored candidate but score < threshold
    no_scores_for_section: 0,  // section had no scored candidates at all
    intro_fallback_any: 0,     // intro reached pickAnyUnusedClip (insertion order)
    downgraded_to_image: 0,    // footage block downgraded
  };

  function pickClipForSection(sectionIdx: number): { clipId: string | null; score: number; reason?: string; source: "scored_top" | "scored_below_threshold" | "no_scores_for_section" } {
    // 1) Try scored candidates first, in score order.
    const scored = scoresBySection.get(sectionIdx) ?? [];
    if (scored.length === 0) {
      return { clipId: null, score: 0, source: "no_scores_for_section" };
    }
    for (const cand of scored) {
      if (usedClipIds.has(cand.clip_id)) continue;
      if (cand.score < MIN_RELEVANT_SCORE) break;     // sorted desc; rest are worse
      return { clipId: cand.clip_id, score: cand.score, reason: cand.reason, source: "scored_top" };
    }
    // Had scored candidates but none cleared the threshold (or all used).
    return { clipId: null, score: 0, source: "scored_below_threshold" };
  }

  function pickAnyUnusedClip(): string | null {
    // Last-resort fallback for the intro block: prefer high-scoring clips
    // (across any section) before falling through to arbitrary clip order.
    const seen = new Set<string>();
    for (const s of sectionScores) {
      for (const cand of s.candidates) {
        if (seen.has(cand.clip_id) || usedClipIds.has(cand.clip_id)) continue;
        seen.add(cand.clip_id);
        return cand.clip_id;
      }
    }
    for (const c of clips) {
      if (!usedClipIds.has(c.id as string)) return c.id as string;
    }
    return null;
  }

  // If we have far fewer clips than footage slots, pre-downgrade the surplus
  // footage blocks to image blocks. We leave the intro alone so the video
  // still opens with motion when possible.
  const footageBlockIdxs: number[] = blocks
    .map((b, i) => (b.type === "footage" || b.type === "intro" ? i : -1))
    .filter((i) => i >= 0);
  const surplus = footageBlockIdxs.length - clips.length;
  if (surplus > 0) {
    const convertibles = footageBlockIdxs.filter((i) => blocks[i].type !== "intro");
    const toConvert = convertibles.slice(-surplus);
    for (const idx of toConvert) {
      const newDur = pickDuration("image");
      blocks[idx] = { type: "image", duration: newDur };
    }
  }

  // Wipe old draft for this project (so re-runs work).
  await sb.from("timeline_items").delete().eq("project_id", projectId);

  // ---- Build timeline_items rows ----------------------------------------
  const items: Array<Record<string, unknown>> = [];
  let position = 0;
  let sectionCursor = 0;
  let assignedFootageCount = 0;
  let downgradedCount = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block: PlannedBlock = blocks[i];

    if (block.type === "intro") {
      // Intro: try the section-0 best pick first, then any unused clip so the
      // video opens with motion even if the score was low.
      const picked = pickClipForSection(0);
      let introClipId = picked.clipId;
      let pickSource: string = picked.source;
      if (!introClipId) {
        introClipId = pickAnyUnusedClip();
        if (introClipId) pickSource = "intro_fallback_any";
      }
      if (introClipId) usedClipIds.add(introClipId);
      // Record diagnostics
      if (picked.source === "scored_top") pickSourceCounts.scored_top++;
      else if (picked.source === "scored_below_threshold") pickSourceCounts.scored_below_threshold++;
      else pickSourceCounts.no_scores_for_section++;
      if (pickSource === "intro_fallback_any") pickSourceCounts.intro_fallback_any++;
      items.push({
        project_id: projectId,
        clip_id: introClipId ?? null,
        type: "intro",
        position: position++,
        duration: block.duration,
        script_text: sections[0] ?? null,
        overlay_text: null,
        metadata: {
          planned: true,
          match_score: picked.clipId ? picked.score : 0,
          match_reason: picked.reason ?? null,
          pick_source: pickSource,
        },
        approved: false,
      });
      if (introClipId) assignedFootageCount++;
      continue;
    }

    if (block.type === "footage") {
      const picked = pickClipForSection(sectionCursor);
      // Record diagnostics regardless of outcome
      if (picked.source === "scored_top") pickSourceCounts.scored_top++;
      else if (picked.source === "scored_below_threshold") pickSourceCounts.scored_below_threshold++;
      else pickSourceCounts.no_scores_for_section++;
      if (picked.clipId) {
        usedClipIds.add(picked.clipId);
        items.push({
          project_id: projectId,
          clip_id: picked.clipId,
          type: "footage",
          position: position++,
          duration: block.duration,
          script_text: sections[sectionCursor] ?? null,
          overlay_text: null,
          metadata: {
            planned: true,
            match_score: picked.score,
            match_reason: picked.reason ?? null,
            pick_source: picked.source,
            section_index: sectionCursor,
          },
          approved: false,
        });
        assignedFootageCount++;
      } else {
        pickSourceCounts.downgraded_to_image++;
        // No relevant clip → image placeholder (better than a misleading shot).
        items.push({
          project_id: projectId,
          clip_id: null,
          type: "image",
          position: position++,
          duration: pickDuration("image"),
          script_text: sections[sectionCursor] ?? null,
          overlay_text: null,
          metadata: {
            placeholder: true,
            planned: true,
            downgraded_from: "footage",
            downgrade_reason: picked.source === "no_scores_for_section"
              ? "section had no scored candidates"
              : "no clip cleared MIN_RELEVANT_SCORE",
            pick_source: picked.source,
            section_index: sectionCursor,
          },
          approved: false,
        });
        downgradedCount++;
      }
      sectionCursor = Math.min(sections.length - 1, sectionCursor + 1);
      continue;
    }

    // Image / split blocks — placeholders, no clip.
    items.push({
      project_id: projectId,
      clip_id: null,
      type: block.type,
      position: position++,
      duration: block.duration,
      script_text: sections[sectionCursor] ?? null,
      overlay_text: null,
      metadata: { placeholder: true, planned: true },
      approved: false,
    });
    sectionCursor = Math.min(sections.length - 1, sectionCursor + 1);
  }

  // Lower-third overlays for the first few celebrity / year / place entities.
  // These don't consume timeline duration in the renderer (they're overlays),
  // so we keep them outside the planned-block sum.
  const { data: ents } = await sb.from("project_entities")
    .select("type, value").eq("project_id", projectId)
    .in("type", ["celebrity", "year", "place"]).limit(6);
  for (const e of ents ?? []) {
    items.push({
      project_id: projectId, clip_id: null, type: "lower_third",
      position: position++, duration: 3,
      script_text: null,
      overlay_text: `${e.value}`,
      metadata: { entity_type: e.type, overlay: true },
      approved: false,
    });
  }

  // Diagnostic summary: tells us at a glance whether the matcher is using
  // Gemini scores or silently degrading to insertion-order fallback. If
  // pickSourceCounts.scored_top is 0 and the others are non-zero, scoring
  // is broken — check match.scores log entry for the cause.
  await logJob({ projectId, jobId: mediaJobId }, "match.assignment", {
    pickSourceCounts,
    assignedFootageCount,
    downgradedCount,
    uniqueClipsUsed: usedClipIds.size,
    totalFootageBlocks: footageBlockIdxs.length,
  });

  await setMediaJob(mediaJobId, { progress: 80 });
  const { error: insErr } = await sb.from("timeline_items").insert(items);
  if (insErr) throw new Error(`insert timeline_items: ${insErr.message}`);

  const plannedSum = Math.round(sumDurations(blocks) * 10) / 10;
  await setMediaJob(mediaJobId, {
    status: "completed",
    progress: 100,
    metadata: {
      items: items.length,
      voiceoverSeconds,
      avgBlockSeconds: plan.avgBlockSeconds,
      totalBlocks: plan.totalBlocks,
      footageBlocks: plan.footageBlocks,
      imageBlocks: plan.imageBlocks,
      bucket: plan.bucket,
      plannedDurationSum: plannedSum,
      uniqueClipsUsed: usedClipIds.size,
      assignedFootageCount,
      downgradedCount,
    },
  });
  await setProjectStatus(projectId, "ready_for_review");
}

import type { MatchJobData } from "@/lib/jobs/queue";
import { logJob, setMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { getServerSupabase } from "@/lib/supabase/server";
import { scoreClipsForSections, type ClipForMatch, type SectionScore } from "@/lib/ai/gemini";
import {
  buildBlockSequence,
  planTimeline,
  sumDurations,
  type PlannedBlock,
} from "@/lib/ai/timeline-plan";
import { estimateDurationSeconds } from "@/lib/ai/segments";
import { fetchImages } from "@/lib/images/fetch";

// Below this score (0–100), Gemini judged the clip a poor visual fit for the
// block's spoken words. We'd rather downgrade the block to an image
// placeholder than burn a low-relevance clip there — that's exactly the
// failure mode that produced the "every block shows the same face"
// screenshot.
const MIN_RELEVANT_SCORE = 25;

// Splits a transcript into ~sentence/paragraph sections. Retained for
// backward-compatibility / test imports; the matcher itself no longer uses
// section-cursor logic. See buildBlockTexts() below for the time-aligned
// approach that replaced it.
export function splitTranscript(transcript: string): string[] {
  const cleaned = transcript.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const paras = transcript.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length >= 4) return paras;
  const sents = cleaned.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).filter(Boolean);
  return sents.length ? sents : [cleaned];
}

// For each timeline block, return the words of the voiceover that are
// (approximately) being spoken during that block's wall-clock window.
//
// Why this exists:
//   The old matcher split the transcript into sentences and walked a
//   sectionCursor that incremented per block — regardless of how long
//   each section actually took to read aloud. A 3-word sentence and a
//   60-word paragraph both consumed one block, so visuals drifted out
//   of sync with audio. Image blocks also incremented the cursor,
//   silently skipping sections.
//
// How it works:
//   We assume the voiceover narrates at a steady pace (words spread
//   uniformly across the duration). For each block's time window
//   [blockStart, blockEnd], we slice the proportional word range out
//   of the transcript and join. This is cheap, deterministic, and
//   gives the matcher exactly the right text to score against.
//
//   When word-level timestamps from Deepgram become available, swap
//   the proportional slicing for actual word boundaries — the
//   surrounding interface stays identical.
export function buildBlockTexts(
  transcript: string,
  blocks: PlannedBlock[],
  voiceoverSeconds: number,
): string[] {
  const cleaned = transcript.replace(/\s+/g, " ").trim();
  const words = cleaned.length ? cleaned.split(" ") : [];
  if (words.length === 0 || voiceoverSeconds <= 0) return blocks.map(() => "");
  const wordsPerSecond = words.length / voiceoverSeconds;

  let acc = 0;
  const out: string[] = [];
  for (const block of blocks) {
    const blockStart = acc;
    const blockEnd = acc + block.duration;
    acc = blockEnd;
    const startWord = Math.max(0, Math.floor(blockStart * wordsPerSecond));
    const endWord = Math.min(words.length, Math.ceil(blockEnd * wordsPerSecond));
    // Pad each window slightly so very short blocks (4-6s) don't get
    // degenerate 1-2 word strings that score poorly. ±1s of padding
    // gives the scorer real context without bleeding across many blocks.
    const paddedStart = Math.max(0, Math.floor((blockStart - 1) * wordsPerSecond));
    const paddedEnd = Math.min(words.length, Math.ceil((blockEnd + 1) * wordsPerSecond));
    const slice = words.slice(
      Math.min(paddedStart, startWord),
      Math.max(paddedEnd, endWord),
    );
    out.push(slice.join(" "));
  }
  return out;
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

  // Load all extracted entities for this project. We use them to bias the
  // scorer so that when a block's text mentions a place / event / movie /
  // song / company / TV show / age, the matched clip's labels SHOULD match
  // that specific entity — not just be generic celebrity B-roll.
  // (Phase A of the entity-aware matching feature.)
  const { data: entityRows } = await sb
    .from("project_entities")
    .select("type, value, confidence")
    .eq("project_id", projectId);
  const allEntities: Array<{ type: string; value: string }> = (entityRows ?? [])
    .map((e) => ({ type: e.type as string, value: String(e.value ?? "") }))
    .filter((e) => e.value.trim().length > 0);

  // ---- Intro clip selection --------------------------------------------
  // Pick a clip showing the main celebrity in an interview-like setting.
  // The intro plays before the planned timeline with the source's ORIGINAL
  // audio (re-downloaded by the render step) — voiceover starts after.
  // Reserved before global assignment so it isn't reused elsewhere.
  const mainCelebrity = (entityRows ?? [])
    .filter((e) => e.type === "celebrity")
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]?.value as string | undefined;

  const INTERVIEW_SETTING_RE = /interview|sit[- ]?down|talk show|podcast|conversation|host/i;
  const INTERVIEW_LABEL_RE = /interview|talking|speaking|microphone|host/i;
  const STAGED_SETTING_RE = /studio|stage|set\b/i;
  // A frame must visibly contain a person to qualify as a usable intro
  // clip. Without this gate, a car-grille close-up from a Dave Kindig
  // interview source gets labeled as "subject: Dave Kindig" by the
  // title-context-prone Vision labeler, scores 110/110 on intro
  // criteria, and ships as the intro — even though no person is in
  // the frame. The PERSON_VISIBLE_RE check forces real human content.
  const PERSON_VISIBLE_RE = /\b(face|person|man|woman|host|interviewee|guest|portrait|headshot|smiling|talking head|speaker|shoulders|sitting|standing|wearing)\b/i;
  // Hard exclusions — labels that strongly suggest the frame is NOT a
  // person shot, even if the labeler also hallucinated a celebrity name.
  const NOT_PERSON_RE = /\b(grille|engine|wheel|hood|bumper|dashboard|tire|exhaust|paint|garage floor|shop floor|tool|wrench|chassis|product|logo only)\b/i;

  function scoreIntroCandidate(c: { id: string; labels?: string[]; source_title: string | null }): number {
    const labelStr = (c.labels ?? []).join(" ").toLowerCase();
    // Gate 1: hard reject if labels suggest no-person object content.
    if (NOT_PERSON_RE.test(labelStr)) return 0;
    // Gate 2: must have at least one person-visible token. Prevents
    // hallucinated celebrity-name labels from passing on object frames.
    if (!PERSON_VISIBLE_RE.test(labelStr)) return 0;

    let score = 0;
    if (mainCelebrity) {
      const cel = mainCelebrity.toLowerCase();
      // Celebrity name in labels still scores, but only after the
      // person-visible gate passed — so we know an actual person IS
      // in the frame. The +50 is "labels say it's the celebrity AND
      // a person is visible" not "labels say it's the celebrity."
      if (labelStr.includes(cel)) score += 50;
      if ((c.source_title ?? "").toLowerCase().includes(cel)) score += 10;
    }
    // Setting check — grab the `setting: ...` label entry if present.
    const settingLabel = (c.labels ?? []).find((l) => l.toLowerCase().startsWith("setting:")) ?? "";
    if (INTERVIEW_SETTING_RE.test(settingLabel)) score += 30;
    else if (STAGED_SETTING_RE.test(settingLabel)) score += 10;
    if (INTERVIEW_LABEL_RE.test(labelStr)) score += 20;
    return score;
  }

  // Tiered intro selection. We pick the highest-scoring clip; if everything
  // scores 0 the intro is skipped (rendered without one).
  let introClipId: string | null = null;
  let introClipScore = 0;
  let introClipDuration = 0;
  let introSelectionTier: "celebrity_interview" | "celebrity_any" | "source_title_match" | "skipped" = "skipped";
  {
    const ranked = clipsForMatch
      .map((c) => ({ c, score: scoreIntroCandidate(c) }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (best && best.score > 0) {
      introClipId = best.c.id;
      introClipScore = best.score;
      // Find the original clip row so we know its duration. We clamp to
      // 5–6s; the YouTube clip is usually 5s already, so this is mostly a
      // safety net for any longer clips that slipped through.
      const fullClip = clips.find((cc) => cc.id === best.c.id);
      const cutDuration = fullClip
        ? Math.max(0, (Number(fullClip.end_time) || 0) - (Number(fullClip.start_time) || 0))
        : 5.5;
      introClipDuration = Math.min(6, Math.max(5, cutDuration || 5.5));
      // Classify which tier won. Used only for diagnostics.
      if (best.score >= 70) introSelectionTier = "celebrity_interview";
      else if (best.score >= 50) introSelectionTier = "celebrity_any";
      else introSelectionTier = "source_title_match";
    }
  }

  await logJob({ projectId, jobId: mediaJobId }, "match.intro", {
    mainCelebrity: mainCelebrity ?? null,
    introClipId,
    introClipScore,
    introClipDuration,
    tier: introSelectionTier,
    candidatesScored: clipsForMatch.length,
  });

  // Persist the intro selection on the project. Render step picks it up.
  // intro_audio_url + intro_duration_seconds get filled by the renderer
  // after yt-dlp + ffmpeg cut the matching audio segment.
  await sb.from("projects").update({
    intro_clip_id: introClipId,
    intro_duration_seconds: introClipDuration || null,
    // Clear any stale audio URL from a previous run — the renderer will
    // re-download to match the newly-selected intro clip.
    intro_audio_url: null,
  }).eq("id", projectId);

  // ---- Build the block plan first ---------------------------------------
  // The block sequence is the unit of matching now. Each block's wall-clock
  // window determines what voiceover words it covers; clips are scored
  // against THAT text, not against arbitrary pre-split sections.
  const plan = planTimeline(voiceoverSeconds);
  const blocks = buildBlockSequence(plan);

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
      // Preserve the footage duration on conversion so we don't inflate
      // total slideshow time when clip supply is tight.
      blocks[idx] = { type: "image", duration: blocks[idx].duration };
    }
  }

  // For each block, derive the voiceover text spoken during that window.
  // The scorer treats each block as a "section" — same prompt, but the
  // text now lines up with the block's actual moment in the audio.
  const blockTexts = buildBlockTexts(transcript, blocks, voiceoverSeconds);

  // For each block, find which entities are mentioned in its spoken text.
  // We do a case-insensitive substring search on each entity value. This is
  // intentionally simple — Gemini does the actual semantic ranking; this
  // step just tells the scorer which named entities are in play for the
  // moment so it can prioritize visually-specific clips over generic ones.
  const blockEntities: Array<Array<{ type: string; value: string }>> = blockTexts.map((text) => {
    if (!text) return [];
    const lower = text.toLowerCase();
    const out: Array<{ type: string; value: string }> = [];
    const seen = new Set<string>();
    for (const ent of allEntities) {
      const key = `${ent.type}:${ent.value.toLowerCase()}`;
      if (seen.has(key)) continue;
      if (lower.includes(ent.value.toLowerCase())) {
        out.push(ent);
        seen.add(key);
      }
    }
    return out;
  });

  // Entity diagnostics: how many blocks have at least one entity, and the
  // total number of (block, entity) pairs across the timeline. If this is
  // 0, the entity-aware matching has nothing to bias on and Phase A is
  // effectively inert — usually because extractEntities returned [] or
  // the entity values don't appear verbatim in the transcript words.
  const blocksWithEntities = blockEntities.filter((e) => e.length > 0).length;
  const totalEntityHits = blockEntities.reduce((n, e) => n + e.length, 0);

  await logJob({ projectId, jobId: mediaJobId }, "match.plan", {
    voiceoverSeconds,
    avgBlockSeconds: plan.avgBlockSeconds,
    totalBlocks: plan.totalBlocks,
    footageBlocks: plan.footageBlocks,
    imageBlocks: plan.imageBlocks,
    bucket: plan.bucket,
    plannedDurationSum: Math.round(sumDurations(blocks) * 10) / 10,
    blockTextSampleHead: blockTexts[0]?.slice(0, 100) ?? "",
    blockTextSampleMid: blockTexts[Math.floor(blocks.length / 2)]?.slice(0, 100) ?? "",
    entitiesLoaded: allEntities.length,
    blocksWithEntities,
    totalEntityHits,
  });

  // Score only the blocks that actually need a clip (footage + intro). We
  // skip image/split blocks here because we never assign clips to them —
  // sending them to Gemini would burn tokens for nothing.
  const scorableBlockIdxs: number[] = [];
  const scorableTexts: string[] = [];
  const scorableEntities: Array<Array<{ type: string; value: string }>> = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === "footage" || blocks[i].type === "intro") {
      scorableBlockIdxs.push(i);
      scorableTexts.push(blockTexts[i]);
      scorableEntities.push(blockEntities[i]);
    }
  }

  let blockScores: SectionScore[] = [];
  let geminiFailed = false;
  try {
    // topN=8 — each block needs enough alternatives that "my top 3 are
    // already used by earlier blocks" doesn't immediately downgrade us.
    // With 72 blocks and ~110 clips, narrow candidate pools (topN=3) cause
    // clip starvation: late blocks find every option already assigned.
    blockScores = await scoreClipsForSections(scorableTexts, clipsForMatch, 8, scorableEntities);
  } catch (e) {
    geminiFailed = true;
    await logJob({ projectId, jobId: mediaJobId }, "match.gemini.failed", { err: (e as Error).message });
  }
  await setMediaJob(mediaJobId, { progress: 40 });

  // Translate scorer's local section_index back to the block index in `blocks`.
  // (scoreClipsForSections returns indices into its own input array, which
  // is `scorableTexts`. We map those to absolute block indices.)
  const scoresByBlock = new Map<number, SectionScore["candidates"]>();
  for (const s of blockScores) {
    const blockIdx = scorableBlockIdxs[s.section_index];
    if (blockIdx === undefined) continue;
    scoresByBlock.set(blockIdx, s.candidates);
  }

  const clipsWithLabels = clipsForMatch.filter((c) => (c.labels?.length ?? 0) > 0).length;
  const scoreBuckets = { gte75: 0, gte50: 0, gte25: 0, gte1: 0, zero: 0 };
  for (const s of blockScores) {
    for (const cand of s.candidates) {
      if (cand.score >= 75) scoreBuckets.gte75++;
      else if (cand.score >= 50) scoreBuckets.gte50++;
      else if (cand.score >= 25) scoreBuckets.gte25++;
      else if (cand.score >= 1) scoreBuckets.gte1++;
      else scoreBuckets.zero++;
    }
  }

  await logJob({ projectId, jobId: mediaJobId }, "match.scores", {
    blocksScored: blockScores.length,
    totalScorableBlocks: scorableBlockIdxs.length,
    totalBlocks: blocks.length,
    totalClips: clips.length,
    clipsWithLabels,
    clipsWithoutLabels: clips.length - clipsWithLabels,
    avgCandidatesPerBlock: blockScores.length
      ? Math.round((blockScores.reduce((n, s) => n + s.candidates.length, 0) / blockScores.length) * 10) / 10
      : 0,
    scoreBuckets,
    geminiThrew: geminiFailed,
    silentScoringFailure: !geminiFailed && blockScores.length === 0 && clips.length > 0,
    minRelevantScore: MIN_RELEVANT_SCORE,
  });

  // ---- Tier 1: Gemini-scored global assignment -------------------------
  // Greedy-by-best-score across all (block, clip) pairs that cleared
  // MIN_RELEVANT_SCORE. Walk triples by score desc; assign each pair to its
  // block IF both block and clip are still free. Each clip used at most
  // once. This produces all the high-confidence matches.
  type Triple = { blockIdx: number; clipId: string; score: number; reason?: string };
  const triples: Triple[] = [];
  for (const [blockIdx, cands] of scoresByBlock) {
    for (const c of cands) {
      if (c.score < MIN_RELEVANT_SCORE) continue;
      triples.push({ blockIdx, clipId: c.clip_id, score: c.score, reason: c.reason });
    }
  }
  triples.sort((a, b) => b.score - a.score);

  type Assignment = { clipId: string; score: number; reason?: string; tier: "scored" | "filler" };
  const blockAssignments = new Map<number, Assignment>();
  const usedClipIds = new Set<string>();
  // Reserve the intro clip so the regular matcher can't re-use it inside
  // the timeline. The intro plays as a prefix segment, not as a timeline block.
  if (introClipId) usedClipIds.add(introClipId);
  for (const t of triples) {
    if (blockAssignments.has(t.blockIdx)) continue;
    if (usedClipIds.has(t.clipId)) continue;
    blockAssignments.set(t.blockIdx, {
      clipId: t.clipId, score: t.score, reason: t.reason, tier: "scored",
    });
    usedClipIds.add(t.clipId);
  }

  // ---- Tier 2: Label-overlap fill for unassigned footage blocks --------
  // Per the user spec: keep 60/40 video:image ratio by filling every
  // footage block with SOMETHING. When Gemini didn't score a usable clip,
  // pick the unused clip whose labels best overlap with the block's text.
  // Each clip still used at most once. If the unused-pool runs out, the
  // remaining blocks downgrade to image (logged as a warning so we know
  // the project under-provisioned clips for its voiceover length).
  //
  // Token-overlap is cheap and deterministic — Jaccard-ish: count the
  // distinct tokens in clip.labels that appear in the block's words.
  // Better than random/round-robin because it gives Tier 2 fills SOME
  // topical relevance even when Gemini couldn't score them.
  const STOP = new Set([
    "the","a","an","of","and","or","to","in","on","for","with","at","by","from",
    "as","is","are","was","were","be","been","this","that","these","those",
  ]);
  function tokenize(s: string): Set<string> {
    const out = new Set<string>();
    for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length >= 3 && !STOP.has(t)) out.add(t);
    }
    return out;
  }
  // Pre-tokenize each clip's labels once. The label set already includes
  // primarySubject and setting prefixes from clipProcessor.
  const clipTokens = new Map<string, Set<string>>();
  for (const c of clipsForMatch) {
    clipTokens.set(c.id, tokenize((c.labels ?? []).join(" ")));
  }

  function pickFillerForBlock(blockIdx: number): { clipId: string; overlap: number } | null {
    const blockText = blockTexts[blockIdx] ?? "";
    if (!blockText) {
      // No words to compare against — fall back to first unused clip.
      for (const c of clipsForMatch) {
        if (!usedClipIds.has(c.id)) return { clipId: c.id, overlap: 0 };
      }
      return null;
    }
    const blockToks = tokenize(blockText);
    let best: { clipId: string; overlap: number } | null = null;
    for (const c of clipsForMatch) {
      if (usedClipIds.has(c.id)) continue;
      const labels = clipTokens.get(c.id) ?? new Set();
      let overlap = 0;
      for (const t of labels) if (blockToks.has(t)) overlap++;
      if (!best || overlap > best.overlap) {
        best = { clipId: c.id, overlap };
      }
    }
    return best;
  }

  for (const blockIdx of scorableBlockIdxs) {
    if (blockAssignments.has(blockIdx)) continue;
    const filler = pickFillerForBlock(blockIdx);
    if (!filler) continue;     // pool exhausted → handled in render loop
    blockAssignments.set(blockIdx, {
      clipId: filler.clipId,
      score: 0,
      reason: filler.overlap > 0 ? `filler: ${filler.overlap} label tokens` : "filler: no overlap",
      tier: "filler",
    });
    usedClipIds.add(filler.clipId);
  }

  // Diagnostic counters — track the tier so logs reveal whether scoring
  // or filling was carrying the timeline.
  const pickSourceCounts = {
    scored_top: 0,          // Tier 1: Gemini-scored ≥ MIN_RELEVANT_SCORE
    filler_overlap: 0,      // Tier 2: label-token overlap ≥ 1
    filler_any: 0,          // Tier 2: any unused clip (overlap = 0)
    pool_exhausted: 0,      // Tier 2 found no unused clips → block downgraded
  };

  // Wipe old draft for this project (so re-runs work).
  await sb.from("timeline_items").delete().eq("project_id", projectId);

  const items: Array<Record<string, unknown>> = [];
  let position = 0;
  let assignedFootageCount = 0;
  let downgradedCount = 0;

  // Prepend the intro as a UI-only timeline item. The renderer ignores
  // type='intro' rows (it pulls intro_clip_id directly from the projects
  // table) — this row exists so the matcher UI can show the intro card
  // at the top of the list. The script_text is intentionally NOT a
  // voiceover slice; the intro plays the celebrity's source audio with
  // voiceover silent for the first 5–6s.
  if (introClipId) {
    const introCaption = mainCelebrity
      ? `Intro — ${mainCelebrity} speaking (${introClipDuration}s, original audio)`
      : `Intro — celebrity speaking (${introClipDuration}s, original audio)`;
    items.push({
      project_id: projectId,
      clip_id: introClipId,
      type: "intro",
      position: position++,
      duration: introClipDuration,
      script_text: introCaption,
      overlay_text: null,
      metadata: {
        is_intro: true,
        match_score: introClipScore,
        intro_tier: introSelectionTier,
        plays_source_audio: true,
        ui_only: true,    // renderer must skip this item
      },
      approved: false,
    });
  }

  for (let i = 0; i < blocks.length; i++) {
    const block: PlannedBlock = blocks[i];
    const assigned = blockAssignments.get(i);
    const blockText = blockTexts[i] ?? "";

    // The intro is handled OUTSIDE the timeline (projects.intro_clip_id +
    // render-step prefix segment). buildBlockSequence no longer emits an
    // intro block, so block.type can only be "footage" / "image" / "split_*".
    if (block.type === "footage") {
      if (assigned) {
        // Tier 1 (scored) or Tier 2 (filler) — both keep the block as
        // footage. The 60/40 ratio holds because the footage block stays
        // a footage block; only the SOURCE of the clip differs.
        let pickSource: string;
        if (assigned.tier === "scored") {
          pickSourceCounts.scored_top++;
          pickSource = "scored_top";
        } else if ((assigned.reason ?? "").startsWith("filler: ") && !(assigned.reason ?? "").endsWith("no overlap")) {
          pickSourceCounts.filler_overlap++;
          pickSource = "filler_overlap";
        } else {
          pickSourceCounts.filler_any++;
          pickSource = "filler_any";
        }
        items.push({
          project_id: projectId,
          clip_id: assigned.clipId,
          type: "footage",
          position: position++,
          duration: block.duration,
          script_text: blockText || null,
          overlay_text: null,
          metadata: {
            planned: true,
            match_score: assigned.score,
            match_reason: assigned.reason ?? null,
            pick_source: pickSource,
            block_index: i,
          },
          approved: false,
        });
        assignedFootageCount++;
      } else {
        // Pool exhausted — the unused-clip pool ran dry before every
        // footage block could be filled. This means clip generation
        // didn't produce enough usable clips for the voiceover length;
        // fix by raising MAX_CLIPS_PER_VIDEO or relaxing the junk filter.
        pickSourceCounts.pool_exhausted++;
        items.push({
          project_id: projectId,
          clip_id: null,
          type: "image",
          position: position++,
          duration: block.duration,
          script_text: blockText || null,
          overlay_text: null,
          metadata: {
            placeholder: true,
            planned: true,
            downgraded_from: "footage",
            downgrade_reason: "unused-clip pool exhausted",
            pick_source: "pool_exhausted",
            block_index: i,
            preserved_footage_duration: true,
          },
          approved: false,
        });
        downgradedCount++;
      }
      continue;
    }

    // Image / split blocks — placeholders, no clip.
    items.push({
      project_id: projectId,
      clip_id: null,
      type: block.type,
      position: position++,
      duration: block.duration,
      script_text: blockText || null,
      overlay_text: null,
      metadata: { placeholder: true, planned: true, block_index: i },
      approved: false,
    });
  }

  // ---- Build a project-level image pool, then assign to image blocks ----
  // Strategy change (vs. per-block voiceover-substring matching):
  //   The transcript already produced a list of named entities at analysis
  //   time. Instead of scanning each block's words for entity mentions and
  //   firing one image search per hit, we fetch a small batch of images per
  //   useful entity ONCE, dedupe URLs, and assign them in order to image
  //   blocks. Each fetched image appears at most once in the final video.
  //
  //   Why: most narrative blocks don't contain a verbatim entity name, so
  //   the old approach left ~70% of image blocks empty. The pool approach
  //   reuses the project's pre-extracted entities — the same set we've
  //   already vetted as relevant — for every image slot.
  //
  // Source priority: Wikipedia first (free, rights-clean) then Google CSE
  // for variety. YouTube thumbnails are no longer used at all.
  //
  // Skipped entity types: "year" and "age" produce nonsense image searches
  // (a bare "2021" returns whatever YouTube/CSE thinks is relevant for that
  // string — usually unrelated). Skip them; "place" / "event" / "company"
  // tend to produce on-topic imagery.
  const POOL_SKIP_TYPES = new Set(["year", "age"]);
  const ENTITY_TYPE_PRIORITY: string[] = [
    "celebrity", "related_person", "company", "tv_show",
    "movie", "song", "place", "event",
  ];
  const IMAGES_PER_ENTITY = 5;

  const imageBlockCount = items.filter((it) => it.type === "image").length;

  // Sort entities by priority then confidence so the most-relevant pictures
  // land at the head of the pool. This matters when the pool is shorter
  // than the image-block count — the head fills the early blocks first.
  const poolEntities = (entityRows ?? [])
    .map((e) => ({
      type: e.type as string,
      value: String(e.value ?? "").trim(),
      confidence: Number(e.confidence ?? 0.8),
    }))
    .filter((e) => e.value.length > 0 && !POOL_SKIP_TYPES.has(e.type))
    .sort((a, b) => {
      const pa = ENTITY_TYPE_PRIORITY.indexOf(a.type);
      const pb = ENTITY_TYPE_PRIORITY.indexOf(b.type);
      const ranka = pa < 0 ? 999 : pa;
      const rankb = pb < 0 ? 999 : pb;
      if (ranka !== rankb) return ranka - rankb;
      return b.confidence - a.confidence;
    });

  type PoolImage = { url: string; source: string; query: string; entityType: string };
  const pool: PoolImage[] = [];
  const poolUrlSet = new Set<string>();
  const poolFetchStats = { entitiesQueried: 0, entitiesFailed: 0 };

  for (const ent of poolEntities) {
    if (pool.length >= imageBlockCount) break;       // already have enough
    poolFetchStats.entitiesQueried++;
    try {
      const fetched = await fetchImages(ent.value, IMAGES_PER_ENTITY, { entityType: ent.type });
      if (fetched.length === 0) {
        poolFetchStats.entitiesFailed++;
        continue;
      }
      for (const f of fetched) {
        if (poolUrlSet.has(f.url)) continue;          // dedupe across entities
        pool.push({ url: f.url, source: f.source, query: ent.value, entityType: ent.type });
        poolUrlSet.add(f.url);
        if (pool.length >= imageBlockCount) break;
      }
    } catch (e) {
      poolFetchStats.entitiesFailed++;
      void logJob({ projectId, jobId: mediaJobId },
        "match.image_fetch.failed", { query: ent.value, err: (e as Error).message });
    }
  }

  // Assign pool images to image blocks in timeline order. Each image is
  // consumed at most once. When the pool runs out, remaining blocks stay
  // blank — the renderer skips blocks without an image_url, which is what
  // the user requested ("each image only appears once, no duplicates").
  let poolIdx = 0;
  for (const item of items) {
    if (item.type !== "image") continue;
    if (poolIdx >= pool.length) break;
    const next = pool[poolIdx++];
    item.image_query = next.query;
    item.image_url = next.url;
    item.image_source = next.source;
  }

  await logJob({ projectId, jobId: mediaJobId }, "match.image_fetch", {
    totalImageBlocks: imageBlockCount,
    poolSize: pool.length,
    assigned: Math.min(pool.length, imageBlockCount),
    leftBlank: Math.max(0, imageBlockCount - pool.length),
    entitiesAvailable: poolEntities.length,
    entitiesQueried: poolFetchStats.entitiesQueried,
    entitiesFailed: poolFetchStats.entitiesFailed,
  });

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

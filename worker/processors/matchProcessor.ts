import type { MatchJobData } from "@/lib/jobs/queue";
import { logJob, setMediaJob, setProjectStatus } from "@/lib/jobs/db";
import { getServerSupabase } from "@/lib/supabase/server";
import {
  scoreClipsForSections,
  verifyIntroCandidates,
  type ClipForMatch,
  type SectionScore,
} from "@/lib/ai/gemini";
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
    .select("id, start_time, end_time, labels, video_source_id, status, thumbnail_url")
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
  // interview source passes on setting/source-title hints alone — even
  // though no person is in the frame.
  const PERSON_VISIBLE_RE = /\b(face|person|man|woman|host|interviewee|guest|portrait|headshot|smiling|talking head|speaker|shoulders|sitting|standing|wearing)\b/i;
  // Hard exclusions — labels that strongly suggest the frame is NOT a
  // person shot.
  const NOT_PERSON_RE = /\b(grille|engine|wheel|hood|bumper|dashboard|tire|exhaust|paint|garage floor|shop floor|tool|wrench|chassis|product|logo only)\b/i;
  // When a named person is a woman, the clip representing them should show
  // a woman; same for man. Clip labels never contain names (the labeler is
  // forbidden from emitting them), but they DO contain sex/age descriptors
  // — those are the only reliable on-frame signal we have for picking the
  // right person when the source documentary stars more than one.
  const WOMAN_RE = /\b(woman|girl|lady|female|actress|her|she|hostess)\b/i;
  const MAN_RE = /\b(\bman\b|boy|guy|male|actor|bearded|moustache|mustache)\b/i;
  // Heuristic sex inference for any named person. We don't have structured
  // gender metadata, so we look for matching pronouns near the name in the
  // transcript. Returns "woman" | "man" | null (unknown → no bias).
  // Cached per name because we call this for the main celebrity AND once
  // per related_person during lower-third tagging.
  const sexByName = new Map<string, "woman" | "man" | null>();
  function inferPersonSex(name: string): "woman" | "man" | null {
    const key = name.toLowerCase();
    if (sexByName.has(key)) return sexByName.get(key)!;
    const t = transcript.toLowerCase();
    let womanHits = 0;
    let manHits = 0;
    let idx = 0;
    while ((idx = t.indexOf(key, idx)) !== -1) {
      const ctx = t.slice(Math.max(0, idx - 80), Math.min(t.length, idx + key.length + 80));
      womanHits += (ctx.match(/\b(she|her|hers|herself|woman|lady)\b/g) ?? []).length;
      manHits += (ctx.match(/\b(he|him|his|himself|man|guy)\b/g) ?? []).length;
      idx += key.length;
    }
    let result: "woman" | "man" | null;
    if (womanHits === 0 && manHits === 0) result = null;
    else if (womanHits >= manHits * 2) result = "woman";
    else if (manHits >= womanHits * 2) result = "man";
    else result = null;
    sexByName.set(key, result);
    return result;
  }
  const mainCelebritySex = mainCelebrity ? inferPersonSex(mainCelebrity) : null;

  function scoreIntroCandidate(c: ClipForMatch): number {
    const labelStr = (c.labels ?? []).join(" ").toLowerCase();
    // The clip stage tags the head-of-source window (start ~ 0s) so the
    // matcher can prefer it. Head clips contain the actual opening shot,
    // which is what we want as an intro — both for picture and for the
    // audio the renderer cuts from the same window.
    const isIntroCandidate =
      (c.labels ?? []).some((l) => l.toLowerCase() === "intro_candidate")
      || (Number(c.start_time) || 0) < 1;
    // Intro-head clips bypass the person-visible / sex-agreement gates:
    // the labeler runs on a single thumbnail and frequently misses the
    // celebrity in the first frame (a title card, a wide shot, a logo).
    // Those clips are still the right pick because the AUDIO under them
    // is the celebrity's intro voice — which is the symptom we're fixing.
    if (!isIntroCandidate) {
      // Gate 1: hard reject if labels suggest no-person object content.
      if (NOT_PERSON_RE.test(labelStr)) return 0;
      // Gate 2: must have at least one person-visible token.
      if (!PERSON_VISIBLE_RE.test(labelStr)) return 0;
      // Gate 3: when we inferred the main celebrity's sex, reject clips
      // whose visible-attribute labels clearly contradict it. This is the
      // primary defense against picking a spouse/co-host of the opposite
      // sex from the same source video.
      if (mainCelebritySex === "woman" && MAN_RE.test(labelStr) && !WOMAN_RE.test(labelStr)) return 0;
      if (mainCelebritySex === "man" && WOMAN_RE.test(labelStr) && !MAN_RE.test(labelStr)) return 0;
    }

    let score = 0;
    // Strong preference for intro-head clips. The bonus is sized to dominate
    // the setting/sex/interview signals (max ~100) so a head clip from the
    // celebrity's source always outranks a mid-source interview clip; a head
    // clip from an unrelated source still loses to a celebrity-source
    // interview clip because it gets the head bonus but no source-title bonus.
    if (isIntroCandidate) score += 60;
    if (mainCelebrity) {
      // Source title is the only celebrity-name signal left now that
      // labels are name-free by design. It's weak — source titles often
      // name multiple people — but it's better than nothing for ranking
      // person-shots from the right documentary higher than unrelated
      // person-shots from other sources.
      if ((c.source_title ?? "").toLowerCase().includes(mainCelebrity.toLowerCase())) score += 30;
    }
    // Sex match bonus — rewards clips whose labels match the celebrity's
    // sex, beyond the contradiction gate above.
    if (mainCelebritySex === "woman" && WOMAN_RE.test(labelStr)) score += 20;
    if (mainCelebritySex === "man" && MAN_RE.test(labelStr)) score += 20;
    // Setting check — grab the `setting: ...` label entry if present.
    const settingLabel = (c.labels ?? []).find((l) => l.toLowerCase().startsWith("setting:")) ?? "";
    if (INTERVIEW_SETTING_RE.test(settingLabel)) score += 30;
    else if (STAGED_SETTING_RE.test(settingLabel)) score += 10;
    if (INTERVIEW_LABEL_RE.test(labelStr)) score += 20;
    return score;
  }

  // Two-stage intro selection:
  //   Stage 1 — heuristic ranking (source title + setting + sex + head bonus)
  //   Stage 2 — Gemini Vision verifier looks at the top-N thumbnails and
  //             picks the clip that ACTUALLY shows the celebrity on camera.
  //
  // Stage 2 exists because the heuristics let title cards / wrong-speaker
  // openings win whenever the labeler missed the person in the first frame
  // — and the audio is cut from the same window, so a title-card pick gives
  // narrator/title-screen audio instead of the celebrity's voice.
  let introClipId: string | null = null;
  let introClipScore = 0;
  let introClipDuration = 0;
  let introSelectionTier:
    | "verified"
    | "heuristic_fallback"
    | "skipped" = "skipped";
  let introVerifierReason: string | null = null;
  let introCandidateCount = 0;

  const ranked = clipsForMatch
    .map((c) => ({ c, score: scoreIntroCandidate(c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  function selectClip(clipId: string, score: number): void {
    introClipId = clipId;
    introClipScore = score;
    const fullClip = clips.find((cc) => cc.id === clipId);
    const cutDuration = fullClip
      ? Math.max(0, (Number(fullClip.end_time) || 0) - (Number(fullClip.start_time) || 0))
      : 5.5;
    introClipDuration = Math.min(6, Math.max(5, cutDuration || 5.5));
  }

  if (ranked.length > 0) {
    // Send up to 5 top heuristic candidates (with thumbnails) to Gemini.
    // 5 is enough to give the verifier real choice without ballooning the
    // request — most projects only have 2-3 plausible head-of-source clips
    // anyway. Skip candidates with no thumbnail_url; the verifier can't see
    // them. If after filtering we have nothing left, fall back to the top
    // heuristic pick.
    const TOP_N_FOR_VERIFY = 5;
    const verifyInputs = ranked
      .slice(0, TOP_N_FOR_VERIFY)
      .map(({ c }) => {
        const full = clips.find((cc) => cc.id === c.id);
        return {
          clipId: c.id,
          thumbnailUrl: (full?.thumbnail_url as string | undefined) ?? "",
          sourceTitle: c.source_title,
          labels: c.labels ?? [],
        };
      })
      .filter((x) => x.thumbnailUrl.length > 0);
    introCandidateCount = verifyInputs.length;

    if (mainCelebrity && verifyInputs.length > 0) {
      const verdict = await verifyIntroCandidates(
        mainCelebrity,
        mainCelebritySex,
        verifyInputs,
      );
      introVerifierReason = verdict.reason;
      if (verdict.winnerClipId) {
        const matched = ranked.find((r) => r.c.id === verdict.winnerClipId);
        selectClip(verdict.winnerClipId, matched?.score ?? 0);
        introSelectionTier = "verified";
      }
    }

    // Gemini found no qualifying candidate (or we couldn't run it). Fall
    // back to the top heuristic pick rather than shipping without an intro
    // — the heuristic is wrong sometimes, but skipping the intro entirely
    // is wrong every time.
    if (!introClipId) {
      const best = ranked[0];
      selectClip(best.c.id, best.score);
      introSelectionTier = "heuristic_fallback";
    }
  }

  await logJob({ projectId, jobId: mediaJobId }, "match.intro", {
    mainCelebrity: mainCelebrity ?? null,
    mainCelebritySex,
    introClipId,
    introClipScore,
    introClipDuration,
    tier: introSelectionTier,
    verifierReason: introVerifierReason,
    candidatesScored: clipsForMatch.length,
    candidatesVerified: introCandidateCount,
    heuristicRanked: ranked.length,
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
  // Skipped entity types: bare "year" entities produce flag-of-the-year or
  // historical-period noise rather than on-topic imagery. "age" is handled
  // via a per-type query strategy below (we search the celebrity at that
  // age range), so it is NOT in this set.
  const POOL_SKIP_TYPES = new Set(["year"]);
  const ENTITY_TYPE_PRIORITY: string[] = [
    "celebrity", "related_person", "company", "tv_show",
    "movie", "song", "place", "event", "life_event", "age",
  ];
  // Per-entity fetch cap. Sized large enough that a handful of strong
  // entities (celebrity + 2-3 related people + a show/company) can fill the
  // ~90 image blocks of a 30-minute timeline on their own. Image search APIs
  // happily return 10-15 results per query at no extra cost vs 5, and the
  // dedup + anti-clustering steps downstream keep variety high.
  const IMAGES_PER_ENTITY = 12;

  const imageBlockCount = items.filter((it) => it.type === "image").length;

  // Country, state, region, and continent names. Even when these are
  // legitimately proper nouns, image search for them returns flags, maps,
  // and coats of arms — which are never the right visual for a celebrity
  // documentary. Drop any "place" entity whose value is in this set, or
  // whose value resolves to one after stripping common prefixes ("the").
  // Match is lowercase and exact-on-words: "the united states" hits "united
  // states"; "salt lake city" does not match "city" alone.
  const GENERIC_PLACE_STOP = new Set([
    // Continents
    "africa", "antarctica", "asia", "europe", "north america", "south america", "australia", "oceania",
    // Big countries / common transcript references
    "united states", "usa", "u.s.", "u.s.a.", "america", "the states",
    "united kingdom", "uk", "u.k.", "great britain", "britain", "england", "scotland", "wales", "ireland", "northern ireland",
    "canada", "australia", "new zealand", "ireland",
    "france", "germany", "italy", "spain", "portugal", "netherlands", "belgium", "switzerland", "austria", "sweden", "norway", "denmark", "finland", "iceland", "greece", "russia", "poland", "ukraine",
    "china", "japan", "korea", "south korea", "north korea", "india", "pakistan", "bangladesh", "thailand", "vietnam", "indonesia", "philippines", "malaysia", "singapore",
    "mexico", "brazil", "argentina", "chile", "colombia", "peru", "venezuela", "cuba",
    "egypt", "south africa", "nigeria", "kenya", "morocco", "ethiopia",
    "israel", "turkey", "iran", "iraq", "saudi arabia", "uae",
    // US states
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
    "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
    "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
    "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
    "new jersey", "new mexico", "new york state", "north carolina", "north dakota", "ohio",
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota",
    "tennessee", "texas", "utah", "vermont", "virginia", "washington state", "west virginia",
    "wisconsin", "wyoming",
    // Common UK / CA / AU regions
    "scotland", "wales", "northern ireland", "ontario", "quebec", "british columbia",
    "new south wales", "victoria", "queensland",
  ]);
  function isGenericPlace(value: string): boolean {
    const norm = value.toLowerCase().replace(/^the\s+/, "").trim();
    return GENERIC_PLACE_STOP.has(norm);
  }

  // Proper-noun gate for image-search candidates. Even with the tightened
  // extraction prompt, Gemini occasionally emits an activity noun like
  // "Charity Project" or "Restoration Work" (capitalized because it
  // appeared at sentence start in the transcript). Those produce stock
  // clipart from image search — which is the bug this gate exists to
  // prevent. Whitelist: at least one word is a clearly proper noun
  // (capitalized AND not a common-noun stop word). For celebrity /
  // related_person we soften this since names are always the main signal.
  const ACTIVITY_NOUN_STOP = new Set([
    "the", "a", "an",
    // Generic activity / topic words that Gemini mislabels as named entities.
    // Lowercased; matched against each word of the value.
    "charity", "donation", "donations", "fundraiser", "fundraising",
    "lawsuit", "case", "trial", "court", "litigation", "settlement",
    "project", "projects", "build", "builds", "restoration", "renovation",
    "deal", "deals", "contract", "agreement",
    "company", "firm", "business", "shop", "office", "warehouse", "garage",
    "marriage", "divorce", "wedding", "scandal", "interview", "appearance",
    "career", "show", "episode", "season", "series",
    "work", "works", "story", "journey",
  ]);
  // Life-event values are intentionally generic lowercase words ("marriage",
  // "wedding") — they DON'T need a proper-noun anchor because the query
  // builder treats them as stock-imagery requests, not as named entities.
  const LIFE_EVENT_VALUES = new Set([
    "marriage", "wedding", "divorce", "funeral", "birth",
    "graduation", "engagement", "retirement", "baptism", "anniversary",
  ]);
  function isImageSearchableValue(type: string, value: string): boolean {
    if (type === "celebrity" || type === "related_person") {
      // People are accepted on capitalization alone — names dominate visual
      // search signal and we want to keep e.g. single-name stage names.
      return /[A-Z]/.test(value);
    }
    if (type === "life_event") {
      // Whitelist-only: must match one of the allowed life-event values.
      return LIFE_EVENT_VALUES.has(value.trim().toLowerCase());
    }
    if (type === "age") {
      // Plain age number like "25". Anything 1-120 is searchable.
      const n = Number(value.trim());
      return Number.isInteger(n) && n >= 1 && n <= 120;
    }
    // For everything else: must contain at least one word that is BOTH
    // capitalized AND not in the activity-noun stop list. "Kindig It Design"
    // passes ("Kindig"); "Charity Project" fails (both stop words).
    const words = value.split(/\s+/).filter(Boolean);
    return words.some((w) => /^[A-Z][a-zA-Z'’-]+$/.test(w) && !ACTIVITY_NOUN_STOP.has(w.toLowerCase()));
  }

  // Sort entities by priority then confidence so the most-relevant pictures
  // land at the head of the pool. This matters when the pool is shorter
  // than the image-block count — the head fills the early blocks first.
  const poolEntities = (entityRows ?? [])
    .map((e) => ({
      type: e.type as string,
      value: String(e.value ?? "").trim(),
      confidence: Number(e.confidence ?? 0.8),
    }))
    .filter((e) =>
      e.value.length > 0 &&
      !POOL_SKIP_TYPES.has(e.type) &&
      isImageSearchableValue(e.type, e.value) &&
      // Country / state / region / continent places produce flags and maps,
      // never on-topic photographs. Drop them at the pool stage even when
      // the extraction prompt let them through.
      !(e.type === "place" && isGenericPlace(e.value))
    )
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

  // Per-type query strategy. Different entity types want different framing
  // because the celebrity-name anchor that helps with people/companies HURTS
  // for titled works (a search for "Drew Pritchard Salvage Hunters" returns
  // press photos of Drew, not the show's title card / artwork). Each branch
  // returns the query string for the image search; the caller also reads
  // queryImgType to decide between imgType=photo (default) and imgType=logo.
  //
  // Quote-anchoring: we wrap multi-word terms in double quotes so search
  // engines treat them as required phrases. Without quotes, "Drew Pritchard
  // Kindig It Design" returns pages matching the most "important" subset of
  // those words, which is exactly what dragged unrelated content into the
  // pool. With quotes, no-match returns nothing → entity gets dropped at
  // validation — better than off-topic results.
  //
  // Try to extract a birth year from the transcript for age queries. We look
  // for "born in 1965" / "born 1965" patterns near the celebrity name.
  // Returns the year as a number, or null if not found.
  function extractBirthYear(): number | null {
    if (!mainCelebrity) return null;
    const t = transcript.toLowerCase();
    const name = mainCelebrity.toLowerCase();
    // Search globally first (catches "Drew Pritchard, born in 1969"), then
    // anywhere in the transcript (the script may not repeat the name on the
    // birth-year sentence). Accept years 1900-2025.
    const namedPattern = new RegExp(
      `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^.]{0,100}\\bborn\\s+(?:in\\s+)?(\\d{4})\\b`,
      "i",
    );
    const m1 = t.match(namedPattern);
    if (m1) {
      const y = Number(m1[1]);
      if (y >= 1900 && y <= 2025) return y;
    }
    const anyPattern = /\bborn\s+(?:in\s+)?(\d{4})\b/i;
    const m2 = t.match(anyPattern);
    if (m2) {
      const y = Number(m2[1]);
      if (y >= 1900 && y <= 2025) return y;
    }
    return null;
  }
  const birthYear = extractBirthYear();

  function quoteIfMultiWord(s: string): string {
    return s.includes(" ") ? `"${s}"` : s;
  }
  function quoted(s: string): string {
    return `"${s}"`;
  }
  type QuerySpec = { query: string; imgType?: "photo" | "logo" };

  function buildImageQuery(ent: { type: string; value: string }): QuerySpec {
    const value = ent.value.trim();
    const subj = mainCelebrity ? quoted(mainCelebrity) : "";

    switch (ent.type) {
      case "celebrity":
      case "related_person":
        // Person's name. Wikipedia handles famous people; Brave/CSE picks up
        // the rest. No anchor needed — the name IS the search target.
        return { query: quoteIfMultiWord(value) };

      case "company":
        // Company logos. Google CSE has a native imgType=logo filter; we set
        // it explicitly so the pool gets brand marks, not storefronts or
        // exec photos. Query is the company name + "logo" so Brave (no
        // server-side logo filter) returns logos too.
        return { query: `${quoteIfMultiWord(value)} logo`, imgType: "logo" };

      case "tv_show":
      case "movie":
        // Titled work. The celebrity anchor HURTS here — searching for
        // "Drew Pritchard Salvage Hunters" returns press photos of Drew,
        // not the show's title card. Search the title alone, asking for
        // the poster / cover.
        return { query: `${quoteIfMultiWord(value)} poster` };

      case "song":
        // Album cover for the song. Anchor to the artist if known (because
        // song names alone often collide with other works), but ask for the
        // cover specifically so we get album art rather than music videos.
        if (subj) return { query: `${subj} ${quoteIfMultiWord(value)} album cover` };
        return { query: `${quoteIfMultiWord(value)} album cover` };

      case "place":
        // Specific named place (the country/state filter ran earlier).
        // The celebrity anchor HURTS — searching "Drew Pritchard Buckingham
        // Palace" returns nothing useful. Just search the place name.
        return { query: quoteIfMultiWord(value) };

      case "event":
        // Named historical event. Same logic as place — the event has its
        // own iconography; the celebrity anchor only narrows to press shots
        // of the celebrity AT the event (which is fine, but usually less
        // visually striking than the canonical event imagery).
        return { query: quoteIfMultiWord(value) };

      case "life_event":
        // Generic stock imagery for a life moment (marriage, funeral, etc.).
        // No anchor — the client wants generic visuals here, not the
        // celebrity at their own wedding (which is usually a press-photo
        // already covered by celebrity/related_person queries).
        return { query: `${value} ceremony` };

      case "age": {
        // Search the celebrity at the stated age. Two strategies:
        //   1. We know the birth year → compute year-of-photo as birth+age
        //      and search "Name 1990" which hits Wikipedia/news from that
        //      era. Most precise.
        //   2. We don't know the birth year → fall back to "Name young"
        //      for ages <30, otherwise just search the name (results may
        //      not be age-targeted but at least are on-celebrity).
        const ageNum = Number(value);
        if (subj && birthYear && Number.isFinite(ageNum)) {
          const year = birthYear + ageNum;
          return { query: `${subj} ${year}` };
        }
        if (subj && Number.isFinite(ageNum) && ageNum < 30) {
          return { query: `${subj} young` };
        }
        if (subj) return { query: subj };
        return { query: value };
      }

      default: {
        // Unknown type — fall back to the old celebrity-anchored search.
        if (!mainCelebrity) return { query: quoteIfMultiWord(value) };
        if (value.toLowerCase().includes(mainCelebrity.toLowerCase())) {
          return { query: quoteIfMultiWord(value) };
        }
        return { query: `${subj} ${quoteIfMultiWord(value)}` };
      }
    }
  }

  for (const ent of poolEntities) {
    if (pool.length >= imageBlockCount) break;       // already have enough
    const spec = buildImageQuery(ent);
    poolFetchStats.entitiesQueried++;
    try {
      const fetched = await fetchImages(spec.query, IMAGES_PER_ENTITY, {
        entityType: ent.type,
        imgType: spec.imgType,
      });
      if (fetched.length === 0) {
        poolFetchStats.entitiesFailed++;
        continue;
      }
      for (const f of fetched) {
        if (poolUrlSet.has(f.url)) continue;          // dedupe across entities
        pool.push({ url: f.url, source: f.source, query: spec.query, entityType: ent.type });
        poolUrlSet.add(f.url);
        if (pool.length >= imageBlockCount) break;
      }
    } catch (e) {
      poolFetchStats.entitiesFailed++;
      void logJob({ projectId, jobId: mediaJobId },
        "match.image_fetch.failed", { query: spec.query, err: (e as Error).message });
    }
  }

  // Second pass: if the strict (quoted) queries didn't fill the pool, retry
  // with RELAXED queries — same entities, but unquoted and without the
  // narrowing modifiers ("poster", "album cover", "logo"). Image-search
  // engines treat unquoted multi-word inputs as "match any subset," which
  // widens the candidate set substantially. We accept some loss of topical
  // precision here in exchange for never leaving image blocks blank — a
  // blank block gets DROPPED at render time, which shortens the final video
  // below the voiceover length (the symptom this whole pass is designed to
  // prevent). The first-pass strict queries already populated the pool with
  // the highest-quality matches; this pass just backfills the tail.
  if (pool.length < imageBlockCount) {
    for (const ent of poolEntities) {
      if (pool.length >= imageBlockCount) break;
      // Drop quotes and trailing modifiers — the entity value alone, with
      // the celebrity anchor where it helps (people-ish types only).
      const value = ent.value.trim();
      const subj = mainCelebrity ?? "";
      let relaxedQuery: string;
      switch (ent.type) {
        case "celebrity":
        case "related_person":
          relaxedQuery = value;
          break;
        case "company":
        case "tv_show":
        case "movie":
        case "song":
        case "place":
        case "event":
          relaxedQuery = value;
          break;
        case "life_event":
          relaxedQuery = subj ? `${subj} ${value}` : value;
          break;
        case "age":
          relaxedQuery = subj || value;
          break;
        default:
          relaxedQuery = subj && !value.toLowerCase().includes(subj.toLowerCase())
            ? `${subj} ${value}`
            : value;
      }
      poolFetchStats.entitiesQueried++;
      try {
        const fetched = await fetchImages(relaxedQuery, IMAGES_PER_ENTITY, {
          entityType: ent.type,
          // No imgType in the relaxed pass — even for companies, a
          // photo/storefront/exec-shot beats a blank block.
        });
        if (fetched.length === 0) {
          poolFetchStats.entitiesFailed++;
          continue;
        }
        for (const f of fetched) {
          if (poolUrlSet.has(f.url)) continue;
          pool.push({ url: f.url, source: f.source, query: relaxedQuery, entityType: ent.type });
          poolUrlSet.add(f.url);
          if (pool.length >= imageBlockCount) break;
        }
      } catch (e) {
        poolFetchStats.entitiesFailed++;
        void logJob({ projectId, jobId: mediaJobId },
          "match.image_fetch.failed", { query: relaxedQuery, relaxed: true, err: (e as Error).message });
      }
    }
  }

  // Third pass: if STILL short (no entities, or all queries failed), seed
  // the pool with a bare celebrity-name query. A 30-minute video must not
  // ship with dropped image blocks regardless of entity quality; the
  // celebrity name is the one query we know is on-topic for the whole
  // project.
  if (pool.length < imageBlockCount && mainCelebrity) {
    const need = imageBlockCount - pool.length;
    poolFetchStats.entitiesQueried++;
    try {
      const fetched = await fetchImages(mainCelebrity, Math.max(IMAGES_PER_ENTITY, need + 4), {
        entityType: "celebrity",
      });
      for (const f of fetched) {
        if (poolUrlSet.has(f.url)) continue;
        pool.push({ url: f.url, source: f.source, query: mainCelebrity, entityType: "celebrity" });
        poolUrlSet.add(f.url);
        if (pool.length >= imageBlockCount) break;
      }
    } catch (e) {
      poolFetchStats.entitiesFailed++;
      void logJob({ projectId, jobId: mediaJobId },
        "match.image_fetch.failed", { query: mainCelebrity, finalFallback: true, err: (e as Error).message });
    }
  }

  // Assign pool images to image blocks in timeline order.
  //
  // Two-tier policy:
  //   Tier 1 — every image is used at most once. This is the preferred path
  //            and runs as long as the pool still has unused entries.
  //   Tier 2 — if the pool runs out before every image block is filled, we
  //            REUSE images from the pool (least-recently-used first) so no
  //            block is left blank. A reused image is invisible to most
  //            viewers; a missing 60 s of video is not. The audio/video
  //            duration contract is upheld unconditionally.
  //
  // Anti-clustering applies in both tiers: don't place two images from the
  // SAME entity back-to-back. The picker tries to satisfy the no-cluster
  // rule; if that's impossible we accept a cluster rather than a gap.
  const consumed = new Set<number>();
  let lastEntityKey: string | null = null;
  // Last-used timestamp per pool index. Tier 2 picks the entry whose last
  // use is OLDEST (and whose entity isn't equal to lastEntityKey when
  // possible) so reuse is spread evenly across the pool rather than
  // hammering pool[0]. Initialized to -1 (= never used).
  const lastUsedAt: number[] = new Array(pool.length).fill(-1);
  let useCounter = 0;
  function pickFreshPoolIdx(): number {
    let fallback = -1;
    for (let i = 0; i < pool.length; i++) {
      if (consumed.has(i)) continue;
      if (fallback < 0) fallback = i;
      const key = `${pool[i].entityType}:${pool[i].query}`;
      if (key !== lastEntityKey) return i;
    }
    return fallback;
  }
  function pickReusePoolIdx(): number {
    if (pool.length === 0) return -1;
    // Walk the pool sorted by lastUsedAt ascending; pick the first whose
    // entity key differs from lastEntityKey. If none differs, return the
    // oldest one anyway.
    let bestDiff = -1;
    let bestDiffAge = Number.POSITIVE_INFINITY;
    let bestAny = -1;
    let bestAnyAge = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const age = lastUsedAt[i];
      if (age < bestAnyAge) { bestAnyAge = age; bestAny = i; }
      const key = `${pool[i].entityType}:${pool[i].query}`;
      if (key !== lastEntityKey && age < bestDiffAge) {
        bestDiffAge = age; bestDiff = i;
      }
    }
    return bestDiff >= 0 ? bestDiff : bestAny;
  }
  let imagesReused = 0;
  for (const item of items) {
    if (item.type !== "image") continue;
    let idx = pickFreshPoolIdx();
    if (idx < 0) {
      // Fresh pool exhausted — fall back to reuse. pickFreshPoolIdx returns
      // -1 only when every entry is in `consumed`; that's the trigger for
      // Tier 2.
      idx = pickReusePoolIdx();
      if (idx < 0) break;                 // pool itself is empty — truly nothing to do
      imagesReused++;
    } else {
      consumed.add(idx);
    }
    const next = pool[idx];
    item.image_query = next.query;
    item.image_url = next.url;
    item.image_source = next.source;
    lastEntityKey = `${next.entityType}:${next.query}`;
    lastUsedAt[idx] = useCounter++;
  }

  await logJob({ projectId, jobId: mediaJobId }, "match.image_fetch", {
    totalImageBlocks: imageBlockCount,
    poolSize: pool.length,
    // Every image block now gets an image_url whenever pool.length > 0
    // (reuse covers the shortfall). leftBlank is non-zero only in the
    // truly-degenerate case where no entity produced any image at all.
    assigned: pool.length > 0 ? imageBlockCount : 0,
    imagesReused,
    leftBlank: pool.length === 0 ? imageBlockCount : 0,
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

  // ---- Lower-third tagging --------------------------------------------
  // Stamp metadata.lower_third on items where the client-requested overlay
  // should burn in during render. Rules (per client spec):
  //   - Names: only on the FIRST clip that visibly depicts them, never again.
  //     "Depicts" is approximated by the clip's labels containing the name —
  //     this is what we have without a structured entity→clip linkage.
  //   - Years: on every scored clip whose block's spoken text mentions the
  //     year — i.e. the narrator is saying it right now. blockEntities[i]
  //     already comes from the transcript window over this block, so the
  //     existing "block mentions a year" check is exactly that signal.
  //   - Places: only when the clip VISUALLY depicts the place, not just when
  //     narration name-drops it. Approximated by the place name appearing in
  //     the clip's labels (case-insensitive substring), same shape as the
  //     name sex-contradiction check below.
  // Only Tier-1 scored picks qualify; filler clips weren't chosen for entity
  // relevance, so labelling them would mislead the viewer.
  // Order matters — we walk items by position so "first occurrence" is the
  // first clip in the final video.
  const labelsByClipId = new Map<string, string[]>(
    clipsForMatch.map((c) => [c.id, (c.labels ?? []).map((l) => l.toLowerCase())]),
  );
  const introducedNames = new Set<string>();
  const lowerThirdCounts = { name: 0, year: 0, place: 0 };
  // Items are still in insertion order at this point (we haven't sorted).
  // Sort defensively in case future edits reorder; the array is small.
  const orderedItems = [...items].sort(
    (a, b) => (a.position as number) - (b.position as number),
  );
  for (const it of orderedItems) {
    if (it.type !== "footage") continue;
    const meta = it.metadata as Record<string, unknown> | undefined;
    if (!meta || meta.pick_source !== "scored_top") continue;
    const blockIdx = Number(meta.block_index ?? -1);
    if (blockIdx < 0) continue;
    const ents = blockEntities[blockIdx] ?? [];
    if (ents.length === 0) continue;
    const clipLabels = labelsByClipId.get(it.clip_id as string) ?? [];
    const labelStr = clipLabels.join(" ");

    // Pick at most one lower-third per clip; names take priority over
    // years/places because a name-on-screen is the strongest signal we want
    // to surface. If no name qualifies, fall back to year, then place.
    type Candidate = { text: string; type: "name" | "year" | "place" };
    let pick: Candidate | null = null;

    for (const ent of ents) {
      if (ent.type !== "celebrity" && ent.type !== "related_person") continue;
      const key = ent.value.toLowerCase();
      if (introducedNames.has(key)) continue;
      // We trust the matcher's block→clip assignment as evidence the clip
      // is about this person — that's the whole point of having scored it
      // into this footage block. Earlier versions required sex-agreement
      // confirmation from labels before burning in the name, which dropped
      // most main-character overlays whenever Gemini's labeler didn't
      // tag a man/woman cue (very common for vehicle/B-roll shots) or
      // when no pronouns sat near the name in transcript.
      //
      // Safety net: if we CAN infer the person's sex from transcript
      // pronouns AND the labels directly contradict it (woman-name on a
      // clip tagged "man" with no "woman" cue, or vice versa), skip.
      // This catches the obvious wrong-face-with-name case without
      // requiring positive confirmation.
      const personSex = inferPersonSex(ent.value);
      if (personSex) {
        const contradicts =
          (personSex === "woman" && MAN_RE.test(labelStr) && !WOMAN_RE.test(labelStr)) ||
          (personSex === "man" && WOMAN_RE.test(labelStr) && !MAN_RE.test(labelStr));
        if (contradicts) continue;
      }
      pick = { text: ent.value, type: "name" };
      break;
    }
    if (!pick) {
      for (const ent of ents) {
        if (ent.type !== "year") continue;
        pick = { text: ent.value, type: "year" };
        break;
      }
    }
    if (!pick) {
      for (const ent of ents) {
        if (ent.type !== "place") continue;
        if (!labelStr.includes(ent.value.toLowerCase())) continue;
        pick = { text: ent.value, type: "place" };
        break;
      }
    }

    if (!pick) continue;
    if (pick.type === "name") introducedNames.add(pick.text.toLowerCase());
    lowerThirdCounts[pick.type]++;
    (it.metadata as Record<string, unknown>) = {
      ...meta,
      lower_third: { text: pick.text, type: pick.type },
    };
  }

  await logJob({ projectId, jobId: mediaJobId }, "match.lower_thirds", {
    name: lowerThirdCounts.name,
    year: lowerThirdCounts.year,
    place: lowerThirdCounts.place,
    namesIntroduced: introducedNames.size,
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

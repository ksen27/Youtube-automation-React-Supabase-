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
  buildBlockSequenceFromHints,
  planTimeline,
  sumDurations,
  IMAGE_HOLD_SECONDS,
  type BlockPlanHint,
  type PlannedBlock,
  type PlannedBlockWithHint,
} from "@/lib/ai/timeline-plan";
import { estimateDurationSeconds, type BlockPlan, type SegmentUnderstanding } from "@/lib/ai/segments";
import { fetchImages } from "@/lib/images/fetch";

// Below this score (0–100), Gemini judged the clip a poor visual fit for the
// block's spoken words. We'd rather downgrade the block to an image
// placeholder than burn a low-relevance clip there — that's exactly the
// failure mode that produced the "every block shows the same face"
// screenshot.
const MIN_RELEVANT_SCORE = 25;

// Countries, U.S. states, regions, and continents whose image search returns
// flags / outline maps / coats of arms instead of recognizable photographs.
// Used by the Phase D image router to skip type-aware place routing when
// Gemini emits a non-landmark "place" entity — the footage fallback (Dave
// Kindig clip) is strictly better than a state flag for those blocks.
//
// We mirror the rejection list from extractEntities (lib/ai/gemini.ts) so
// the matcher's defense lines up with the entity-extractor's prompt rules.
const COUNTRY_REGION_SET = new Set<string>([
  // Common country names + ISO short forms.
  "usa","u.s.","u.s.a.","united states","united states of america","america",
  "uk","u.k.","united kingdom","great britain","britain","england","scotland",
  "wales","northern ireland","ireland","france","germany","spain","italy",
  "portugal","netherlands","belgium","switzerland","austria","poland","russia",
  "ukraine","greece","turkey","canada","mexico","brazil","argentina","chile",
  "australia","new zealand","japan","china","india","pakistan","bangladesh",
  "south korea","north korea","singapore","thailand","vietnam","philippines",
  "indonesia","saudi arabia","uae","united arab emirates","egypt","south africa",
  "nigeria","kenya","morocco","norway","sweden","denmark","finland","iceland",
  // Continents.
  "europe","asia","africa","north america","south america","antarctica","oceania",
  // U.S. states (just the ones most likely to land in our scripts).
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut",
  "delaware","florida","georgia","hawaii","idaho","illinois","indiana","iowa",
  "kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan",
  "minnesota","mississippi","missouri","montana","nebraska","nevada","new hampshire",
  "new jersey","new mexico","new york","north carolina","north dakota","ohio",
  "oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota",
  "tennessee","texas","utah","vermont","virginia","washington","west virginia",
  "wisconsin","wyoming","district of columbia","washington dc","washington d.c.",
  // Generic regions.
  "the south","the north","the midwest","the west","the east","the eastern seaboard",
  "the west coast","the east coast","the mainland",
]);

function isCountryOrRegion(s: string): boolean {
  const norm = s.toLowerCase().trim().replace(/[.,!?;:]+$/, "");
  if (COUNTRY_REGION_SET.has(norm)) return true;
  // "Northern California" / "Eastern Europe" → contains a region word.
  // Cheap heuristic — catches the common "{direction} {region}" cases.
  return /\b(northern|southern|eastern|western|central)\s+(europe|asia|africa|america|california|state|states)\b/.test(norm);
}

// Bare-date detector. Catches "January 2016", "2019", "the early 2000s",
// "spring of 1998" etc — strings that are PRIMARILY a calendar reference,
// not a named event. A 4-digit year embedded inside a longer named-event
// string ("Royal Wedding 1981") survives because the proper noun balances it.
function isDateOnly(s: string): boolean {
  const norm = s.toLowerCase().trim();
  if (!norm) return true;
  // Bare year, optional decade marker.
  if (/^(the\s+)?(early|mid|late)?\s*\d{4}s?$/.test(norm)) return true;
  // Month + year (e.g. "January 2016", "Jan. 2016").
  if (/^(the\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+\d{4}$/.test(norm)) return true;
  // "the 2000s" / "the early 2000s" / "the mid 90s".
  if (/^(the\s+)?(early|mid|late)?\s*\d{2,4}s?$/.test(norm)) return true;
  // Quarter / season + year ("spring 2018", "Q1 2020").
  if (/^(the\s+)?(spring|summer|fall|autumn|winter|q[1-4])\s+(of\s+)?\d{4}$/.test(norm)) return true;
  return false;
}

// Words that look proper-noun-ish at sentence start but are common nouns.
// Used to drop false-positive capitalized phrases lifted from script text
// (the matcher considers "Behind The Grand Gates" a phrase otherwise).
const SCRIPT_PHRASE_STOPWORDS = new Set<string>([
  "the", "a", "an", "this", "that", "these", "those",
  "he", "she", "they", "we", "you", "i", "it",
  "his", "her", "their", "our", "your", "my",
  "behind", "before", "after", "during", "while", "when", "where", "why", "how",
  "but", "and", "or", "so", "yet", "still", "even", "just", "only",
  "then", "now", "today", "yesterday", "tomorrow", "later", "soon",
]);
// Connector words allowed INSIDE a capitalized phrase ("District Court of
// Utah", "Bank of America"). They don't have to be capitalized themselves.
const SCRIPT_PHRASE_CONNECTORS = new Set<string>([
  "of", "the", "and", "for", "in", "on", "at", "de", "la", "le", "van", "von",
]);

// Extract proper-noun-like phrases from narration text. Returns search-ready
// strings, longest first (so multi-word references like "District Court of
// Utah" outrank single-word "Utah"). Used as a last-resort visual search
// when Gemini's reference/entity hints produced nothing for an image block —
// per spec, we'd rather try a script-derived search than fall through to
// the entity pool of generic celebrity photos.
export function extractScriptPhrases(text: string): string[] {
  if (!text) return [];
  // Strip punctuation that splits otherwise-valid phrases (commas, periods,
  // dashes inside phrases). Keep apostrophes for names like "Drew's Garage".
  const tokens = text.split(/\s+/).map((w) => w.replace(/[.,!?;:"()]+$/g, "")).filter(Boolean);
  const phrases: string[] = [];
  let cur: string[] = [];
  function flush() {
    if (cur.length === 0) return;
    // Trim trailing connectors ("District Court of" → "District Court").
    while (cur.length > 0 && SCRIPT_PHRASE_CONNECTORS.has(cur[cur.length - 1].toLowerCase())) {
      cur.pop();
    }
    if (cur.length > 0) phrases.push(cur.join(" "));
    cur = [];
  }
  for (const tok of tokens) {
    const stripped = tok.replace(/[.,!?;:"()]+/g, "");
    if (!stripped) { flush(); continue; }
    const isCap = /^[A-Z][a-zA-Z'’-]*$/.test(stripped);
    const isConnector = SCRIPT_PHRASE_CONNECTORS.has(stripped.toLowerCase());
    if (isCap) {
      // Reject sentence-start common-noun false positives ("Behind", "The").
      // We still allow them mid-phrase if they came after another capital.
      if (cur.length === 0 && SCRIPT_PHRASE_STOPWORDS.has(stripped.toLowerCase())) {
        continue;
      }
      cur.push(stripped);
    } else if (isConnector && cur.length > 0) {
      cur.push(stripped.toLowerCase());
    } else {
      flush();
    }
  }
  flush();
  // Dedupe (case-insensitive) and require at least one multi-character word
  // so we don't search for single initials ("J.").
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of phrases) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.replace(/\s+/g, "").length < 3) continue;
    out.push(p);
  }
  // Longest first — "District Court of Utah" before "Utah".
  out.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);
  return out;
}

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
    .select("transcript, voiceover_duration_seconds, transcript_words")
    .eq("id", projectId)
    .single();
  const transcript = project?.transcript ?? "";
  // Per-word timings persisted at voiceover-upload time. When present
  // they let the timeline planner size each block to the narrator's
  // real spoken duration for that sentence (instead of a uniform-wpm
  // estimate that accumulates drift across 100+ blocks).
  const transcriptWords = ((): { word: string; start: number; end: number }[] | null => {
    const raw = (project as { transcript_words?: unknown } | null)?.transcript_words;
    if (!Array.isArray(raw)) return null;
    const out: { word: string; start: number; end: number }[] = [];
    for (const w of raw as Array<Record<string, unknown>>) {
      const word = String(w.word ?? "");
      const start = Number(w.start);
      const end = Number(w.end);
      if (!word || !Number.isFinite(start) || !Number.isFinite(end)) continue;
      out.push({ word, start, end });
    }
    return out.length > 0 ? out : null;
  })();

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
    .select("id, start_time, end_time, duration, labels, video_source_id, status, thumbnail_url")
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

  // Defensive junk filter at the matcher input. The clip stage already
  // drops clips whose Gemini Vision visualCategory is non-content
  // (subscribe_screen, blank, text_only, etc.) via isJunkCategory, but
  // Vision occasionally mis-classifies them as "content" and lets the
  // junk leak through to the matcher. The leaked clips show up in the
  // final video as YouTube subscribe screens, static text cards, and
  // blank black frames sitting under legal narration. Their LABELS
  // usually betray them even when the category was wrong, so we drop
  // any clip whose labels contain a junk telltale before matching runs.
  const JUNK_LABEL_TELLTALES = [
    "subscribe", "subscribe screen", "click here", "end card", "end screen",
    "title card", "watermark", "channel logo", "blank frame", "black frame",
    "uniform color", "solid black", "solid white", "credits", "scrolling text",
    "lower third only", "text only", "quote card",
  ];
  const droppedJunkAtMatcher: Array<{ id: string; offending: string[] }> = [];
  const clipsForMatch: ClipForMatch[] = [];
  for (const c of clips) {
    const labels = Array.isArray(c.labels) ? c.labels as string[] : [];
    const lower = labels.map((l) => l.toLowerCase());
    const offending = JUNK_LABEL_TELLTALES.filter((t) => lower.some((l) => l.includes(t)));
    if (offending.length > 0) {
      droppedJunkAtMatcher.push({ id: c.id as string, offending });
      continue;
    }
    clipsForMatch.push({
      id: c.id,
      source_title: titleById.get(c.video_source_id) ?? null,
      start_time: c.start_time,
      end_time: c.end_time,
      labels,
    });
  }
  if (droppedJunkAtMatcher.length > 0) {
    await logJob({ projectId, jobId: mediaJobId }, "match.junk_label_filter", {
      dropped: droppedJunkAtMatcher.length,
      sample: droppedJunkAtMatcher.slice(0, 8),
    });
  }
  if (clipsForMatch.length === 0) {
    await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: "all clips filtered as junk thumbnails" });
    await setProjectStatus(projectId, "failed");
    throw new Error("all clips filtered as junk thumbnails");
  }

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
  //
  // We prefer Gemini's per-block visual plan (emitted by analyzeSegment
  // during the analyze step and persisted in media_jobs.metadata.payload).
  // Each block carries a recommended_visual_type that says whether the
  // narration wants footage / image / title_card / split_2. The hint-aware
  // builder respects those recommendations and only rebalances when the
  // realized 60/40 footage:image ratio drifts outside ±10%.
  //
  // If the analyze payload is missing (older project, or analyze never ran),
  // we fall back to the legacy duration-only planner. Same downstream
  // contract — every block ends up with a type + duration + text.
  const plan = planTimeline(voiceoverSeconds);
  let hints = await loadBlockHintsFromAnalyze(sb, projectId, voiceoverSeconds);
  const planSource: "gemini_hints" | "legacy_quota" = hints.length > 0 ? "gemini_hints" : "legacy_quota";

  let blocks: PlannedBlock[];
  let blockHintTexts: Array<string | null>;
  let blockSectionTitles: Array<string | null>;
  let blockResolvedSubjects: Array<string | null>;
  let blockRecommendedTypes: Array<string | null>;
  // Phase C: per-block specific references ("tattoo", "mother", "Frida")
  // surfaced from the Gemini block plan. Drives the reference-driven image
  // matcher below — when a block has any references, we search for them
  // BEFORE falling back to the entity pool. We index hints by absolute
  // block index post-build (Phase A's buildBlockSequenceFromHints preserves
  // input order 1:1 so hint[i] === block[i]).
  let blockSpecificRefs: Array<string[]>;
  // Phase D: parallel array of per-block subject_type. Drives type-aware
  // image routing and the once-per-video shown-entity dedup. null when the
  // legacy planner is in use (no Gemini hints available).
  let blockSubjectTypes: Array<string | null>;
  // Person-first documentary axis (forwarded from Gemini's visual_priority).
  // Drives the fallback chain: "specific_*" blocks fall back to the person
  // image when their reference search fails, NEVER to random pool entries.
  // null when the legacy planner is in use.
  let blockVisualPriorities: Array<string | null>;
  if (planSource === "gemini_hints") {
    // Pass the intro slot's reserved time so the planner targets
    // (voiceoverSeconds - introClipDuration) for its block sum. Without
    // this the prepended intro item pushed items.duration past voiceover,
    // showing up in the editor header as a "X scenes · 9:47 / 10:00" gap.
    const planned: PlannedBlockWithHint[] = buildBlockSequenceFromHints(hints, voiceoverSeconds, transcript, transcriptWords, introClipDuration);
    blocks = planned.map((p) => ({ type: p.type, duration: p.duration }));
    blockHintTexts = planned.map((p) => p.text || null);
    blockSectionTitles = planned.map((p) => p.section_title ?? null);
    blockResolvedSubjects = planned.map((p) => p.resolved_subject ?? null);
    blockRecommendedTypes = planned.map((p) => p.type);
    blockSpecificRefs = planned.map((p) => p.specific_visual_references ?? []);
    blockSubjectTypes = planned.map((p) => p.subject_type ?? null);
    blockVisualPriorities = planned.map((p) => p.visual_priority ?? null);
  } else {
    blocks = buildBlockSequence(plan);
    blockHintTexts = blocks.map(() => null);
    blockSectionTitles = blocks.map(() => null);
    blockResolvedSubjects = blocks.map(() => null);
    blockRecommendedTypes = blocks.map(() => null);
    blockSpecificRefs = blocks.map(() => []);
    blockSubjectTypes = blocks.map(() => null);
    blockVisualPriorities = blocks.map(() => null);
  }

  // Title cards and split-screens now have real renderers — let them pass
  // through. Enforce client direction "1-2 split_2 per minute" using FIXED
  // minute buckets [0,60s), [60,120s), … :
  //   • Cap = 2  → drop split_2 #3+ inside a bucket to plain image (earlier
  //                ones win so the first half-minute keeps its split).
  //   • Floor = 1 → if a bucket has 0 split_2 after the cap pass, promote
  //                 the first image block in that bucket to split_2.
  // We use the block's START time to assign a bucket (a block straddling a
  // boundary belongs to the minute it began in). Footage/title_card blocks
  // are never promoted — only image blocks — so promotion doesn't disturb
  // clip/title alignment.
  const SPLIT_2_PER_MINUTE_CAP = 2;
  const SPLIT_2_PER_MINUTE_FLOOR = 1;
  const SPLIT_2_BUCKET_SEC = 60;
  const blockStartTimes: number[] = [];
  {
    let acc = 0;
    for (const b of blocks) {
      blockStartTimes.push(acc);
      acc += b.duration;
    }
  }
  const blockBucket = blockStartTimes.map((t) => Math.floor(t / SPLIT_2_BUCKET_SEC));
  const totalBuckets = blocks.length === 0
    ? 0
    : Math.floor(blockStartTimes[blockStartTimes.length - 1] / SPLIT_2_BUCKET_SEC) + 1;
  // Cap pass — keep at most 2 split_2 per bucket, in narration order.
  let splitDowngradedByCap = 0;
  const splitCountPerBucket = new Array<number>(totalBuckets).fill(0);
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type !== "split_2") continue;
    const bucket = blockBucket[i];
    if (splitCountPerBucket[bucket] >= SPLIT_2_PER_MINUTE_CAP) {
      blocks[i] = { type: "image", duration: blocks[i].duration };
      splitDowngradedByCap++;
    } else {
      splitCountPerBucket[bucket]++;
    }
  }
  // Floor pass — promote the first eligible image block in any bucket that
  // landed with 0 split_2. "Eligible" = image-typed AND has ≥2 mentioned
  // entities (so the split-screen fill can find topical left/right images
  // instead of falling through to pool junk).
  //
  // Why the 2-entity gate: split halves with no entities pull from the
  // project image pool, which contains leftover Brave/CSE search noise
  // (random brand logos, stock product photos). The result is a split
  // showing two unrelated images over abstract narration — strictly worse
  // than a plain image block of the celebrity. Per the client's spec
  // ("never use random unrelated visuals"), we'd rather skip the floor
  // for this minute than ship a junk split.
  //
  // Promote with a tiered preference so we hit the 1-per-minute spec even
  // when Gemini's entity coverage is sparse. The split fill step (further
  // down) already handles the no-entity case by drawing both halves from
  // the project image pool — per client direction split halves don't have
  // to match the narration — so we no longer gate promotion on having 2
  // entities upfront. Tiers, in order of preference within each bucket:
  //   T1: image block with ≥2 entities (entity-driven left AND right)
  //   T2: image block with ≥1 entity (entity-driven one side, pool other)
  //   T3: any image block (both sides drawn from the project pool)
  // Footage blocks are still never promoted — that would steal a clip slot
  // and break the 60/40 footage/image ratio downstream.
  let splitPromotedToFloor = 0;
  let bucketsBelowFloor = 0;
  for (let b = 0; b < totalBuckets; b++) {
    if (splitCountPerBucket[b] >= SPLIT_2_PER_MINUTE_FLOOR) continue;
    const findImageInBucket = (minEntities: number) =>
      blocks.findIndex((blk, i) => {
        if (blockBucket[i] !== b || blk.type !== "image") return false;
        const ents = hints[i]?.mentioned_entities ?? [];
        return ents.length >= minEntities;
      });
    let promoteIdx = findImageInBucket(2);
    if (promoteIdx < 0) promoteIdx = findImageInBucket(1);
    if (promoteIdx < 0) promoteIdx = findImageInBucket(0);
    if (promoteIdx < 0) {
      bucketsBelowFloor++;
      continue;
    }
    blocks[promoteIdx] = { type: "split_2", duration: blocks[promoteIdx].duration };
    splitCountPerBucket[b]++;
    splitPromotedToFloor++;
    // Reflect the type change on the parallel recommended-type array so
    // downstream diagnostics tally accurately. The hint payload's other
    // fields (mentioned_entities, references, subject_type) stay valid —
    // the split-screen fill step reads them straight from `hints[idx]`.
    if (promoteIdx < blockRecommendedTypes.length) {
      blockRecommendedTypes[promoteIdx] = "split_2";
    }
  }
  // split_4 has no renderer yet; downgrade it to image as before.
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === "split_4") {
      blocks[i] = { type: "image", duration: blocks[i].duration };
    }
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
      // Preserve the footage duration on conversion so we don't inflate
      // total slideshow time when clip supply is tight.
      blocks[idx] = { type: "image", duration: blocks[idx].duration };
    }
  }

  // ---- Phase D: once-per-video shown-entity dedup -----------------------
  // Per the client's spec ("show the logo only the first time, then use
  // different Dave Kindig footage for later mentions"): walk image blocks
  // whose subject is a non-person entity. The FIRST block per canonical
  // entity keeps its image type. Every subsequent block for the SAME entity
  // is downgraded to footage so the existing footage pipeline assigns it a
  // Dave Kindig clip via the person-first bonus. Dedup is once-per-video,
  // canonical match (lowercased entity value), non-person entities only —
  // confirmed with the client.
  const NON_PERSON_TYPES = new Set(["company", "movie", "show", "song", "place", "event", "object"]);
  const shownEntityKeys = new Set<string>();
  let dedupDowngradedCount = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type !== "image") continue;
    const subjectType = blockSubjectTypes[i];
    if (!subjectType || !NON_PERSON_TYPES.has(subjectType)) continue;
    // Canonical key: prefer the first mentioned entity (most specific), fall
    // back to resolved_subject. Lowercased to match anaphoric variations
    // ("Creative Controls" vs "Creative controls"). Trim removes the
    // whitespace Gemini sometimes leaves around entity strings.
    const ents = hints[i]?.mentioned_entities ?? [];
    const canonical = (ents[0] ?? blockResolvedSubjects[i] ?? "").trim().toLowerCase();
    if (!canonical) continue;
    if (shownEntityKeys.has(canonical)) {
      // Repeat mention — downgrade to footage. The Tier 1 person-first
      // bonus will route a Dave Kindig clip here so the visual doesn't
      // flash the same logo/poster repeatedly. We clear the per-block
      // reference state so Phase C doesn't try to re-search this block
      // and accidentally re-show the entity image.
      blocks[i] = { type: "footage", duration: blocks[i].duration };
      blockRecommendedTypes[i] = "footage";
      blockSpecificRefs[i] = [];
      // We intentionally keep blockSubjectTypes[i] populated — downstream
      // logging / future routing may still want to know the block was
      // originally a non-person entity even after downgrade.
      dedupDowngradedCount++;
    } else {
      shownEntityKeys.add(canonical);
    }
  }
  await logJob({ projectId, jobId: mediaJobId }, "match.entity_dedup", {
    shown_entities: Array.from(shownEntityKeys),
    downgraded_blocks: dedupDowngradedCount,
  });

  // ---- Visual-rhythm pass: break runs of 3+ same-type blocks -----------
  // Client direction: "footage clip - footage clip - still image - footage -
  // splitscreen - footage - footage - still image …". Translates to:
  // no more than 2 consecutive blocks of the same type. Gemini's per-
  // sentence recommendation is honored by default — we only override when
  // a run of 3+ would otherwise read as a monotone block of identical
  // visuals (the all-image run sentences 70–76 in the editor screenshot).
  //
  // Swap rules:
  //   • 3rd consecutive image → footage (if a clip slot is still available
  //     in the project budget — otherwise we'd create an unfillable footage
  //     block downstream).
  //   • 3rd consecutive footage → image (always safe — image blocks have
  //     no hard supply cap; the matcher's image-search pipeline can fill
  //     any block via the entity pool / person fallback).
  //   • split_2 / title_card / intro runs are not rebalanced — those types
  //     are deliberate beats; consecutive splits / cards are rare anyway
  //     because the planner caps splits at 2/minute and title cards are
  //     section-bound.
  //
  // We preserve the block's duration on every swap (5s for image, raw for
  // footage); downstream phases re-derive `image_url` / `clip_id` from the
  // post-swap type.
  let rhythmSwappedImageToFootage = 0;
  let rhythmSwappedFootageToImage = 0;
  let rhythmRunsLeftUnbroken = 0;
  {
    // Available clip slots = total clips minus what's already reserved as
    // footage. We deduct one for the intro (it consumes its own clip).
    const currentFootageCount = blocks.filter((b) => b.type === "footage" || b.type === "intro").length;
    let footageHeadroom = Math.max(0, clips.length - currentFootageCount);
    let runType: string | null = null;
    let runLen = 0;
    for (let i = 0; i < blocks.length; i++) {
      const t = blocks[i].type;
      if (t === runType) {
        runLen++;
      } else {
        runType = t;
        runLen = 1;
      }
      if (runLen < 3) continue;
      // 3+ consecutive same-type. Decide whether to swap this block.
      if (t === "image") {
        if (footageHeadroom <= 0) {
          rhythmRunsLeftUnbroken++;
          continue;
        }
        blocks[i] = { type: "footage", duration: blocks[i].duration };
        blockRecommendedTypes[i] = "footage";
        // Clear image-only refs so Phase C doesn't try to image-search a
        // footage block. mentioned_entities stay valid for clip scoring.
        blockSpecificRefs[i] = [];
        footageHeadroom--;
        rhythmSwappedImageToFootage++;
      } else if (t === "footage") {
        blocks[i] = { type: "image", duration: blocks[i].duration };
        blockRecommendedTypes[i] = "image";
        footageHeadroom++;
        rhythmSwappedFootageToImage++;
      } else {
        // Other types (split_2 / title_card / intro): don't rebalance.
        rhythmRunsLeftUnbroken++;
        continue;
      }
      // Reset the run tracking — the post-swap block starts a new run of
      // length 1 in its new type. Subsequent blocks of the original type
      // are now a fresh run (length restarts at the next block).
      runType = blocks[i].type;
      runLen = 1;
    }
  }
  await logJob({ projectId, jobId: mediaJobId }, "match.visual_rhythm", {
    swappedImageToFootage: rhythmSwappedImageToFootage,
    swappedFootageToImage: rhythmSwappedFootageToImage,
    runsLeftUnbroken: rhythmRunsLeftUnbroken,
  });

  // Split oversized image blocks into back-to-back 5s holds. Image blocks
  // longer than IMAGE_HOLD_SECONDS only appear after a footage→image
  // downgrade (surplus pass, rhythm-pass swap) carried the footage block's
  // spoken-sentence duration over. A 13s static image is uncomfortable to
  // watch; splitting it into ~5s segments restores the documentary pacing
  // while keeping the total timeline length intact so the voiceover still
  // lines up.
  //
  // The same subject hint metadata is cloned to every fragment so the image
  // matcher routes each fragment using the same entities/references — it
  // may pick the same photo or different photos of the same subject; either
  // way the viewer sees fresh framing every ~5s. We expand every parallel
  // per-block array in lock-step so downstream indexing stays valid.
  {
    const SPLIT_THRESHOLD = IMAGE_HOLD_SECONDS + 1.5;
    const newBlocks: PlannedBlock[] = [];
    const newHintTexts: typeof blockHintTexts = [];
    const newSectionTitles: typeof blockSectionTitles = [];
    const newResolvedSubjects: typeof blockResolvedSubjects = [];
    const newRecommendedTypes: typeof blockRecommendedTypes = [];
    const newSpecificRefs: typeof blockSpecificRefs = [];
    const newSubjectTypes: typeof blockSubjectTypes = [];
    const newVisualPriorities: typeof blockVisualPriorities = [];
    const newHints: typeof hints = [];
    let splitFragmentsCreated = 0;
    let splitSourceBlocks = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type !== "image" || b.duration <= SPLIT_THRESHOLD) {
        newBlocks.push(b);
        newHintTexts.push(blockHintTexts[i] ?? null);
        newSectionTitles.push(blockSectionTitles[i] ?? null);
        newResolvedSubjects.push(blockResolvedSubjects[i] ?? null);
        newRecommendedTypes.push(blockRecommendedTypes[i] ?? null);
        newSpecificRefs.push(blockSpecificRefs[i] ?? []);
        newSubjectTypes.push(blockSubjectTypes[i] ?? null);
        newVisualPriorities.push(blockVisualPriorities[i] ?? null);
        if (i < hints.length) newHints.push(hints[i]);
        continue;
      }
      // Slot the duration into N fragments. Math.round biases toward an
      // even split (13s → 3 fragments of ~4.3s, 11s → 2 of 5.5s) so no
      // fragment lands too far from the IMAGE_HOLD_SECONDS target.
      const slots = Math.max(2, Math.round(b.duration / IMAGE_HOLD_SECONDS));
      const perSlot = Math.round((b.duration / slots) * 10) / 10;
      // Last fragment absorbs the rounding residue so the sum exactly
      // matches the source duration (no drift in total timeline length).
      let remaining = b.duration;
      for (let k = 0; k < slots; k++) {
        const isLast = k === slots - 1;
        const dur = isLast ? Math.round(remaining * 10) / 10 : perSlot;
        remaining = Math.round((remaining - dur) * 10) / 10;
        newBlocks.push({ type: "image", duration: dur });
        newHintTexts.push(blockHintTexts[i] ?? null);
        // Section titles only ride the FIRST fragment so we don't render
        // the same title card multiple times in a row.
        newSectionTitles.push(k === 0 ? (blockSectionTitles[i] ?? null) : null);
        newResolvedSubjects.push(blockResolvedSubjects[i] ?? null);
        newRecommendedTypes.push(blockRecommendedTypes[i] ?? null);
        newSpecificRefs.push(blockSpecificRefs[i] ?? []);
        newSubjectTypes.push(blockSubjectTypes[i] ?? null);
        newVisualPriorities.push(blockVisualPriorities[i] ?? null);
        if (i < hints.length) newHints.push(hints[i]);
      }
      splitFragmentsCreated += slots;
      splitSourceBlocks++;
    }
    blocks = newBlocks;
    blockHintTexts = newHintTexts;
    blockSectionTitles = newSectionTitles;
    blockResolvedSubjects = newResolvedSubjects;
    blockRecommendedTypes = newRecommendedTypes;
    blockSpecificRefs = newSpecificRefs;
    blockSubjectTypes = newSubjectTypes;
    blockVisualPriorities = newVisualPriorities;
    hints = newHints;
    if (splitSourceBlocks > 0) {
      await logJob({ projectId, jobId: mediaJobId }, "match.image_block_split", {
        sourceBlocks: splitSourceBlocks,
        fragmentsCreated: splitFragmentsCreated,
        threshold: SPLIT_THRESHOLD,
      });
    }
  }

  // For each block, derive the voiceover text spoken during that window.
  // The scorer treats each block as a "section" — same prompt, but the
  // text now lines up with the block's actual moment in the audio.
  //
  // When Gemini hints are available, prefer the hint's sentence-aligned
  // text (1–3 complete sentences per block) over re-slicing the transcript
  // by word offsets. The proportional word-slice in buildBlockTexts splits
  // mid-sentence, which leaves both halves without the subject context
  // ("Behind the grand gates of Buckingham Palace lies…" + "…a world few
  // ever see") and downgrades the matcher's ability to pick a relevant
  // clip/image. Falling back to buildBlockTexts only when the hint text
  // is missing keeps the legacy planner working unchanged.
  const wordSlicedTexts = buildBlockTexts(transcript, blocks, voiceoverSeconds);
  const blockTexts = blocks.map((_, i) => {
    const hintText = blockHintTexts[i];
    return hintText && hintText.trim().length > 0 ? hintText : (wordSlicedTexts[i] ?? "");
  });

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

  // Realized block-type tally — useful to see how much title_card / split_2
  // got downgraded to image vs how much landed as Gemini recommended.
  const realizedTypeCounts = {
    footage: 0, image: 0, title_card: 0, split_2: 0, split_4: 0, intro: 0,
  } as Record<string, number>;
  for (const b of blocks) realizedTypeCounts[b.type] = (realizedTypeCounts[b.type] ?? 0) + 1;
  const recommendedTypeCounts = { footage: 0, image: 0, title_card: 0, split_2: 0 } as Record<string, number>;
  for (const t of blockRecommendedTypes) {
    if (t) recommendedTypeCounts[t] = (recommendedTypeCounts[t] ?? 0) + 1;
  }
  const totalDurationSum = sumDurations(blocks);
  const footageDurationSum = blocks
    .filter((b) => b.type === "footage")
    .reduce((s, b) => s + b.duration, 0);
  const realizedFootageRatio = totalDurationSum > 0
    ? Math.round((footageDurationSum / totalDurationSum) * 1000) / 1000
    : 0;

  await logJob({ projectId, jobId: mediaJobId }, "match.plan", {
    voiceoverSeconds,
    avgBlockSeconds: plan.avgBlockSeconds,
    totalBlocks: plan.totalBlocks,
    footageBlocks: plan.footageBlocks,
    imageBlocks: plan.imageBlocks,
    bucket: plan.bucket,
    plannedDurationSum: Math.round(totalDurationSum * 10) / 10,
    blockTextSampleHead: blockTexts[0]?.slice(0, 100) ?? "",
    blockTextSampleMid: blockTexts[Math.floor(blocks.length / 2)]?.slice(0, 100) ?? "",
    entitiesLoaded: allEntities.length,
    blocksWithEntities,
    totalEntityHits,
    planSource,
    realizedTypeCounts,
    recommendedTypeCounts,
    realizedFootageRatio,
    actualBlockCount: blocks.length,
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

  // Phase B: count how many clips carry the source-intent provenance
  // we wired in. If this is 0 on a project that was analyzed/searched
  // after the Phase B deploy, something broke the metadata pipeline.
  const clipsWithProvenance = clipsForMatch.filter(
    (c) => (c.labels ?? []).some((l) => /^(matched_query|intended_subject|source_intent):/i.test(l))
  ).length;

  await logJob({ projectId, jobId: mediaJobId }, "match.scores", {
    blocksScored: blockScores.length,
    totalScorableBlocks: scorableBlockIdxs.length,
    totalBlocks: blocks.length,
    totalClips: clips.length,
    clipsWithLabels,
    clipsWithoutLabels: clips.length - clipsWithLabels,
    clipsWithProvenance,
    avgCandidatesPerBlock: blockScores.length
      ? Math.round((blockScores.reduce((n, s) => n + s.candidates.length, 0) / blockScores.length) * 10) / 10
      : 0,
    scoreBuckets,
    geminiThrew: geminiFailed,
    silentScoringFailure: !geminiFailed && blockScores.length === 0 && clips.length > 0,
    minRelevantScore: MIN_RELEVANT_SCORE,
  });

  // ---- Phase B: deterministic person-first bonus ------------------------
  // The Gemini score from scoreClipsForSections measures visual fit ("does
  // this clip's frame match the block's narration"). It doesn't know which
  // PERSON the clip is supposed to depict — only what's in the frame.
  // We add a transparent, rule-based bonus that rewards matching the
  // resolved_subject from Phase A against the clip's source-intent
  // provenance (matched_query / intended_subject) and visual labels.
  //
  // Scoring rules — straight from the client spec.
  // Priority axis (per client docs, descending):
  //   1. resolved_subject  → matches intended_subject / person_hint
  //   2. matched_query     → query string used to discover the source
  //   3. source_title      → fallback when provenance is missing
  //   4. visual_labels     → on-frame interview / red-carpet / movie cues
  // Bonuses (scaled by subject_present where applicable):
  //   +60  full resolved_subject matches intended_subject / person_hint
  //   +35  full resolved_subject matches matched_query
  //   +25  full resolved_subject matches source_title
  //   +25  strong name-token match anywhere in those hint fields
  //   +20  visual labels include interview / talking head / red carpet /
  //        movie / event / person tokens
  //   +10  source is high-quality (intro_candidate flag, or source-intent
  //        explicitly tagged "person")
  //   -30  title card / logo / subscribe / blank / credits / text-only
  //        labels (junk filter at clip stage missed it)
  //
  // The bonus is added to Gemini's 0-100 score. Final score can exceed 100.
  // Threshold (MIN_RELEVANT_SCORE) still applies post-bonus, so a clip with
  // zero Gemini score but a +60 person bonus passes Tier 1 — which is what
  // the spec wants: footage doesn't need to perfectly match every sentence
  // as long as it shows the right person.

  // Parse provenance from a clip's labels. We persisted "matched_query: X",
  // "intended_subject: Y", "source_intent: Z", "subject_present: yes|no|uncertain"
  // as prefixed tokens in the clip processor; pull them back out here.
  // subject_present is the visual-truth gate: the labeler saw the frame and
  // judged whether the title's person is actually visible. Without it, the
  // matcher's +50 bonus rubber-stamped any clip from a "Dave" source as
  // a Dave-clip, even when the frame showed a stranger.
  function readProvenance(c: ClipForMatch): {
    matched_query: string;
    intended_subject: string;
    source_intent: string;
    is_intro_candidate: boolean;
    subject_present: "yes" | "no" | "uncertain";
  } {
    let mq = "", is = "", si = "", intro = false;
    let sp: "yes" | "no" | "uncertain" = "uncertain";
    for (const l of c.labels ?? []) {
      const low = l.toLowerCase();
      if (low.startsWith("matched_query:")) mq = l.slice("matched_query:".length).trim();
      else if (low.startsWith("intended_subject:")) is = l.slice("intended_subject:".length).trim();
      else if (low.startsWith("source_intent:")) si = l.slice("source_intent:".length).trim();
      else if (low.startsWith("subject_present:")) {
        const v = l.slice("subject_present:".length).trim().toLowerCase();
        if (v === "yes" || v === "no" || v === "uncertain") sp = v;
      }
      else if (low === "intro_candidate") intro = true;
    }
    return {
      matched_query: mq,
      intended_subject: is,
      source_intent: si,
      is_intro_candidate: intro,
      subject_present: sp,
    };
  }

  // Junk-ish labels that should never have made it past the clip stage,
  // but occasionally do (Gemini Vision misclassifies, or a partial response
  // shipped without categories). Match against the raw label strings —
  // setting/subject prefixes don't matter here.
  const JUNK_LABEL_RE = /\b(title card|logo|subscribe|credits|blank frame|text only|end screen|watermark)\b/i;
  // Useful-content labels that signal a clip is a real person shot.
  const USEFUL_LABEL_RE = /\b(interview|talking head|red carpet|movie|event|person|portrait|host|stage|studio|premiere|microphone)\b/i;

  // Compute the deterministic bonus for a (block, clip) pair given the
  // block's resolved subject (from Phase A) and the clip's labels.
  function personFirstBonus(resolvedSubject: string | null, clip: ClipForMatch): {
    bonus: number;
    breakdown: string;
  } {
    const subj = (resolvedSubject ?? "").trim();
    if (!subj) return { bonus: 0, breakdown: "no_subject" };
    const subjLow = subj.toLowerCase();
    // Tokens of the subject's name, minus stop-words (1-letter or generic).
    // Helps with multi-word names: "Salma Hayek" → ["salma", "hayek"], so
    // a clip whose intended_subject says "Salma" still gets +25 even though
    // the full "Salma Hayek" doesn't appear verbatim.
    const subjTokens = subjLow.split(/\s+/).filter((t) => t.length >= 3);

    const prov = readProvenance(clip);
    const intendedHay = `${prov.intended_subject}`.toLowerCase();
    const matchedQueryHay = `${prov.matched_query}`.toLowerCase();
    const sourceTitleHay = `${clip.source_title ?? ""}`.toLowerCase();
    const labelStr = (clip.labels ?? []).join(" ").toLowerCase();

    let bonus = 0;
    const reasons: string[] = [];
    // Person-name bonuses are scaled by the labeler's visual judgement.
    // The base bonus says "this clip CAME FROM a source about Dave" — a
    // provenance fact. subject_present says "Dave IS / IS NOT in the
    // frame" — a visual fact. We trust the visual fact:
    //   yes       → full bonus (the title's person is on screen, possibly
    //               with others — both cases are good)
    //   uncertain → half bonus (could be a B-roll location, could be the
    //               subject from an angle we couldn't judge — eligible
    //               filler but not a winner over a confirmed clip)
    //   no        → zero bonus (frame has people, none of them is the
    //               title's person — must not impersonate them)
    //
    // Priority order per client spec (highest → lowest): intended_subject /
    // person_hint > matched_query > source_title. We pick the strongest
    // hit available rather than summing — a clip that matches all three
    // gets one bonus (the strongest), not three stacked bonuses.
    let nameBonus = 0;
    let nameReason = "";
    if (intendedHay.includes(subjLow)) {
      nameBonus = 60;
      nameReason = "intended_subject_full";
    } else if (matchedQueryHay.includes(subjLow)) {
      nameBonus = 35;
      nameReason = "matched_query_full";
    } else if (sourceTitleHay.includes(subjLow)) {
      nameBonus = 25;
      nameReason = "source_title_full";
    } else if (subjTokens.length > 0) {
      // Fall back to weaker token-overlap on any of the same fields.
      const allHay = `${intendedHay} | ${matchedQueryHay} | ${sourceTitleHay}`;
      if (subjTokens.some((t) => allHay.includes(t))) {
        nameBonus = 25;
        nameReason = "subject_token_match";
      }
    }
    if (nameBonus > 0) {
      const scale = prov.subject_present === "yes" ? 1
        : prov.subject_present === "uncertain" ? 0.5
        : 0;
      const scaled = Math.round(nameBonus * scale);
      bonus += scaled;
      reasons.push(`${nameReason}:+${nameBonus}*${scale}(present=${prov.subject_present})=+${scaled}`);
    }
    // +20 — useful visual content labels (interview / red carpet / movie /
    // event / person tokens). Bumped from +15 so visible-content evidence
    // matters more relative to provenance-only matches.
    if (USEFUL_LABEL_RE.test(labelStr)) {
      bonus += 20;
      reasons.push("useful_labels:+20");
    }
    // +10 — high-quality source signal
    if (prov.is_intro_candidate || prov.source_intent === "person") {
      bonus += 10;
      reasons.push("high_quality_source:+10");
    }
    // -30 — junk content that slipped past the clip-stage filter
    if (JUNK_LABEL_RE.test(labelStr)) {
      bonus -= 30;
      reasons.push("junk_label:-30");
    }
    return { bonus, breakdown: reasons.join(",") || "no_bonus" };
  }

  // Person-visible gate. A clip QUALIFIES as a "person clip" when its
  // labels contain at least one person-visible token AND don't include
  // hard exclusions like grille/engine/wheel. The intro selector already
  // defined PERSON_VISIBLE_RE / NOT_PERSON_RE earlier in this function —
  // reuse them so the rules stay aligned. Subject_present is a secondary
  // signal: a clip explicitly tagged subject_present=yes still qualifies
  // even if its labels don't carry an explicit person token (the labeler
  // sometimes describes a person via clothing/age only).
  function clipShowsPerson(clip: ClipForMatch): boolean {
    const prov = readProvenance(clip);
    if (prov.subject_present === "yes") return true;
    const labelStr = (clip.labels ?? []).join(" ").toLowerCase();
    if (NOT_PERSON_RE.test(labelStr) && !PERSON_VISIBLE_RE.test(labelStr)) return false;
    return PERSON_VISIBLE_RE.test(labelStr);
  }

  // ---- Tier 1: Gemini-scored global assignment -------------------------
  // Greedy-by-best-score across all (block, clip) pairs that cleared
  // MIN_RELEVANT_SCORE after the person-first bonus. Walk triples by score
  // desc; assign each pair to its block IF both block and clip are still
  // free. Each clip used at most once. This produces all the high-confidence
  // matches.
  //
  // Hard person-first gate: for blocks whose visual_priority is
  // "person_default" (the documentary "show the person" rule), reject any
  // clip whose labels show no person at all — even when its Gemini score
  // is high. This is what was letting car-grille / workshop-floor / co-host
  // B-roll land under person-narrating blocks. The gate runs BEFORE the
  // bonus is computed so the rejected pair never enters the triple list.
  type Triple = { blockIdx: number; clipId: string; score: number; baseScore: number; bonus: number; reason?: string; bonusBreakdown?: string };
  const triples: Triple[] = [];
  let personGateRejections = 0;
  // Index clips by id for fast bonus lookup inside the triple loop.
  const clipById = new Map<string, ClipForMatch>(clipsForMatch.map((c) => [c.id, c]));
  for (const [blockIdx, cands] of scoresByBlock) {
    const resolvedSubject = blockResolvedSubjects[blockIdx] ?? null;
    const visualPriority = blockVisualPriorities[blockIdx] ?? null;
    // person_default is the documentary default — narration about a person.
    // null priority (legacy planner) also defaults to person-gated because
    // those blocks are always footage about the celebrity.
    const requiresPerson = visualPriority === "person_default" || visualPriority === null;
    for (const c of cands) {
      const clip = clipById.get(c.clip_id);
      if (requiresPerson && clip && !clipShowsPerson(clip)) {
        personGateRejections++;
        continue;
      }
      const { bonus, breakdown } = clip
        ? personFirstBonus(resolvedSubject, clip)
        : { bonus: 0, breakdown: "missing_clip" };
      const finalScore = c.score + bonus;
      if (finalScore < MIN_RELEVANT_SCORE) continue;
      triples.push({
        blockIdx,
        clipId: c.clip_id,
        score: finalScore,
        baseScore: c.score,
        bonus,
        reason: c.reason,
        bonusBreakdown: breakdown,
      });
    }
  }
  triples.sort((a, b) => b.score - a.score);

  type Assignment = {
    clipId: string;
    score: number;
    baseScore?: number;
    bonus?: number;
    bonusBreakdown?: string;
    reason?: string;
    tier: "scored" | "filler";
  };
  const blockAssignments = new Map<number, Assignment>();
  const usedClipIds = new Set<string>();
  // Reserve the intro clip so the regular matcher can't re-use it inside
  // the timeline. The intro plays as a prefix segment, not as a timeline block.
  // Phase B: this is also the hard "no clip_id reuse" guarantee — every
  // clip that gets assigned (intro, scored, or filler) goes into this set
  // before any other block can claim it.
  if (introClipId) usedClipIds.add(introClipId);
  for (const t of triples) {
    if (blockAssignments.has(t.blockIdx)) continue;
    if (usedClipIds.has(t.clipId)) continue;
    blockAssignments.set(t.blockIdx, {
      clipId: t.clipId,
      score: t.score,
      baseScore: t.baseScore,
      bonus: t.bonus,
      bonusBreakdown: t.bonusBreakdown,
      reason: t.reason,
      tier: "scored",
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
    const visualPriority = blockVisualPriorities[blockIdx] ?? null;
    const requiresPerson = visualPriority === "person_default" || visualPriority === null;
    if (!blockText) {
      // No words to compare against — fall back to first unused clip
      // that satisfies the person-visible gate.
      for (const c of clipsForMatch) {
        if (usedClipIds.has(c.id)) continue;
        if (requiresPerson && !clipShowsPerson(c)) continue;
        return { clipId: c.id, overlap: 0 };
      }
      return null;
    }
    const blockToks = tokenize(blockText);
    let best: { clipId: string; overlap: number } | null = null;
    for (const c of clipsForMatch) {
      if (usedClipIds.has(c.id)) continue;
      if (requiresPerson && !clipShowsPerson(c)) continue;
      const labels = clipTokens.get(c.id) ?? new Set();
      let overlap = 0;
      for (const t of labels) if (blockToks.has(t)) overlap++;
      if (!best || overlap > best.overlap) {
        best = { clipId: c.id, overlap };
      }
    }
    return best;
  }

  // ---- Block timing (drives reuse cooldown distance) -------------------
  // Cumulative timeline second at which each block STARTS. The intro is a
  // prefix segment played BEFORE the timeline begins, so block 0 starts at
  // t=0 regardless of the intro. We use this to enforce "reuse must be
  // spread by N minutes" — same clip not within ~3min, same image not
  // within ~2min — per the client spec.
  const blockStartSec: number[] = new Array(blocks.length).fill(0);
  {
    let acc = 0;
    for (let i = 0; i < blocks.length; i++) {
      blockStartSec[i] = acc;
      acc += blocks[i].duration;
    }
  }

  // Same-clip reuse cooldown. Spec says 3-5 minutes; pick 3 minutes (180s)
  // because longer windows leave too many blocks with no eligible reuse
  // candidate on shorter videos. Same source video has a SHORTER cooldown
  // because the spec explicitly allows that ("same source video allowed
  // more often IF using different clips"); the per-clip-id cooldown above
  // handles "different clips" — we don't need a separate source-cooldown
  // for it.
  const CLIP_REUSE_COOLDOWN_SEC = 180;

  // Map of clip_id → seconds-into-timeline of its last placement. Updated
  // every time a block is assigned. Used by tier 2 / tier 2.5 to pick a
  // clip that's outside the cooldown when possible.
  const clipLastUsedAt = new Map<string, number>();
  if (introClipId) clipLastUsedAt.set(introClipId, -CLIP_REUSE_COOLDOWN_SEC);   // intro is at t=0 by convention
  for (const [bIdx, a] of blockAssignments) {
    clipLastUsedAt.set(a.clipId, blockStartSec[bIdx]);
  }

  // Tier 2.5 reuse picker. Used when the fresh-pool fill produced no
  // candidate. Walks every clip; for each, computes the distance between
  // this block's start time and the clip's last placement; prefers clips
  // outside the cooldown (largest distance wins) and breaks ties by label
  // token overlap.
  function pickReuseClipForBlock(blockIdx: number): { clipId: string; distance: number; overlap: number } | null {
    if (clipsForMatch.length === 0) return null;
    const blockText = blockTexts[blockIdx] ?? "";
    const blockToks = blockText ? tokenize(blockText) : new Set<string>();
    const now = blockStartSec[blockIdx];
    const visualPriority = blockVisualPriorities[blockIdx] ?? null;
    const requiresPerson = visualPriority === "person_default" || visualPriority === null;
    // Two-pass: first try with the person gate enforced; only when it
    // produces nothing do we relax the gate and accept an object-only
    // clip (the truly-degenerate case where the source documentary has
    // no usable person frames at all).
    function scan(enforceGate: boolean): { clipId: string; distance: number; overlap: number } | null {
      let best: { clipId: string; distance: number; overlap: number } | null = null;
      for (const c of clipsForMatch) {
        if (enforceGate && !clipShowsPerson(c)) continue;
        const lastUsed = clipLastUsedAt.get(c.id);
        const distance = lastUsed === undefined ? Number.POSITIVE_INFINITY : now - lastUsed;
        if (distance <= 0) continue;
        const labels = clipTokens.get(c.id) ?? new Set();
        let overlap = 0;
        for (const t of labels) if (blockToks.has(t)) overlap++;
        if (
          !best
          || distance > best.distance
          || (distance === best.distance && overlap > best.overlap)
        ) {
          best = { clipId: c.id, distance, overlap };
        }
      }
      return best;
    }
    return (requiresPerson ? scan(true) : null) ?? scan(false);
  }

  for (const blockIdx of scorableBlockIdxs) {
    if (blockAssignments.has(blockIdx)) continue;
    const filler = pickFillerForBlock(blockIdx);
    if (filler) {
      blockAssignments.set(blockIdx, {
        clipId: filler.clipId,
        score: 0,
        reason: filler.overlap > 0 ? `filler: ${filler.overlap} label tokens` : "filler: no overlap",
        tier: "filler",
      });
      usedClipIds.add(filler.clipId);
      clipLastUsedAt.set(filler.clipId, blockStartSec[blockIdx]);
      continue;
    }
    // Fresh clips exhausted — fall back to REUSE with cooldown. Per the
    // spec, reuse is allowed as long as it's spread across the timeline.
    // Picks the clip whose last use is FURTHEST in the past, breaking
    // ties on label overlap. A reused clip with distance < cooldown is
    // still better than a blank image block (which dilutes the
    // person-first feel), but we tag it so logs surface the warning.
    const reuse = pickReuseClipForBlock(blockIdx);
    if (!reuse) continue;     // pool truly empty → handled in render loop
    const withinCooldown = reuse.distance < CLIP_REUSE_COOLDOWN_SEC;
    blockAssignments.set(blockIdx, {
      clipId: reuse.clipId,
      score: 0,
      reason: withinCooldown
        ? `filler_reuse: ${Math.round(reuse.distance)}s since last use (under ${CLIP_REUSE_COOLDOWN_SEC}s cooldown)`
        : `filler_reuse: ${Math.round(reuse.distance)}s since last use`,
      tier: "filler",
    });
    // NOTE: do NOT add reuse picks to usedClipIds — that set is the
    // "already-used-once" gate. Reuse picks update clipLastUsedAt only,
    // so subsequent blocks can re-pick a different clip on cooldown.
    clipLastUsedAt.set(reuse.clipId, blockStartSec[blockIdx]);
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

  // Phase A metadata helper. Every timeline_item gets the originating
  // block's hint data so downstream phases (B = scoring, C = image search,
  // D = render) can use resolved_subject / section_title /
  // recommended_visual_type without re-deriving them. Stored on the
  // timeline_items.metadata jsonb column — no schema change required.
  const planHintFor = (idx: number) => ({
    plan_source: planSource,
    resolved_subject: blockResolvedSubjects[idx] ?? null,
    section_title: blockSectionTitles[idx] ?? null,
    recommended_visual_type: blockRecommendedTypes[idx] ?? null,
    hint_text: blockHintTexts[idx] ?? null,
    specific_visual_references: blockSpecificRefs[idx] ?? [],
    visual_priority: blockVisualPriorities[idx] ?? null,
    subject_type: blockSubjectTypes[idx] ?? null,
  });

  // Real-duration lookup for footage clamping. video_clips.duration is the
  // source-of-truth: the renderer's cutClip uses ffmpeg's -t flag, which
  // produces a file no longer than the source. If the planner asked for
  // 10s but the clip is only 5s, the rendered video is 5s — and the editor
  // would lie about the timeline length unless we record the real 5s here.
  const clipDurationById = new Map<string, number>(
    clips.map((c) => {
      const stored = Number((c as { duration?: number }).duration ?? 0);
      const derived = Number(c.end_time) - Number(c.start_time);
      const dur = stored > 0 ? stored : derived;
      return [c.id as string, dur > 0 ? dur : 0];
    }),
  );

  // Track how much voiceover time we lose to clip-shorter-than-planned
  // clamping so we can redistribute it back into footage blocks below.
  // Without this redistribution the timeline would end up shorter than the
  // voiceover by the sum of all clamps, re-introducing the render-time
  // duration-mismatch we already fixed in the planner.
  let durationReclaimSeconds = 0;
  let durationClampedCount = 0;

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
        // Clamp planned duration to the clip's real length. The renderer's
        // cutClip uses ffmpeg -t which produces a file no longer than the
        // source, so anything we record above the clip's real duration is
        // a lie that surfaces as editor-total ≠ rendered-total. We keep
        // the clamped seconds in durationReclaimSeconds so a later pass
        // can stretch other footage blocks to absorb the gap.
        const clipDur = clipDurationById.get(assigned.clipId) ?? 0;
        let realDuration = block.duration;
        if (clipDur > 0 && clipDur < block.duration) {
          durationReclaimSeconds += block.duration - clipDur;
          durationClampedCount++;
          realDuration = Math.round(clipDur * 10) / 10;
        }
        items.push({
          project_id: projectId,
          clip_id: assigned.clipId,
          type: "footage",
          position: position++,
          duration: realDuration,
          script_text: blockText || null,
          overlay_text: null,
          metadata: {
            planned: true,
            planned_duration: block.duration,
            clip_duration: clipDur || null,
            duration_clamped: realDuration < block.duration,
            match_score: assigned.score,
            match_base_score: assigned.baseScore ?? null,
            match_bonus: assigned.bonus ?? null,
            match_bonus_breakdown: assigned.bonusBreakdown ?? null,
            match_reason: assigned.reason ?? null,
            pick_source: pickSource,
            block_index: i,
            ...planHintFor(i),
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
            ...planHintFor(i),
          },
          approved: false,
        });
        downgradedCount++;
      }
      continue;
    }

    // Image / title_card / split blocks — placeholders, no clip. Title
    // cards put their section title in overlay_text so the renderer can
    // pick it up directly (and the review UI can show it without parsing
    // metadata). For other types overlay_text stays null.
    const overlayText = block.type === "title_card"
      ? (blockSectionTitles[i] ?? null)
      : null;
    items.push({
      project_id: projectId,
      clip_id: null,
      type: block.type,
      position: position++,
      duration: block.duration,
      script_text: blockText || null,
      overlay_text: overlayText,
      metadata: { placeholder: true, planned: true, block_index: i, ...planHintFor(i) },
      approved: false,
    });
  }

  // ---- Phase C: reference-driven per-block image matching ---------------
  // BEFORE we fall back to the entity-pool approach, walk every image block
  // whose Phase-A hint has specific_visual_references and try to resolve
  // each block to an image that depicts THAT reference. The client spec
  // explicitly calls this out:
  //   "She had a tattoo..." → search "{resolved_subject} tattoo"
  //   "Her mother..."       → search "{resolved_subject} mother"
  //
  // Query priority per the spec:
  //   1. Exact entity/reference from block (mentioned_entities)
  //   2. resolved_subject + reference
  //   3. Section subject + reference (subject from earlier blocks)
  //   4. Main celebrity fallback (bare name)
  //
  // We persist the full provenance ({query_used, source_url, image_url,
  // entity, reason_selected}) on the timeline_items.metadata jsonb so
  // reviewers can see exactly why each image was chosen.
  //
  // Image blocks that don't get filled here (no references, or all queries
  // failed) drop through to the entity-pool pass that follows. That keeps
  // the existing pool logic as the backstop without losing reference
  // precision when the script genuinely calls it out.
  const refUrlSet = new Set<string>();      // URLs claimed by reference pass
  let refImagesAssigned = 0;
  let refImagesFailed = 0;

  // Lowercase tokens that indicate "fetch a logo, not a photo" — feeds the
  // existing fetchImages imgType plumbing.
  const LOGO_REF_TOKENS = /^(logo|company|brand|corporation|corp\.?|inc\.?|llc)$/i;
  // Tokens that indicate poster/cover artwork rather than a head-shot.
  const POSTER_REF_TOKENS = /^(poster|movie|film|show|series|episode)$/i;
  // Tokens that indicate place imagery rather than person-of-the-place.
  const PLACE_REF_TOKENS = /^(building|skyline|landmark|venue|stadium|theater|theatre|museum|palace|monument|landscape)$/i;

  function buildReferenceQueries(
    references: string[],
    resolvedSubject: string | null,
    mentionedEntities: string[],
    subjectType: string | null,
  ): Array<{ query: string; reason: string; imgType?: "photo" | "logo" }> {
    const out: Array<{ query: string; reason: string; imgType?: "photo" | "logo" }> = [];
    const subj = (resolvedSubject ?? mainCelebrity ?? "").trim();

    // Phase D: type-aware routing. When Gemini has typed the block's subject
    // (company / movie / show / place / event / song / object), the docs spec
    // says the visual should depict THAT entity, not the celebrity. We map
    // the type to a search shape that matches the entity's canonical imagery:
    //   company → "{name} logo" with imgType: "logo" (CSE returns vectorized
    //     brand assets, not random photos containing the brand name)
    //   movie / show → "{name} poster" — the canonical promotional image
    //   song → "{name} album cover"
    //   place → "{name}" alone (adding the celebrity anchor produces press
    //     photos of them AT the place instead of the place itself)
    //   event → "{name} archival footage" — try to find news-style imagery
    //   object → "{name}" alone, photo bias
    // This entry runs BEFORE the regex-based reference fallback so the
    // entity gets routed by its known type before we try to infer from the
    // reference string.
    const primaryEntity = (mentionedEntities[0] ?? resolvedSubject ?? "").trim();
    if (primaryEntity && subjectType) {
      // Defensive guards — even with the prompt-side restrictions, Gemini
      // occasionally emits "place" for a country/state ("Utah", "Michigan")
      // or "event" for a bare date ("January 2016"). Those queries pull
      // flags, outline maps, and calendar pages — strictly worse than a
      // celebrity footage fallback. Detect and skip the type routing so the
      // block falls through to subject_plus_reference / footage paths.
      const isGeographicNonLandmark = isCountryOrRegion(primaryEntity);
      const isBareDate = isDateOnly(primaryEntity);

      switch (subjectType) {
        case "company":
          out.push({ query: `${primaryEntity} logo`, reason: `subject_type:company:${primaryEntity}`, imgType: "logo" });
          break;
        case "movie":
          out.push({ query: `${primaryEntity} movie poster`, reason: `subject_type:movie:${primaryEntity}` });
          break;
        case "show":
          out.push({ query: `${primaryEntity} tv show poster`, reason: `subject_type:show:${primaryEntity}` });
          break;
        case "place":
          // Drop country / state / region "places" — they return flags and
          // outline maps, never on-topic photographs. The footage fallback
          // does a better job (Dave Kindig clip + segment context).
          if (!isGeographicNonLandmark) {
            out.push({ query: primaryEntity, reason: `subject_type:place:${primaryEntity}` });
          }
          break;
        case "event":
          // Drop bare dates — image search on "January 2016" returns calendar
          // pages and stock photos. Only route named events through the
          // archival query.
          if (!isBareDate) {
            out.push({ query: `${primaryEntity} archival footage`, reason: `subject_type:event:${primaryEntity}` });
          }
          break;
        case "object":
          out.push({ query: primaryEntity, reason: `subject_type:object:${primaryEntity}` });
          break;
        // "person" and "general" fall through to the reference / subject
        // anchor path below — the existing flow handles them.
      }
    }

    // Tier 1: each mentioned entity verbatim. Highest precision — the script
    // named something concrete (a movie, a place, a person).
    for (const ent of mentionedEntities) {
      const e = ent.trim();
      if (!e) continue;
      out.push({ query: e, reason: `mentioned_entity:${e}` });
    }
    // Tier 2: subject + reference. Most reference→image work lives here.
    // "tattoo" / "mother" / "Frida" combine with the celebrity name to
    // give Wikipedia/CSE a precise image to find.
    for (const ref of references) {
      const r = ref.trim();
      if (!r) continue;
      const isLogo = LOGO_REF_TOKENS.test(r);
      const isPoster = POSTER_REF_TOKENS.test(r);
      const isPlace = PLACE_REF_TOKENS.test(r);
      // Special-case framings: logos/posters/places use the reference WITHOUT
      // the celebrity anchor because the anchor produces press-photos of the
      // celebrity AT the location instead of canonical imagery of the thing.
      if (isLogo) {
        out.push({ query: `${r} logo`, reason: `reference:${r}:logo`, imgType: "logo" });
      } else if (isPoster) {
        out.push({ query: `${r} poster`, reason: `reference:${r}:poster` });
      } else if (isPlace) {
        out.push({ query: r, reason: `reference:${r}:place` });
      } else if (subj) {
        out.push({ query: `${subj} ${r}`, reason: `subject_plus_reference:${subj}:${r}` });
      } else {
        out.push({ query: r, reason: `reference:${r}` });
      }
    }
    // Tier 3: subject alone — only if we exhausted Tier 1 and 2. Skipped
    // here because the entity pool already covers it as a fallback, and
    // we don't want to "use up" a generic subject photo on a reference
    // block that should have a specific image.
    return out;
  }

  // Build queries from proper-noun phrases lifted from a block's script.
  // Skips phrases that are just the subject's name (those go through the
  // person fallback) and phrases that are pure country/state/continent
  // names (those still produce flags/maps). When a phrase contains the
  // subject, we keep it — "Salvage Hunters" needs the title alone, but
  // "Drew Pritchard Salvage Hunters" coming straight from the script is
  // still a high-precision query for image search.
  function buildScriptPhraseQueries(
    scriptText: string,
    subject: string | null,
  ): Array<{ query: string; reason: string; imgType?: "photo" | "logo" }> {
    const phrases = extractScriptPhrases(scriptText);
    if (phrases.length === 0) return [];
    const subjLower = (subject ?? "").trim().toLowerCase();
    const out: Array<{ query: string; reason: string; imgType?: "photo" | "logo" }> = [];
    for (const p of phrases) {
      const pl = p.toLowerCase();
      // Skip subject-name phrases — person fallback handles those, and
      // they shouldn't consume a "reference" search slot.
      if (subjLower && (pl === subjLower || pl === subjLower.split(/\s+/).slice(-1)[0])) continue;
      // Skip pure country/state/region phrases (flag/map noise).
      if (isCountryOrRegion(p)) continue;
      // Skip bare dates.
      if (isDateOnly(p)) continue;
      out.push({ query: p, reason: `script_phrase:${p}` });
    }
    // Cap to 3 queries per block — image fetches cost money and time, and
    // beyond the top phrases we're typically scraping the barrel.
    return out.slice(0, 3);
  }

  // Image reuse cooldown (per client spec: 2-4 minutes for same image).
  // Pick 2 minutes (120s) since image holds are short and shorter videos
  // would otherwise have too few eligible blocks. The reference pass and
  // the entity pool both honor this when picking.
  const IMAGE_REUSE_COOLDOWN_SEC = 120;
  const imageUrlLastUsedAt = new Map<string, number>();

  // Build a list of image-block start seconds, mirroring blockStartSec but
  // indexed by item position rather than by block index. Items are pushed
  // in block order with the intro inserted at position 0, so we look up
  // by item's stored block_index when computing distance.
  function blockSecForItem(it: Record<string, unknown>): number {
    const bi = (it.metadata as Record<string, unknown> | undefined)?.block_index;
    if (typeof bi === "number" && bi >= 0 && bi < blockStartSec.length) {
      return blockStartSec[bi];
    }
    return 0;
  }

  // Per-block PERSON-image fallback. When a "specific_*" block can't find
  // an image of its exact reference (a tattoo, a wedding, a courthouse),
  // the client spec says: fall back to the PERSON image — never to a
  // random pool entry. This helper builds the bare-name search for the
  // block's resolved_subject (or the project celebrity when the subject is
  // unknown). Returns the first non-duplicate image URL respecting the
  // image cooldown.
  async function tryPersonImageFallback(blockIdx: number): Promise<{
    url: string;
    source: string;
    query: string;
  } | null> {
    const subj = (blockResolvedSubjects[blockIdx] || mainCelebrity || "").trim();
    if (!subj) return null;
    const nowSec = blockStartSec[blockIdx];
    try {
      const fetched = await fetchImages(subj, 10, { entityType: "celebrity" });
      if (fetched.length === 0) return null;
      // Three-tier pick. Per client spec: "If an exact image/visual cannot
      // be found → fallback to the person image. NEVER use random unrelated
      // visuals." So we MUST return a person image when any exist — even
      // when they're already used elsewhere in the timeline. Re-showing the
      // same celebrity photo twice is strictly better than dropping through
      // to the entity pool and rendering a random brand logo.
      //
      //   Tier A — fresh URL outside the reuse cooldown (or never used).
      //   Tier B — fresh URL ignoring the cooldown but unused by reference
      //            pass (refUrlSet) — i.e. seen earlier in the timeline as
      //            another person-fallback, fine to repeat.
      //   Tier C — any fetched URL, including ones reference-claimed. This
      //            is the "we'd rather repeat than ship junk" tier.
      let bestA: typeof fetched[number] | null = null;
      let bestB: typeof fetched[number] | null = null;
      let bestBDistance = -Infinity;
      for (const f of fetched) {
        if (refUrlSet.has(f.url)) continue;
        const last = imageUrlLastUsedAt.get(f.url);
        if (last === undefined) {
          bestA = f;
          break;
        }
        const dist = nowSec - last;
        if (dist >= IMAGE_REUSE_COOLDOWN_SEC) {
          bestA = f;
          break;
        }
        if (dist > bestBDistance) {
          bestB = f;
          bestBDistance = dist;
        }
      }
      let pick = bestA ?? bestB;
      if (!pick) {
        // Tier C — every fetched image was already in refUrlSet. Pick the
        // one used longest ago, ignoring refUrlSet. Better to re-show a
        // person photo than to leave the block for the entity pool.
        let bestC: typeof fetched[number] | null = null;
        let bestCDistance = -Infinity;
        for (const f of fetched) {
          const last = imageUrlLastUsedAt.get(f.url);
          const dist = last === undefined ? Infinity : nowSec - last;
          if (dist > bestCDistance) {
            bestCDistance = dist;
            bestC = f;
          }
        }
        pick = bestC;
      }
      if (!pick) return null;
      return { url: pick.url, source: pick.source, query: subj };
    } catch {
      return null;
    }
  }

  // First pass: walk image blocks in order, try to fill from references.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== "image") continue;
    const blockIdx = (item.metadata as Record<string, unknown> | undefined)?.block_index as number | undefined;
    if (blockIdx == null) continue;
    const refs = blockSpecificRefs[blockIdx] ?? [];
    const ents = (hints[blockIdx]?.mentioned_entities) ?? [];
    const subjectType = blockSubjectTypes[blockIdx] ?? null;
    const resolvedSubject = blockResolvedSubjects[blockIdx] ?? null;
    const refQueries = buildReferenceQueries(refs, resolvedSubject, ents, subjectType);
    // Tier 4 (script-derived): proper-noun phrases lifted straight from the
    // block's narration. This catches references Gemini's hint pipeline
    // dropped — e.g. "District Court of Utah" gets blocked from the entity
    // pool because "Utah" is a generic-place stop, but the narrator is
    // clearly asking for a courthouse image. We extract capitalized phrases
    // (allowing connector words like "of"/"the") and use them as queries.
    // Run AFTER the reference-driven queries so Gemini's curated picks win
    // when they exist, but BEFORE the person fallback so we still try for
    // a topical image before defaulting to the celebrity.
    const scriptText = blockTexts[blockIdx] ?? "";
    const scriptQueries = buildScriptPhraseQueries(scriptText, resolvedSubject ?? mainCelebrity ?? null);
    const queries = [...refQueries, ...scriptQueries];
    const nowSec = blockStartSec[blockIdx];
    let filled = false;
    for (const q of queries) {
      try {
        // Build context tokens from the query's proper-noun words. This
        // gates out CSE substitutions — e.g. searching "Kindigit Design
        // logo" used to return "Strong Guard" (similar-shape fist logo)
        // when CSE couldn't find the exact mark. With context-token
        // gating, only results whose source page mentions "kindigit" or
        // "design" survive. Generic words ("logo", "poster") are skipped
        // since every logo result has "logo" in its URL. We keep the
        // query's MAIN entity words by requiring tokens ≥4 chars and
        // dropping a small list of search-modifier words.
        const QUERY_MODIFIERS = new Set(["logo", "poster", "cover", "album", "movie", "show", "tv", "film", "image", "photo", "picture"]);
        const ctxTokens = q.query
          .split(/\s+/)
          .map((w) => w.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase())
          .filter((w) => w.length >= 4 && !QUERY_MODIFIERS.has(w));
        // Fetch more per query (was 4 → now 8) so long sentences that
        // split into multiple image slots all sharing the same hint can
        // each claim a distinct image. The refUrlSet dedup below picks
        // the first not-yet-used URL, so the bigger pool means cloned
        // blocks don't run out and fall back to the entity pool.
        const fetched = await fetchImages(q.query, 8, {
          imgType: q.imgType,
          requireContextTokens: ctxTokens.length > 0 ? ctxTokens : undefined,
        });
        // Take the first non-duplicate image. We use a per-pass set to
        // avoid two image blocks landing on the same URL when the script
        // mentions the same reference twice. Also honor the image cooldown
        // so the same picture doesn't repeat within ~2 minutes.
        const pick = fetched.find((f) => {
          if (refUrlSet.has(f.url)) return false;
          const last = imageUrlLastUsedAt.get(f.url);
          if (last === undefined) return true;
          return nowSec - last >= IMAGE_REUSE_COOLDOWN_SEC;
        });
        if (!pick) continue;
        refUrlSet.add(pick.url);
        imageUrlLastUsedAt.set(pick.url, nowSec);
        item.image_url = pick.url;
        item.image_query = q.query;
        item.image_source = pick.source;
        const meta = (item.metadata ?? {}) as Record<string, unknown>;
        meta.image_query_used = q.query;
        meta.image_source_url = pick.url;
        meta.image_source_provider = pick.source;
        meta.image_entity = refs[0] ?? ents[0] ?? null;
        meta.image_reason = q.reason;
        meta.image_pick_source = q.reason.startsWith("script_phrase:") ? "script_phrase" : "reference_driven";
        item.metadata = meta;
        refImagesAssigned++;
        filled = true;
        break;
      } catch (e) {
        void logJob({ projectId, jobId: mediaJobId },
          "match.image_ref.failed", {
            blockIndex: blockIdx, query: q.query, err: (e as Error).message,
          });
      }
    }
    // Spec fallback: when the specific reference / type-routed search did
    // NOT produce a usable image, fall back to the PERSON image instead of
    // letting this block drop through to the entity pool. The entity pool
    // is a fine LAST resort, but the spec is explicit: "If an exact
    // image/visual cannot be found → fallback to the person image/footage.
    // NEVER use random unrelated visuals." Person fallback runs BEFORE
    // pool assignment so it gets first pick of fresh person images.
    if (!filled) {
      refImagesFailed++;
      const personPick = await tryPersonImageFallback(blockIdx);
      if (personPick) {
        refUrlSet.add(personPick.url);
        imageUrlLastUsedAt.set(personPick.url, nowSec);
        item.image_url = personPick.url;
        item.image_query = personPick.query;
        item.image_source = personPick.source;
        const meta = (item.metadata ?? {}) as Record<string, unknown>;
        meta.image_query_used = personPick.query;
        meta.image_source_url = personPick.url;
        meta.image_source_provider = personPick.source;
        meta.image_entity = personPick.query;
        meta.image_reason = "person_image_fallback";
        meta.image_pick_source = "person_fallback";
        item.metadata = meta;
      }
    }
  }

  // Count how many blocks ended up using the person-image fallback rather
  // than a true reference match. High counts here mean Gemini emitted
  // specific_event/object refs that didn't produce any image — useful
  // signal for tuning the prompt.
  const personFallbackCount = items.filter(
    (it) => it.type === "image"
      && (it.metadata as Record<string, unknown> | undefined)?.image_pick_source === "person_fallback",
  ).length;
  await logJob({ projectId, jobId: mediaJobId }, "match.image_ref", {
    refImagesAssigned,
    refImagesFailed,
    refBlocksWithHints: blockSpecificRefs.filter((r) => r.length > 0).length,
    personFallbackCount,
  });

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
  const poolFetchStats = {
    entitiesQueried: 0,
    entitiesFailed: 0,
    // Person-image floor diagnostics. The pool is supposed to feel
    // person-first (Dave Kindig himself), not logo-heavy — so we track how
    // many celebrity photos we managed to fetch vs the 50% target. A run
    // that lands far below the target means Wikipedia/Brave/CSE collapsed
    // to a handful of unique URLs for this celebrity and the diversified
    // queries below couldn't backfill — useful signal when the client says
    // "I see logos more than the person."
    personImagesPrefetched: 0,
    personFloorTarget: 0,
  };

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

  // Person-image floor: before any other entity is queried, fetch enough
  // images of the project's main celebrity to cover at least 50% of the
  // image block count. Without this, the entity loop below stops as soon
  // as pool.length >= imageBlockCount, which means a celebrity with sparse
  // search results (2-3 unique URLs after dedup) gets crowded out by
  // company logos that happen to return cleanly — the pool ends up logo-
  // dominant and the viewer sees the person rarely on screen.
  //
  // We diversify the celebrity query when the strict quoted name returns
  // less than the floor. Each follow-up query targets a different visual
  // facet (interview, portrait, shop / set context) so search engines
  // surface different press shots instead of the same handful of canonical
  // images at multiple thumbnail sizes (which all collapse to one URL via
  // normalizeImageUrl). When the celebrity is unknown (rare — non-person-
  // centric video), the floor is skipped and the legacy entity loop runs
  // unchanged.
  const personFloor = mainCelebrity
    ? Math.min(imageBlockCount, Math.ceil(imageBlockCount * 0.5))
    : 0;
  poolFetchStats.personFloorTarget = personFloor;
  if (mainCelebrity && personFloor > 0) {
    // Query variants in priority order. The bare quoted name runs first
    // because it returns the highest-precision results; diversified queries
    // only run if dedup collapsed the bare query down to too few unique
    // URLs. We keep the variant set small — three extras — because each
    // call is an HTTP round-trip and the pool's downstream relaxed pass
    // already provides a safety net.
    const celebrityQueries: string[] = [
      `"${mainCelebrity}"`,
      `${mainCelebrity} interview`,
      `${mainCelebrity} portrait`,
      `${mainCelebrity} shop`,
    ];
    for (const cq of celebrityQueries) {
      if (pool.length >= personFloor) break;
      poolFetchStats.entitiesQueried++;
      try {
        const fetched = await fetchImages(cq, IMAGES_PER_ENTITY, {
          entityType: "celebrity",
        });
        if (fetched.length === 0) {
          poolFetchStats.entitiesFailed++;
          continue;
        }
        for (const f of fetched) {
          if (poolUrlSet.has(f.url)) continue;
          pool.push({ url: f.url, source: f.source, query: cq, entityType: "celebrity" });
          poolUrlSet.add(f.url);
          poolFetchStats.personImagesPrefetched++;
          if (pool.length >= personFloor) break;
        }
      } catch (e) {
        poolFetchStats.entitiesFailed++;
        void logJob({ projectId, jobId: mediaJobId },
          "match.image_fetch.failed", { query: cq, personFloor: true, err: (e as Error).message });
      }
    }
  }

  for (const ent of poolEntities) {
    if (pool.length >= imageBlockCount) break;       // already have enough
    // Skip celebrity entities here — they were handled by the person-floor
    // prefetch above. Running them again would burn a query for the same
    // URLs the prefetch already dedup-rejected and bias the pool back
    // toward "celebrity has 2 unique results" → bumping into the rest of
    // the loop too quickly. The celebrity slot is fully owned by the
    // prefetch so the main loop's job is filling the remaining ~50% with
    // related people, companies, places, events, etc.
    if (mainCelebrity && ent.type === "celebrity") continue;
    const spec = buildImageQuery(ent);
    poolFetchStats.entitiesQueried++;
    // For non-person entities (company, place, movie, etc.), require the
    // entity name's distinctive words to appear in each result's context
    // URL. Otherwise CSE substitutes a visually-similar but unrelated
    // logo/poster — the bug behind "Kindigit Design" returning Strong
    // Guard logos. The check is bypassed for celebrity-typed entities
    // (already filtered out above) and for person-typed mentions.
    const QUERY_MODIFIERS_POOL = new Set(["logo", "poster", "cover", "album", "movie", "show", "tv", "film", "image", "photo", "picture", "ceremony"]);
    const poolCtxTokens = ent.value
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase())
      .filter((w) => w.length >= 4 && !QUERY_MODIFIERS_POOL.has(w));
    try {
      const fetched = await fetchImages(spec.query, IMAGES_PER_ENTITY, {
        entityType: ent.type,
        imgType: spec.imgType,
        requireContextTokens: poolCtxTokens.length > 0 ? poolCtxTokens : undefined,
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
  // Last-used timestamp per pool index. Reuse picks the entry whose last
  // use is OLDEST so reuse is spread evenly across the pool rather than
  // hammering pool[0]. Initialized to -1 (= never used).
  const lastUsedAt: number[] = new Array(pool.length).fill(-1);
  let useCounter = 0;
  let imagesReused = 0;
  let poolGatedToPerson = 0;
  // Pre-build per-pool-entry relevance tokens once. Each pool image is
  // tied to an entity (Gemini-extracted, e.g. "Kindigit Design"). We use
  // those tokens to verify the block's narration actually references the
  // entity before we paste its image onto an otherwise-abstract block.
  // Without this gate, abstract blocks ("Settlements can save time")
  // picked up random pool entries ("AirTouch") because the pool was just
  // walked in order.
  const poolEntityTokens = pool.map((p) => {
    const out = new Set<string>();
    for (const tok of p.query.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length >= 3) out.add(tok);
    }
    return out;
  });
  function blockRelevantToPoolEntry(blockIdx: number, poolIdx: number): boolean {
    const entry = pool[poolIdx];
    // Person-typed pool entries (celebrity / related_person) are always
    // relevant — they're the canonical "show the person" fallback.
    if (entry.entityType === "celebrity" || entry.entityType === "related_person") {
      return true;
    }
    // Non-person pool entries (company, place, movie, show, song, event,
    // life_event) must have their entity name appear in the block's text
    // OR Gemini's hint-extracted entities for this block. Otherwise the
    // image will be visually orthogonal to the narration.
    const tokens = poolEntityTokens[poolIdx];
    if (tokens.size === 0) return true;        // entry had no usable tokens — let it through
    const scriptText = (blockTexts[blockIdx] ?? "").toLowerCase();
    for (const tok of tokens) {
      if (scriptText.includes(tok)) return true;
    }
    const ents = hints[blockIdx]?.mentioned_entities ?? [];
    for (const e of ents) {
      const el = e.toLowerCase();
      for (const tok of tokens) {
        if (el.includes(tok)) return true;
      }
    }
    return false;
  }
  for (const item of items) {
    if (item.type !== "image") continue;
    // Phase C: skip blocks the reference-driven pass already filled —
    // their image_url is the specific reference image the script asked
    // for, and we don't want to overwrite it with a generic pool entry.
    if (item.image_url) continue;
    const nowSec = blockSecForItem(item);
    const blockIdx = (item.metadata as Record<string, unknown> | undefined)?.block_index as number | undefined;
    // Try to find a pool entry whose entity name actually appears in the
    // block's narration. We scan the pool in priority order (sorted by
    // entity type + confidence at pool-build time) and prefer:
    //   1) A fresh entry (not consumed) that's relevant + outside cooldown.
    //   2) A fresh entry that's relevant but inside cooldown (soft).
    //   3) Any consumed entry that's relevant (reuse).
    // If no relevant entry exists at all, fall through to the person
    // fallback — never paste a brand logo over abstract narration.
    let idx = -1;
    if (blockIdx != null) {
      // Tier 1 — relevant + fresh + outside cooldown.
      for (let j = 0; j < pool.length; j++) {
        if (consumed.has(j)) continue;
        if (!blockRelevantToPoolEntry(blockIdx, j)) continue;
        const last = imageUrlLastUsedAt.get(pool[j].url);
        if (last === undefined || nowSec - last >= IMAGE_REUSE_COOLDOWN_SEC) {
          idx = j;
          break;
        }
      }
      // Tier 2 — relevant + fresh, ignoring cooldown.
      if (idx < 0) {
        for (let j = 0; j < pool.length; j++) {
          if (consumed.has(j)) continue;
          if (!blockRelevantToPoolEntry(blockIdx, j)) continue;
          idx = j;
          break;
        }
      }
      // Tier 3 — relevant + reused. Pick the longest-since-last-used.
      if (idx < 0) {
        let bestAge = Number.POSITIVE_INFINITY;
        for (let j = 0; j < pool.length; j++) {
          if (!blockRelevantToPoolEntry(blockIdx, j)) continue;
          const age = lastUsedAt[j];
          if (age < bestAge) { bestAge = age; idx = j; }
        }
        if (idx >= 0) imagesReused++;
      }
    }
    if (idx < 0) {
      // No relevant pool entry — try person fallback (with reuse OK so a
      // repeated celebrity photo is acceptable). This is the path that
      // catches abstract narration like "settlements can save time" — the
      // old behavior here was to paste a random pool image (AirTouch); new
      // behavior is to show the celebrity instead.
      poolGatedToPerson++;
      if (blockIdx != null) {
        const personPick = await tryPersonImageFallback(blockIdx);
        if (personPick) {
          refUrlSet.add(personPick.url);
          imageUrlLastUsedAt.set(personPick.url, nowSec);
          item.image_url = personPick.url;
          item.image_query = personPick.query;
          item.image_source = personPick.source;
          const meta = (item.metadata ?? {}) as Record<string, unknown>;
          meta.image_query_used = personPick.query;
          meta.image_source_url = personPick.url;
          meta.image_source_provider = personPick.source;
          meta.image_entity = personPick.query;
          meta.image_reason = "person_image_fallback_after_pool_gate";
          meta.image_pick_source = "person_fallback";
          item.metadata = meta;
        }
      }
      continue;
    }
    // We found a relevant pool entry — mark consumed (if fresh) and stamp
    // metadata. Fresh = not yet picked AND not yet imagesReused-flagged.
    if (!consumed.has(idx)) consumed.add(idx);
    const next = pool[idx];
    item.image_query = next.query;
    item.image_url = next.url;
    item.image_source = next.source;
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    meta.image_query_used = next.query;
    meta.image_source_url = next.url;
    meta.image_source_provider = next.source;
    meta.image_entity = next.entityType;
    meta.image_reason = `entity_pool:${next.entityType}`;
    meta.image_pick_source = "entity_pool";
    item.metadata = meta;
    lastUsedAt[idx] = useCounter++;
    imageUrlLastUsedAt.set(next.url, nowSec);
  }

  await logJob({ projectId, jobId: mediaJobId }, "match.image_fetch", {
    totalImageBlocks: imageBlockCount,
    poolSize: pool.length,
    // Some image blocks now route through the person fallback when the
    // pool has no entity relevant to the block's narration (per spec —
    // we no longer paste random brand logos onto abstract narration).
    // The diff (totalImageBlocks - poolGatedToPerson) is what actually
    // landed on a pool entry; assigned is now imprecise for legacy logs.
    assigned: pool.length > 0 ? imageBlockCount : 0,
    imagesReused,
    poolGatedToPerson,
    leftBlank: pool.length === 0 ? imageBlockCount : 0,
    entitiesAvailable: poolEntities.length,
    entitiesQueried: poolFetchStats.entitiesQueried,
    entitiesFailed: poolFetchStats.entitiesFailed,
    personFloorTarget: poolFetchStats.personFloorTarget,
    personImagesPrefetched: poolFetchStats.personImagesPrefetched,
  });

  // ---- Split-screen image fill -----------------------------------------
  // Walk split_2 blocks (cap-survivors from earlier in this function) and
  // resolve a LEFT and RIGHT image for each. Strategy per side:
  //   1) Try the corresponding mentioned_entity via the same reference
  //      query builder used for ordinary image blocks (Tier 1 / Tier 2).
  //   2) On miss, draw from the project image pool — same pool feeding
  //      regular image blocks. Per client direction, split-screen halves
  //      do NOT have to relate to what the narrator is saying; any pool
  //      image is acceptable.
  // The LEFT image lives on item.image_url (so existing UI/tooling that
  // reads image_url still gets a preview), and the RIGHT image is stored
  // on item.metadata.right_image_url. The renderer consumes both.
  const POOL_FALLBACK_REASON = "split_pool_fallback";
  let splitsAssigned = 0;
  let splitsLeftFailed = 0;
  let splitsRightFailed = 0;
  // Track which pool entries we've used for split halves so we don't pick
  // the same URL for left and right of the same block, and so a later
  // split doesn't repeat the same pair. We don't consume() from the main
  // pool — splits get to reuse images already shown elsewhere, which is
  // fine because they live in a half-width slot.
  const splitUsedUrls = new Set<string>();
  async function resolveSplitSide(
    entity: string | null,
    blockIdx: number,
    nowSec: number,
    forbiddenUrls: Set<string>,
  ): Promise<{ url: string; query: string; source: string; reason: string } | null> {
    // Tier 1 — try the entity as a literal query (same shape as the
    // mentioned_entity branch in buildReferenceQueries). Skip when Gemini
    // didn't name a second entity for this block.
    if (entity && entity.trim()) {
      const q = entity.trim();
      try {
        const fetched = await fetchImages(q, 6, {});
        for (const f of fetched) {
          if (forbiddenUrls.has(f.url)) continue;
          if (refUrlSet.has(f.url)) continue;
          const last = imageUrlLastUsedAt.get(f.url);
          if (last !== undefined && nowSec - last < IMAGE_REUSE_COOLDOWN_SEC) continue;
          return { url: f.url, query: q, source: f.source, reason: `split_entity:${q}` };
        }
      } catch (e) {
        void logJob({ projectId, jobId: mediaJobId },
          "match.split.fetch_failed", { blockIndex: blockIdx, query: q, err: (e as Error).message });
      }
    }
    // Tier 2 — pool fallback. Any pool entry that isn't forbidden by the
    // caller (i.e. already used on the other side) and isn't cooling down.
    for (const p of pool) {
      if (forbiddenUrls.has(p.url)) continue;
      const last = imageUrlLastUsedAt.get(p.url);
      if (last !== undefined && nowSec - last < IMAGE_REUSE_COOLDOWN_SEC) continue;
      return { url: p.url, query: p.query, source: p.source, reason: POOL_FALLBACK_REASON };
    }
    // Tier 3 — pool but ignore cooldown. Better to repeat a recent image
    // in a half-frame slot than to leave the split half-empty.
    for (const p of pool) {
      if (forbiddenUrls.has(p.url)) continue;
      return { url: p.url, query: p.query, source: p.source, reason: POOL_FALLBACK_REASON };
    }
    return null;
  }
  for (const item of items) {
    if (item.type !== "split_2") continue;
    const blockIdx = (item.metadata as Record<string, unknown> | undefined)?.block_index as number | undefined;
    if (blockIdx == null) continue;
    const ents = (hints[blockIdx]?.mentioned_entities) ?? [];
    const nowSec = blockSecForItem(item);
    const localForbidden = new Set<string>(splitUsedUrls);
    // LEFT side: first mentioned entity (if any) or pool.
    const leftPick = await resolveSplitSide(ents[0] ?? null, blockIdx, nowSec, localForbidden);
    if (leftPick) {
      localForbidden.add(leftPick.url);
    } else {
      splitsLeftFailed++;
    }
    // RIGHT side: second mentioned entity (if any) or pool. Pass LEFT's
    // URL as forbidden so the two halves are never the same image.
    const rightPick = await resolveSplitSide(ents[1] ?? null, blockIdx, nowSec, localForbidden);
    if (rightPick) {
      localForbidden.add(rightPick.url);
    } else {
      splitsRightFailed++;
    }
    // If we couldn't resolve ANY image for either side, downgrade this
    // block to a plain image and let the next render pick a pool entry.
    // We can't render an empty split-screen.
    if (!leftPick && !rightPick) continue;
    // If only one side resolved, downgrade to a single full-frame image
    // using whichever URL we have. The renderer then treats this as a
    // normal image block.
    if (leftPick && !rightPick) {
      item.type = "image";
      item.image_url = leftPick.url;
      item.image_query = leftPick.query;
      item.image_source = leftPick.source;
      const meta = (item.metadata ?? {}) as Record<string, unknown>;
      meta.image_pick_source = "split_downgrade_to_single";
      item.metadata = meta;
      continue;
    }
    if (!leftPick && rightPick) {
      item.type = "image";
      item.image_url = rightPick.url;
      item.image_query = rightPick.query;
      item.image_source = rightPick.source;
      const meta = (item.metadata ?? {}) as Record<string, unknown>;
      meta.image_pick_source = "split_downgrade_to_single";
      item.metadata = meta;
      continue;
    }
    // Happy path — both sides resolved. Persist left on the existing
    // image_url column (so the review UI's existing preview keeps working
    // for the left half) and right on metadata.
    item.image_url = leftPick!.url;
    item.image_query = leftPick!.query;
    item.image_source = leftPick!.source;
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    meta.image_pick_source = "split_screen";
    meta.left_image_url = leftPick!.url;
    meta.left_image_query = leftPick!.query;
    meta.left_image_source = leftPick!.source;
    meta.left_image_reason = leftPick!.reason;
    meta.right_image_url = rightPick!.url;
    meta.right_image_query = rightPick!.query;
    meta.right_image_source = rightPick!.source;
    meta.right_image_reason = rightPick!.reason;
    item.metadata = meta;
    splitUsedUrls.add(leftPick!.url);
    splitUsedUrls.add(rightPick!.url);
    splitsAssigned++;
  }
  const splitBlocksTotal = items.filter((it) => it.type === "split_2").length;
  await logJob({ projectId, jobId: mediaJobId }, "match.split_screen", {
    splitBlocksTotal,
    splitsAssigned,
    splitsLeftFailed,
    splitsRightFailed,
    splitDowngradedByCap,
    splitPromotedToFloor,
    bucketsBelowFloor,
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
    personGateRejections,
  });

  // ---- Lower-third tagging --------------------------------------------
  // Stamp metadata.lower_third on items where the client-requested overlay
  // should burn in during render. Per client spec: at most one lower-third
  // every 60 seconds of timeline, drawn from the names / years / places
  // the narrator is mentioning around that moment (these are the red-
  // highlighted words in the script — celebrities, related_persons, years,
  // places extracted from the same transcript window).
  //
  // We walk items in playback order, accumulating duration. A clip is
  // eligible only when ≥ 60s has passed since the previous overlay (or it
  // is the first eligible clip). When eligible, we prefer name → year →
  // place — a name-on-screen is the strongest signal — and pick from the
  // block's own entity list so the overlay matches what's being said.
  //
  // Only Tier-1 scored picks qualify; filler clips weren't chosen for
  // entity relevance, so labelling them would mislead the viewer. Earlier
  // visual-match gates (first-occurrence-only for names, sex contradiction
  // check, labels-must-contain-place) are gone — the per-minute throttle
  // replaces them.
  // Cadence: at least LOWER_THIRD_INTERVAL_SEC of timeline between overlays.
  // The timer (`lastLowerThirdAtSec`) only advances on a SUCCESSFUL placement
  // — if the minute mark lands on an image / title-card / filler clip, or
  // on a block whose only entities were already used earlier, we keep
  // searching and the *next* eligible footage clip claims the slot. This is
  // what keeps the cadence close to one-per-minute even when the timeline
  // has gaps (image-heavy stretches, filler runs).
  //
  // Dedup: each overlay text is shown at most once across the whole video.
  // Without this, the same celebrity gets a name card every time the
  // narrator says their name. We key the dedup set on lowercased text so
  // "Salma Hayek" and "salma hayek" collapse to one entry.
  const LOWER_THIRD_INTERVAL_SEC = 60;
  // Cooldown for re-showing the same overlay text. Set to 5 minutes so a
  // long stretch about one subject still gets minute-cadence overlays
  // (the same name can repeat after the cooldown elapses) instead of
  // going dark for the rest of the video on first show.
  const LOWER_THIRD_REPEAT_COOLDOWN_SEC = 300;
  const lowerThirdCounts = { name: 0, year: 0, place: 0, phrase: 0 };
  let skippedForCadence = 0;
  let skippedForDuplicate = 0;
  let cumulativeSec = 0;
  let lastLowerThirdAtSec = Number.NEGATIVE_INFINITY;
  // text -> last-shown second. Replaces the previous show-once set so the
  // same name can return after LOWER_THIRD_REPEAT_COOLDOWN_SEC.
  const lastShownAt = new Map<string, number>();
  const orderedItems = [...items].sort(
    (a, b) => (a.position as number) - (b.position as number),
  );
  for (const it of orderedItems) {
    const dur = Number(it.duration ?? 0);
    const clipStartSec = cumulativeSec;
    cumulativeSec += dur;

    if (it.type !== "footage") continue;
    const meta = it.metadata as Record<string, unknown> | undefined;
    if (!meta || meta.pick_source !== "scored_top") continue;
    const blockIdx = Number(meta.block_index ?? -1);
    if (blockIdx < 0) continue;

    if (clipStartSec - lastLowerThirdAtSec < LOWER_THIRD_INTERVAL_SEC) {
      skippedForCadence++;
      continue;
    }

    const ents = blockEntities[blockIdx] ?? [];
    const blockText = blockTexts[blockIdx] ?? "";

    type Candidate = { text: string; type: "name" | "year" | "place" | "phrase" };
    const isFresh = (text: string): boolean => {
      const prev = lastShownAt.get(text.toLowerCase());
      if (prev === undefined) return true;
      return clipStartSec - prev >= LOWER_THIRD_REPEAT_COOLDOWN_SEC;
    };
    let pick: Candidate | null = null;

    // Tier 1 — named entity from project_entities, matched against block text.
    for (const ent of ents) {
      if (ent.type !== "celebrity" && ent.type !== "related_person") continue;
      if (!isFresh(ent.value)) continue;
      pick = { text: ent.value, type: "name" };
      break;
    }
    if (!pick) {
      for (const ent of ents) {
        if (ent.type !== "year") continue;
        if (!isFresh(ent.value)) continue;
        pick = { text: ent.value, type: "year" };
        break;
      }
    }
    if (!pick) {
      for (const ent of ents) {
        if (ent.type !== "place") continue;
        if (!isFresh(ent.value)) continue;
        pick = { text: ent.value, type: "place" };
        break;
      }
    }

    // Tier 2 — fall back to a key phrase pulled from the block's narration.
    // Only proper-noun-like candidates qualify: a multi-word capitalized
    // phrase ("Buckingham Palace") or a standalone year. The previous
    // implementation also accepted single capitalized tokens and the
    // longest non-stopword word in the block, which produced obviously
    // random overlays like "completely" or "interview" when the narration
    // had no real proper noun in that minute. We'd rather skip the slot
    // than show a junk word.
    if (!pick && blockText) {
      const phrase = pickPhraseFromBlock(blockText, isFresh);
      if (phrase) pick = { text: phrase, type: "phrase" };
    }

    if (!pick) {
      skippedForDuplicate++;
      continue;
    }
    lowerThirdCounts[pick.type]++;
    lastLowerThirdAtSec = clipStartSec;
    lastShownAt.set(pick.text.toLowerCase(), clipStartSec);
    (it.metadata as Record<string, unknown>) = {
      ...meta,
      lower_third: { text: pick.text, type: pick.type },
    };
  }

  await logJob({ projectId, jobId: mediaJobId }, "match.lower_thirds", {
    name: lowerThirdCounts.name,
    year: lowerThirdCounts.year,
    place: lowerThirdCounts.place,
    phrase: lowerThirdCounts.phrase,
    skippedForCadence,
    skippedForDuplicate,
    intervalSec: LOWER_THIRD_INTERVAL_SEC,
    repeatCooldownSec: LOWER_THIRD_REPEAT_COOLDOWN_SEC,
  });

  // Reclaim time lost to clip-shorter-than-planned clamping by stretching
  // the unclamped footage rows. Without this, the inserted timeline would
  // total voiceoverSeconds - durationReclaimSeconds and the duration check
  // at render time would fail again. We only touch footage rows that
  // weren't clamped (i.e. their clip is at least as long as planned), so
  // we don't push any row past the source clip's real length and
  // re-introduce the same lie we just fixed.
  if (durationReclaimSeconds > 0.1) {
    // With word-timing-driven planning, each footage block's duration is
    // the real spoken length of its sentence — stretching another footage
    // row past its sentence breaks A/V alignment for that block. We cap
    // stretching at +1.5s per row so reclaim can absorb small per-clip
    // shortages without visibly drifting from the narration; anything
    // larger is left as residue and surfaces in the render-time tolerance
    // check (±3s) which prompts the user to re-match with longer clips.
    const footageMax = 15;
    const PER_ROW_STRETCH_LIMIT = 1.5;
    const stretchable: typeof items = [];
    const rowCeilings = new Map<string | number, number>();
    for (const it of items) {
      if (it.type !== "footage") continue;
      const meta = (it.metadata as Record<string, unknown> | undefined) ?? {};
      if (meta.duration_clamped === true) continue;
      const clipDur = Number(meta.clip_duration ?? 0);
      const current = Number(it.duration ?? 0);
      // Per-row stretch ceiling: don't exceed the clip's real length, the
      // 15s overall guard, OR the sentence's spoken duration + 1.5s
      // (so the visual doesn't drift far from the narration). We key the
      // row by position since items don't have an id yet.
      const sentenceCap = current + PER_ROW_STRETCH_LIMIT;
      const ceiling = Math.min(
        footageMax,
        clipDur > 0 ? clipDur : footageMax,
        sentenceCap,
      );
      if (current < ceiling) {
        rowCeilings.set(Number(it.position), ceiling);
        stretchable.push(it);
      }
    }
    let remaining = durationReclaimSeconds;
    let safety = 0;
    // 0.1s is the timeline's storage precision. Spreading a small reclaim
    // across many rows can produce per-row steps below 0.05s that round to
    // zero — the loop then thinks it absorbed time it never actually wrote.
    // Force each pass to bump the front rows by at least 0.1s so progress
    // is real, and bail only when no row has headroom left.
    const MIN_STEP = 0.1;
    while (remaining > 0.05 && stretchable.length > 0 && safety++ < 16) {
      const perRow = Math.max(MIN_STEP, remaining / stretchable.length);
      let absorbed = 0;
      for (let k = stretchable.length - 1; k >= 0; k--) {
        if (remaining - absorbed <= 0.05) break;
        const it = stretchable[k];
        const ceiling = rowCeilings.get(Number(it.position)) ?? Number(it.duration ?? 0);
        const current = Number(it.duration ?? 0);
        const headroom = ceiling - current;
        if (headroom <= 0) {
          stretchable.splice(k, 1);
          continue;
        }
        const add = Math.min(perRow, headroom, remaining - absorbed);
        const next = Math.round((current + add) * 10) / 10;
        const delta = next - current;
        if (delta <= 0) continue;
        absorbed += delta;
        it.duration = next;
      }
      if (absorbed < 0.05) break;
      remaining -= absorbed;
    }
    await logJob({ projectId, jobId: mediaJobId }, "match.duration_reclaim", {
      reclaimedSecondsRequested: Math.round(durationReclaimSeconds * 10) / 10,
      reclaimedSecondsAbsorbed: Math.round((durationReclaimSeconds - remaining) * 10) / 10,
      residualSeconds: Math.round(remaining * 10) / 10,
      clampedFootageBlocks: durationClampedCount,
      stretchedFootageBlocks: stretchable.length,
    });
  }

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

// Pick a lower-third overlay text from a block's spoken narration when no
// project_entities hit is available. We only return proper-noun-like
// phrases so the overlay always reads as a name / place / organization,
// never as a random long word from the narration.
//   1. Longest consecutive run of TWO OR MORE capitalized words
//      (e.g. "Buckingham Palace", "Margot Robbie"). Single capitalized
//      tokens are rejected — too often a sentence-start verb or an
//      unrelated proper noun that confuses the viewer.
//   2. A standalone 4-digit year — strong visual anchor on its own.
// Returns null when neither tier finds a fresh candidate; the caller
// skips the overlay for this minute rather than burning in a junk word.
function pickPhraseFromBlock(
  text: string,
  isFresh: (s: string) => boolean,
): string | null {
  const stopwords = new Set([
    "the","a","an","and","or","but","of","in","on","at","to","for","with",
    "by","from","as","is","was","are","were","be","been","being","has","have",
    "had","do","does","did","this","that","these","those","it","its","they",
    "them","their","there","here","what","which","who","whom","how","when",
    "where","why","while","so","because","then","than","just","also","not",
    "no","yes","one","two","three","very","much","more","most","some","any",
    "all","every","each","other","another","such","into","over","under","out",
    "up","down","off","again","still","ever","never","always","you","your",
    "yours","we","our","ours","i","me","my","mine","he","him","his","she",
    "her","hers",
  ]);

  // 1) Multi-word capitalized-phrase scan. Sentence-start words are excluded
  //    so we don't pick "The" / "When" from "The court ruled...". We do that
  //    by splitting on sentence terminators first. Single-word runs are
  //    dropped — they're too often false positives ("I", sentence-start
  //    verbs, isolated proper nouns the entity extractor already rejected).
  const sentences = text.split(/[.!?]+/);
  let bestCapPhrase = "";
  for (const sentence of sentences) {
    const tokens = sentence.trim().split(/\s+/);
    let run: string[] = [];
    const flush = () => {
      if (run.length < 2) { run = []; return; }
      const phrase = run.join(" ").replace(/[^\p{L}\p{N} '-]+$/u, "");
      if (phrase && phrase.length > bestCapPhrase.length && isFresh(phrase)) {
        bestCapPhrase = phrase;
      }
      run = [];
    };
    tokens.forEach((tok, i) => {
      const clean = tok.replace(/[^\p{L}\p{N}'-]/gu, "");
      if (!clean) { flush(); return; }
      const isCap = /^[A-Z]/.test(clean);
      const isSentenceStart = i === 0;
      if (isCap && (!isSentenceStart || !stopwords.has(clean.toLowerCase()))) {
        run.push(clean);
      } else {
        flush();
      }
    });
    flush();
  }
  if (bestCapPhrase) return bestCapPhrase;

  // 2) Standalone year.
  const yearMatch = text.match(/\b(1[89]\d{2}|20\d{2})\b/);
  if (yearMatch && isFresh(yearMatch[0])) return yearMatch[0];

  return null;
}

// Read the most recent analyze job's payload from media_jobs and flatten
// every segment's Gemini-supplied blocks into a single ordered hint stream.
//
// Why this lives here and not in the analyze route: the matcher is the
// step that builds the final block sequence, and it needs the blocks in
// strict narration order regardless of which segment they came from. The
// analyze step persists per-segment blocks; the matcher concatenates.
//
// Returns [] when:
//   - no analyze job exists for the project
//   - the payload is missing or malformed
//   - none of the segments produced blocks (older payload, pre-Phase-A)
// The caller falls back to the legacy duration-only planner in that case
// so older projects keep working without re-running analyze.
async function loadBlockHintsFromAnalyze(
  sb: ReturnType<typeof getServerSupabase>,
  projectId: string,
  voiceoverSeconds: number,
): Promise<BlockPlanHint[]> {
  const { data } = await sb
    .from("media_jobs")
    .select("metadata")
    .eq("project_id", projectId)
    .eq("type", "analyze")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const payload = (data?.metadata as { payload?: { segments?: Array<{ understanding?: SegmentUnderstanding; startSeconds?: number; endSeconds?: number }> } } | null)?.payload;
  const segments = payload?.segments ?? [];
  if (segments.length === 0) return [];

  // We need to know which segment each block belongs to so we can recover
  // the segment's sectionTitle for title_card blocks. The hint stream is
  // segments concatenated in order.
  const hints: BlockPlanHint[] = [];
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    const u = seg.understanding;
    if (!u) continue;
    const segBlocks: BlockPlan[] = Array.isArray(u.blocks) ? u.blocks : [];
    if (segBlocks.length === 0) continue;
    // Resolve the section title for this segment's first block. Gemini's
    // sectionTitle field is conservative — the prompt asks for it ONLY when
    // the narration "clearly opens a new chapter", so scripts written as
    // continuous prose (no labelled chapters) often leave it empty and the
    // black title-card never gets rendered. Fall back to segmentTopic, which
    // every segment has and which reads like a chapter heading ("lawsuit /
    // Creative Controls", "early career", "wedding 2019"). Title-case the
    // first letter so an all-lowercase topic reads as a heading.
    const rawTitle = (u.sectionTitle && u.sectionTitle.trim())
      || (u.segmentTopic && u.segmentTopic.trim())
      || "";
    const resolvedSectionTitle = rawTitle
      ? rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1)
      : undefined;
    // Force the first block of each segment (except segment 0, which is the
    // hook/opening) to be a title_card ONLY when Gemini explicitly emitted a
    // sectionTitle for the segment — that is its signal that the narration
    // opens a real chapter. We deliberately do NOT promote on the
    // segmentTopic fallback: every segment has a topic, and promoting on
    // that would drop a black card every ~60-90s and bury the narration. The
    // overlay_text still uses resolvedSectionTitle (which can fall back to
    // segmentTopic), so the few promoted cards always render with readable
    // heading text.
    const hasExplicitSectionTitle = !!(u.sectionTitle && u.sectionTitle.trim());
    for (let i = 0; i < segBlocks.length; i++) {
      const b = segBlocks[i];
      const promoteToTitleCard =
        i === 0 && segIdx > 0 && hasExplicitSectionTitle;
      hints.push({
        text: b.text,
        resolved_subject: b.resolved_subject || undefined,
        recommended_visual_type: promoteToTitleCard
          ? "title_card"
          : b.recommended_visual_type,
        // Only attach section_title to the FIRST block of a segment — that's
        // the chapter boundary. Later blocks in the same segment continue
        // under the same section.
        section_title: i === 0 ? resolvedSectionTitle : undefined,
        // Phase C: forward Gemini's per-block visual references and
        // mentioned entities so the image matcher can search for the
        // specific reference ("tattoo", "Frida") instead of falling
        // straight to the entity pool.
        specific_visual_references: Array.isArray(b.specific_visual_references)
          ? b.specific_visual_references.filter((s) => typeof s === "string" && s.trim().length > 0)
          : undefined,
        mentioned_entities: Array.isArray(b.mentioned_entities)
          ? b.mentioned_entities.filter((s) => typeof s === "string" && s.trim().length > 0)
          : undefined,
        // Phase D: forward Gemini's per-block subject_type so the matcher
        // can route non-person entities through type-aware image search
        // (company → logo, movie → poster, place → place photo) instead
        // of pattern-matching the literal word "logo" inside references.
        subject_type: b.subject_type,
        // Person-first documentary axis. The matcher uses this to decide
        // the fallback chain when a specific image search fails — a
        // "specific_*" block falls back to the person image, while a
        // "person_default" block routes a person clip directly.
        visual_priority: b.visual_priority,
      });
    }
  }
  // Sanity check: if the total hint count is wildly out of range with the
  // voiceover length we'd produce a degenerate timeline. The legacy planner
  // targets ~voiceoverSeconds / 5s blocks; if Gemini produced fewer than
  // half that, the hints are probably truncated — fall back to legacy.
  const minReasonable = Math.max(2, Math.floor(voiceoverSeconds / 10));
  if (hints.length < minReasonable) return [];
  return hints;
}

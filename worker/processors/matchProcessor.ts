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
import { estimateDurationSeconds, type BlockPlan, type BlockEntityType, type SegmentUnderstanding } from "@/lib/ai/segments";
import { fetchImages, rehostImageToR2 } from "@/lib/images/fetch";
import { getEnv } from "@/lib/env";
import {
  verifyPoolAssetWithRetry,
  verifyPoolAssetsBatch,
  resetVerifyOutageTracking,
  getVerifyOutageStats,
} from "@/lib/ai/pool-verification";
import { verifyImageMatchesScript } from "@/lib/ai/verify";
import { lookupReference, upsertReference } from "@/lib/ai/face-references";
import { splitTranscriptIntoSentences } from "@/lib/ai/sentences";
import { alignSentencesToWords } from "@/lib/ai/sentence-alignment";
import { buildEnrichmentLookup } from "@/lib/ai/gemini-enrichment";
import { buildBlockSequenceFromTranscript } from "@/lib/ai/transcript-driven-builder";

// Legacy entity type → closed-world BlockEntityType mapping for the image
// pool's verification gate (Slice 5 of the matching refactor). The pool
// builder pulls entities from project_entities whose `type` column uses
// the original extractor vocabulary; verifyPoolAsset speaks the new closed-
// world vocabulary. Returns null when the type cannot be mapped (e.g.
// "topic", "year"), in which case the gate is skipped — those entities
// produce stock graphics anyway and the relaxed-pass fallback handles them.
function legacyEntityToBlockEntityType(legacy: string): BlockEntityType | null {
  switch (legacy) {
    case "celebrity":
      // Project celebrity → fallback pool, gate skipped. The pool builder
      // already isolates celebrity queries; verifyPoolAsset returns
      // accept=true for celebrity_default to keep this consistent.
      return "celebrity_default";
    case "related_person":
      return "person";
    case "company":
      return "company";
    case "tv_show":
      return "tv_show";
    case "movie":
      return "movie";
    case "song":
      return "song";
    case "place":
      return "place";
    default:
      return null;
  }
}

// Person-image hard gate (the "wrong celebrity slipped into the pool" fix).
//
// PRINCIPLE: any image that is supposed to depict a real PERSON must be
// positively face-matched against that person's reference photo before it can
// enter a pool. "On-topic for the narration" is NOT "is this the right person"
// — a glamorous red-carpet photo of the WRONG woman is perfectly on-topic for a
// celebrity documentary, which is exactly how a mislabeled web image
// ("Katherine Heigl" that isn't her) used to leak in.
//
// This centralises that decision so every fetch site enforces it identically:
//   - When we know which person the image should depict (the block's named
//     person, OR — for generic / celebrity_default slots — the project
//     celebrity), require Gemini to POSITIVELY confirm identity against the
//     reference. No reference / "uncertain" / "no" → reject. Never fail-open
//     for a person image.
//   - When there is no person to check against (no named person AND no project
//     celebrity), return accept=true so non-person flows are unchanged.
//
// `personName` is the person to verify against — pass the block's resolved
// person when it has one, else the project's main celebrity. Pass null/empty
// to opt out (caller has no person identity to enforce).
async function gatePersonImage(args: {
  projectId: string;
  personName: string | null | undefined;
  candidateUrl: string;
}): Promise<{ accept: boolean; verdict: string; reason: string }> {
  const name = (args.personName ?? "").trim();
  if (!name) return { accept: true, verdict: "skipped", reason: "no person to verify against" };
  // Retry-aware verify: a Gemini 503 is retried with backoff (bounded by the
  // shared per-job budget) instead of instantly counting as "unconfirmed".
  const verdict = await verifyPoolAssetWithRetry(
    {
      projectId: args.projectId,
      entityType: "person",
      entityName: name,
      candidateUrl: args.candidateUrl,
    },
    // requireConfirmed: only a POSITIVE face-match passes. Missing reference,
    // "uncertain", and "no" are all rejected — an unconfirmable person image
    // must never ship as that person.
    { requireConfirmed: true },
  );
  return { accept: verdict.accept, verdict: verdict.verdict, reason: verdict.reason };
}

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

// Single common nouns that double as famous movie / book / song titles.
// When the script uses these as plain English words ("recording judges'
// desk conversations", "the statement was leaked") the image-search engines
// happily return the famous-work poster — a 1974 Coppola film for
// "conversation", a thriller for "the statement", etc. Strictly worse than
// a celebrity fallback. We block them as STANDALONE one-word queries from:
//   1. mentioned_entities (Tier 1 reference query),
//   2. script-phrase extraction (fallback proper-noun search).
// Multi-word phrases containing these tokens are still allowed — "The
// Conversation Pit" stays, "The Statement Building" stays. The trap is
// purely the one-word-title collision.
const COMMON_NOUN_TITLE_BLOCKLIST = new Set<string>([
  "conversation", "conversations",
  "statement", "statements",
  "witness", "witnesses",
  "case", "cases",
  "story", "stories",
  "interview", "interviews",
  "trial", "trials",
  "verdict", "verdicts",
  "deal", "deals",
  "contract", "contracts",
  "secret", "secrets",
  "letter", "letters",
  "message", "messages",
  "decision", "decisions",
  "announcement", "announcements",
  "scandal", "scandals",
  "incident", "incidents",
  "accident", "accidents",
  "meeting", "meetings",
  "marriage", "wedding",
  "divorce", "funeral",
  "rumor", "rumors", "rumour", "rumours",
  "exchange", "exchanges",
  "recording", "recordings",
]);

function isCommonNounTitle(s: string): boolean {
  const norm = s.toLowerCase().trim().replace(/^the\s+/, "").replace(/[.,!?;:]+$/, "");
  if (!norm) return false;
  // Only block when the whole query is a single common-noun token (after
  // stripping a leading "the"). Multi-word phrases keep their proper-noun
  // signal even if one word is in the blocklist.
  if (/\s/.test(norm)) return false;
  return COMMON_NOUN_TITLE_BLOCKLIST.has(norm);
}

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
    // Drop single common-noun tokens that collide with famous titles
    // ("Conversation" → 1974 Coppola film poster from CSE).
    if (isCommonNounTitle(p)) continue;
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

  // Fresh outage accounting + retry-wait budget for this run. The stats feed
  // the circuit breaker at the end of the job: a run whose verifications
  // mostly ERRORED (sustained Gemini outage) must fail and re-run later —
  // never complete with an all-fallback video that merely looks successful.
  resetVerifyOutageTracking();

  // Heartbeat. The match step does its heavy work — LLM block scoring plus
  // per-entity image-pool building (fetchImages + verifyPoolAsset, hundreds
  // of Gemini round-trips) — in one long span with sparse progress writes.
  // The stall sweeper (worker/reconcile.ts) fails any media_jobs row whose
  // updated_at hasn't moved past the lock window (~20 min), so on a large
  // project it used to flip a STILL-RUNNING match job to "failed" mid-flight
  // — the job then finished and wrote "completed", producing the confusing
  // "failed, then succeeded" sequence. A metadata write merges (it never
  // clobbers status/progress) and fires the media_jobs_touch trigger, which
  // refreshes updated_at — proving the job is alive so the sweeper leaves it
  // be. unref() so this timer never keeps the worker process alive on its own.
  const heartbeat = setInterval(() => {
    void setMediaJob(mediaJobId, { metadata: { heartbeatAt: new Date().toISOString() } })
      .catch(() => { /* transient DB blip — next tick retries */ });
  }, 60_000);
  heartbeat.unref?.();
  const stopHeartbeat = () => clearInterval(heartbeat);

  try {

  const { data: project } = await sb
    .from("projects")
    .select("transcript, voiceover_duration_seconds, transcript_words, intro_source_youtube_url")
    .eq("id", projectId)
    .single();
  const transcript = project?.transcript ?? "";
  // When the user pasted their own intro URL on the intake screen, the
  // renderer will cut the intro directly from that source — we skip the
  // pool-based heuristic + verifier path entirely and leave intro_clip_id
  // null. The renderer reads intro_source_youtube_url itself and prepends
  // the cut video/audio regardless of intro_clip_id.
  const legacyIntroUrlProvided = !!(project as { intro_source_youtube_url?: string | null } | null)
    ?.intro_source_youtube_url?.trim();

  // Script-doc intro_card markers (one per blue-bold timestamp block at the
  // top of the Google Doc). When any exist, they ARE the pre-roll — we
  // suppress the auto-pick path so the heuristic + Gemini verifier don't
  // burn API spend choosing a clip that won't be used. We also insert a
  // type='intro' timeline_items row per doc intro below so the editor UI
  // reflects what the renderer is actually going to play.
  const { data: introCardMarkers } = await sb
    .from("project_script_markers")
    .select("id, ordinal, text, youtube_url, start_seconds, end_seconds, clip_storage_url")
    .eq("project_id", projectId)
    .eq("kind", "intro_card")
    .order("ordinal");
  const docIntroCards = (introCardMarkers ?? []) as Array<{
    id: string;
    ordinal: number;
    text: string | null;
    youtube_url: string | null;
    start_seconds: number | null;
    end_seconds: number | null;
    clip_storage_url: string | null;
  }>;
  const hasDocIntros = docIntroCards.some((m) => !!m.youtube_url);
  // Combined gate: any user-supplied intro source (doc markers OR legacy
  // intro_source_* columns) suppresses the auto-pick path.
  const userIntroProvided = legacyIntroUrlProvided || hasDocIntros;
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
    // Disclaimer / legal / text-card screens — clips whose frame is mostly
    // on-screen text the editor never wants in the final video. These catch
    // OLD clips that were cut before the clip-stage clean-footage gate existed
    // (new clips are dropped at creation). Kept broad on purpose.
    "disclaimer", "legal notice", "for entertainment purposes",
    "text card", "text screen", "text overlay", "full screen text",
    "intro card", "outro card", "warning screen", "notice screen",
  ];
  // Narrower telltale set used ONLY to screen the heuristic intro fallback
  // (when the Vision verifier couldn't run). Anything obviously a full-screen
  // text/legal card should never become the 0:00–0:06 intro slot. Kept a
  // subset of JUNK_LABEL_TELLTALES focused on cards a head-of-source clip
  // commonly opens with — the disclaimer / discretion card being the one
  // that prompted this gate.
  const INTRO_TEXTCARD_TELLTALES = [
    "disclaimer", "legal notice", "for entertainment purposes",
    "viewer discretion", "discretion advised",
    "text card", "text screen", "text overlay", "full screen text",
    "title card", "intro card", "warning screen", "notice screen",
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

  // ---- Person-name disambiguation (project-wide) -----------------------
  // A SECONDARY person is often referred to by bare FIRST NAME in the script
  // ("Catherine", "William", "Charles"). Searching image providers for a bare
  // first name returns the most famous unrelated namesake — e.g. "Catherine"
  // returned the actress Catherine Zeta-Jones instead of Catherine, Princess of
  // Wales — and because the face-verify REFERENCE is built from the SAME bare
  // query, the wrong person self-verifies as "yes". To stop this for EVERY
  // ambiguous name in the project, we append a context phrase derived from the
  // project's main subject so the query/reference target the right person.
  //
  // Context source: derive a NEUTRAL domain phrase from the main celebrity's
  // descriptor — NOT the literal title. "Diana, Princess of Wales" implies the
  // British royal family, so bare royal first names ("Catherine", "William",
  // "Charles") get "British royal family" appended. Using the literal title
  // would be wrong across genders/roles (appending "Princess of Wales" to
  // "William" or "Charles" pulls bad images). A "Firstname Lastname" main
  // celebrity with no royal/known descriptor (e.g. "Simon Cowell") yields no
  // context, so we append nothing rather than guess.
  const projectContextPhrase = (() => {
    const mc = (mainCelebrity ?? "").trim();
    if (!mc) return "";
    const qualifier = mc.includes(",") ? mc.split(",").slice(1).join(",") : mc;
    // Royal cue anywhere in the descriptor → neutral royal-family context.
    if (/\b(Prince|Princess|King|Queen|Duke|Duchess|Earl|Countess|Royal|Crown)\b/i.test(qualifier)) {
      return "British royal family";
    }
    // No recognized domain cue — don't guess a context.
    return "";
  })();

  // True when `name` is a bare single token (one word, no comma/title/surname)
  // — exactly the ambiguous case that needs project context appended.
  function isBareFirstName(name: string): boolean {
    const n = name.trim();
    if (!n || n.includes(",")) return false;
    if (/\b(Prince|Princess|King|Queen|Duke|Duchess|Sir|Dame|Lord|Lady|Markle|Windsor)\b/i.test(n)) {
      return false;
    }
    return n.split(/\s+/).length === 1;
  }

  // Qualify a person name for image search/verify. Bare first names get the
  // project context appended ("Catherine" → "Catherine Princess of Wales");
  // already-qualified names pass through unchanged. Applied project-wide at the
  // single choke point that builds person photo pools.
  function disambiguatePersonName(name: string): string {
    const n = (name ?? "").trim();
    if (!n) return n;
    if (projectContextPhrase && isBareFirstName(n)) {
      return `${n} ${projectContextPhrase}`;
    }
    return n;
  }

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

  // Project-level topic string used by the script-aware image verifier. The
  // verifier asks "is this image on-topic for the narration?" — without a
  // topic anchor it has no way to reject a Nazi/swastika graphic captioned
  // "The Statement" attached to a Britain's Got Talent script line. We
  // combine the main celebrity with the top tv_show / movie / company so
  // queries like "The Statement" or "Case Closed" can be evaluated against
  // the actual project subject. Empty when neither is known — the verifier
  // skips gracefully in that case.
  const topShowEntity = (allEntities.find((e) => e.type === "tv_show") ??
    allEntities.find((e) => e.type === "movie") ??
    allEntities.find((e) => e.type === "company")
  )?.value;
  const projectTopic = [mainCelebrity, topShowEntity].filter(Boolean).join(" — ");

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

  const ranked = userIntroProvided
    ? []
    : clipsForMatch
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

    // Did the Vision verifier actually look at frames and REJECT them all?
    // We must distinguish that from "the verifier never ran" (no celebrity,
    // no usable thumbnails, or a Gemini error). When the verifier examined
    // real candidates and qualified none, its "no" is authoritative — the
    // top head clip is a title / disclaimer / wrong-speaker card and must
    // NOT be shipped as the intro. perCandidate is non-empty only when the
    // model returned per-frame judgements, so it's our "verifier ran" signal.
    let verifierRanAndRejectedAll = false;

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
      } else if (verdict.perCandidate.length > 0) {
        verifierRanAndRejectedAll = true;
      }
    }

    // Fallback policy — only when we still have no intro:
    //   1. If the verifier RAN and rejected every candidate, trust it and
    //      SKIP the intro. Re-admitting ranked[0] here is exactly the bug
    //      that put a t=0 "DISCLAIMER / viewer discretion" text card in the
    //      0:00–0:06 intro slot: the head clip wins the heuristic, the
    //      verifier correctly says "no person on camera", and the old
    //      fallback shipped it anyway. The renderer handles a null intro
    //      clip gracefully (renders without an intro), so skipping is safe.
    //   2. If the verifier COULD NOT run (no celebrity / no thumbnails /
    //      Gemini error), fall back to the top heuristic pick — but screen
    //      it for text-card telltales first so a disclaimer/title card never
    //      becomes the intro silently when Vision was unavailable.
    if (!introClipId && !verifierRanAndRejectedAll) {
      const best = ranked[0];
      const bestLabels = (best.c.labels ?? []).map((l) => l.toLowerCase());
      const looksLikeTextCard = bestLabels.some((l) =>
        INTRO_TEXTCARD_TELLTALES.some((t) => l.includes(t))
      );
      if (looksLikeTextCard) {
        introVerifierReason = introVerifierReason
          ? `${introVerifierReason}; heuristic fallback skipped (text-card labels)`
          : "verifier unavailable; heuristic fallback skipped (text-card labels)";
      } else {
        selectClip(best.c.id, best.score);
        introSelectionTier = "heuristic_fallback";
      }
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
  //
  // Skip the write entirely when the user provided their own intro source —
  // the renderer reads intro_source_youtube_url + intro_source_start_seconds
  // directly and we must NOT clobber the user's intro_duration_seconds with
  // 0 / null from this auto-pick path.
  if (!userIntroProvided) {
    await sb.from("projects").update({
      intro_clip_id: introClipId,
      intro_duration_seconds: introClipDuration || null,
      // Clear any stale audio URL from a previous run — the renderer will
      // re-download to match the newly-selected intro clip.
      intro_audio_url: null,
    }).eq("id", projectId);
  }

  // ---- Drop scene-ineligible clips before scene matching ----------------
  // Intro selection above is the ONLY consumer allowed to see clips tagged
  // `not_scene_eligible` (a t=0 disclaimer / text card kept solely as a
  // possible intro AUDIO shot). Everything below — scene scoring, filler
  // tiers, the whole timeline — must never place these as footage. Pruning
  // here, after the intro pick is persisted, removes them from every
  // downstream scene path in one place instead of guarding each loop.
  // Exception: if the selected intro clip itself is tagged (rare — it won
  // the intro slot anyway), keep it so the intro reference still resolves;
  // it's reserved in usedClipIds below and can't land in a scene block.
  {
    const before = clipsForMatch.length;
    for (let i = clipsForMatch.length - 1; i >= 0; i--) {
      const c = clipsForMatch[i];
      const notSceneEligible = (c.labels ?? []).some(
        (l) => l.toLowerCase() === "not_scene_eligible",
      );
      if (notSceneEligible && c.id !== introClipId) {
        clipsForMatch.splice(i, 1);
      }
    }
    const dropped = before - clipsForMatch.length;
    if (dropped > 0) {
      await logJob({ projectId, jobId: mediaJobId }, "match.scene_ineligible_filter", {
        dropped,
      });
    }
  }

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
  let hints = await loadBlockHintsFromAnalyze(sb, projectId, voiceoverSeconds, transcript);
  const planSource: "gemini_hints" | "legacy_quota" = hints.length > 0 ? "gemini_hints" : "legacy_quota";
  // True when the transcript-driven builder produced the block sequence
  // for this project. Used much later by the duration-strategy logic to
  // decide whether to skip duration_reclaim (proportional fit handles
  // small adjustments cleanly on its own; reclaim distorts blocks).
  let usedTranscriptDrivenBuilder = false;

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
  // Closed-world block-entity bindings forwarded from analyze. Replaces
  // the noisy refs[0]/ents[0] heuristic for picking the image-verify
  // target — when block_entity is celebrity_default we skip the
  // reference-driven image search entirely and go straight to the
  // person fallback so abstract narration never picks up a random image.
  // Named with a "ClosedWorld" suffix because an unrelated local
  // `blockEntities` (mentioned-entity hits per block) lives in the same
  // outer scope further down for clip scoring — different concept, same
  // word, can't rename without churn so we differentiate the new one.
  type BlockEntityBinding = { type: BlockEntityType; name: string };
  let blockClosedWorldEntities: Array<BlockEntityBinding | null>;
  // Real voiceover-time window for each block, from Deepgram word timings
  // via the planner. The matcher writes these onto each timeline item's
  // metadata so script-marker positioning and per-block text slicing can
  // map to the actual audio position instead of relying on cumulative
  // duration sums (which drift away from real spoken time because Gemini
  // hints don't cover every word and the planner rounds to 0.1s).
  let blockVoStart: Array<number | null>;
  let blockVoEnd: Array<number | null>;
  if (planSource === "gemini_hints") {
    // Transcript-driven path. The SENTENCE LIST is the source of truth —
    // one editor row per sentence, never split mid-phrase, never merged
    // across paragraph boundaries. Gemini's blocks become enrichment
    // metadata (visual type, subject, references) looked up per sentence
    // rather than the input to the block sequence itself.
    //
    // This replaces the hint-driven builder that silently dropped sentences
    // and re-split single hints into many slots with duplicated text — the
    // failure mode that surfaced in the editor as identical captions across
    // many consecutive scenes on long audios.
    //
    // Requires both: (a) Deepgram word timings on the project, so each
    // sentence gets a real spoken-audio window, and (b) at least one
    // Gemini hint to enrich against. Falls through to the legacy
    // hint-driven path when either is missing.
    const haveWordTimings = transcriptWords != null && transcriptWords.length > 0;
    if (haveWordTimings && hints.length > 0) {
      // 1) Load blue-bold title-card markers and the paragraph indices
      //    they belong to. The transcript splitter flags those paragraphs'
      //    first sentence so the builder can prepend a title_card row.
      const { data: titleMarkerRows } = await sb
        .from("project_script_markers")
        .select("paragraph_index, text")
        .eq("project_id", projectId)
        .eq("kind", "title_card");
      const titleCardTextByParagraph = new Map<number, string>();
      const titleCardParagraphIndices = new Set<number>();
      for (const m of titleMarkerRows ?? []) {
        const pIdx = m.paragraph_index as number | null;
        if (pIdx == null) continue;
        const text = (m.text as string | null) ?? "";
        titleCardParagraphIndices.add(pIdx);
        if (text.trim()) titleCardTextByParagraph.set(pIdx, text);
      }

      // 2) Split the doc into ordered sentences. Title cards bind to the
      //    flagged paragraph's first sentence.
      const sentences = splitTranscriptIntoSentences(transcript, titleCardParagraphIndices);

      // 3) Stamp each sentence with its real spoken-audio window from
      //    Deepgram. This is what gives every block a duration that
      //    matches the narrator's actual pace — no cadence-fallback
      //    overshoot, no sentence-drift across long audios.
      const aligned = alignSentencesToWords(sentences, transcriptWords!);

      // 4) Build the per-sentence enrichment lookup from Gemini's hints.
      //    BlockPlanHint is structurally compatible with BlockPlan for
      //    the fields enrichment reads — type-cast is safe.
      const enrichment = buildEnrichmentLookup(sentences, hints as unknown as BlockPlan[]);

      // 5) Build the block sequence. Image hold policy "sentence_duration"
      //    means each block's `duration` is the narrator's real spoken time
      //    for that sentence (vo_end − vo_start), so visuals change exactly
      //    when narration changes — no fixed 5s clamp. Long sentences
      //    (> IMAGE_SPLIT_THRESHOLD) are still split into multiple image
      //    fragments sharing the same subject, but each fragment's duration
      //    is `sentence_duration / N` (no rounding), keeping total = sentence.
      const built = buildBlockSequenceFromTranscript({
        sentences: aligned,
        enrichment,
        titleCardTextByParagraph,
        mainCelebrity: mainCelebrity ?? "",
        imageHoldPolicy: "sentence_duration",
        // Cap images at MAX_IMAGE_RATIO (default 30:70). Gemini's raw
        // visual-type split lands ~50% images, over-using the photo pool and
        // reading as a slideshow; the builder converts the lowest-priority
        // surplus image blocks to footage (footage supply is plentiful).
        maxImageRatio: getEnv().MAX_IMAGE_RATIO,
      });

      blocks = built.blocks.map((p) => ({ type: p.type, duration: p.duration }));
      blockHintTexts = built.blocks.map((p) => p.text || null);
      blockSectionTitles = built.blocks.map((p) => p.section_title ?? null);
      blockResolvedSubjects = built.blocks.map((p) => p.resolved_subject ?? null);
      blockRecommendedTypes = built.blocks.map((p) => p.type);
      blockSpecificRefs = built.blocks.map((p) => p.specific_visual_references ?? []);
      blockSubjectTypes = built.blocks.map((p) => p.subject_type ?? null);
      blockVisualPriorities = built.blocks.map((p) => p.visual_priority ?? null);
      blockClosedWorldEntities = built.blocks.map((p) =>
        p.block_entity
          ? { type: p.block_entity.type as BlockEntityType, name: (p.block_entity.name ?? "").trim() }
          : null,
      );
      blockVoStart = built.blocks.map((p) => p.vo_start_seconds ?? null);
      blockVoEnd = built.blocks.map((p) => p.vo_end_seconds ?? null);

      // The downstream code reads from `hints` for fields that aren't on
      // PlannedBlockWithHint (mentioned_entities for clip scoring, etc.).
      // Rebuild a hints array aligned 1:1 with the new blocks so those
      // lookups still work. Each block points back to its source sentence
      // index; that sentence's enrichment carries the metadata we need.
      const rebuiltHints: BlockPlanHint[] = built.blocks.map((b, i) => {
        const sIdx = built.blockSentenceIndex[i];
        const enr = enrichment.perSentence[sIdx];
        // BlockPlanHint.recommended_visual_type is narrower than the
        // builder's PlannedBlock type — it excludes "intro" and "split_4".
        // The builder demotes split_4 internally and never emits intro
        // (intros are a render-time prefix, not a block), but TS doesn't
        // know that, so narrow explicitly.
        const recommendedVisualType: BlockPlanHint["recommended_visual_type"] =
          b.type === "intro" || b.type === "split_4" ? "footage" : b.type;
        return {
          text: b.text,
          resolved_subject: b.resolved_subject,
          recommended_visual_type: recommendedVisualType,
          section_title: b.section_title,
          specific_visual_references: enr?.specific_visual_references ?? [],
          mentioned_entities: enr?.mentioned_entities ?? [],
          subject_type: enr?.subject_type ?? "general",
          visual_priority: enr?.visual_priority ?? "person_default",
          block_entity: enr?.block_entity,
          paragraph_index: b.paragraph_index ?? null,
        };
      });
      hints = rebuiltHints;

      usedTranscriptDrivenBuilder = true;

      // Alignment sanity audit. The sum of aligned sentence durations
      // should equal the voiceover audio length. If they diverge by more
      // than ALIGN_DRIFT_THRESHOLD seconds, the picture timeline and the
      // audio will fall out of sync — the symptom the user sees as 1-2s
      // of misalignment near title cards or numeric phrases. Log so a
      // human can correlate a misaligned render with where it went wrong.
      const ALIGN_DRIFT_THRESHOLD = 2.0;
      const lastAligned = aligned[aligned.length - 1];
      const alignmentSpanSeconds = lastAligned ? lastAligned.vo_end : 0;
      const alignmentDriftSeconds = voiceoverSeconds > 0
        ? Math.round((alignmentSpanSeconds - voiceoverSeconds) * 10) / 10
        : 0;
      const sentencesNotAligned = aligned.filter((s) => !s.aligned).length;
      // Find the first synthesized sentence — that's where alignment fell
      // off the rails. The matcher's downstream behavior degrades after
      // this point, so surfacing the location helps debugging.
      const firstSynthesizedIdx = aligned.findIndex((s) => !s.aligned);

      await logJob({ projectId, jobId: mediaJobId }, "match.transcript_driven_builder", {
        sentences: sentences.length,
        alignedSentences: aligned.filter((s) => s.aligned).length,
        sentencesNotAligned,
        firstSynthesizedSentenceIdx: firstSynthesizedIdx,
        firstSynthesizedSentenceText: firstSynthesizedIdx >= 0
          ? aligned[firstSynthesizedIdx].text.slice(0, 80)
          : null,
        voiceoverSeconds: Math.round(voiceoverSeconds * 10) / 10,
        alignmentSpanSeconds: Math.round(alignmentSpanSeconds * 10) / 10,
        alignmentDriftSeconds,
        alignmentDriftExceedsThreshold: Math.abs(alignmentDriftSeconds) > ALIGN_DRIFT_THRESHOLD,
        enrichedSentences: enrichment.matchedSentences,
        unmatchedSentences: enrichment.unmatched,
        titleCardsInserted: built.titleCardsInserted,
        shortSentencesGrouped: built.shortSentencesGrouped,
        shortSentencesMerged: built.shortSentencesMerged,
        imageSplitCount: built.imageSplitCount,
        imagesConvertedToFootage: built.imagesConvertedToFootage,
        maxImageRatio: getEnv().MAX_IMAGE_RATIO,
        blocksProduced: built.blocks.length,
      });
    } else {
      // Legacy hint-driven path. Used when word timings aren't available
      // or Gemini emitted no hints.
      const planned: PlannedBlockWithHint[] = buildBlockSequenceFromHints(hints, voiceoverSeconds, transcript, transcriptWords, introClipDuration);
      blocks = planned.map((p) => ({ type: p.type, duration: p.duration }));
      blockHintTexts = planned.map((p) => p.text || null);
      blockSectionTitles = planned.map((p) => p.section_title ?? null);
      blockResolvedSubjects = planned.map((p) => p.resolved_subject ?? null);
      blockRecommendedTypes = planned.map((p) => p.type);
      blockSpecificRefs = planned.map((p) => p.specific_visual_references ?? []);
      blockSubjectTypes = planned.map((p) => p.subject_type ?? null);
      blockVisualPriorities = planned.map((p) => p.visual_priority ?? null);
      blockClosedWorldEntities = planned.map((p) =>
        p.block_entity
          ? { type: p.block_entity.type as BlockEntityType, name: (p.block_entity.name ?? "").trim() }
          : null,
      );
      blockVoStart = planned.map((p) => p.vo_start_seconds ?? null);
      blockVoEnd = planned.map((p) => p.vo_end_seconds ?? null);
    }
  } else {
    blocks = buildBlockSequence(plan);
    blockHintTexts = blocks.map(() => null);
    blockSectionTitles = blocks.map(() => null);
    blockResolvedSubjects = blocks.map(() => null);
    blockRecommendedTypes = blocks.map(() => null);
    blockSpecificRefs = blocks.map(() => []);
    blockSubjectTypes = blocks.map(() => null);
    blockVisualPriorities = blocks.map(() => null);
    blockClosedWorldEntities = blocks.map(() => null);
    blockVoStart = blocks.map(() => null);
    blockVoEnd = blocks.map(() => null);
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

  // NOTE: we deliberately do NOT pre-downgrade footage blocks to images when
  // the clip pool is smaller than the footage-slot count. The Tier 2.5 reuse
  // picker fills every footage block by re-picking clips on a cooldown, so a
  // small pool no longer forces the planned 60:40 footage:image ratio toward
  // images. (The old surplus pass converted footage→image with the footage
  // block's long duration intact; the oversized-image split then fragmented
  // each one into 2-4 image scenes, which is how a 40-minute video with a
  // 165-clip pool ended up ~61% image scenes.)

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
    // Footage supply is no longer a hard budget: the Tier 2.5 reuse picker
    // can fill any footage block as long as at least one clip exists. So the
    // image→footage swap is gated only on the pool being non-empty —
    // otherwise a small pool would leave all-image runs unbroken while still
    // converting footage runs to images, skewing the 60:40 ratio further
    // toward images exactly when clips are scarce.
    let footageHeadroom = clips.length > 0 ? Number.POSITIVE_INFINITY : 0;
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

  // ---- Final 60:40 footage:image enforcement (by screen time) ----------
  // The builder caps images at MAX_IMAGE_RATIO of content blocks at plan
  // time, but the passes above (split_4 downgrade, entity dedup, rhythm
  // swaps) can shift the realized ratio. The final video's percentage is
  // screen TIME, not block count, so re-enforce the cap here on durations —
  // after all type-shuffling passes and before the oversized-image split
  // (which changes counts but never durations). Convert the surplus image
  // blocks to footage, "person_default" priority first (a person image swaps
  // naturally to person footage; specific_event / specific_object images
  // genuinely need a still), longest duration first within a rank. split_2
  // and title_card blocks are deliberate beats and are left alone. Safe even
  // on a small clip pool: the Tier 2.5 reuse picker fills every footage
  // block as long as one clip exists.
  let ratioEnforcedConversions = 0;
  if (clips.length > 0) {
    const maxImageRatio = getEnv().MAX_IMAGE_RATIO;
    const isContent = (t: string) => t === "footage" || t === "image" || t === "split_2";
    const contentDur = blocks.reduce(
      (s, b) => (isContent(b.type) ? s + b.duration : s), 0);
    let imageDur = blocks.reduce(
      (s, b) => (b.type === "image" || b.type === "split_2" ? s + b.duration : s), 0);
    const maxImageDur = contentDur * maxImageRatio;
    if (imageDur > maxImageDur) {
      const rank = (i: number) =>
        (blockVisualPriorities[i] ?? "person_default") === "person_default" ? 0 : 1;
      const convertible = blocks
        .map((b, i) => (b.type === "image" ? i : -1))
        .filter((i) => i >= 0)
        .sort((a, b) => {
          if (rank(a) !== rank(b)) return rank(a) - rank(b);
          return blocks[b].duration - blocks[a].duration;
        });
      for (const idx of convertible) {
        if (imageDur <= maxImageDur) break;
        imageDur -= blocks[idx].duration;
        blocks[idx] = { type: "footage", duration: blocks[idx].duration };
        blockRecommendedTypes[idx] = "footage";
        // Clear image-only refs so Phase C doesn't image-search a footage
        // block (same convention as the rhythm-pass swap above).
        blockSpecificRefs[idx] = [];
        ratioEnforcedConversions++;
      }
    }
    await logJob({ projectId, jobId: mediaJobId }, "match.ratio_enforce", {
      maxImageRatio,
      contentDurationSec: Math.round(contentDur * 10) / 10,
      imageDurationSecAfter: Math.round(imageDur * 10) / 10,
      imagesConvertedToFootage: ratioEnforcedConversions,
    });
  }

  // Split oversized image blocks into back-to-back 5s holds. Image blocks
  // longer than IMAGE_HOLD_SECONDS only appear after a footage→image
  // downgrade (rhythm-pass swap) carried the footage block's
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
    const newClosedWorldEntities: typeof blockClosedWorldEntities = [];
    const newVoStart: typeof blockVoStart = [];
    const newVoEnd: typeof blockVoEnd = [];
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
        newClosedWorldEntities.push(blockClosedWorldEntities[i] ?? null);
        newVoStart.push(blockVoStart[i] ?? null);
        newVoEnd.push(blockVoEnd[i] ?? null);
        if (i < hints.length) newHints.push(hints[i]);
        continue;
      }
      // Slot the duration into N fragments. Math.round biases toward an
      // even split (13s → 3 fragments of ~4.3s, 11s → 2 of 5.5s) so no
      // fragment lands too far from the IMAGE_HOLD_SECONDS target.
      // Hard cap at 4 fragments per source block. Without this, blocks that
      // ended up with an inflated duration (footage→image rhythm swap that
      // kept the footage's 10-15s window, or a planner overshoot from
      // cadence-fallback estimation) explode into 6+ fragments all sharing
      // the same source sentence. On long audios that compounded into a
      // timeline 2× the audio length — see match.image_block_split log.
      const MAX_IMAGE_FRAGMENTS = 4;
      const slots = Math.min(
        MAX_IMAGE_FRAGMENTS,
        Math.max(2, Math.round(b.duration / IMAGE_HOLD_SECONDS)),
      );
      const perSlot = Math.round((b.duration / slots) * 10) / 10;
      // Split the source block's voiceover window across the fragments
      // proportionally so each fragment knows the spoken-time slice it
      // covers (used downstream for script-marker placement and
      // per-block text slicing).
      const srcVoStart = blockVoStart[i];
      const srcVoEnd = blockVoEnd[i];
      const srcSpan =
        srcVoStart != null && srcVoEnd != null && srcVoEnd > srcVoStart
          ? srcVoEnd - srcVoStart
          : null;
      // Last fragment absorbs the rounding residue so the sum exactly
      // matches the source duration (no drift in total timeline length).
      let remaining = b.duration;
      for (let k = 0; k < slots; k++) {
        const isLast = k === slots - 1;
        const dur = isLast ? Math.round(remaining * 10) / 10 : perSlot;
        remaining = Math.round((remaining - dur) * 10) / 10;
        newBlocks.push({ type: "image", duration: dur });
        // Every fragment carries the SAME source hint text — the
        // narration that text represents is being spoken across the full
        // span of the original block. The old behavior (only k=0 got
        // the text, k>=1 got null) was meant to avoid duplicate text in
        // the editor, but that null fell through to buildBlockTexts'
        // proportional word-slicer in the blockTexts derivation step
        // (line 1257 below), which pads each slice by ±1s of neighbor
        // words. The result was visible OVERLAP text on the fragment
        // (e.g. "didn't say was louder. This is the full story. Private
        // conversations..." straddling the previous sentence's end and
        // the next sentence's start). Showing the same sentence on each
        // fragment is correct: that sentence IS being narrated under
        // every fragment, the fragments are just visual subdivisions.
        newHintTexts.push(blockHintTexts[i] ?? null);
        // Section titles only ride the FIRST fragment so we don't render
        // the same title card multiple times in a row.
        newSectionTitles.push(k === 0 ? (blockSectionTitles[i] ?? null) : null);
        newResolvedSubjects.push(blockResolvedSubjects[i] ?? null);
        newRecommendedTypes.push(blockRecommendedTypes[i] ?? null);
        newSpecificRefs.push(blockSpecificRefs[i] ?? []);
        newSubjectTypes.push(blockSubjectTypes[i] ?? null);
        newVisualPriorities.push(blockVisualPriorities[i] ?? null);
        newClosedWorldEntities.push(blockClosedWorldEntities[i] ?? null);
        if (srcVoStart != null && srcSpan != null) {
          newVoStart.push(srcVoStart + (k * srcSpan) / slots);
          newVoEnd.push(srcVoStart + ((k + 1) * srcSpan) / slots);
        } else {
          newVoStart.push(null);
          newVoEnd.push(null);
        }
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
    blockClosedWorldEntities = newClosedWorldEntities;
    blockVoStart = newVoStart;
    blockVoEnd = newVoEnd;
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
  //
  // The proportional fallback is also used to bridge the rare case where
  // a block has no aligned vo_start/vo_end (a hint whose words don't match
  // the transcript at all). Most blocks should take the hint-text path.
  const wordSlicedTexts = buildBlockTexts(transcript, blocks, voiceoverSeconds);
  const blockTexts = blocks.map((_, i) => {
    const hintText = blockHintTexts[i];
    return hintText && hintText.trim().length > 0 ? hintText : (wordSlicedTexts[i] ?? "");
  });

  // Roster-person promotion: when a block's text literally names a roster
  // person (other than the main celebrity) but Gemini tagged the block as
  // celebrity_default, promote the binding to that person. Catches the
  // "Bruno Tonioli in the chair" failure mode where Gemini bound the
  // block to the main celebrity even though Bruno is the literal subject
  // of the sentence — without this, the block falls through to the
  // Walliams pool and shows a generic Walliams photo (or worse, a noisy
  // collage) instead of Bruno.
  const rosterPersons = allEntities
    .filter((e) => e.type === "person" || e.type === "celebrity")
    .map((e) => e.value.trim())
    .filter((v) => v.length > 0 && v.toLowerCase() !== (mainCelebrity ?? "").toLowerCase());
  if (rosterPersons.length > 0) {
    let promoted = 0;
    for (let i = 0; i < blocks.length; i++) {
      const cur = blockClosedWorldEntities[i];
      if (cur && cur.type !== "celebrity_default") continue;
      const text = (blockTexts[i] ?? "").toLowerCase();
      if (!text) continue;
      for (const person of rosterPersons) {
        if (text.includes(person.toLowerCase())) {
          blockClosedWorldEntities[i] = { type: "person", name: person };
          promoted++;
          break;
        }
      }
    }
    if (promoted > 0) {
      void logJob({ projectId, jobId: mediaJobId }, "match.roster_person_promotion", {
        promoted,
        rosterSize: rosterPersons.length,
      });
    }
  }

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

  // No-adjacent-same-source rule.
  //
  // Per client direction, two consecutive footage rows in the timeline
  // must not come from the same source video. Even when the same source
  // produces the highest-scoring clip for both rows, the second row
  // falls to the next-best candidate from a different source. Eliminates
  // the "two clips look like one continuous interview" pattern where the
  // viewer perceives adjacent sub-blocks as a single long held shot.
  //
  // The rule is SOFT: if no candidate from a different source exists for
  // a block, we still pick from the same source (better to repeat than
  // to leave the row empty). We log the violation so we can audit how
  // often the variety constraint runs out of options.
  const clipSourceId = new Map<string, string>();
  for (const c of clips) {
    if (c.id && c.video_source_id) {
      clipSourceId.set(c.id as string, c.video_source_id as string);
    }
  }
  let adjacentSameSourceForced = 0;
  // Find the source_id of whichever clip is assigned to blockIdx - 1.
  // Returns null when the previous block has no assignment yet (e.g. its
  // assignment comes later in the triples scan) or it's not a footage
  // row at all.
  function prevSourceFor(blockIdx: number): string | null {
    if (blockIdx <= 0) return null;
    const prev = blockAssignments.get(blockIdx - 1);
    if (!prev) return null;
    return clipSourceId.get(prev.clipId) ?? null;
  }

  // Tier 1 pass — TWO sweeps so the variety rule has all info available.
  // The triples are sorted by score so a greedy single-sweep would let
  // a high-scoring same-source pick claim a block before we know what
  // the adjacent blocks will get. We do this in TWO passes:
  //
  //   Pass A: walk triples top-down; SKIP any candidate whose source
  //           matches the previous block's already-assigned source.
  //           This is where the variety rule fires.
  //   Pass B: walk triples again; fill any block that's still empty,
  //           ignoring the source-adjacency rule. This is the soft
  //           fallback when no different-source candidate was available.
  //
  // The two-pass design preserves the original greedy "best score wins"
  // intuition for blocks where the variety rule doesn't bite, but
  // guarantees adjacent rows differ when there's any choice at all.
  for (const t of triples) {
    if (blockAssignments.has(t.blockIdx)) continue;
    if (usedClipIds.has(t.clipId)) continue;
    const prevSrc = prevSourceFor(t.blockIdx);
    const thisSrc = clipSourceId.get(t.clipId) ?? null;
    if (prevSrc && thisSrc && prevSrc === thisSrc) continue; // pass A: skip same-source
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
  // Pass B: backstop. Blocks left empty after pass A get the next-best
  // candidate even if it shares the previous block's source.
  for (const t of triples) {
    if (blockAssignments.has(t.blockIdx)) continue;
    if (usedClipIds.has(t.clipId)) continue;
    const prevSrc = prevSourceFor(t.blockIdx);
    const thisSrc = clipSourceId.get(t.clipId) ?? null;
    if (prevSrc && thisSrc && prevSrc === thisSrc) {
      adjacentSameSourceForced++;
    }
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
  await logJob({ projectId, jobId: mediaJobId }, "match.adjacent_source_rule", {
    forced_same_source: adjacentSameSourceForced,
    note: "blocks where no different-source candidate existed; the rule is soft",
  });

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
    // Same variety rule as Tier 1: prefer a clip whose source differs
    // from the previous block's source. We do TWO passes — first try
    // to find an overlap candidate from a different source, then if
    // nothing qualifies, fall back to any candidate (the rule is soft).
    const prevSrc = prevSourceFor(blockIdx);
    if (!blockText) {
      // No words to compare against — try a different-source clip first,
      // then fall back to any unused clip that passes the person gate.
      for (const c of clipsForMatch) {
        if (usedClipIds.has(c.id)) continue;
        if (requiresPerson && !clipShowsPerson(c)) continue;
        const thisSrc = clipSourceId.get(c.id) ?? null;
        if (prevSrc && thisSrc && prevSrc === thisSrc) continue;
        return { clipId: c.id, overlap: 0 };
      }
      // Fallback pass — same-source allowed.
      for (const c of clipsForMatch) {
        if (usedClipIds.has(c.id)) continue;
        if (requiresPerson && !clipShowsPerson(c)) continue;
        return { clipId: c.id, overlap: 0 };
      }
      return null;
    }
    const blockToks = tokenize(blockText);
    // Pass A — best overlap among DIFFERENT-source candidates.
    let bestDiff: { clipId: string; overlap: number } | null = null;
    let bestAny: { clipId: string; overlap: number } | null = null;
    for (const c of clipsForMatch) {
      if (usedClipIds.has(c.id)) continue;
      if (requiresPerson && !clipShowsPerson(c)) continue;
      const labels = clipTokens.get(c.id) ?? new Set();
      let overlap = 0;
      for (const t of labels) if (blockToks.has(t)) overlap++;
      const thisSrc = clipSourceId.get(c.id) ?? null;
      if (!bestAny || overlap > bestAny.overlap) bestAny = { clipId: c.id, overlap };
      if (prevSrc && thisSrc && prevSrc === thisSrc) continue;
      if (!bestDiff || overlap > bestDiff.overlap) bestDiff = { clipId: c.id, overlap };
    }
    return bestDiff ?? bestAny;
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

  // Prepend the intro segments as UI-only timeline items. Renderer
  // ignores type='intro' rows (it reads its own intro sources directly
  // from project_script_markers / projects.intro_source_*). These rows
  // exist so the editor UI shows the intro pre-roll at the top of the
  // timeline, matching what the user will see in the final video.
  if (hasDocIntros) {
    // Doc-driven intros — one UI row per intro_card marker. The
    // YouTube-derived thumbnail makes the block visually distinguishable
    // in the editor instead of showing a blank "intro" tile.
    for (const m of docIntroCards) {
      if (!m.youtube_url) continue;
      const start = m.start_seconds != null ? Number(m.start_seconds) : 0;
      const end = m.end_seconds != null ? Number(m.end_seconds) : start + 6;
      const duration = Math.max(1, end - start);
      const videoIdMatch = m.youtube_url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|v\/)([A-Za-z0-9_-]{11})/);
      const ytVideoId = videoIdMatch?.[1] ?? null;
      const thumbUrl = ytVideoId ? `https://i.ytimg.com/vi/${ytVideoId}/mqdefault.jpg` : null;
      const labelText = m.text?.trim()
        ? `Intro — ${m.text.trim()} (${Math.round(duration)}s, original audio)`
        : `Intro clip ${m.ordinal + 1} (${Math.round(duration)}s, original audio)`;
      items.push({
        project_id: projectId,
        clip_id: null,
        type: "intro",
        position: position++,
        duration,
        script_text: labelText,
        overlay_text: null,
        metadata: {
          is_intro: true,
          intro_source: "script_doc",
          doc_marker_id: m.id,
          marker_ordinal: m.ordinal,
          plays_source_audio: true,
          ui_only: true,
          youtube_url: m.youtube_url,
          start_seconds: start,
          end_seconds: end,
          thumbnail_url: thumbUrl,
          clip_storage_url: m.clip_storage_url ?? null,
        },
        approved: false,
      });
    }
  } else if (introClipId) {
    // Legacy auto-pick intro — only used when no doc intros were declared.
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
    // Real voiceover-time window for this block's narration. Used by
    // markers.ts (script marker placement) and by buildBlockTexts (per-
    // block text slicing) to map between audio time and item position
    // without drifting from cumulative duration sums.
    vo_start_seconds: blockVoStart[idx] ?? null,
    vo_end_seconds: blockVoEnd[idx] ?? null,
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
  // Note: `usedTranscriptDrivenBuilder` is declared earlier (near the
  // hints load) because it gets WRITTEN inside the planSource branch
  // hundreds of lines above this point. The duration-strategy logic
  // below reads it to decide whether to skip duration_reclaim.

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
        const clipDur = clipDurationById.get(assigned.clipId) ?? 0;
        // Phase B: split this block into sub-rows when the clip is too
        // short for slow-mo to cover the sentence. Slow-mo handles up to
        // 1.5× stretch invisibly (Phase A); beyond that, audio-visual
        // sync requires filling the rest of the sentence with another
        // visual rather than stretching the clip further or pushing the
        // gap onto OTHER blocks via reclaim.
        //
        // Decision: stretch = sentence_duration / clipDur
        //   stretch ≤ 1.5  → ONE row (slow-mo handles small gaps)
        //   stretch > 1.5  → TWO sub-rows split at clipDur boundary:
        //     • Sub-row A: this clip, played at natural speed for clipDur
        //     • Sub-row B: a SECOND clip from the block's scored candidates
        //                  (preferred), or an image of the resolved subject
        //                  (fallback in a later pass — see needs_fallback_visual)
        //
        // The sub-rows share the same script_text so the editor shows
        // the same sentence on both rows; the user can review/replace
        // either half independently. vo_start/vo_end are sliced
        // proportionally so each sub-row covers its own audio window.
        const SLOWMO_COVERAGE_LIMIT = 1.5;
        const stretch = clipDur > 0 ? block.duration / clipDur : 1.0;
        const needsSplit = clipDur > 0 && stretch > SLOWMO_COVERAGE_LIMIT;

        if (needsSplit) {
          // ──────────── Phase B split path ────────────
          // Sub-row A — Clip A at natural speed, covers the first clipDur
          // seconds of the sentence's audio window.
          const blockVoStartSec = blockVoStart[i];
          const blockVoEndSec = blockVoEnd[i];
          const haveVo = blockVoStartSec != null && blockVoEndSec != null;
          const subAVoStart = haveVo ? blockVoStartSec : null;
          const subAVoEnd = haveVo ? (blockVoStartSec as number) + clipDur : null;
          const subBVoStart = subAVoEnd;
          const subBVoEnd = haveVo ? blockVoEndSec : null;
          const remainder = Math.max(0.1, block.duration - clipDur);

          // Pick Clip B from this block's scored candidates. Prefer:
          //   1. Not already used elsewhere in the timeline
          //   2. Different source than Clip A (existing variety rule)
          //   3. Highest Gemini score (candidates are already score-sorted)
          const candidates = scoresByBlock.get(i) ?? [];
          const clipASourceId = clipSourceId.get(assigned.clipId) ?? null;
          let clipB: { clipId: string; score: number } | null = null;
          // Pass 1: different source.
          for (const cand of candidates) {
            if (cand.clip_id === assigned.clipId) continue;
            if (usedClipIds.has(cand.clip_id)) continue;
            const candSrc = clipSourceId.get(cand.clip_id) ?? null;
            if (clipASourceId && candSrc && candSrc === clipASourceId) continue;
            clipB = { clipId: cand.clip_id, score: cand.score };
            break;
          }
          // Pass 2: any unused (relax the different-source rule).
          if (!clipB) {
            for (const cand of candidates) {
              if (cand.clip_id === assigned.clipId) continue;
              if (usedClipIds.has(cand.clip_id)) continue;
              clipB = { clipId: cand.clip_id, score: cand.score };
              break;
            }
          }
          // Pass 3: reuse a clip on cooldown rather than downgrading the
          // tail to an image — preserves the planned footage:image ratio
          // when the unused pool is thin. pickReuseClipForBlock skips
          // distance ≤ 0 candidates, so Clip A (just placed at this block's
          // start) can never be picked for its own tail.
          let clipBIsReuse = false;
          if (!clipB) {
            const reuse = pickReuseClipForBlock(i);
            if (reuse) {
              clipB = { clipId: reuse.clipId, score: 0 };
              clipBIsReuse = true;
            }
          }

          // Push sub-row A.
          items.push({
            project_id: projectId,
            clip_id: assigned.clipId,
            type: "footage",
            position: position++,
            duration: clipDur,
            script_text: blockText || null,
            overlay_text: null,
            metadata: {
              planned: true,
              planned_duration: clipDur,
              clip_duration: clipDur,
              duration_clamped: false,
              match_score: assigned.score,
              match_base_score: assigned.baseScore ?? null,
              match_bonus: assigned.bonus ?? null,
              match_bonus_breakdown: assigned.bonusBreakdown ?? null,
              match_reason: assigned.reason ?? null,
              pick_source: pickSource,
              block_index: i,
              split_sub_row: "A",
              split_total_sub_rows: 2,
              split_reason: `stretch_${Math.round(stretch * 100) / 100}x_exceeds_${SLOWMO_COVERAGE_LIMIT}x`,
              ...planHintFor(i),
              vo_start_seconds: subAVoStart,
              vo_end_seconds: subAVoEnd,
            },
            approved: false,
          });
          assignedFootageCount++;

          // Push sub-row B.
          if (clipB) {
            const clipBDur = clipDurationById.get(clipB.clipId) ?? 0;
            // Clip B might also be shorter than the remainder. Clamp it;
            // the residual goes into durationReclaimSeconds so the reclaim
            // pass can absorb the tail onto other rows. This is the rare
            // case where BOTH the primary AND secondary clip are short —
            // mathematically impossible to fix with footage alone here.
            let subBDur = remainder;
            if (clipBDur > 0 && clipBDur < remainder) {
              durationReclaimSeconds += remainder - clipBDur;
              durationClampedCount++;
              subBDur = clipBDur;
            }
            // Reuse picks update the cooldown clock only — usedClipIds is
            // the "used once" gate for FRESH picks (same convention as the
            // Tier 2.5 fill loop above).
            if (clipBIsReuse) {
              clipLastUsedAt.set(clipB.clipId, blockStartSec[i]);
            } else {
              usedClipIds.add(clipB.clipId);
            }
            items.push({
              project_id: projectId,
              clip_id: clipB.clipId,
              type: "footage",
              position: position++,
              duration: subBDur,
              script_text: blockText || null,
              overlay_text: null,
              metadata: {
                planned: true,
                planned_duration: remainder,
                clip_duration: clipBDur || null,
                duration_clamped: subBDur < remainder,
                match_score: clipB.score,
                match_reason: clipBIsReuse ? "phase_b_split_secondary_reuse" : "phase_b_split_secondary_clip",
                pick_source: clipBIsReuse ? "split_secondary_reuse" : "split_secondary_clip",
                block_index: i,
                split_sub_row: "B",
                split_total_sub_rows: 2,
                ...planHintFor(i),
                vo_start_seconds: subBVoStart,
                vo_end_seconds: subBVoEnd,
              },
              approved: false,
            });
            assignedFootageCount++;
          } else {
            // No second clip available → push a placeholder image row.
            // Pass 2 (the reference-driven image pass) walks items with
            // needs_fallback_visual=true and fills them via
            // tryPersonImageFallback(resolved_subject). Until then,
            // image_url stays null and the renderer would skip it; we
            // rely on Pass 2 always succeeding for the main celebrity.
            items.push({
              project_id: projectId,
              clip_id: null,
              type: "image",
              position: position++,
              duration: remainder,
              script_text: blockText || null,
              overlay_text: null,
              metadata: {
                placeholder: true,
                planned: true,
                needs_fallback_visual: true,
                downgraded_from: "footage",
                downgrade_reason: "phase_b_split_no_second_clip",
                pick_source: "split_image_tail",
                block_index: i,
                split_sub_row: "B",
                split_total_sub_rows: 2,
                ...planHintFor(i),
                vo_start_seconds: subBVoStart,
                vo_end_seconds: subBVoEnd,
              },
              approved: false,
            });
            // NOTE: not counting this in assignedFootageCount because it's
            // an image, but it WAS supposed to be footage so the
            // downgradedCount metric should reflect it.
            downgradedCount++;
          }
          continue;
        }

        // ──────────── Phase A path (≤ 1.5× stretch) ────────────
        // Slow-mo at the renderer handles small shortfalls invisibly.
        // We still record planned_duration vs clip_duration so the
        // editor can show the user the planned slot length.
        const realDuration = block.duration;
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
            duration_clamped: false,
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
  // GENUINE failures only: the block had references/entities, the search +
  // verify pipeline ran, and no candidate survived.
  let refImagesFailed = 0;
  // BY-DESIGN person fallbacks: celebrity_default blocks skip the reference
  // search entirely per the closed-world spec ("abstract narration → show the
  // project celebrity"). Counted separately so this log line stops reading
  // like a mass failure when most blocks are simply abstract narration.
  let refImagesShortCircuited = 0;

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
    // Project-level context anchor — the celebrity the script is about.
    // Bare proper-noun queries ("The Conversation", "Matisse", "Advertising
    // Week") were returning the literal Wikipedia/CSE result (the 1974 film
    // poster, a Matisse painting, an event promo poster) instead of imagery
    // tied to the project's topic. Prefixing the anchor keeps the search
    // inside the project's universe — same gating we already apply in
    // buildScriptPhraseQueries.
    const contextAnchor = (mainCelebrity ?? "").trim();
    const anchorLower = contextAnchor.toLowerCase();

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

      // Single common-noun titles (e.g. "Conversation", "Statement") are
      // dropped here too — Gemini occasionally labels a sentence containing
      // the common noun as subject_type "movie" with primaryEntity "The
      // Conversation". Without this guard the type-router fires
      // "The Conversation movie poster" and CSE returns the 1974 film.
      const isCommonNounTrap = isCommonNounTitle(primaryEntity);
      // Prefix the project's celebrity anchor onto subject-type queries so
      // generic entity names ("The Conversation", "Advertising Week",
      // "December") return imagery tied to the project's topic instead of
      // the literal famous-work or calendar-page result. When the entity
      // already starts with the anchor we skip the prefix to avoid
      // duplicate tokens.
      const entityLower = primaryEntity.toLowerCase();
      const needsAnchor = contextAnchor && !entityLower.startsWith(anchorLower);
      const anchored = needsAnchor ? `${contextAnchor} ${primaryEntity}` : primaryEntity;
      switch (subjectType) {
        case "company":
          if (!isCommonNounTrap) {
            out.push({ query: `${anchored} logo`, reason: `subject_type:company:${primaryEntity}`, imgType: "logo" });
          }
          break;
        case "movie":
          if (!isCommonNounTrap) {
            out.push({ query: `${anchored} movie poster`, reason: `subject_type:movie:${primaryEntity}` });
          }
          break;
        case "show":
          if (!isCommonNounTrap) {
            out.push({ query: `${anchored} tv show poster`, reason: `subject_type:show:${primaryEntity}` });
          }
          break;
        case "place":
          // Drop country / state / region "places" — they return flags and
          // outline maps, never on-topic photographs. The footage fallback
          // does a better job (Dave Kindig clip + segment context).
          if (!isGeographicNonLandmark) {
            out.push({ query: anchored, reason: `subject_type:place:${primaryEntity}` });
          }
          break;
        case "event":
          // Drop bare dates — image search on "January 2016" returns calendar
          // pages and stock photos. Only route named events through the
          // archival query.
          if (!isBareDate) {
            out.push({ query: `${anchored} archival footage`, reason: `subject_type:event:${primaryEntity}` });
          }
          break;
        case "object":
          out.push({ query: anchored, reason: `subject_type:object:${primaryEntity}` });
          break;
        // "person" and "general" fall through to the reference / subject
        // anchor path below — the existing flow handles them.
      }
    }

    // Tier 1: each mentioned entity verbatim. Highest precision — the script
    // named something concrete (a movie, a place, a person). Single common-
    // noun tokens that collide with famous-work titles are dropped (see
    // COMMON_NOUN_TITLE_BLOCKLIST) — those queries return the famous-work
    // poster from CSE, never on-topic visuals.
    //
    // Bare entity queries are prefixed with the project's celebrity anchor
    // for the same reason buildScriptPhraseQueries does it: a query like
    // "The Conversation" returns the 1974 film poster, "Matisse" returns a
    // painting, "Advertising Week" returns a conference promo — none of
    // which belong in a BGT/Cowell timeline. Prefixing keeps the search
    // inside the project's topic universe. Country/region and bare-date
    // entities are dropped outright (flags, maps, calendar pages).
    for (const ent of mentionedEntities) {
      const e = ent.trim();
      if (!e) continue;
      if (isCommonNounTitle(e)) continue;
      if (isCountryOrRegion(e)) continue;
      if (isDateOnly(e)) continue;
      const eLower = e.toLowerCase();
      if (contextAnchor && !eLower.startsWith(anchorLower) && eLower !== anchorLower) {
        out.push({
          query: `${contextAnchor} ${e}`,
          reason: `mentioned_entity_contextual:${contextAnchor}:${e}`,
        });
      } else {
        out.push({ query: e, reason: `mentioned_entity:${e}` });
      }
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
    // Project-level context anchor for script-phrase searches. Without this,
    // a bare phrase like "The Statement" lifted from a BGT script returns a
    // swastika graphic captioned "The Statement / Case Closed" because Google
    // Image Search has no idea the phrase is part of a Britain's Got Talent
    // narration. Prefixing the main celebrity (and the show, if known) keeps
    // the search inside the project's topic universe.
    const contextAnchor = (mainCelebrity ?? "").trim();
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
      // Contextualized query only — the bare-phrase fallback was leaking
      // literal-text graphics into the timeline. Examples that shipped to
      // the editor before this gate tightened:
      //   - "The Statement" → red graphic with "STATEMENT" lettering
      //   - "Advertising Week" → a conference promo poster
      //   - "twenty fourteen" / "YouTube" → calendar pages, YouTube logos
      // The contextualized form keeps the search inside the project's topic
      // (e.g. "Simon Cowell statement", "Simon Cowell Walliams") which is
      // what the script is actually about. We only fall back to the bare
      // phrase when there's NO context anchor — i.e. no main celebrity was
      // extracted for this project, which is rare.
      if (contextAnchor && pl !== contextAnchor.toLowerCase()) {
        out.push({
          query: `${contextAnchor} ${p}`,
          reason: `script_phrase_contextual:${contextAnchor}:${p}`,
        });
      } else {
        out.push({ query: p, reason: `script_phrase:${p}` });
      }
    }
    // Cap to 4 queries per block — image fetches cost money and time, and
    // beyond the top phrases we're typically scraping the barrel. With the
    // bare-phrase fallback removed, this is one query per phrase, so we
    // get up to 4 distinct phrases per block to try.
    return out.slice(0, 4);
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

  // Per-person photo cache. tryPersonImageFallback builds this lazily on
  // the first call for each person (block-resolved-subject or main
  // celebrity), fetches multiple query facets to maximise variety, and
  // face-verifies every image against the person's reference. Subsequent
  // calls read from the cache so per-block fallback doesn't pay for
  // redundant fetches.
  //
  // Sized analogously to the entity pool's personFloor: scales with
  // voiceoverSeconds so a 10-min video gets ~60 unique celebrity images
  // available to the fallback (vs. the old single-query fetch of 10).
  // Without this, the celebrity_default short-circuit consumed only the
  // top of one query's results, ignoring the bigger pool built later.
  type PersonPhotoCacheEntry = {
    url: string;
    source: string;
    query: string;
  };
  const personPhotoCache = new Map<string, PersonPhotoCacheEntry[]>();
  // Per-person target size for the MAIN celebrity. Same formula as the
  // entity-pool personFloor. Scales with voiceoverSeconds so a 10-min
  // video gets ~60 unique celebrity images available to the fallback.
  //
  // Hard cap at PERSON_PHOTO_HARD_CAP (env-tunable, default 80). Each cached
  // image is a separate Gemini face-verify call; on a 30-min audio the
  // uncapped target was ~192, multiplied across ~8 entities that's ~1500
  // Gemini calls just for the verify gate, and the match step burned 10+
  // minutes here on Gemini 503 retries. The cap bounds that cost while still
  // letting the duration-scaled target (voiceoverSeconds / 10) drive variety:
  // at 80, audios up to ~13 min hit the duration target before clamping, and
  // longer ones cap at 80 unique photos — well above the ~20 the reuse
  // cooldown needs to avoid back-to-back repeats. Raise the env var for more
  // variety on long videos at the cost of a slower match step.
  const PERSON_PHOTO_HARD_CAP = getEnv().PERSON_PHOTO_HARD_CAP;
  const personPhotoTarget = Math.min(
    PERSON_PHOTO_HARD_CAP,
    Math.max(20, Math.ceil(voiceoverSeconds / 10)),
  );

  // Compute consecutive-run-length per secondary person from the block
  // entity bindings. Used by Phase 2b to size each secondary's photo
  // cache: a person mentioned in 8 consecutive blocks (e.g. Simon Cowell
  // in this project) needs more variety than someone mentioned once.
  //
  // This mirrors analyze's findPersonRunsAcrossSegments but runs on the
  // MATCHER's already-flattened block list, so we don't need to ship
  // the personRuns map through the analyze payload. The match-time
  // recompute is cheap (single linear scan) and stays in sync when
  // block order changes (e.g. via image_block_split).
  function computeSecondaryPersonRuns(): Map<string, { maxRun: number; totalBlocks: number }> {
    const out = new Map<string, { maxRun: number; totalBlocks: number }>();
    const celebLower = (mainCelebrity ?? "").trim().toLowerCase();
    let i = 0;
    while (i < blockClosedWorldEntities.length) {
      const cur = blockClosedWorldEntities[i];
      if (!cur || cur.type !== "person") { i++; continue; }
      const name = cur.name.trim();
      const lo = name.toLowerCase();
      if (!name || lo === celebLower) { i++; continue; }
      let j = i;
      while (j < blockClosedWorldEntities.length) {
        const next = blockClosedWorldEntities[j];
        if (!next || next.type !== "person") break;
        if (next.name.trim().toLowerCase() !== lo) break;
        j++;
      }
      const run = j - i;
      const prev = out.get(lo) ?? { maxRun: 0, totalBlocks: 0 };
      out.set(lo, {
        maxRun: Math.max(prev.maxRun, run),
        totalBlocks: prev.totalBlocks + run,
      });
      i = j;
    }
    return out;
  }
  const secondaryPersonRuns = computeSecondaryPersonRuns();

  // Map a secondary person's narrative weight to a photo-cache target size.
  //
  // We weigh by BOTH the longest consecutive run AND the total footprint, and
  // take the larger tier. A co-lead like Camilla in a William+Camilla script
  // is mentioned constantly but ALTERNATES with William, so her consecutive
  // run is often just 1-2 even though she's the subject of a third of the
  // blocks. Keying the pool size on maxRun alone gave her target=0 → a single
  // repeated Wikipedia headshot while William got a pool of dozens — the
  // "Camilla image is smaller" symptom. Folding in totalBlocks lets a
  // scattered-but-dominant person earn a real pool. (Mirrors the
  // maxRun-OR-totalBlocks lesson already applied to analyze discovery.)
  //   weight >= 6 → "co-main" treatment, larger pool
  //   weight 3-5  → "significant secondary", moderate pool
  //   weight 2    → "brief mention", small pool
  //   weight 1    → 0 → caller skips the cache and uses Wikipedia portrait
  function secondaryPhotoTargetForRun(info: { maxRun: number; totalBlocks: number }): number {
    // Total footprint counts a bit less per block than a consecutive run
    // (scattered mentions are individually weaker signals), so scale it down
    // before comparing. A person with ~8 total blocks but no long run still
    // clears the "significant secondary" tier.
    const weight = Math.max(info.maxRun, Math.round(info.totalBlocks * 0.6));
    if (weight >= 6) return Math.min(personPhotoTarget, 30);
    if (weight >= 3) return 15;
    if (weight >= 2) return 8;
    return 0;
  }

  // Resolve the NAME a person can actually be face-VERIFIED under. The pool
  // verifier looks up face_references by entity_name; block subjects are
  // often bare ("Catherine") and disambiguatePersonName produces a
  // search-qualified phrase ("Catherine British royal family") — but the
  // roster row from analyze was created under the script's full proper noun
  // ("Catherine, Princess of Wales"). That exact-string mismatch made every
  // secondary person UNVERIFIABLE: lookupReference missed, all their fetched
  // candidates came back "skipped", requireConfirmed rejected them, and the
  // pool was cached EMPTY — so Catherine/Camilla blocks all fell back to the
  // main celebrity. Resolution order:
  //   1. the disambiguated name   (exact roster hit)
  //   2. the raw name             (roster row under the bare form)
  //   3. roster prefix match      ("Catherine" → "Catherine, Princess of Wales")
  //   4. lazily CREATE a roster row for the disambiguated name (Wikipedia
  //      fetch + is-a-person guard) so even people the analyze-time roster
  //      missed become verifiable.
  // Returns the name used for BOTH search queries and verification. When
  // nothing resolves, returns the disambiguated name — verification then
  // "skips" and strict mode rejects, exactly the old behaviour.
  const personVerifyNameCache = new Map<string, string>();
  async function resolvePersonVerifyName(rawPersonName: string): Promise<string> {
    const raw = rawPersonName.trim();
    const cacheKey = raw.toLowerCase();
    const hit = personVerifyNameCache.get(cacheKey);
    if (hit) return hit;
    const disambiguated = disambiguatePersonName(raw);
    const bare = isBareFirstName(raw);
    let resolved: string | null = null;
    // Exact candidates. For a BARE first name we deliberately do NOT accept
    // an exact roster row under the bare name itself here — bare-name rows
    // are the known-poisoned class: Wikipedia resolves a bare given name to
    // its "given name" article, whose infobox photo is a FAMOUS NAMESAKE
    // (the Katherine-Heigl-as-"Catherine" bug), and the is-a-person guard
    // can't catch that because the namesake IS a person. The bare row stays
    // reachable below as a prefix match — but only when no longer, more
    // specific roster name exists for the same first name.
    for (const cand of bare ? [disambiguated] : [disambiguated, raw]) {
      if (await lookupReference(projectId, "person", cand)) { resolved = cand; break; }
    }
    if (!resolved) {
      // Prefix match against the project roster, preferring the LONGEST
      // entity_name — "Catherine" → "Catherine, Princess of Wales" wins over
      // a bare (possibly poisoned) "Catherine" row. Project-scoped, so a
      // bare first name resolving to the wrong namesake would require TWO
      // people with the same first name in one script — acceptable residual
      // risk.
      const prefix = raw.replace(/[%_]/g, "");
      if (prefix) {
        const { data } = await sb
          .from("face_references")
          .select("entity_name")
          .eq("project_id", projectId)
          .eq("entity_type", "person")
          .ilike("entity_name", `${prefix}%`)
          .not("reference_url", "is", null)
          .limit(10);
        const rows = (data ?? []) as Array<{ entity_name: string }>;
        if (rows.length > 0) {
          rows.sort((a, b) => b.entity_name.length - a.entity_name.length);
          resolved = rows[0].entity_name;
        }
      }
    }
    if (!resolved) {
      try {
        const row = await upsertReference(projectId, { type: "person", name: disambiguated });
        if (row.reference_url) resolved = disambiguated;
      } catch {
        // Lazy roster build failed (Wikipedia miss / DB blip) — verification
        // will skip for this person, same as before this resolver existed.
      }
    }
    const finalName = resolved ?? disambiguated;
    personVerifyNameCache.set(cacheKey, finalName);
    void logJob({ projectId, jobId: mediaJobId }, "match.person_ref_resolved", {
      raw, disambiguated, resolved: finalName, referenceFound: resolved !== null,
    });
    return finalName;
  }

  async function buildPersonPhotoCache(
    rawPersonName: string,
    sizeOverride?: number,
  ): Promise<PersonPhotoCacheEntry[]> {
    // Cache key stays on the ORIGINAL name (callers pass the bare subject), but
    // every search query AND the face-verify reference below use the RESOLVED
    // name: disambiguated so a bare first name ("Catherine") can't pull/confirm
    // the wrong namesake (the actress), and roster-resolved so verification
    // finds the person's reference photo — see resolvePersonVerifyName.
    const cached = personPhotoCache.get(rawPersonName.toLowerCase());
    if (cached) return cached;
    const personName = await resolvePersonVerifyName(rawPersonName);
    // Caller-provided size override (used by secondary-person path to
    // scale by maxRun); falls back to the main-celebrity target.
    const target = sizeOverride ?? personPhotoTarget;
    if (target <= 0) {
      // Caller asked for an empty pool (maxRun 1 secondary). Return [] —
      // they'll fall back to the Wikipedia portrait. Cache under the RAW name
      // so the lookup at the top (also raw) hits.
      personPhotoCache.set(rawPersonName.toLowerCase(), []);
      return [];
    }
    const result: PersonPhotoCacheEntry[] = [];
    const seen = new Set<string>();
    // Query facets — same set as the entity pool's celebrity floor, kept
    // in sync deliberately. Each query returns ~10-15 unique URLs after
    // dedup; with ~85% face-verify pass rate, 10 facets yield ~50-70.
    // For smaller targets (secondary people with low maxRun) we exit the
    // outer loop early once the target is reached, so cost scales with
    // the cache size we actually need.
    const queries = [
      `"${personName}"`,
      `${personName} interview`,
      `${personName} portrait`,
      `${personName} red carpet`,
      `${personName} premiere`,
      `${personName} press conference`,
      `${personName} photoshoot`,
      `${personName} BAFTA`,
      `${personName} headshot`,
      `${personName} talk show`,
    ];
    // Face-verify a query's candidates in BATCHED Gemini calls (up to 8
    // candidates per call, one shared reference upload) instead of one call
    // per candidate — this loop was the dominant Gemini volume of the match
    // step (~120 calls/person) and the thing that tripped 503 "high demand".
    //
    // STRICT mode: only POSITIVELY confirmed photos enter the cache. INFRA
    // FAILURES (Gemini 503 / fetch timeout — verdict.errored) are PARKED:
    // never accepted unverified, never counted as a rejection. Parked
    // candidates are re-verified in bounded rounds below, after a wait that
    // lets the typical 503 spike pass. Still-errored after that → dropped
    // (the job-level circuit breaker decides whether the run is shippable).
    const parked: PersonPhotoCacheEntry[] = [];
    async function verifyBatch(cands: PersonPhotoCacheEntry[]): Promise<void> {
      if (cands.length === 0) return;
      const verdicts = await verifyPoolAssetsBatch(
        cands.map((f) => ({
          projectId,
          entityType: "person" as const,
          entityName: personName,
          candidateUrl: f.url,
        })),
        { requireConfirmed: true },
      );
      verdicts.forEach((v, k) => {
        if (v.errored) { parked.push(cands[k]); return; }
        if (v.accept && result.length < target) result.push(cands[k]);
      });
    }

    for (const q of queries) {
      if (result.length >= target) break;
      try {
        const fetched = await fetchImages(q, 12, { entityType: "celebrity" });
        // Dedup this query's URLs against everything already kept/seen, in
        // fetch order, before verifying. `seen` is marked now so two URLs
        // that are identical within the same fetched[] list aren't both
        // verified.
        const candidates = fetched.filter((f) => {
          if (seen.has(f.url)) return false;
          seen.add(f.url);
          return true;
        });
        await verifyBatch(candidates.map((f) => ({ url: f.url, source: f.source, query: q })));
      } catch {
        // Image search failed for one query — continue with the rest.
      }
    }

    // Parked-retry rounds. Each round re-verifies everything that errored so
    // far; re-erroring entries land back in `parked` for the next round.
    for (const delayMs of [20_000, 40_000]) {
      if (result.length >= target || parked.length === 0) break;
      await new Promise((r) => setTimeout(r, delayMs));
      const retry = parked.splice(0, parked.length);
      void logJob({ projectId, jobId: mediaJobId }, "match.person_photo_cache.retry_parked", {
        person: personName, parked: retry.length, have: result.length, target,
      });
      await verifyBatch(retry);
    }
    personPhotoCache.set(rawPersonName.toLowerCase(), result);
    void logJob({ projectId, jobId: mediaJobId }, "match.person_photo_cache.built", {
      person: personName,
      rawPerson: rawPersonName,
      target,
      cached: result.length,
      // Candidates whose verification still ERRORED after the retry rounds —
      // dropped unverified. Non-zero here means Gemini was down for the whole
      // build window; the circuit breaker evaluates the run-level impact.
      unverifiedDropped: parked.length,
    });
    return result;
  }

  // Per-block PERSON-image fallback. When a "specific_*" block can't find
  // an image of its exact reference (a tattoo, a wedding, a courthouse),
  // the client spec says: fall back to the PERSON image — never to a
  // random pool entry. This helper now consults a per-person photo cache
  // (built lazily on first call) instead of issuing a fresh single-query
  // fetch every time — giving the celebrity_default short-circuit access
  // to the same wide pool the entity-pool builder uses.
  async function tryPersonImageFallback(blockIdx: number): Promise<{
    url: string;
    source: string;
    query: string;
  } | null> {
    // Only use blockResolvedSubjects[blockIdx] when Gemini classified it as
    // an actual person — otherwise non-person strings like "YouTube",
    // "Britain's Got Talent", "Advertising Week" feed buildPersonPhotoCache
    // and end up as the block's "celebrity photo" (a Getty stock image of
    // a YouTube monitor was leaking in via query `"YouTube"`).
    //
    // For non-person resolved subjects, fall through to mainCelebrity so
    // the spec-required behaviour ("If an exact image/visual cannot be
    // found → fallback to the PERSON image. NEVER use random unrelated
    // visuals.") actually shows the project celebrity.
    const resolvedSubjectType = blockSubjectTypes[blockIdx] ?? null;
    const resolvedSubject = blockResolvedSubjects[blockIdx];
    const nowSec = blockStartSec[blockIdx];

    // Subjects to try, in order. When the block resolves to a SECONDARY person
    // (e.g. "Charles" on a Diana project), try them first — but if their photo
    // pool comes back empty (a thin secondary pool, or every candidate rejected
    // by the verify gate), FALL BACK TO THE MAIN CELEBRITY rather than giving
    // up. The narration on these blocks is almost always still about the main
    // subject ("…Diana chose it herself."), so the project celebrity is an
    // on-topic visual — and a real celebrity photo beats leaving the block
    // empty (which collapses the timeline). De-duplicated so we never fetch the
    // same person twice.
    const subjectCandidates: string[] = [];
    if (resolvedSubjectType === "person" && resolvedSubject) {
      subjectCandidates.push(resolvedSubject.trim());
    }
    if (mainCelebrity && mainCelebrity.trim()) {
      subjectCandidates.push(mainCelebrity.trim());
    }
    const seenSubjects = new Set<string>();

    // Three-tier pick over one subject's fetched photo pool. Per client spec:
    // "If an exact image/visual cannot be found → fallback to the person image.
    // NEVER use random unrelated visuals." So we MUST return a person image
    // when any exist — even one already used elsewhere; re-showing a celebrity
    // photo beats dropping through to a random brand logo (or empty).
    //   Tier A — fresh URL outside the reuse cooldown (or never used).
    //   Tier B — fresh URL ignoring the cooldown but unused by the reference
    //            pass (refUrlSet) — seen earlier as another fallback, fine to repeat.
    //   Tier C — any fetched URL, including reference-claimed ones.
    const pickFromPool = (fetched: PersonPhotoCacheEntry[]): PersonPhotoCacheEntry | null => {
      let bestA: PersonPhotoCacheEntry | null = null;
      let bestB: PersonPhotoCacheEntry | null = null;
      let bestBDistance = -Infinity;
      for (const f of fetched) {
        if (refUrlSet.has(f.url)) continue;
        const last = imageUrlLastUsedAt.get(f.url);
        if (last === undefined) { bestA = f; break; }
        const dist = nowSec - last;
        if (dist >= IMAGE_REUSE_COOLDOWN_SEC) { bestA = f; break; }
        if (dist > bestBDistance) { bestB = f; bestBDistance = dist; }
      }
      let pick = bestA ?? bestB;
      if (!pick) {
        let bestC: PersonPhotoCacheEntry | null = null;
        let bestCDistance = -Infinity;
        for (const f of fetched) {
          const last = imageUrlLastUsedAt.get(f.url);
          const dist = last === undefined ? Infinity : nowSec - last;
          if (dist > bestCDistance) { bestCDistance = dist; bestC = f; }
        }
        pick = bestC;
      }
      return pick;
    };

    for (const subj of subjectCandidates) {
      const key = subj.toLowerCase();
      if (seenSubjects.has(key)) continue;
      seenSubjects.add(key);
      const fetched = await buildPersonPhotoCache(subj);
      if (fetched.length === 0) continue;
      const pick = pickFromPool(fetched);
      if (pick) {
        if (subj !== resolvedSubject) {
          void logJob({ projectId, jobId: mediaJobId }, "match.person_fallback_to_main_celebrity", {
            blockIndex: blockIdx, triedSubject: resolvedSubject ?? null, usedSubject: subj,
          });
        }
        return { url: pick.url, source: pick.source, query: pick.query };
      }
    }
    return null;
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
    const rawBlockEntity = blockClosedWorldEntities[blockIdx] ?? null;
    // Defensive null-coalescing. The diagnostic logs showed some image
    // blocks arrive with blockEntity=null — Gemini occasionally omits
    // the block_entity field entirely, or it gets lost between the
    // analyze payload and the matcher's hint forwarding. When that
    // happens, the legacy reference-driven path uses refs[0]/ents[0]
    // (common nouns like "transcript", "recordings") and produces
    // pages of nonsense Gemini rejects. Treat a null binding as
    // celebrity_default so the same protective short-circuit applies.
    let blockEntity: BlockEntityBinding =
      rawBlockEntity ?? { type: "celebrity_default", name: mainCelebrity ?? "" };
    let narrativeSubjectOverride = false;

    // Narrative-subject anchor (Option B).
    //
    // Gemini sometimes extracts a place/event/general entity as the
    // block subject when the narration is actually ABOUT the project
    // celebrity AT that place/event. Example: "The BGT auditions at
    // the London Palladium proceeded the way they always did." — Gemini
    // tags the block as { type: "place", name: "London Palladium" },
    // and the matcher faithfully searches for Palladium photos. Image
    // search returns BGT promotional shots featuring random contestants
    // (because the venue hosts BGT), Gemini verifier accepts them
    // (they ARE from the Palladium), and the editor shows the wrong
    // person on screen during narration about Walliams.
    //
    // The fix: when the block's subject is a non-person AND the project
    // celebrity is mentioned in this block or the surrounding ±1 block
    // window, override to celebrity_default. The celebrity image path
    // shows a clean Walliams photo instead of place-context noise.
    //
    // We don't override "company" / "movie" / "show" / "tv_show"
    // because those entities have canonical visual identities (logos,
    // posters) the user does want to see. Only "place", "event",
    // "general", and "object" get the override — these are subjects
    // where image search reliably drifts into context-photos with
    // wrong people in frame.
    const NARRATIVE_OVERRIDE_TYPES = new Set(["place", "event", "general", "object"]);
    if (
      mainCelebrity &&
      blockEntity.type !== "celebrity_default" &&
      blockEntity.type !== "person" &&
      subjectType &&
      NARRATIVE_OVERRIDE_TYPES.has(subjectType)
    ) {
      const celebLower = mainCelebrity.toLowerCase();
      const celebLastName = mainCelebrity.toLowerCase().split(/\s+/).slice(-1)[0];
      // Widen the window to ±3 blocks. Documentary narration often
      // separates the SETUP sentence (e.g. "On January twenty twenty,
      // microphones at the London Palladium picked up something...")
      // from the PAYOFF sentence naming the celebrity ("what David
      // Walliams said next..."). The Palladium block needs to know
      // about the Walliams reference 2-3 sentences later to fire the
      // override. The previous ±1 window was too narrow and missed
      // most of these setup-payoff pairs — every block in the test
      // logs showed narrativeSubjectOverride:false.
      const WINDOW = 3;
      const windowTexts: string[] = [];
      for (let off = -WINDOW; off <= WINDOW; off++) {
        const idx = blockIdx + off;
        if (idx < 0 || idx >= blockTexts.length) continue;
        windowTexts.push((blockTexts[idx] ?? "").toLowerCase());
      }
      const celebMentioned = windowTexts.some(
        (t) => t.includes(celebLower) || (celebLastName.length >= 4 && t.includes(celebLastName)),
      );
      if (celebMentioned) {
        blockEntity = { type: "celebrity_default", name: mainCelebrity };
        narrativeSubjectOverride = true;
      }
    }
    void logJob({ projectId, jobId: mediaJobId }, "match.image_block_entity_state", {
      blockIndex: blockIdx,
      blockEntity: { type: blockEntity.type, name: blockEntity.name },
      rawWasNull: rawBlockEntity === null,
      subjectType,
      refs0: refs[0] ?? null,
      ents0: ents[0] ?? null,
      narrativeSubjectOverride,
    });
    // Note: text-grounding for block_entity is enforced upstream in
    // analyze's normalizeBlockEntities — by the time hints reach the
    // matcher, any non-grounded entity has already been demoted to
    // celebrity_default. No matcher-side denylist needed.

    // Closed-world short-circuit. When analyze tagged this block as
    // celebrity_default, the block is abstract narration ("Private
    // conversations, he would later say. Among friends."). The spec is
    // explicit: never random visuals — show the project celebrity. Skip
    // the reference-driven image search (whose refs/ents for these blocks
    // are common nouns like "private" / "friends" that pull noise like
    // the "I AM PAKISTANI" graphic) and route directly to the person
    // fallback. Without this, Gemini's mistyped image blocks slip through
    // the reference search and produce the random-image failure mode the
    // user reported.
    if (blockEntity && blockEntity.type === "celebrity_default") {
      void logJob({ projectId, jobId: mediaJobId }, "match.image_block_celebrity_default", {
        blockIndex: blockIdx, name: blockEntity.name || mainCelebrity || null,
      });
      refImagesShortCircuited++;
      const personPick = await tryPersonImageFallback(blockIdx);
      if (personPick) {
        refUrlSet.add(personPick.url);
        imageUrlLastUsedAt.set(personPick.url, blockStartSec[blockIdx]);
        item.image_url = personPick.url;
        item.image_query = personPick.query;
        item.image_source = personPick.source;
        const meta = (item.metadata ?? {}) as Record<string, unknown>;
        meta.image_query_used = personPick.query;
        meta.image_source_url = personPick.url;
        meta.image_source_provider = personPick.source;
        meta.image_entity = personPick.query;
        meta.image_reason = "celebrity_default_short_circuit";
        meta.image_pick_source = "person_fallback";
        item.metadata = meta;
        item.image_entity_type = "celebrity_default";
        item.image_entity_name = mainCelebrity ?? null;
        item.image_verified = "yes";
      }
      continue;
    }

    // Hybrid secondary-person policy. When the block's resolved subject is
    // a NAMED PERSON who is NOT the project celebrity, and we have a
    // Wikipedia reference image for them in face_references, fill the
    // block with that reference image and skip the entire fetch path.
    // This is the matcher half of the analyze-route policy that already
    // suppressed YouTube searches for short-mention secondary characters
    // (analyze.intent.skipped_for_photo_path). For runs >= 4 the analyze
    // route did fetch clips; this code path still runs because:
    //   (a) the picker UI shows the Wikipedia photo as a fallback option,
    //   (b) on a 1-block run we never search and the photo is the only
    //       way to render the block.
    // The check is intentionally narrow: subject_type must be "person",
    // resolved_subject must be a non-celebrity name, and the reference
    // lookup must succeed. Anything else falls through to the existing
    // reference-driven fetch (which already handles celebrity blocks via
    // the entity pool / person-floor pre-fetch).
    if (
      subjectType === "person" &&
      resolvedSubject &&
      mainCelebrity &&
      resolvedSubject.trim().toLowerCase() !== mainCelebrity.trim().toLowerCase()
    ) {
      // Phase 2b: per-secondary photo cache. Before falling back to the
      // single Wikipedia portrait, try the secondary's own photo pool
      // (sized by their narrative weight = max consecutive run OR total
      // footprint, whichever is larger). For Cowell with maxRun=8 this yields
      // ~30 verified Cowell photos; for a scattered co-lead like Camilla
      // (low run, high total) it still yields a real pool instead of one
      // repeated headshot. For true one-off mentions the target is 0 → cache
      // returns [] → caller falls through to the Wikipedia portrait as before.
      const personLower = resolvedSubject.trim().toLowerCase();
      const runInfo = secondaryPersonRuns.get(personLower) ?? { maxRun: 1, totalBlocks: 1 };
      const maxRun = runInfo.maxRun;
      const target = secondaryPhotoTargetForRun(runInfo);
      if (target > 0) {
        try {
          const cache = await buildPersonPhotoCache(resolvedSubject, target);
          if (cache.length > 0) {
            const nowSec = blockStartSec[blockIdx];
            // Three-tier pick mirroring tryPersonImageFallback. We prefer
            // fresh + uncooled, then fresh + ignoring cooldown, then
            // longest-since-used.
            let bestA: PersonPhotoCacheEntry | null = null;
            let bestB: PersonPhotoCacheEntry | null = null;
            let bestBDistance = -Infinity;
            for (const f of cache) {
              if (refUrlSet.has(f.url)) continue;
              const last = imageUrlLastUsedAt.get(f.url);
              if (last === undefined) { bestA = f; break; }
              const dist = nowSec - last;
              if (dist >= IMAGE_REUSE_COOLDOWN_SEC) { bestA = f; break; }
              if (dist > bestBDistance) { bestB = f; bestBDistance = dist; }
            }
            let pick = bestA ?? bestB;
            if (!pick) {
              let bestC: PersonPhotoCacheEntry | null = null;
              let bestCDistance = -Infinity;
              for (const f of cache) {
                const last = imageUrlLastUsedAt.get(f.url);
                const dist = last === undefined ? Infinity : nowSec - last;
                if (dist > bestCDistance) { bestCDistance = dist; bestC = f; }
              }
              pick = bestC;
            }
            if (pick) {
              refUrlSet.add(pick.url);
              imageUrlLastUsedAt.set(pick.url, nowSec);
              item.image_url = pick.url;
              item.image_source = pick.source;
              item.image_query = pick.query;
              const meta = (item.metadata ?? {}) as Record<string, unknown>;
              meta.image_query_used = pick.query;
              meta.image_source_url = pick.url;
              meta.image_source_provider = pick.source;
              meta.image_entity = resolvedSubject;
              meta.image_reason = "secondary_person_pool";
              meta.image_pick_source = "secondary_person_pool";
              item.metadata = meta;
              item.image_entity_type = "person";
              item.image_entity_name = resolvedSubject;
              item.image_verified = "yes";
              void logJob({ projectId, jobId: mediaJobId }, "match.secondary_person_pool", {
                blockIndex: blockIdx, person: resolvedSubject,
                cacheSize: cache.length, maxRun,
              });
              continue;
            }
          }
        } catch (e) {
          // Cache build failure is non-fatal — fall through to the
          // Wikipedia portrait path below so the block still gets a visual.
          void logJob({ projectId, jobId: mediaJobId }, "match.secondary_person_pool.failed", {
            blockIndex: blockIdx, person: resolvedSubject,
            err: (e as Error).message?.slice(0, 120),
          });
        }
      }

      // Wikipedia portrait fallback. Used when:
      //   - maxRun=1 (we don't build a cache for one-off mentions)
      //   - cache build returned 0 verified photos
      //   - all cache photos already consumed by refUrlSet (rare)
      try {
        // Resolve the roster name FIRST — looking up the bare subject
        // ("Catherine") directly is how a poisoned bare-name reference row
        // (the Wikipedia given-name article whose photo is Katherine Heigl,
        // not the princess) shipped straight into approved blocks stamped
        // image_verified:"yes". The resolver prefers the longest, most
        // specific roster row ("Catherine, Princess of Wales").
        const refName = await resolvePersonVerifyName(resolvedSubject);
        const ref = await lookupReference(projectId, "person", refName);
        if (ref?.reference_url) {
          item.image_url = ref.reference_url;
          item.image_source = "wikipedia";
          item.image_query = `face_reference:${refName}`;
          const meta = (item.metadata ?? {}) as Record<string, unknown>;
          meta.image_query_used = `face_reference:${refName}`;
          meta.image_source_url = ref.reference_url;
          meta.image_source_provider = "wikipedia";
          meta.image_entity = resolvedSubject;
          meta.image_reason = "secondary_person_photo";
          meta.image_pick_source = "secondary_person_photo";
          item.metadata = meta;
          // Stamp closed-world verification metadata. The reference image
          // IS the canonical — no Gemini gate needed.
          item.image_entity_type = "person";
          item.image_entity_name = resolvedSubject;
          item.image_verified = "yes";
          void logJob({ projectId, jobId: mediaJobId }, "match.secondary_person_photo", {
            blockIndex: blockIdx, person: resolvedSubject,
          });
          // Block filled — skip the rest of the per-block fetch path.
          continue;
        }
      } catch (e) {
        // Lookup failure (DB hiccup, etc.) — fall through to the legacy
        // fetch path. The matcher's existing fallback chain will still
        // produce a visual.
        void logJob({ projectId, jobId: mediaJobId }, "match.secondary_person_photo.lookup_failed", {
          blockIndex: blockIdx, person: resolvedSubject,
          err: (e as Error).message?.slice(0, 120),
        });
      }
    }

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
    // CELEBRITY-ONLY image mode: per-block image queries are forced to the main
    // celebrity. We drop the script-phrase queries (which surface buildings /
    // places / logos from capitalized phrases like "London Palladium") and the
    // entity ref queries, so a block can only ever fetch a celebrity image. If
    // there's no celebrity (shouldn't happen for these projects), fall back to
    // the original queries rather than leaving the block with none.
    const queries = getEnv().IMAGE_CELEBRITY_ONLY
      ? (mainCelebrity
          ? [{ query: mainCelebrity, reason: `celebrity_only:${mainCelebrity}`, imgType: "photo" as const }]
          : [...refQueries, ...scriptQueries])
      : [...refQueries, ...scriptQueries];
    const nowSec = blockStartSec[blockIdx];
    // Accumulate every candidate URL we considered across all queries for
    // this block. Persisted to metadata.image_candidates so the editor's
    // Replace Media panel can offer alternatives, not just the single chosen
    // image. Cap at CANDIDATE_RECORD_CAP to keep the timeline_items row
    // size reasonable (each entry is ~3 short strings).
    const CANDIDATE_RECORD_CAP = 20;
    const seenCandidateUrls = new Set<string>();
    const consideredCandidates: Array<{ url: string; source: string; query: string }> = [];
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
        // Record every candidate this query produced (before verification
        // runs) so the editor's Replace Media panel can offer alternatives.
        // We skip URLs we've already recorded for this block; we DO include
        // URLs that fail entity / script verification below, because once a
        // human reviewer is in the loop they can decide for themselves. We
        // tag the loser candidates so the UI can de-prioritise them.
        for (const f of fetched) {
          if (seenCandidateUrls.has(f.url)) continue;
          if (consideredCandidates.length >= CANDIDATE_RECORD_CAP) break;
          seenCandidateUrls.add(f.url);
          consideredCandidates.push({ url: f.url, source: f.source, query: q.query });
        }
        // Slice 5: per-block verification gate. Map the block's subject_type
        // to a closed-world BlockEntityType and ask Gemini whether each
        // fetched image actually depicts the entity Gemini named. This
        // catches the "UK map for 'United Kingdom'", "PRIVATE—KEEP OUT
        // sign for 'private'", "What is LOGO graphic for 'Guardian logo'"
        // failure mode at the source: bad images never reach item.image_url.
        // Routes only the matchable types; subject_type "general" / unknown
        // skips the gate (those queries don't have a clean entity binding).
        // Closed-world wins when present — block_entity.type is the
        // analyze-side authoritative binding. Fall back to subject_type
        // routing for legacy blocks that predate block_entity.
        // CELEBRITY-ONLY mode: the query was forced to the celebrity above, so
        // the verify gate must check against the celebrity (person), NOT the
        // block's original entity (e.g. a place) — otherwise a correct
        // celebrity image gets rejected for "not being London Palladium".
        const celebOnly = getEnv().IMAGE_CELEBRITY_ONLY && !!mainCelebrity;
        const verifyType: BlockEntityType | null =
          celebOnly ? "person" :
          blockEntity && blockEntity.type !== "celebrity_default" ? blockEntity.type :
          subjectType === "person" ? "person" :
          subjectType === "company" ? "company" :
          subjectType === "show" ? "tv_show" :
          subjectType === "movie" ? "movie" :
          subjectType === "place" ? "place" :
          null;
        // Use the closed-world entity NAME (Gemini's verbatim proper
        // noun) instead of the first ref/ent — refs[0] often contains
        // common nouns like "transcript", "announcement", "private"
        // which produce pages of nonsensical Gemini verify rejections
        // (`entity_type: "company", entity_name: "transcript"`).
        const rawVerifyName = celebOnly ? mainCelebrity! : (blockEntity?.name || refs[0] || ents[0] || "").trim();
        // For PEOPLE, resolve to the roster name the reference photo is
        // actually filed under. Block entities are often bare first names
        // ("Catherine"); verifying against the bare-name row risks the
        // poisoned given-name reference (see resolvePersonVerifyName).
        const verifyName = verifyType === "person" && rawVerifyName
          ? await resolvePersonVerifyName(rawVerifyName)
          : rawVerifyName;
        // Take the first non-duplicate, verification-passing image. The
        // verification call runs inside the find predicate so we stop at
        // the first acceptable URL instead of paying for every candidate
        // in fetched[] — matters because each verify call hits Gemini.
        //
        // Two-stage verification per candidate:
        //   1. Entity gate (verifyPoolAsset) when the block resolves to a
        //      concrete entity — "is this a real photo of <London Palladium>?"
        //   2. Script gate (verifyImageMatchesScript) ALWAYS, when we have a
        //      project topic — "would a viewer of <topic> find this image
        //      on-topic for this narration?" Stage 2 catches the failure
        //      mode where Stage 1 was skipped (block_entity is celebrity_
        //      default / general) and a literal-phrase search ("The
        //      Statement") returned an image matching the words but in the
        //      wrong world entirely.
        let pick: (typeof fetched)[number] | undefined;
        // The original publisher URL of the chosen candidate, captured before
        // the in-loop rehost mutates f.url to the R2 URL. Used as the de-dup /
        // reuse-cooldown key so it matches the source URLs the next block
        // compares against. See the rehost block below for the full rationale.
        let pickSourceUrl = "";
        for (const f of fetched) {
          if (refUrlSet.has(f.url)) continue;
          const last = imageUrlLastUsedAt.get(f.url);
          if (last !== undefined && nowSec - last < IMAGE_REUSE_COOLDOWN_SEC) continue;
          if (verifyType && verifyName) {
            // Retry-aware verify: a Gemini 503 gets backoff retries (bounded
            // by the shared per-job budget) before this candidate is given up
            // on. A still-errored result is logged as UNAVAILABLE, not
            // "rejected" — nobody ever looked at the image, and during the
            // 2026-06 outage these fake rejections were what collapsed whole
            // jobs to celebrity_default fallback (refImagesFailed:188).
            const verdict = await verifyPoolAssetWithRetry({
              projectId,
              entityType: verifyType,
              entityName: verifyName,
              candidateUrl: f.url,
              // Only confirmed photos of a PERSON pass — client requires the
              // correct celebrity only. Non-person entities keep default policy.
            }, verifyType === "person" ? { requireConfirmed: true } : {});
            if (!verdict.accept) {
              void logJob({ projectId, jobId: mediaJobId },
                verdict.errored ? "match.image_block_verify.unavailable" : "match.image_block_verify.rejected", {
                blockIndex: blockIdx, entity_type: verifyType, entity_name: verifyName,
                url: f.url, verdict: verdict.verdict, reason: verdict.reason.slice(0, 120),
              });
              continue;
            }
          }
          // Script-aware gate. Runs on every pick when we have a topic and
          // script text — fail-open on Gemini errors (thrown exceptions
          // keep the candidate) so we don't gut the pool on rate-limit
          // blips. Only "yes" passes; both "no" and "uncertain" reject.
          // We tightened from "no-only" because the symptom was an image
          // matching a literal common noun in the script ("Conversation"
          // → 1974 Coppola poster) that Gemini judged "uncertain" — those
          // never belong on a celebrity documentary, so we'd rather lose
          // the rare edge case and fall through to the person fallback.
          if (projectTopic && scriptText) {
            try {
              const scriptVerdict = await verifyImageMatchesScript({
                candidateUrl: f.url,
                topic: projectTopic,
                scriptText,
              });
              // Infra failure (errored) fails OPEN — same policy as the
              // thrown-exception path below. The script gate is a topical
              // filter; identity was already enforced by the entity gate
              // above, so an unjudged candidate is kept rather than lost
              // to a 503 blip.
              if (!scriptVerdict.errored && scriptVerdict.verdict !== "yes") {
                void logJob({ projectId, jobId: mediaJobId }, "match.image_block_script_verify.rejected", {
                  blockIndex: blockIdx, topic: projectTopic,
                  url: f.url, verdict: scriptVerdict.verdict,
                  reason: scriptVerdict.reason.slice(0, 120),
                  query: q.query,
                });
                continue;
              }
            } catch {
              // verify outage — keep the candidate.
            }
          }
          // Re-host the accepted image onto our R2 CDN before committing it.
          // This is the chokepoint that guarantees every timeline image lives
          // on our own CDN — so it loads in the editor AND renders in the final
          // video. Publisher CDNs that block server fetches (people.com etc.)
          // return null here; we reject the candidate and keep looking, exactly
          // like a failed verification gate, rather than committing an image
          // that would 403 in both the editor and the render.
          //
          // IMPORTANT: we keep the ORIGINAL publisher URL as `pickSourceUrl`
          // and rehost into a SEPARATE field. The de-dup / reuse-cooldown maps
          // (refUrlSet, imageUrlLastUsedAt) MUST be keyed on the source URL —
          // that's the identity the next block's `fetched[]` candidates are
          // compared against. Every OTHER assignment path (person-fallback,
          // secondary-person, entity-pool) keys on the source URL too; the
          // final rehost sweep converts item.image_url to R2 at the end. The
          // old code keyed these maps on the rehosted R2 URL, so the check
          // `refUrlSet.has(f.url)` (a publisher URL) never matched and the
          // reuse-cooldown was silently dead — the top-ranked result for an
          // identical query (e.g. celebrity-only "Prince William") was picked
          // for EVERY block, reappearing dozens of times instead of rotating
          // through the pool. Keying on the source URL revives the spacing.
          pickSourceUrl = f.url;
          {
            const rehosted = await rehostImageToR2(f.url, projectId);
            if (!rehosted) {
              void logJob({ projectId, jobId: mediaJobId }, "match.image_block_rehost.failed", {
                blockIndex: blockIdx, url: f.url, query: q.query,
              });
              continue;
            }
            f.url = rehosted;
          }
          pick = f;
          break;
        }
        if (!pick) continue;
        // De-dup/cooldown keyed on the SOURCE url (see note above), display
        // url committed as the rehosted R2 url.
        refUrlSet.add(pickSourceUrl);
        imageUrlLastUsedAt.set(pickSourceUrl, nowSec);
        item.image_url = pick.url;
        item.image_query = q.query;
        item.image_source = pick.source;
        const meta = (item.metadata ?? {}) as Record<string, unknown>;
        meta.image_query_used = q.query;
        meta.image_source_url = pick.url;
        meta.image_source_provider = pick.source;
        meta.image_entity = verifyName || refs[0] || ents[0] || null;
        meta.image_reason = q.reason;
        meta.image_pick_source = q.reason.startsWith("script_phrase:") ? "script_phrase" : "reference_driven";
        // Persist the considered-candidates list for the editor's pool. We
        // also include the chosen URL in this list (defensive — the loop
        // recorded it above when we saw it in `fetched`, but a future change
        // could break that ordering). De-dupe is handled by seenCandidateUrls.
        meta.image_candidates = consideredCandidates;
        item.metadata = meta;
        // Slice 4b: stamp the verification metadata onto the timeline_item
        // so the Replace Media UI (Slice 7) can show which entity this
        // image was bound to and which verdict the gate returned.
        if (verifyType) {
          item.image_entity_type = verifyType;
          item.image_entity_name = verifyName;
          item.image_verified = "yes";
        } else {
          item.image_entity_type = "celebrity_default";
          item.image_entity_name = mainCelebrity ?? null;
          item.image_verified = "skipped";
        }
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
        // Person-fallback path: include the person-pool URL on the pick at
        // position 0 plus the reference-stage considered candidates (which
        // didn't pass) so the editor can offer them as user-overridable
        // swaps. The reference candidates won't be auto-picked, but a human
        // can choose differently — that's the point of the Replace panel.
        const fallbackCandidates = [
          { url: personPick.url, source: personPick.source, query: personPick.query },
          ...consideredCandidates.filter((c) => c.url !== personPick.url),
        ].slice(0, CANDIDATE_RECORD_CAP);
        meta.image_candidates = fallbackCandidates;
        item.metadata = meta;
      } else if (consideredCandidates.length > 0) {
        // No fallback either, but we still considered candidates — surface
        // them so the user has SOMETHING to pick from in the editor.
        const meta = (item.metadata ?? {}) as Record<string, unknown>;
        meta.image_candidates = consideredCandidates;
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
    refImagesShortCircuited,
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
  // dedup + anti-clustering steps downstream keep variety high. Tunable via
  // IMAGES_PER_ENTITY (default 12).
  const IMAGES_PER_ENTITY = getEnv().IMAGES_PER_ENTITY;

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
      !(e.type === "place" && isGenericPlace(e.value)) &&
      // CELEBRITY-ONLY image mode: drop every non-celebrity entity so the
      // image pool never fetches buildings / places / company or show logos /
      // posters / related people. The main celebrity's images come from the
      // person-floor prefetch; blocks about non-person entities fall back to
      // celebrity footage instead of an off-person image. Client requirement.
      (!getEnv().IMAGE_CELEBRITY_ONLY || e.type === "celebrity")
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
  // Scale the celebrity-image floor by voiceover duration, not just by
  // image-block count. A 10-min video has roughly 2× the image blocks of
  // a 5-min one BUT the SAME pool size under the old formula because the
  // cap was `min(imageBlockCount, ...)`. The cooldown (120s) means a tiny
  // pool produces visible repetition on longer videos. Sized so a 5-min
  // video gets ~30 unique celebrity images and a 10-min video gets ~60 —
  // enough that no single image needs to appear more than 2× under the
  // cooldown rule.
  //
  // Floor formula: max(imageBlockCount × 1.0, voiceoverSeconds / 10).
  // The first term gives at least one unique image per block for short
  // videos; the second scales with duration for long ones.
  const personFloor = mainCelebrity
    ? Math.max(
        imageBlockCount,
        Math.ceil(voiceoverSeconds / 10),
      )
    : 0;
  poolFetchStats.personFloorTarget = personFloor;
  if (mainCelebrity && personFloor > 0) {
    // Query variants in priority order. The bare quoted name runs first
    // because it returns the highest-precision results; diversified queries
    // run after to add facet variety (interview, premiere, BAFTAs, etc.).
    // Each query is one HTTP round-trip + N×Gemini-verify calls; we break
    // out of the loop as soon as `pool.length >= personFloor` so we only
    // pay for queries we actually need.
    //
    // Expanded from 10 → 20 facets to compensate for the verify gate's
    // strict mode (rejectUncertain). Strict mode drops ~30% more candidates
    // than the lenient policy because side-angles, group shots, and small-
    // face press photos return "uncertain" — those used to pass and now
    // don't. Doubling the query count keeps the pool floor reachable for
    // a 10-min video while every kept image is a clearly-identified
    // headshot or portrait of the celebrity.
    //
    // The facet list mixes MODERN press-circuit terms (red carpet, premiere,
    // BAFTA, recent years) with ARCHIVAL terms (vintage, old photo, decade
    // anchors, career framing). Modern terms return almost nothing for an
    // older / deceased / pre-internet actor, while archival terms return
    // almost nothing for a contemporary star — so we ship both and let the
    // dead queries fall through cheaply (each is skipped once the floor is
    // reached). This is the lever for the "same image repeats" symptom on
    // vintage subjects: more DISTINCT surfacing angles → a larger unique
    // pool → less Tier-3 reuse downstream.
    const celebrityQueries: string[] = [
      `"${mainCelebrity}"`,
      `${mainCelebrity} interview`,
      `${mainCelebrity} portrait`,
      `${mainCelebrity} headshot`,
      `${mainCelebrity} photo`,
      `${mainCelebrity} smiling`,
      `${mainCelebrity} close up`,
      `${mainCelebrity} face`,
      // Career / role framing — works for any era; surfaces publicity stills
      // and on-set photos distinct from the press-circuit shots above.
      `${mainCelebrity} actor`,
      `${mainCelebrity} young`,
      `${mainCelebrity} old`,
      `${mainCelebrity} career`,
      `${mainCelebrity} movie still`,
      `${mainCelebrity} publicity photo`,
      `${mainCelebrity} headshot black and white`,
      // Archival / vintage anchors — the high-yield facets for older actors
      // (Western, classic-Hollywood, pre-internet) whose press archive is
      // black-and-white studio stills and decade-tagged photos rather than
      // red-carpet shots.
      `${mainCelebrity} vintage`,
      `${mainCelebrity} 1950s`,
      `${mainCelebrity} 1960s`,
      `${mainCelebrity} 1970s`,
      `${mainCelebrity} 1980s`,
      // Modern press-circuit anchors — high-yield for contemporary subjects,
      // cheaply dead for vintage ones.
      `${mainCelebrity} red carpet`,
      `${mainCelebrity} premiere`,
      `${mainCelebrity} event`,
      `${mainCelebrity} award`,
      `${mainCelebrity} 2023`,
      `${mainCelebrity} 2022`,
    ];
    // Face-verify rejection counter so we can see how many fetched URLs
    // didn't survive the gate. High rejection rate means CSE is returning
    // press shots with the wrong primary subject (e.g. red-carpet photos
    // where the celebrity is in the background and the foreground person
    // dominates the frame — the "woman in yellow" failure mode).
    let personPoolVerifyRejected = 0;
    // Candidates whose verification ERRORED (Gemini 503 / fetch timeout) —
    // parked for bounded retry rounds after the query loop. Never accepted
    // unverified, never counted as a rejection: during the 2026-06 outage
    // these fake "uncertain" rejections gutted the entire pool.
    const poolParked: Array<{ url: string; source: string; query: string }> = [];
    // Face-verify candidates in BATCHED Gemini calls (up to 8 per call, the
    // celebrity reference uploaded once per call instead of once per
    // candidate). This was the dominant cost of the match step on image-
    // heavy projects. Survivors are appended in the original fetch order so
    // the pool stays deterministic.
    //
    // STRICT mode (requireConfirmed): only images Gemini POSITIVELY
    // confirms are the celebrity enter the pool — "uncertain", "no", and
    // "skipped" (no reference) are all rejected. Per the client's "only
    // the correct celebrity image" requirement, an unverifiable image
    // must never ship as the celebrity.
    const verifyIntoPool = async (
      cands: Array<{ url: string; source: string; query: string }>,
    ): Promise<void> => {
      if (cands.length === 0) return;
      const verdicts = await verifyPoolAssetsBatch(
        cands.map((f) => ({
          projectId,
          entityType: "person" as const,
          entityName: mainCelebrity,
          candidateUrl: f.url,
        })),
        { requireConfirmed: true },
      );
      verdicts.forEach((v, k) => {
        const f = cands[k];
        if (v.errored) { poolParked.push(f); return; }
        if (!v.accept) {
          personPoolVerifyRejected++;
          void logJob({ projectId, jobId: mediaJobId }, "match.person_pool.verify_rejected", {
            query: f.query, url: f.url,
            verdict: v.verdict, reason: v.reason.slice(0, 120),
          });
          return;
        }
        if (pool.length >= personFloor) return;
        pool.push({ url: f.url, source: f.source, query: f.query, entityType: "celebrity" });
        poolFetchStats.personImagesPrefetched++;
      });
    };

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
        // Dedup-and-reserve each unique URL into poolUrlSet up front so the
        // verify batch below never double-verifies the same image (and the
        // same URL appearing twice in fetched[] is collapsed).
        const personCandidates = fetched.filter((f) => {
          if (poolUrlSet.has(f.url)) return false;
          poolUrlSet.add(f.url);
          return true;
        });
        await verifyIntoPool(personCandidates.map((f) => ({ url: f.url, source: f.source, query: cq })));
      } catch (e) {
        poolFetchStats.entitiesFailed++;
        void logJob({ projectId, jobId: mediaJobId },
          "match.image_fetch.failed", { query: cq, personFloor: true, err: (e as Error).message });
      }
    }

    // Parked-retry rounds: re-verify everything that errored once the 503
    // spike has had time to pass. Re-erroring entries land back in
    // poolParked for the next round; whatever still errors after the final
    // round is dropped (the circuit breaker judges the run overall).
    for (const delayMs of [20_000, 40_000]) {
      if (pool.length >= personFloor || poolParked.length === 0) break;
      await new Promise((r) => setTimeout(r, delayMs));
      const retry = poolParked.splice(0, poolParked.length);
      void logJob({ projectId, jobId: mediaJobId }, "match.person_pool.retry_parked", {
        parked: retry.length, have: pool.length, target: personFloor,
      });
      await verifyIntoPool(retry);
    }
    if (personPoolVerifyRejected > 0 || poolParked.length > 0) {
      void logJob({ projectId, jobId: mediaJobId }, "match.person_pool.verify_summary", {
        celebrity: mainCelebrity,
        rejected: personPoolVerifyRejected,
        kept: poolFetchStats.personImagesPrefetched,
        unverifiedDropped: poolParked.length,
      });
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
      // Slice 5: closed-world verification gate. For each fetched image we
      // ask Gemini "is this actually a {logo|poster|cover|place photo} of
      // {entityName}?" via verifyPoolAsset. Rejected images never enter the
      // pool. Mapping to BlockEntityType is lossy (topic/year/event don't
      // map) — those legacy types fall through with mapped=null and the gate
      // is skipped, preserving prior behavior for entity classes we can't
      // verify.
      const mapped = legacyEntityToBlockEntityType(ent.type);
      for (const f of fetched) {
        if (poolUrlSet.has(f.url)) continue;          // dedupe across entities
        if (mapped && mapped !== "celebrity_default") {
          const verdict = await verifyPoolAssetWithRetry({
            projectId,
            entityType: mapped,
            entityName: ent.value,
            candidateUrl: f.url,
            // Strict confirmation for PEOPLE — the client requires only the
            // correct celebrity/person to appear. Non-person entities (logos,
            // places, shows) stay on the default policy since their verify path
            // has no reference photo and would over-reject.
          }, mapped === "person" ? { requireConfirmed: true } : {});
          if (!verdict.accept) {
            void logJob({ projectId, jobId: mediaJobId },
              verdict.errored ? "match.image_verify.unavailable" : "match.image_verify.rejected", {
              entity_type: mapped, entity_name: ent.value, url: f.url,
              verdict: verdict.verdict, reason: verdict.reason.slice(0, 120),
            });
            continue;
          }
        } else if (mapped === "celebrity_default") {
          // The project celebrity's OWN pool. Image search for "Katherine
          // Heigl" can return a MISLABELLED photo of a different woman; the
          // pool builder isolating the query does not guarantee the photo is
          // actually her. Face-gate every candidate against the celebrity
          // reference so only the correct person enters — same hard rule as a
          // named secondary person.
          const gate = await gatePersonImage({ projectId, personName: mainCelebrity, candidateUrl: f.url });
          if (!gate.accept) {
            void logJob({ projectId, jobId: mediaJobId }, "match.image_verify.rejected", {
              entity_type: "celebrity_default", entity_name: mainCelebrity, url: f.url,
              verdict: gate.verdict, reason: gate.reason.slice(0, 120),
            });
            continue;
          }
        }
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
        // Slice 5: same verification gate as the strict pass. The relaxed
        // pass widens the query (drops modifiers/quotes) so it's MORE likely
        // to surface off-topic stock results — gating here is what stops
        // "Republican states" / "What is LOGO" graphics from ever entering
        // the pool.
        const mappedRelaxed = legacyEntityToBlockEntityType(ent.type);
        for (const f of fetched) {
          if (poolUrlSet.has(f.url)) continue;
          if (mappedRelaxed && mappedRelaxed !== "celebrity_default") {
            const verdict = await verifyPoolAssetWithRetry({
              projectId,
              entityType: mappedRelaxed,
              entityName: ent.value,
              candidateUrl: f.url,
              // requireConfirmed for PEOPLE here too — the relaxed pass widens
              // the query and is MORE likely to surface a similar-looking wrong
              // person, so an "uncertain" person image must NOT pass.
            }, mappedRelaxed === "person" ? { requireConfirmed: true } : {});
            if (!verdict.accept) {
              void logJob({ projectId, jobId: mediaJobId },
                verdict.errored ? "match.image_verify.unavailable" : "match.image_verify.rejected", {
                entity_type: mappedRelaxed, entity_name: ent.value, url: f.url,
                verdict: verdict.verdict, reason: verdict.reason.slice(0, 120),
                relaxed: true,
              });
              continue;
            }
          } else if (mappedRelaxed === "celebrity_default") {
            // Celebrity's own pool, relaxed pass — same hard face-gate as the
            // strict pass. The relaxed query is even more likely to surface a
            // mislabelled photo of the wrong person.
            const gate = await gatePersonImage({ projectId, personName: mainCelebrity, candidateUrl: f.url });
            if (!gate.accept) {
              void logJob({ projectId, jobId: mediaJobId }, "match.image_verify.rejected", {
                entity_type: "celebrity_default", entity_name: mainCelebrity, url: f.url,
                verdict: gate.verdict, reason: gate.reason.slice(0, 120),
                relaxed: true,
              });
              continue;
            }
          }
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
    // Slice 4b: stamp closed-world verification metadata. Pool entries from
    // the celebrity floor / final fallback get celebrity_default; everything
    // else inherits its mapped BlockEntityType (verified at insert time in
    // the pool builder above). Skipped entries fall through with "skipped".
    const mappedPoolType = legacyEntityToBlockEntityType(next.entityType);
    if (mappedPoolType === "celebrity_default" || next.entityType === "celebrity") {
      item.image_entity_type = "celebrity_default";
      item.image_entity_name = mainCelebrity ?? null;
      item.image_verified = "skipped";
    } else if (mappedPoolType) {
      item.image_entity_type = mappedPoolType;
      item.image_entity_name = next.query;
      item.image_verified = "yes";
    } else {
      item.image_entity_type = null;
      item.image_entity_name = null;
      item.image_verified = "skipped";
    }
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

  // ---- Empty-image → footage downgrade ---------------------------------
  // After the entity pool + person fallback have run, any remaining image
  // block whose image_url is still null would render as an empty tile in
  // the editor and a black hole in the final MP4. Per the user's spec
  // ("never empty visuals"), convert each such block to footage using
  // the unused-clip pool. We honor the no-adjacent-same-source rule by
  // routing through pickFillerForBlock (already enforces it). When the
  // clip pool is empty too, the block stays as image — the renderer's
  // black-background fallback then masks the missing url. This is the
  // last-resort case the renderer was always able to handle; we just
  // prefer footage when one exists.
  // Shared "never leave a block empty" fill ladder, tried in order until the
  // block has a visual:
  //   1. FRESH clip             — pickFillerForBlock (unused-only)
  //   2. REUSED celebrity image — tryPersonImageFallback (re-shows a person
  //                               photo; its Tier C repeats one if needed)
  //   3. REUSED clip            — pickReuseClipForBlock (already-placed clip,
  //                               spread by the reuse cooldown)
  // Returns the outcome so callers can tally it; returns "blank" only when ALL
  // of the above are exhausted, in which case the render-side filler holds the
  // slot so timing never desyncs. Reuse is explicitly allowed by the spec; the
  // reuse pickers enforce the cooldown / spread rules.
  //
  // This is shared by BOTH the empty-image pass below AND the split-downgrade
  // branch (resolveSplitSide's caller). That matters: the split pass runs
  // AFTER this point, so a split block that resolves to nothing there has no
  // later pass to catch it — it must run the ladder itself. (That ordering gap
  // is exactly how abstract split blocks reached render empty before.)
  async function fillEmptyBlock(
    item: typeof items[number],
    blockIdx: number,
    downgradedFrom: string,
  ): Promise<"fresh_clip" | "reused_image" | "reused_clip" | "blank"> {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;

    const filler = pickFillerForBlock(blockIdx);
    if (filler && !usedClipIds.has(filler.clipId)) {
      item.type = "footage";
      item.clip_id = filler.clipId;
      item.image_url = null;
      usedClipIds.add(filler.clipId);
      clipLastUsedAt.set(filler.clipId, blockStartSec[blockIdx]);
      meta.downgraded_from = downgradedFrom;
      meta.downgrade_reason = "no image resolved; fresh clip";
      meta.pick_source = "image_downgrade_to_footage";
      item.metadata = meta;
      return "fresh_clip";
    }

    // Reused celebrity image — preferred over a reused clip per the spec's
    // "fallback to the PERSON image" direction.
    const personPick = await tryPersonImageFallback(blockIdx);
    if (personPick) {
      item.type = "image";
      item.clip_id = null;
      item.image_url = personPick.url;
      item.image_query = personPick.query;
      item.image_source = personPick.source;
      refUrlSet.add(personPick.url);
      imageUrlLastUsedAt.set(personPick.url, blockStartSec[blockIdx]);
      meta.downgraded_from = downgradedFrom;
      meta.image_query_used = personPick.query;
      meta.image_source_url = personPick.url;
      meta.image_source_provider = personPick.source;
      meta.image_reason = "empty_block_reused_person_image";
      meta.image_pick_source = "person_fallback_reuse";
      item.metadata = meta;
      return "reused_image";
    }

    // Reused clip (already placed elsewhere, spread by the cooldown). Do NOT
    // add to usedClipIds — that set is the used-once gate; reuse only updates
    // the cooldown clock.
    const reuse = pickReuseClipForBlock(blockIdx);
    if (reuse) {
      item.type = "footage";
      item.clip_id = reuse.clipId;
      item.image_url = null;
      clipLastUsedAt.set(reuse.clipId, blockStartSec[blockIdx]);
      meta.downgraded_from = downgradedFrom;
      meta.downgrade_reason = "no image + no fresh clip; reused a prior clip";
      meta.pick_source = "image_downgrade_to_reused_footage";
      item.metadata = meta;
      return "reused_clip";
    }

    return "blank";
  }

  let emptyImageDowngradedCount = 0;
  let emptyImageReusedImageCount = 0;
  let emptyImageReusedClipCount = 0;
  let emptyImageStillBlankCount = 0;
  for (const item of items) {
    if (item.type !== "image") continue;
    if (item.image_url && String(item.image_url).trim().length > 0) continue;
    const blockIdx = (item.metadata as Record<string, unknown> | undefined)?.block_index as number | undefined;
    if (blockIdx == null) continue;
    const outcome = await fillEmptyBlock(item, blockIdx, "image_no_url");
    if (outcome === "fresh_clip") emptyImageDowngradedCount++;
    else if (outcome === "reused_image") emptyImageReusedImageCount++;
    else if (outcome === "reused_clip") emptyImageReusedClipCount++;
    else emptyImageStillBlankCount++;
  }
  await logJob({ projectId, jobId: mediaJobId }, "match.empty_image_downgrade", {
    downgraded: emptyImageDowngradedCount,
    reusedImage: emptyImageReusedImageCount,
    reusedClip: emptyImageReusedClipCount,
    stillBlank: emptyImageStillBlankCount,
  });

  // ---- Split-screen image fill -----------------------------------------
  // Walk split_2 blocks (cap-survivors from earlier in this function) and
  // resolve a LEFT and RIGHT image for each. Strategy per side:
  //   1) Try the corresponding mentioned_entity via the same reference
  //      query builder used for ordinary image blocks.
  //   2) On miss, fall back to the PERSON image (project celebrity).
  //
  // The old pool-fallback path was removed: it pasted ANY pool image onto
  // a split half regardless of script relevance, which produced literal
  // "Sun" photos for narration about The Sun newspaper, brand logos for
  // unrelated narration, etc. Per spec "If an exact image/visual cannot
  // be found → fallback to the person image. NEVER use random unrelated
  // visuals." — split halves now follow the same rule.
  let splitsAssigned = 0;
  let splitsLeftFailed = 0;
  let splitsRightFailed = 0;
  // Track which URLs we've used for split halves so we don't pick the
  // same URL for left and right of the same block, and so a later split
  // doesn't immediately repeat the same pair.
  const splitUsedUrls = new Set<string>();
  async function resolveSplitSide(
    entity: string | null,
    blockIdx: number,
    nowSec: number,
    forbiddenUrls: Set<string>,
  ): Promise<{ url: string; query: string; source: string; reason: string } | null> {
    // Tier 1 — try the entity as a literal query. Skip when Gemini didn't
    // name an entity for this side. Each candidate is Gemini-verified
    // against the entity name BEFORE acceptance — without this, a query
    // like "The Sun" (a newspaper) returned photos of our solar system's
    // sun, which the gate now rejects so we fall through to single-image
    // downgrade. Strict mode (rejectUncertain) is on because half-frame
    // slots are visually obvious — an "uncertain" image is too risky.
    //
    // Derive the entity type from the hint's subject_type so the verify
    // gate prompts Gemini with the right framing ("is this a photo of
    // the company X" vs "is this a photo of the person X"). Default to
    // "company" when unknown — most non-person split entities in this
    // pipeline are companies / publications (The Sun, Guardian, Fremantle).
    //
    // No person-image fallback. Split-screens are editorially supposed to
    // show TWO different entities side-by-side; if we can't find a real
    // entity image for one side, the block downgrades to a single-image
    // block (see caller below). Falling back to the project celebrity's
    // photo cache for a split half produced two failure modes:
    //   1. Same subject on both halves (visually weird "split" of one
    //      person against themselves).
    //   2. Broken / placeholder images returned by CDNs (the "speech
    //      bubble icon" placeholder), since the celebrity cache pulls
    //      from Getty/Hello/Daily Mail URLs that sometimes return
    //      a "no image" graphic with HTTP 200.
    if (entity && entity.trim()) {
      const q = entity.trim();
      const hintSubjectType = hints[blockIdx]?.subject_type;
      const verifyEntityType: BlockEntityType =
        hintSubjectType === "person" ? "person" :
        hintSubjectType === "company" ? "company" :
        hintSubjectType === "show" ? "tv_show" :
        hintSubjectType === "movie" ? "movie" :
        hintSubjectType === "place" ? "place" :
        "company";
      try {
        const fetched = await fetchImages(q, 6, {});
        for (const f of fetched) {
          if (forbiddenUrls.has(f.url)) continue;
          if (refUrlSet.has(f.url)) continue;
          const last = imageUrlLastUsedAt.get(f.url);
          if (last !== undefined && nowSec - last < IMAGE_REUSE_COOLDOWN_SEC) continue;
          try {
            // Retry-aware so a 503 spike recovers; a still-errored verdict
            // stays rejected here (rejectUncertain) — split entities fail
            // CLOSED by design, see the catch below.
            const verdict = await verifyPoolAssetWithRetry({
              projectId,
              entityType: verifyEntityType,
              entityName: q,
              candidateUrl: f.url,
            }, { rejectUncertain: true });
            if (!verdict.accept) {
              void logJob({ projectId, jobId: mediaJobId },
                verdict.errored ? "match.split.entity_verify_unavailable" : "match.split.entity_verify_rejected", {
                blockIndex: blockIdx, query: q, url: f.url,
                verdict: verdict.verdict, reason: verdict.reason.slice(0, 120),
              });
              continue;
            }
          } catch {
            // Verify failure (Gemini outage) — fail closed for split entities
            // because the cost of a wrong image is high (literally "the sun"
            // for "The Sun"). Skip this candidate; block downgrades to single.
            continue;
          }
          return { url: f.url, query: q, source: f.source, reason: `split_entity:${q}` };
        }
      } catch (e) {
        void logJob({ projectId, jobId: mediaJobId },
          "match.split.fetch_failed", { blockIndex: blockIdx, query: q, err: (e as Error).message });
      }
    }
    // No fallback. Caller handles null by downgrading the block to a
    // single full-frame image (using whichever side did resolve), or to
    // a footage / image block if neither resolved.
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
    // RIGHT side: second mentioned entity (if any) or person fallback.
    // Pass LEFT's URL as forbidden so the two halves are never the same
    // image (especially important when both fall back to a person photo).
    const rightPick = await resolveSplitSide(ents[1] ?? null, blockIdx, nowSec, localForbidden);
    if (rightPick) {
      localForbidden.add(rightPick.url);
    } else {
      splitsRightFailed++;
    }
    // If we couldn't resolve ANY image for either side, the block was
    // going to render as an empty split. Try a final downgrade to
    // footage by pulling from the unused-clip pool the same way
    // pickFillerForBlock did during the original Tier 2 fill. If a
    // clip is available we convert to footage; if not we fall back to
    // image (which still gets the eventual entity-pool fill below).
    if (!leftPick && !rightPick) {
      // Run the same never-empty ladder the image pass uses: fresh clip →
      // reused celebrity image → reused clip. This pass runs AFTER the
      // empty-image pass, so there's no later catch-all — the block must be
      // filled here or it reaches render empty and desyncs the timeline (the
      // original "leave it as a url-less image for a later pass" comment was
      // wrong; that pass already ran above).
      const outcome = await fillEmptyBlock(item, blockIdx, "split_2_no_images");
      if (outcome === "blank") {
        // Truly nothing left to reuse — leave url-less; render-side filler
        // holds the slot so timing stays aligned.
        item.type = "image";
        const meta = (item.metadata ?? {}) as Record<string, unknown>;
        meta.downgraded_from = "split_2_no_images";
        meta.downgrade_reason = "neither split half resolved; no clip/image to reuse";
        item.metadata = meta;
      } else {
        void logJob({ projectId, jobId: mediaJobId }, "match.split_downgrade_filled", {
          blockIndex: blockIdx, outcome,
        });
      }
      continue;
    }
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
    totalFootageBlocks: blocks.filter((b) => b.type === "footage" || b.type === "intro").length,
    personGateRejections,
  });

  // ---- Lower-third tagging --------------------------------------------
  // Disabled: lower-thirds are now sourced ONLY from the Google Doc's
  // red-text markers (applied below by applyScriptMarkers). The previous
  // entity-driven cadence pre-stamped one overlay per ~60s of timeline,
  // and applyScriptMarkers skips any item that already has a lower_third
  // — so the auto picks were silently shadowing the doc-authored ones the
  // client actually wants on screen. The doc is the single source of truth.

  // Script-doc markers (title cards + lower-thirds parsed from the Google
  // Doc the user pasted at intake). MUST run BEFORE duration_reclaim so the
  // marker positioner sees item durations that still equal their hint's
  // word-timed spoken length — reclaim would stretch footage rows and
  // desynchronize computeStarts(items) from real spoken time, causing
  // findItemIndexAtTime to land each title card on the wrong item.
  //
  // The post-processor mutates `items` in place: inserts a title_card +
  // forced-footage pair at each blue-bold marker's spoken moment, CONSUMING
  // the script items playing under that overlay window so the timeline does
  // not grow past the voiceover length. Stamps metadata.lower_third on
  // whichever item is playing at each red marker's moment. Forced footage
  // rows carry metadata.forced_clip = { youtube_url, start_seconds,
  // end_seconds }; the renderer downloads the window via the proxied yt-dlp
  // pipeline at render time, same way the user-supplied intro works today.
  //
  // intro_card markers live in the same table but are pre-roll only —
  // never aligned to spoken audio — so we filter them out here. The
  // renderer queries them directly when building the pre-roll segment.
  const { data: allMarkerRows } = await sb
    .from("project_script_markers")
    .select("id, kind, text, ordinal, paragraph_index, char_offset, youtube_url, start_seconds, end_seconds")
    .eq("project_id", projectId)
    .in("kind", ["title_card", "title_card_clip", "inline_clip", "lower_third"])
    .order("ordinal");
  if (allMarkerRows && allMarkerRows.length > 0) {
    // Lower-third → canonical visual override (per client spec).
    //
    // For each lower-third anchored to a named noun (Bruno Tonioli,
    // Guardian, London Palladium, Dixon), we override the underlying
    // item's visual with the canonical reference image we already fetched
    // at analyze time and persisted to face_references. This stops the
    // failure mode where a BRUNO TONIOLI chip sits over a Walliams+Carr
    // split, or a GUARDIAN chip over BGT stage footage.
    //
    // We load every face_references row for the project ONCE and build
    // an in-memory resolver, so the marker pass stays synchronous and
    // doesn't fire one DB roundtrip per marker. Rows with no
    // reference_url (Wikipedia miss at analyze time) are filtered inside
    // buildResolverContext — they can't drive a visual, so they're
    // treated as if the entity never existed for resolution purposes.
    const { data: refRows } = await sb
      .from("face_references")
      .select("id, project_id, entity_type, entity_name, source, reference_url, source_page_url, metadata")
      .eq("project_id", projectId);
    const { buildResolverContext } = await import("@/lib/gdocs/lower-third-resolver");
    const resolverCtx = buildResolverContext(
      (refRows ?? []) as unknown as import("@/lib/ai/face-references").FaceReferenceRow[],
    );
    await logJob({ projectId, jobId: mediaJobId }, "match.lower_third_resolver.built", {
      refRows: refRows?.length ?? 0,
      withReferenceImage: (refRows ?? []).filter((r) => r.reference_url).length,
    });

    const { applyScriptMarkers } = await import("@/lib/gdocs/markers");
    const stats = applyScriptMarkers(
      items as unknown as import("@/lib/gdocs/markers").TimelineItemDraft[],
      allMarkerRows as unknown as import("@/lib/gdocs/markers").ScriptMarkerRow[],
      transcriptWords,
      projectId,
      transcript,
      resolverCtx,
    );
    await logJob({ projectId, jobId: mediaJobId }, "match.script_markers_applied", { ...stats });
    // Surface forced-clip trims as their own job log entry so the doc
    // author can see exactly which clips were shortened and by how much.
    // Two thresholds are reported per the user spec (2026-05-31):
    //   • Every trim is logged (debug audit trail) so we can correlate
    //     any visual misalignment with the trim that caused it.
    //   • Trims where requested - trimmed > 2s are flagged as warnings —
    //     the doc author picked a clip noticeably longer than the
    //     section narration and probably wants to fix the doc. Sub-2s
    //     trims are silent (renderer-level rounding territory).
    if (stats.forcedClipTrimmings.length > 0) {
      const WARN_OVERFLOW_SECONDS = 2;
      const warnings = stats.forcedClipTrimmings.filter(
        (t) => t.requestedDur - t.trimmedDur > WARN_OVERFLOW_SECONDS,
      );
      await logJob({ projectId, jobId: mediaJobId }, "match.forced_clip_trimmed", {
        count: stats.forcedClipTrimmings.length,
        warningCount: warnings.length,
        trims: stats.forcedClipTrimmings,
        warnings,
      });
    }

    // Audit log: which lower-third markers got a canonical override vs.
    // were left to the celebrity fallback. Useful for the doc writer to
    // see which red-marked nouns the system couldn't ground.
    const overrideAudit = items
      .map((it, idx) => {
        const meta = (it.metadata ?? {}) as Record<string, unknown>;
        const ltOv = meta.lower_third_override as Record<string, unknown> | undefined;
        const lt = meta.lower_third as { text?: string } | undefined;
        if (!lt) return null;
        return {
          itemIdx: idx,
          markerText: lt.text ?? null,
          resolved: !!ltOv,
          entity_type: ltOv?.entity_type ?? null,
          entity_name: ltOv?.entity_name ?? null,
          match: ltOv?.match ?? null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (overrideAudit.length > 0) {
      await logJob({ projectId, jobId: mediaJobId }, "match.lower_third_overrides", {
        total: overrideAudit.length,
        resolved: overrideAudit.filter((r) => r.resolved).length,
        unresolved: overrideAudit.filter((r) => !r.resolved).length,
        rows: overrideAudit,
      });
    }
  }

  // ---- vo-start-driven duration pass (2026-06-01) ---------------------
  // Each non-intro row's `duration` must equal the audio interval it owns:
  //   duration = next_row.vo_start_seconds - cur.vo_start_seconds
  //
  // Why this pass exists:
  //   Without it, per-row durations drift away from the row's real spoken
  //   audio window. Footage rows get clamped to short clip lengths
  //   (clipDur < spoken), image rows get inflated by proportional-fit to
  //   absorb the leftover, and the title-card padding logic dumps even
  //   more time onto the row preceding each title card. End result:
  //   image holds 8.33s for sentences the narrator finishes in 4.96s
  //   (block #11 in the user's BGT project, 2026-06-01).
  //
  //   Deepgram already gives us each sentence's exact vo_start. The
  //   correct visual hold time is just the delta to the next row's
  //   vo_start — no estimation, no padding, no proportional fit.
  //
  // Clip-too-short handling:
  //   Footage rows where the matched clip is shorter than the audio
  //   interval rely on the renderer's slow-motion path (up to 1.5×) to
  //   fill the gap. Beyond 1.5×, the renderer caps the stretch and the
  //   residual is absorbed by the legacy reclaim/proportional-fit pass
  //   below. This pass deliberately does NOT clamp footage rows down to
  //   their clip length — that's the renderer's call at render time, not
  //   the matcher's.
  //
  // Rows skipped:
  //   • intro                         — separate audio axis (pre-roll)
  //   • duration_clamped: true        — forced YouTube clips with a pinned
  //                                     duration the doc author chose
  //   • title_card with typewriter    — pinned to typewriter_seconds; the
  //                                     trailing visual hold (HOLD_TAIL)
  //                                     is intentionally NOT audio time
  //                                     and stays on the row's duration
  //
  // The last non-intro row's duration = voiceoverSeconds - cur.vo_start.
  {
    type Row = (typeof items)[number];
    const adjustable: Array<{ row: Row; voStart: number }> = [];
    for (const it of items) {
      if (it.type === "intro") continue;
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      const vs = meta.vo_start_seconds;
      if (typeof vs !== "number") continue;
      adjustable.push({ row: it, voStart: Number(vs) });
    }
    // Sort by vo_start so the delta-to-next math is correct regardless of
    // the items[] insertion order. (applyScriptMarkers splices title-card
    // rows in reverse order — sequential index ≠ audio-time order until
    // we sort here.)
    adjustable.sort((a, b) => a.voStart - b.voStart);

    let adjustedCount = 0;
    let totalDriftBefore = 0;
    let totalDriftAfter = 0;
    let forcedClipsStretched = 0;
    for (let k = 0; k < adjustable.length; k++) {
      const cur = adjustable[k];
      const meta = (cur.row.metadata ?? {}) as Record<string, unknown>;
      const next = adjustable[k + 1];
      const targetEnd = next ? next.voStart : voiceoverSeconds;
      const audioInterval = targetEnd - cur.voStart;
      const oldDuration = Number(cur.row.duration ?? 0);
      // Title cards keep their typewriter+hold duration ONLY when that
      // duration already covers (or exceeds) the audio interval the card
      // sits over — then the trailing hold is a pure visual beat and the
      // next row's vo_start is naturally <= (this.vo_start + this.duration).
      //
      // But when the interval is LONGER than the card (narrator keeps
      // talking for seconds after the typewriter+hold finishes), the leftover
      // narration is owned by no row: cumulative video falls behind the audio
      // by (interval - duration) and never recovers, dragging every later row
      // — including the next title card and all lower-thirds — earlier than
      // its spoken moment (the 2026-06-10 −3.40s-per-card step bug, confirmed
      // in DB: card at vo 607.15 held 2.08s over a 5.48s interval). Extend the
      // card to fill the interval so its trailing hold absorbs the gap; the
      // typewriter sub-timing is unchanged (it's driven by typewriter_seconds
      // in the render filter, not by the row duration), only the hold grows.
      if (cur.row.type === "title_card") {
        if (audioInterval > oldDuration + 0.05) {
          const newDuration = Math.round(audioInterval * 100) / 100;
          cur.row.duration = newDuration;
          meta.vo_end_seconds = cur.voStart + newDuration;
          cur.row.metadata = meta;
          adjustedCount++;
        }
        continue;
      }
      totalDriftBefore += Math.abs(oldDuration - audioInterval);
      // Forced YouTube clips AND title-card-padded rows carry
      // duration_clamped: true. In BOTH cases the correct visual hold
      // time is the audio interval — anything longer leaks visual past
      // the narrator's next sentence (the 32s-overshoot bug, 2026-06-01).
      //
      // - audioInterval > current: EXTEND. For forced clips this means
      //   the source window is shorter than the narration; renderer
      //   applies slow-mo (≤1.5×) to fill. We stash the original window
      //   so the renderer can compute the stretch factor.
      // - audioInterval < current: SHRINK. Two cases produce this:
      //     (a) marker padding stamped duration_clamped on the row
      //         preceding a title card (markers.ts); shrinking restores
      //         the audio-aligned duration.
      //     (b) a forced YouTube clip whose source window is longer than
      //         the section's narration budget; shrinking trims the
      //         playback so the next row's visual lands on its narration.
      if (meta.duration_clamped === true) {
        const sourceWindowDur = oldDuration;
        const newDuration = Math.max(0.3, Math.round(audioInterval * 100) / 100);
        if (audioInterval > sourceWindowDur + 0.05) {
          // EXTEND path — stash source window for slow-mo factor.
          meta.forced_clip_source_window_seconds = Math.round(sourceWindowDur * 100) / 100;
          cur.row.duration = newDuration;
          meta.vo_end_seconds = cur.voStart + newDuration;
          cur.row.metadata = meta;
          forcedClipsStretched++;
          adjustedCount++;
          totalDriftAfter += Math.abs(newDuration - audioInterval);
          continue;
        }
        if (audioInterval + 0.05 < sourceWindowDur) {
          // SHRINK path — clamp the playback to the audio interval.
          cur.row.duration = newDuration;
          meta.vo_end_seconds = cur.voStart + newDuration;
          // Forced clips: also trim the source end so the renderer plays
          // start..start+newDuration, not the original (longer) window.
          const forcedClip = meta.forced_clip as
            | { youtube_url?: string; start_seconds?: number; end_seconds?: number }
            | undefined;
          if (forcedClip && typeof forcedClip.start_seconds === "number") {
            forcedClip.end_seconds = forcedClip.start_seconds + newDuration;
            meta.forced_clip = forcedClip;
          }
          cur.row.metadata = meta;
          adjustedCount++;
          totalDriftAfter += Math.abs(newDuration - audioInterval);
          continue;
        }
        // Else: already matches within tolerance. Leave alone.
        totalDriftAfter += Math.abs(oldDuration - audioInterval);
        continue;
      }
      // Regular footage / image / split rows: simple delta-to-next rule.
      const newDuration = Math.max(0.3, Math.round(audioInterval * 100) / 100);
      cur.row.duration = newDuration;
      meta.vo_end_seconds = cur.voStart + newDuration;
      cur.row.metadata = meta;
      if (Math.abs(oldDuration - newDuration) > 0.05) adjustedCount++;
      totalDriftAfter += Math.abs(newDuration - audioInterval);
    }
    await logJob({ projectId, jobId: mediaJobId }, "match.vo_start_duration_pass", {
      rowsSeen: adjustable.length,
      rowsAdjusted: adjustedCount,
      forcedClipsStretched,
      totalAbsDriftBefore: Math.round(totalDriftBefore * 10) / 10,
      totalAbsDriftAfter: Math.round(totalDriftAfter * 10) / 10,
    });

    // (Title-card anchor pass moved below — runs after reclaim and
    // proportional-fit so it has the final word on title-card alignment.
    // See "title-card hard-anchor pass" further down.)
  }

  // Recompute the reclaim target AFTER applyScriptMarkers ran. The marker
  // pass can both add (title card + forced footage rows) AND remove (the
  // dedup pass strips script items overlapping the title-card overlay), so
  // the original durationReclaimSeconds calculated from planner blocks
  // alone no longer reflects reality. We use the live items[] sum vs the
  // target sum to set the actual gap that needs closing.
  //
  // Target sum = voiceoverSeconds. Forced doc clips now play SILENT (per
  // user direction 2026-05-27) under a continuing narrator voiceover, so
  // they consume both video-timeline time AND voiceover time — just like
  // any other footage row. The non-intro item sum should equal
  // voiceoverSeconds (the previous "+forced clip durations" inflation
  // only applied when the render-time audio splice paused the narrator,
  // which is now disabled).
  const liveTimelineSum = items
    .filter((it) => it.type !== "intro")
    .reduce((s, it) => s + Number(it.duration ?? 0), 0);
  const targetTimelineSum = voiceoverSeconds;
  const liveGap = targetTimelineSum - liveTimelineSum;

  // Predict the proportional fit multiplier for the new-builder path so we
  // can decide whether to also run reclaim. Proportional fit is clean when
  // the adjustment is small (≤ 5% per block); beyond that, every block
  // distorts visibly. Reclaim absorbs the bulk shortfall onto specific
  // footage rows BEFORE proportional fit runs, keeping the multiplier in
  // the safe range.
  //
  // Math: proportional fit scales the "adjustable" sum (everything except
  // intro + title_card) by adjustableTarget / adjustableSum. We compute
  // what that ratio WOULD BE if reclaim didn't run, and check if it's
  // outside [0.9, 1.1]. Outside that band → also run reclaim.
  const PROP_FIT_SAFE_MIN = 0.9;
  const PROP_FIT_SAFE_MAX = 1.1;
  const adjustableSumPreview = items
    .filter((it) => it.type !== "intro" && it.type !== "title_card")
    .reduce((s, it) => s + Number(it.duration ?? 0), 0);
  const fixedSumPreview = items
    .filter((it) => it.type === "title_card")
    .reduce((s, it) => s + Number(it.duration ?? 0), 0);
  const adjustableTargetPreview = Math.max(0.1, voiceoverSeconds - fixedSumPreview);
  const predictedMultiplier = adjustableSumPreview > 0.1
    ? adjustableTargetPreview / adjustableSumPreview
    : 1;
  const propFitWouldBeExtreme =
    predictedMultiplier < PROP_FIT_SAFE_MIN ||
    predictedMultiplier > PROP_FIT_SAFE_MAX;

  // Reclaim + proportional-fit are LEGACY passes superseded by the
  // vo_start_duration_pass above. The new pass already sets every row's
  // duration to its exact audio interval (next.vo_start - cur.vo_start),
  // so the picture timeline naturally equals voiceoverSeconds row-by-row.
  // Letting reclaim and proportional-fit run on top would UNDO that
  // alignment — they sum the live timeline, compare to voiceoverSeconds,
  // and redistribute any residual onto image rows, which is exactly the
  // inflation behavior the new pass replaces (e.g. block #11's 4.96s
  // narration getting padded to 7.99s, 2026-06-01 BGT project).
  //
  // Gate: when the transcript-driven builder ran, the new pass owns
  // duration assignment. Skip reclaim and proportional-fit entirely.
  // For legacy projects without transcript_words / Gemini hints, the
  // builder falls back and these passes are still needed.
  const shouldUseReclaim = !usedTranscriptDrivenBuilder;
  if (liveGap > 0.1 && shouldUseReclaim) {
    durationReclaimSeconds = liveGap;
  }
  await logJob({ projectId, jobId: mediaJobId }, "match.duration_strategy", {
    usedTranscriptDrivenBuilder,
    liveGap: Math.round(liveGap * 10) / 10,
    predictedMultiplier: Math.round(predictedMultiplier * 10000) / 10000,
    propFitWouldBeExtreme,
    shouldUseReclaim,
    safeRange: [PROP_FIT_SAFE_MIN, PROP_FIT_SAFE_MAX],
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

  // Proportional fit — force the body of the timeline to total exactly
  // voiceoverSeconds so every word of narration aligns with a visual,
  // start to end.
  //
  // Why proportional (not tail-trim): the renderer needs the visual
  // timeline to match the voiceover EXACTLY so the narrator's voice ends
  // at the same moment the last visual ends — no trailing silence under a
  // frozen frame, no audio cut short. The old tail-trim only touched the
  // last few rows, which either created 1-2s flash blocks at the end or
  // dropped sentences entirely when the overshoot exceeded what trimming
  // could absorb.
  //
  // Proportional fit distributes the adjustment across every body row
  // (footage and image) by a fixed multiplier. A 32:10 timeline against
  // 31:54 audio yields a 0.992 multiplier — a 5s sentence becomes 4.96s,
  // a 6s footage becomes 5.95s, all rounded to 0.1s precision. Viewers
  // cannot perceive 0.04s differences, but the total now matches exactly.
  //
  // Preserves:
  //   • Title cards — their 5s hold is editorial spec, not adjustable
  //   • Intro rows — they have their own audio track (separate timeline)
  //
  // When the timeline is SHORTER than audio (rare, but possible when many
  // rows were clamped to clip lengths), we expand instead of compress
  // using the same proportional rule, so the gap is absorbed evenly
  // rather than appearing as silent visual at the end.
  //
  // Skipped on the transcript-driven path: the vo_start_duration_pass
  // above already aligned every row to its exact audio interval. Running
  // proportional fit here would scale those exact values away from the
  // narration windows again — the same bug that caused block #11 to hold
  // for 7.99s when its real spoken time is 4.96s.
  if (!usedTranscriptDrivenBuilder) {
    const target = voiceoverSeconds;
    const adjustableType = (it: { type?: string | null }) =>
      it.type !== "intro" && it.type !== "title_card";
    const adjustableSum = () =>
      items.filter(adjustableType).reduce((s, it) => s + Number(it.duration ?? 0), 0);
    const fixedSum = () =>
      items.filter((it) => !adjustableType(it) && it.type !== "intro")
        .reduce((s, it) => s + Number(it.duration ?? 0), 0);

    const initialAdjustable = adjustableSum();
    const fixed = fixedSum();
    const adjustableTarget = Math.max(0.1, target - fixed);

    if (initialAdjustable > 0.1) {
      const multiplier = adjustableTarget / initialAdjustable;
      // Per-row ceiling: a footage row can't exceed its clip's real length
      // (we'd be asking ffmpeg to show frames that don't exist). Image
      // rows have no source-media ceiling, so they can stretch freely.
      // When compressing (multiplier <= 1) ceilings don't matter; only
      // the expand path needs this guard.
      function ceilingFor(it: typeof items[number]): number {
        if (it.type === "footage") {
          const meta = (it.metadata as Record<string, unknown> | undefined) ?? {};
          const clipDur = Number(meta.clip_duration ?? 0);
          if (clipDur > 0) return clipDur;
        }
        return Infinity;
      }
      // Apply the multiplier to every adjustable row. Round each to 0.1s
      // precision; let the LAST adjustable row absorb any residue so the
      // sum still equals adjustableTarget exactly.
      const adjustableItems = items.filter(adjustableType);
      let cumulative = 0;
      const leftover: { it: typeof items[number]; want: number; ceiling: number }[] = [];
      for (let k = 0; k < adjustableItems.length - 1; k++) {
        const it = adjustableItems[k];
        const cur = Number(it.duration ?? 0);
        const ceiling = ceilingFor(it);
        // 0.01s precision (was 0.1s). Per-row accumulated rounding error
        // drops 10× — on a 128-row project that's the difference between
        // ±0.5s overshoot and ±0.05s overshoot. The editor displays
        // durations rounded to 0.1s but stores the precise value, so the
        // user-visible scene times are unchanged.
        const scaled = Math.round(cur * multiplier * 100) / 100;
        // Lower the per-row floor from 1.0s to 0.3s. Short narration
        // sentences (1-2s) were being bumped up to 1.0s by the old floor,
        // each contributing 0.5-0.9s of overshoot. The transcript-driven
        // builder's short-sentence merger already absorbs sub-second
        // sentences into neighbors; any sub-1s row that survives is a
        // legitimate brief beat that should hold for its real duration,
        // not get inflated.
        const want = Math.max(0.3, scaled);
        const capped = Math.min(want, ceiling);
        it.duration = capped;
        // Use the local `capped` value (not it.duration) for the running
        // sum — items[] is typed loosely so reading it.duration back
        // returns `unknown`, breaking the addition.
        cumulative += capped;
        if (want > capped) {
          leftover.push({ it, want, ceiling });
        }
      }
      // Tail row absorbs the residue so the body sums to adjustableTarget
      // exactly. When expanding and the tail's clip ceiling can't absorb
      // the full residue, the leftover stretches across the image rows
      // (which have no clip ceiling) on a second pass.
      if (adjustableItems.length > 0) {
        const tail = adjustableItems[adjustableItems.length - 1];
        const tailCeiling = ceilingFor(tail);
        const want = Math.max(0.3, Math.round((adjustableTarget - cumulative) * 100) / 100);
        const capped = Math.min(want, tailCeiling);
        tail.duration = capped;
        cumulative += capped;
      }
      // If we still undershoot the target (expand case where many footage
      // rows hit their clip ceilings), distribute the gap across IMAGE
      // rows only — they have no clip-source ceiling and can hold a
      // single image for any length without source-media issues.
      //
      // Lossless distribution: divide the gap proportionally without
      // rounding each per-row addition to 0.1s. The previous version
      // computed `perImage = Math.round((gap / N) * 10) / 10` which on
      // small gaps (<0.05s per row) rounded to 0 (no-op, gap unabsorbed)
      // and on medium gaps rounded UP to 0.1s on EVERY row, adding far
      // more than the gap requested (50 rows × 0.1s = +5s on a 3s gap).
      // We use float division and let the LAST image row absorb residue.
      const gap = adjustableTarget - cumulative;
      if (Math.abs(gap) > 0.05) {
        const imageRows = adjustableItems.filter((it) => it.type === "image");
        if (imageRows.length > 0) {
          const exactPerImage = gap / imageRows.length;
          let added = 0;
          for (let k = 0; k < imageRows.length - 1; k++) {
            const it = imageRows[k];
            const cur = Number(it.duration ?? 0);
            const next = Math.max(0.3, Math.round((cur + exactPerImage) * 100) / 100);
            added += next - cur;
            it.duration = next;
          }
          // Tail image row absorbs the residue so the sum changes by exactly `gap`.
          const tailImg = imageRows[imageRows.length - 1];
          const tailImgCur = Number(tailImg.duration ?? 0);
          const residue = gap - added;
          tailImg.duration = Math.max(0.3, Math.round((tailImgCur + residue) * 100) / 100);
        }
      }
    }

    const finalSum = adjustableSum() + fixed;
    await logJob({ projectId, jobId: mediaJobId }, "match.proportional_fit", {
      targetSeconds: target,
      voiceoverSeconds,
      initialAdjustableSum: Math.round(initialAdjustable * 10) / 10,
      fixedSum: Math.round(fixed * 10) / 10,
      finalSum: Math.round(finalSum * 10) / 10,
      residualGap: Math.round((target - finalSum) * 10) / 10,
      multiplier: Math.round((adjustableTarget / Math.max(0.1, initialAdjustable)) * 10000) / 10000,
      adjustableRows: items.filter(adjustableType).length,
      fixedRows: items.filter((it) => !adjustableType(it) && it.type !== "intro").length,
    });
  }

  // ---- title-card hard-anchor pass (2026-06-02) -----------------------
  // Runs LAST, after vo_start_duration_pass + reclaim + proportional-fit,
  // so it has the final word on title-card alignment. The client requires
  // title cards to appear at the EXACT video time the narrator speaks them
  // — no drift tolerance — while other clips and images can drift by small
  // amounts without the viewer noticing.
  //
  // Strategy: SECTION-BASED DRIFT DISTRIBUTION + HARD SNAP.
  //   A "section" is the run of rows between two title cards (or from the
  //   start to the first title card, or from the last title card to the
  //   end). For each title card we measure cumulative video time at that
  //   point and compare to the title card's vo_start. We distribute the
  //   delta across every adjustable row in the section first; any residual
  //   after distribution gets hard-snapped onto a single row so the title
  //   card lands within 0.01s of its narrated moment.
  //
  // Why this lives AFTER proportional-fit (was BEFORE in the original
  // pass): proportional-fit scales every adjustable row by a fixed
  // multiplier to make the timeline total equal voiceoverSeconds. That
  // scaling silently re-introduces drift at every title card (each row
  // shifts by a few percent, cumulative drift at a card 60 rows in can
  // hit 1-2s). Running the anchor after proportional-fit reverses this
  // for the title-card-adjacent rows specifically.
  //
  // Why sort by vo_start: applyScriptMarkers (markers.ts) splices title-
  // card rows in REVERSE doc-marker order to keep splice indices stable.
  // After that, items[] is no longer in audio-time order — a title card
  // can sit BEFORE an adjacent script row whose vo_start is earlier than
  // its own. Walking items[] in array order accumulates wrong durations
  // and the drift measurement at each title card becomes meaningless.
  // Sorting by vo_start (with the title card itself anchored at its own
  // vs) gives a correct audio-time walk.
  //
  // Adjustable rows: footage, image, split_2/4. NOT: intro, title_card.
  // Doc-author-forced YouTube clips carry duration_clamped: true and were
  // ALREADY corrected by the vo_start_duration_pass earlier, so they're
  // also excluded here (re-stretching their playback breaks the YouTube
  // window the doc author chose). The padded row immediately preceding
  // a title card (markers.ts marks it duration_clamped too) is similarly
  // excluded; if drift remains after proportional distribution, we hard-
  // snap onto a single non-clamped row at the section tail.
  {
    type Row = (typeof items)[number];

    // vo_start of a row. Items without vo_start metadata fall through to
    // the end (defensive — every non-intro row in the transcript-driven
    // builder has vo_start_seconds, but legacy projects may not).
    function voOf(row: Row): number {
      const m = (row.metadata ?? {}) as Record<string, unknown>;
      const vs = m.vo_start_seconds;
      return typeof vs === "number" ? Number(vs) : Number.POSITIVE_INFINITY;
    }

    // CRITICAL: reorder items[] itself into audio (vo_start) order and
    // re-number position, so array order == audio order == RENDER order.
    //
    // The renderer loads timeline_items `ORDER BY position` and plays them
    // back-to-back, accumulating each row's duration — so a row's video-time
    // start is the sum of all PRIOR rows' durations in position order. But
    // applyScriptMarkers (markers.ts) splices title-card + forced-footage
    // rows in REVERSE doc order (to keep splice indices stable) and its
    // dedup pass deletes rows, so after it runs items[] (and therefore
    // position) is NO LONGER in audio-time order.
    //
    // The old anchor pass measured drift over a vo_start-SORTED *copy*
    // (nonIntroRows) while the renderer played the *unsorted* array. When
    // the two orders diverged, the pass pinned each title card perfectly in
    // a layout the renderer never reproduced — leaving the card 5-6s off its
    // narrated moment in the actual video. Reordering the real items[] here
    // makes the pass measure in the exact coordinate system the renderer
    // uses, and keeps the downstream image-merge pass (which coalesces
    // array-adjacent rows) merging rows that are genuinely adjacent in time.
    //
    // Intro rows live on a different time axis (pre-roll, before the
    // voiceover) and must stay pinned at the head in their existing order —
    // they're not sorted into the voiceover timeline. We use a stable sort
    // by a key that keeps intros first (in original order) and orders every
    // other row by vo_start.
    {
      const introOrder = new Map<Row, number>();
      let introSeq = 0;
      for (const it of items) {
        if (it.type === "intro") introOrder.set(it, introSeq++);
      }
      items.sort((a: Row, b: Row) => {
        const aIntro = a.type === "intro";
        const bIntro = b.type === "intro";
        if (aIntro && bIntro) {
          return (introOrder.get(a) ?? 0) - (introOrder.get(b) ?? 0);
        }
        if (aIntro) return -1; // intros always precede voiceover rows
        if (bIntro) return 1;
        return voOf(a) - voOf(b);
      });
      for (let i = 0; i < items.length; i++) items[i].position = i;
    }

    const nonIntroRows = items.filter((it: Row) => it.type !== "intro");

    function isAdjustable(row: Row): boolean {
      if (row.type === "title_card") return false;
      if (row.type === "intro") return false;
      const m = (row.metadata ?? {}) as Record<string, unknown>;
      if (m.duration_clamped === true) return false;
      return true;
    }

    function distributeDelta(rows: Row[], delta: number): number {
      if (rows.length === 0 || Math.abs(delta) < 0.005) return 0;
      let remaining = delta;
      for (let pass = 0; pass < 5 && Math.abs(remaining) > 0.005; pass++) {
        const eligible: Row[] = [];
        for (const r of rows) {
          const d = Number(r.duration ?? 0);
          if (remaining > 0 || d > 0.31) eligible.push(r);
        }
        if (eligible.length === 0) break;
        const share = remaining / eligible.length;
        let absorbedThisPass = 0;
        for (const r of eligible) {
          const cur = Number(r.duration ?? 0);
          const target = cur + share;
          const next = Math.max(0.3, target);
          const actual = next - cur;
          if (Math.abs(actual) < 0.005) continue;
          r.duration = Math.round(next * 100) / 100;
          const m = (r.metadata ?? {}) as Record<string, unknown>;
          const vs = m.vo_start_seconds;
          if (typeof vs === "number") {
            m.vo_end_seconds = Number(vs) + next;
            r.metadata = m;
          }
          absorbedThisPass += actual;
        }
        if (Math.abs(absorbedThisPass) < 0.005) break;
        remaining -= absorbedThisPass;
      }
      return delta - remaining;
    }

    // Hard-snap: dump the entire delta on a single row, ignoring the
    // duration_clamped filter so we can pin the title card EXACTLY.
    // Caller picks the snap target — typically the row immediately
    // before the title card. We still respect the 0.3s floor.
    function hardSnap(row: Row | undefined, delta: number): number {
      if (!row || Math.abs(delta) < 0.005) return 0;
      const cur = Number(row.duration ?? 0);
      const next = Math.max(0.3, Math.round((cur + delta) * 100) / 100);
      const actual = next - cur;
      row.duration = next;
      const m = (row.metadata ?? {}) as Record<string, unknown>;
      const vs = m.vo_start_seconds;
      if (typeof vs === "number") {
        m.vo_end_seconds = Number(vs) + next;
        row.metadata = m;
      }
      return actual;
    }

    let titleCardsAnchored = 0;
    let titleCardsResidualDrift = 0;
    let rowsTouched = 0;
    let hardSnaps = 0;
    let cumulativeVideo = 0;
    let sectionStart = 0;
    const anchorAudit: Array<{
      vo_start: number; before: number; after: number; section_rows: number;
    }> = [];

    // A row is an anchor point when its start MUST equal its vo_start in the
    // final video — the client requires both title cards AND lower-thirds to
    // appear at the exact narrated moment (other clips/images may drift a
    // little). A title card IS its own anchored row (we pin the video time at
    // its start). A lower-third overlay is stamped on a footage/image host
    // row; that host row's start must equal the lower-third's vo_start so the
    // chyron burns in exactly when the narrator says it. In both cases the
    // fix is identical: force cumulativeVideo at index k to equal voOf(cur).
    function isAnchorRow(row: Row): boolean {
      if (row.type === "title_card") return true;
      const m = (row.metadata ?? {}) as Record<string, unknown>;
      const lt = m.lower_third;
      return !!lt && typeof lt === "object";
    }

    let lowerThirdsAnchored = 0;
    for (let k = 0; k < nonIntroRows.length; k++) {
      const cur = nonIntroRows[k];
      if (isAnchorRow(cur)) {
        const isTitle = cur.type === "title_card";
        const target = voOf(cur);
        if (Number.isFinite(target) && k > 0) {
          const driftBefore = target - cumulativeVideo;
          if (Math.abs(driftBefore) > 0.005) {
            const section = nonIntroRows.slice(sectionStart, k).filter(isAdjustable);
            distributeDelta(section, driftBefore);
            rowsTouched += section.length;

            // Re-measure cumulative video by re-walking nonIntroRows[0..k-1]
            // after distribution. Trusting distributeDelta's return value is
            // unsafe because each row gets Math.round(×100)/100 rounded —
            // the per-row rounding accumulates to a 0.01-0.1s sum-vs-
            // returned-absorbed mismatch, which leaves the title card
            // landing slightly off the narrator. We measure the truth and
            // snap any residual onto the row immediately before the title
            // card.
            //
            // The snap target is nonIntroRows[k-1] regardless of duration_
            // clamped. markers.ts marks that row clamped specifically to
            // absorb title-card alignment padding — re-snapping here is
            // exactly what that clamp was designed for.
            let cumAtCard = 0;
            for (let q = 0; q < k; q++) {
              cumAtCard += Number(nonIntroRows[q].duration ?? 0);
            }
            const residual = target - cumAtCard;
            if (Math.abs(residual) > 0.005) {
              // Snap the residual onto the row immediately before this
              // anchor — unless that row is ITSELF an anchor we already
              // pinned (two anchors back-to-back, e.g. a lower-third whose
              // host sits right after a title card). Re-stretching an
              // already-pinned row would shift it and everything after off
              // their narrated moments, so in that case snap onto the last
              // adjustable row in this section instead. Falls back to k-1
              // when the section has no adjustable row (then the tiny
              // sub-0.1s rounding residual is left for the final-section
              // distribution to absorb).
              let snapTarget = nonIntroRows[k - 1];
              if (isAnchorRow(snapTarget)) {
                const sectionRows = nonIntroRows.slice(sectionStart, k).filter(isAdjustable);
                snapTarget = sectionRows[sectionRows.length - 1] ?? nonIntroRows[k - 1];
              }
              const snapped = hardSnap(snapTarget, residual);
              if (Math.abs(snapped) > 0.005) hardSnaps++;
              cumAtCard += snapped;
            }
            cumulativeVideo = cumAtCard;
            if (isTitle) titleCardsAnchored++;
            else lowerThirdsAnchored++;
            titleCardsResidualDrift += Math.abs(target - cumAtCard);
            anchorAudit.push({
              vo_start: Math.round(target * 100) / 100,
              before: Math.round(driftBefore * 100) / 100,
              after: Math.round((target - cumAtCard) * 100) / 100,
              section_rows: section.length,
            });
          }
        }
        // Next section begins after this anchor. For a title_card that's
        // k+1 (the card is non-adjustable and fully placed). For a lower-
        // third host row, the row itself is adjustable content the NEXT
        // anchor may scale — but its START is now pinned, so we still begin
        // the next section at k+1 and let that section distribute drift over
        // rows AFTER the host. This keeps each anchor's start exact while
        // never re-stretching a row that sits before an already-pinned point.
        sectionStart = k + 1;
      }
      cumulativeVideo += Number(cur.duration ?? 0);
    }

    // Final section anchor — make the total video equal voiceoverSeconds.
    let finalSectionAnchored = false;
    let finalSectionResidual = 0;
    if (sectionStart < nonIntroRows.length) {
      const finalDrift = voiceoverSeconds - cumulativeVideo;
      if (Math.abs(finalDrift) > 0.05) {
        const finalSection = nonIntroRows.slice(sectionStart).filter(isAdjustable);
        let absorbed = distributeDelta(finalSection, finalDrift);
        rowsTouched += finalSection.length;
        const residual = finalDrift - absorbed;
        if (Math.abs(residual) > 0.005) {
          absorbed += hardSnap(nonIntroRows[nonIntroRows.length - 1], residual);
        }
        finalSectionAnchored = true;
        finalSectionResidual = Math.abs(finalDrift - absorbed);
      }
    }

    await logJob({ projectId, jobId: mediaJobId }, "match.title_card_anchor_pass", {
      titleCardsAnchored,
      lowerThirdsAnchored,
      finalSectionAnchored,
      rowsTouched,
      hardSnaps,
      residualDriftSeconds: Math.round(titleCardsResidualDrift * 100) / 100,
      finalSectionResidualSeconds: Math.round(finalSectionResidual * 100) / 100,
      anchors: anchorAudit,
    });
  }

  // Pre-render duration validation. After reclaim + proportional fit, the
  // non-intro timeline_items sum should equal voiceoverSeconds to within
  // 0.1s. If it doesn't, the render will start with a baked-in drift that
  // no amount of slow-mo or reclaim downstream can fix. Log loudly so
  // operators see it in match logs before render even starts.
  {
    const nonIntroSum = items
      .filter((it) => it.type !== "intro")
      .reduce((s, it) => s + Number(it.duration ?? 0), 0);
    const driftSeconds = nonIntroSum - voiceoverSeconds;
    const driftMs = Math.round(driftSeconds * 1000);
    const PRE_RENDER_TOLERANCE_MS = 100;
    await logJob({ projectId, jobId: mediaJobId }, "match.pre_render_validation", {
      voiceoverSeconds,
      timelineSumSeconds: Math.round(nonIntroSum * 1000) / 1000,
      driftMs,
      toleranceMs: PRE_RENDER_TOLERANCE_MS,
      passed: Math.abs(driftMs) <= PRE_RENDER_TOLERANCE_MS,
      itemCount: items.filter((it) => it.type !== "intro").length,
    });
  }

  // ---- Merge directly-adjacent identical image slots --------------------
  // Even with the reuse-cooldown working, the SAME celebrity photo can land
  // in two image blocks that end up back-to-back in the timeline (e.g. two
  // consecutive sentences both routed to the person fallback, no footage
  // between them). Rendered, that reads as the same picture "restarting" —
  // a visible blink — instead of one calm hold. Coalesce a run of adjacent
  // image items that share the same image_url into a SINGLE item whose
  // duration is the sum, so the photo simply stays on screen longer.
  //
  // Constraints that keep this safe:
  //   • Only plain `image` items merge. Split-screen items (right_image_url
  //     present) are left untouched — their left/right pairing is meaningful.
  //   • Total duration is preserved (we sum), so the pre-render duration
  //     validation above still holds and audio stays in sync (timeline_items
  //     carry no start_time; the renderer plays them in `position` order for
  //     their `duration`).
  //   • Script text is concatenated so the merged hold still carries the
  //     narration of every sentence it now spans (caption/overlay continuity).
  //   • Positions are re-sequenced afterwards so they stay 0..N-1 contiguous.
  {
    const isPlainImage = (it: (typeof items)[number]): boolean => {
      if (it.type !== "image") return false;
      const url = typeof it.image_url === "string" ? it.image_url : null;
      if (!url) return false;
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      // Split-screen halves carry a right_image_url — never coalesce those.
      if (typeof meta.right_image_url === "string" && meta.right_image_url) return false;
      // Never coalesce a row carrying a lower_third overlay. Merging would
      // either drop the overlay (when this row is folded into a neighbour)
      // or widen its on-screen window (when the neighbour folds into it),
      // both of which break the exact-narrated-moment placement the anchor
      // pass just pinned for that lower-third. These rows are rare; keeping
      // them distinct preserves the chyron and its pinned start.
      if (meta.lower_third && typeof meta.lower_third === "object") return false;
      return true;
    };
    const merged: typeof items = [];
    let mergedRuns = 0;   // number of distinct runs that absorbed ≥1 slot
    let mergedSlots = 0;  // total slots folded away
    for (const it of items) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        isPlainImage(prev) &&
        isPlainImage(it) &&
        prev.image_url === it.image_url
      ) {
        // Fold `it` into `prev`: extend the hold and append its narration.
        prev.duration = Number(prev.duration ?? 0) + Number(it.duration ?? 0);
        const prevText = typeof prev.script_text === "string" ? prev.script_text : "";
        const curText = typeof it.script_text === "string" ? it.script_text : "";
        if (curText && curText !== prevText) {
          prev.script_text = prevText ? `${prevText} ${curText}` : curText;
        }
        const prevMeta = (prev.metadata ?? {}) as Record<string, unknown>;
        if (!prevMeta.merged_image_run) {
          prevMeta.merged_image_run = true;
          prev.metadata = prevMeta;
          mergedRuns++;
        }
        mergedSlots++;
        continue;
      }
      merged.push(it);
    }
    if (mergedSlots > 0) {
      // Re-sequence positions to stay contiguous after the merge.
      for (let i = 0; i < merged.length; i++) merged[i].position = i;
      items.length = 0;
      items.push(...merged);
      await logJob({ projectId, jobId: mediaJobId }, "match.image_merge_adjacent", {
        mergedRuns,
        mergedSlots,
        finalItemCount: items.length,
      });
    }
  }

  // ---- Hard image use-count cap (client spec: max twice per video) ------
  // The reuse cooldown above only spreads repeats across TIME — it never caps
  // the TOTAL number of times one photo appears. On image-heavy projects with
  // a thin verified pool the same celebrity photo could still surface 3, 4, 5+
  // times over a long video. Client direction (2026-06): no image may appear
  // more than twice in a video; the 3rd+ appearance must fall back to a CLIP
  // (footage), not another image and not a blank slot.
  //
  // We enforce this as a single post-assignment pass rather than gating every
  // individual pick site: the pick loops have divergent fall-through behaviour
  // (next-oldest image, person fallback, blank) and none of them naturally
  // lands on a clip, which is exactly what the client asked for. Walking the
  // committed timeline once — in position order, so the FIRST two chronological
  // uses of each image are the ones kept — and downgrading the surplus is both
  // simpler and a precise match for the spec.
  //
  // Runs AFTER the adjacent-merge pass on purpose: that pass folds a back-to-
  // back identical photo (very common from the person fallback) into ONE slot,
  // so two consecutive duplicates count as a single on-screen appearance — the
  // semantic the client means by "appears in the video". Counting before the
  // merge would over-count and downgrade images the viewer only sees twice.
  //
  // Scope: plain `image` items only. split_2 blocks are deliberate side-by-side
  // compositions (a whole different visual), so we leave them intact and don't
  // count their halves toward the cap.
  //
  // Downgrade target: a clip via the SAME ladder fillEmptyBlock uses, but with
  // the person-image rung removed (steps 1 + 3 only: fresh clip, then reused
  // clip). Re-showing a person photo here would defeat the cap. If no clip is
  // available at all, we keep the image — a 3rd appearance beats a black slot,
  // and footage genuinely being exhausted is the documented last resort.
  {
    const IMAGE_MAX_USES = 2;
    const imageUseCount = new Map<string, number>();

    // Clip-only downgrade: fresh clip first, then a reused clip on cooldown.
    // Mirrors fillEmptyBlock steps 1 & 3 but never reintroduces an image.
    const downgradeImageToClip = (
      item: typeof items[number],
      blockIdx: number,
    ): "fresh_clip" | "reused_clip" | "no_clip" => {
      const meta = (item.metadata ?? {}) as Record<string, unknown>;
      const prevUrl = typeof item.image_url === "string" ? item.image_url : null;

      const filler = pickFillerForBlock(blockIdx);
      if (filler && !usedClipIds.has(filler.clipId)) {
        item.type = "footage";
        item.clip_id = filler.clipId;
        item.image_url = null;
        usedClipIds.add(filler.clipId);
        clipLastUsedAt.set(filler.clipId, blockStartSec[blockIdx]);
        meta.downgraded_from = "image_use_cap";
        meta.downgrade_reason = `image used > ${IMAGE_MAX_USES}x; fresh clip`;
        meta.pick_source = "image_cap_downgrade_to_footage";
        if (prevUrl) meta.capped_image_url = prevUrl;
        item.metadata = meta;
        return "fresh_clip";
      }

      const reuse = pickReuseClipForBlock(blockIdx);
      if (reuse) {
        item.type = "footage";
        item.clip_id = reuse.clipId;
        item.image_url = null;
        clipLastUsedAt.set(reuse.clipId, blockStartSec[blockIdx]);
        meta.downgraded_from = "image_use_cap";
        meta.downgrade_reason = `image used > ${IMAGE_MAX_USES}x; reused a prior clip`;
        meta.pick_source = "image_cap_downgrade_to_reused_footage";
        if (prevUrl) meta.capped_image_url = prevUrl;
        item.metadata = meta;
        return "reused_clip";
      }

      return "no_clip";
    };

    let cappedToFreshClip = 0;
    let cappedToReusedClip = 0;
    let cappedKeptNoClip = 0;
    for (const item of items) {
      if (item.type !== "image") continue;
      const url = typeof item.image_url === "string" ? item.image_url.trim() : "";
      if (!url) continue;
      const prior = imageUseCount.get(url) ?? 0;
      if (prior >= IMAGE_MAX_USES) {
        // This would be the 3rd+ appearance — try to downgrade to a clip.
        const blockIdx = (item.metadata as Record<string, unknown> | undefined)?.block_index as number | undefined;
        const outcome = blockIdx == null ? "no_clip" : downgradeImageToClip(item, blockIdx);
        if (outcome === "fresh_clip") cappedToFreshClip++;
        else if (outcome === "reused_clip") cappedToReusedClip++;
        else {
          // No clip available — keep the image (last resort) and count it so
          // the metric reflects reality.
          cappedKeptNoClip++;
          imageUseCount.set(url, prior + 1);
        }
        continue;
      }
      imageUseCount.set(url, prior + 1);
    }
    if (cappedToFreshClip + cappedToReusedClip + cappedKeptNoClip > 0) {
      // Positions may now be non-contiguous if any items changed type? No —
      // downgrade mutates type in place and keeps position/duration, so the
      // 0..N-1 sequencing from the merge pass still holds.
      await logJob({ projectId, jobId: mediaJobId }, "match.image_use_cap", {
        maxUses: IMAGE_MAX_USES,
        downgradedToFreshClip: cappedToFreshClip,
        downgradedToReusedClip: cappedToReusedClip,
        keptNoClipAvailable: cappedKeptNoClip,
        distinctImages: imageUseCount.size,
      });
    }
  }

  // Re-host safety net. The main image-block path already re-hosts to R2 at
  // pick time (with candidate fallback). This pass catches every OTHER image
  // commit site (secondary-person photos, Wikipedia portraits, split-screen
  // left/right) so NO timeline image ships pointing at an external URL — which
  // would 403 in the editor preview and be silently dropped from the render.
  // Wikipedia/Google-hosted URLs re-host fine; a publisher CDN that blocks the
  // fetch returns null. Already-R2 URLs are returned as-is, so this is cheap
  // for the common case.
  //
  // POOL FALLBACK (the no-URL-image fix): when a rehost returns null we DON'T
  // clear the field to null — that would drop the slot from the render and
  // shrink the final video by its duration. Instead we substitute an
  // already-validated image from the project's entity pool (every pool URL was
  // re-hosted to R2 at pool-build time, so it's known-good). We prefer a
  // pool entry RELEVANT to the block's narration (same gate the entity-pool
  // pass uses), falling back to any pool entry. Only when the pool is empty do
  // we leave the field null — the upstream footage-downgrade pass and the
  // render-time reconciliation backstop both still cover that edge.
  {
    const env = getEnv();
    const r2Base = env.R2_PUBLIC_BASE_URL ?? "";
    let rehostedCount = 0;
    let pooledCount = 0;
    let clearedCount = 0;

    // Pick a validated pool URL to fill a slot whose own image failed rehost.
    // Relevant-first (blockRelevantToPoolEntry), else any pool entry. Returns
    // null only when the pool is genuinely empty. `avoidUrl` lets the
    // split-screen RIGHT side skip the URL just chosen for the LEFT side so a
    // split doesn't show the same image on both halves.
    function pickPoolFallbackUrl(blockIdx: number | undefined, avoidUrl?: string): string | null {
      if (pool.length === 0) return null;
      if (blockIdx != null) {
        for (let j = 0; j < pool.length; j++) {
          if (avoidUrl && pool[j].url === avoidUrl) continue;
          if (blockRelevantToPoolEntry(blockIdx, j)) return pool[j].url;
        }
      }
      for (let j = 0; j < pool.length; j++) {
        if (avoidUrl && pool[j].url === avoidUrl) continue;
        return pool[j].url;
      }
      return null;
    }

    for (const it of items) {
      if (it.type !== "image") continue;
      const blockIdx = (it.metadata as Record<string, unknown> | undefined)?.block_index as number | undefined;
      const url = typeof it.image_url === "string" ? it.image_url : null;
      if (url && !(r2Base && url.startsWith(r2Base))) {
        const r = await rehostImageToR2(url, projectId);
        if (r) { it.image_url = r; rehostedCount++; }
        else {
          const sub = pickPoolFallbackUrl(blockIdx);
          if (sub) {
            it.image_url = sub;
            const m = (it.metadata ?? {}) as Record<string, unknown>;
            m.image_reason = "pool_fallback_after_rehost_fail";
            m.image_pick_source = "pool_fallback";
            it.metadata = m;
            pooledCount++;
          } else {
            it.image_url = null;
            clearedCount++;
          }
        }
      }
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      const rightUrl = typeof meta.right_image_url === "string" ? meta.right_image_url : null;
      if (rightUrl && !(r2Base && rightUrl.startsWith(r2Base))) {
        const r = await rehostImageToR2(rightUrl, projectId);
        if (r) { meta.right_image_url = r; it.metadata = meta; rehostedCount++; }
        else {
          const leftUrl = typeof it.image_url === "string" ? it.image_url : undefined;
          const sub = pickPoolFallbackUrl(blockIdx, leftUrl);
          if (sub) { meta.right_image_url = sub; it.metadata = meta; pooledCount++; }
          else { meta.right_image_url = null; it.metadata = meta; clearedCount++; }
        }
      }
    }
    if (rehostedCount > 0 || pooledCount > 0 || clearedCount > 0) {
      await logJob({ projectId, jobId: mediaJobId }, "match.image_rehost.summary", {
        rehosted: rehostedCount, pooled: pooledCount, cleared: clearedCount,
      });
    }
  }

  // Gemini-outage circuit breaker. When MOST verification attempts in this
  // run were infra failures (sustained 503 outage), the pools and gates
  // above degraded to fallback everywhere — completing now would ship a
  // video that LOOKS successful but silently violates the "correct celebrity
  // only" requirement (the refImagesFailed:188 incident). Fail the job
  // instead: BullMQ retries it, and the persistent image_verifications cache
  // makes the re-run skip everything that was already verified, so retrying
  // is cheap. Thresholds: enough attempts to be meaningful (≥20) and a
  // majority errored — a brief spike that the parked-retry rounds absorbed
  // never trips this.
  {
    const vs = getVerifyOutageStats();
    if (vs.checked >= 20 && vs.errored / vs.checked > 0.5) {
      await logJob({ projectId, jobId: mediaJobId }, "match.gemini_outage_abort", {
        checked: vs.checked, errored: vs.errored,
      });
      throw new Error(
        `gemini verification unavailable: ${vs.errored}/${vs.checked} verify attempts errored — ` +
        `failing the job so it retries instead of shipping unverified fallback images`,
      );
    }
  }

  // ---- Final authoritative duration pass (runs on the EXACT array that
  //      gets inserted, after every other pass) -------------------------
  // Goal: guarantee the persisted non-intro timeline sums to voiceoverSeconds
  // within the render-route tolerance, closing the "orphaned narration" bug
  // class (2026-06-16, King Charles project) where a row kept a short planned
  // duration and the picture timeline ended up shorter than the audio.
  //
  // HISTORY / why this pass was rewritten (2026-06-19, Queen Elizabeth II
  // project): the previous version re-derived EVERY adjustable row's duration
  // from vo_start gaps (`next.vo_start - cur.vo_start`) while SKIPPING title
  // cards and duration_clamped rows. That telescoping is subtly lossy:
  //   • the body collapses to (last.vo_start - first.vo_start), silently
  //     dropping any lead-in before the first sentence (first.vo_start > 0);
  //   • every skipped card/clamped row keeps a duration shorter than its
  //     audio interval, so each one removes (interval - duration) from the
  //     total.
  // On this project that turned a correct +1.07s timeline into a -8.51s one
  // (88 rows rewritten, -9.6s reclaimed) — failing the very gate below and
  // looping the match through all 3 BullMQ retries. The earlier
  // vo_start_duration_pass + duration_reclaim + title_card_anchor_pass
  // already reconcile the timeline to ~0 drift IN THE RENDER COORDINATE
  // SYSTEM (items[] is in position == vo_start order by now), so a blanket
  // re-derivation here can only undo their work.
  //
  // The correct final pass therefore CORRECTS RESIDUAL DRIFT ONLY: measure
  // the real shortfall/overage, and if it exceeds a tiny epsilon, absorb it
  // into the tail's adjustable rows (then hard-snap any remainder onto the
  // last adjustable row) — the same mechanism the anchor pass's final-section
  // step uses. This still stretches a short tail row to reach voiceoverSeconds
  // (the orphaned-narration fix) without rewriting rows that are already
  // correctly placed. Idempotent: a timeline already within epsilon is left
  // untouched, so a re-match writes the same values.
  {
    type Row = (typeof items)[number];
    const voOf = (it: Row): number => {
      const m = (it.metadata ?? {}) as Record<string, unknown>;
      const vs = m.vo_start_seconds;
      return typeof vs === "number" ? Number(vs) : Number.NaN;
    };
    // Adjustable = a row we may stretch/shrink to absorb drift. Excludes
    // intro (separate axis), title cards (pinned typewriter+hold beat) and
    // duration_clamped rows (forced YouTube windows / title-card padding the
    // earlier passes already sized).
    const isAdjustable = (it: Row): boolean => {
      if (it.type === "intro" || it.type === "title_card") return false;
      const m = (it.metadata ?? {}) as Record<string, unknown>;
      return m.duration_clamped !== true;
    };
    const setDuration = (row: Row, next: number): number => {
      const cur = Number(row.duration ?? 0);
      const clamped = Math.max(0.3, Math.round(next * 100) / 100);
      row.duration = clamped;
      const m = (row.metadata ?? {}) as Record<string, unknown>;
      const vs = m.vo_start_seconds;
      if (typeof vs === "number") {
        m.vo_end_seconds = Number(vs) + clamped;
        row.metadata = m;
      }
      return clamped - cur;
    };

    const sumNonIntro = (): number =>
      items
        .filter((it) => it.type !== "intro")
        .reduce((s, it) => s + Number(it.duration ?? 0), 0);

    let orphanedResized = 0;
    let orphanedReclaimedSeconds = 0;
    const FINAL_EPSILON = 0.05;
    let residual = voiceoverSeconds - sumNonIntro();
    if (Math.abs(residual) > FINAL_EPSILON) {
      // Spread the drift across the tail's adjustable rows in position order
      // (a couple of even passes), then dump any remainder on the last
      // adjustable row so the total lands exactly on voiceoverSeconds. This
      // never touches a clamped/card row and never depends on first.vo_start.
      const tail = items.filter((it) => it.type !== "intro" && isAdjustable(it));
      for (let pass = 0; pass < 4 && Math.abs(residual) > FINAL_EPSILON; pass++) {
        const eligible = tail.filter(
          (r) => residual > 0 || Number(r.duration ?? 0) > 0.31,
        );
        if (eligible.length === 0) break;
        const share = residual / eligible.length;
        let absorbed = 0;
        for (const r of eligible) {
          const delta = setDuration(r, Number(r.duration ?? 0) + share);
          if (Math.abs(delta) > 0.0001) {
            absorbed += delta;
            orphanedResized++;
            orphanedReclaimedSeconds += delta;
          }
        }
        if (Math.abs(absorbed) < 0.0001) break;
        residual = voiceoverSeconds - sumNonIntro();
      }
      // Final exact snap onto the last adjustable row (respecting the 0.3s
      // floor; any sub-floor remainder is reported via driftSeconds below).
      if (Math.abs(residual) > FINAL_EPSILON && tail.length > 0) {
        const last = tail[tail.length - 1];
        const delta = setDuration(last, Number(last.duration ?? 0) + residual);
        if (Math.abs(delta) > 0.0001) {
          orphanedResized++;
          orphanedReclaimedSeconds += delta;
        }
      }
    }

    const finalNonIntroSum = items
      .filter((it) => it.type !== "intro")
      .reduce((s, it) => s + Number(it.duration ?? 0), 0);
    const finalDriftSeconds = finalNonIntroSum - voiceoverSeconds;
    const FINAL_TOLERANCE_SECONDS = 3; // mirrors the render-route guard

    // When the pass can't close the drift (usually because the shrinkable
    // pool is too small — most duration lives in title cards / clamped rows
    // the pass may not touch), the operator needs to see WHERE the excess
    // lives. Break the persisted sum down by type and by adjustable vs.
    // fixed so a failing re-match is self-diagnosing instead of opaque.
    const durationBreakdown: Record<string, { count: number; dur: number; clamped: number }> = {};
    let adjustablePoolSeconds = 0;
    let adjustablePoolCount = 0;
    for (const it of items) {
      if (it.type === "intro") continue;
      const t = String(it.type);
      const d = Number(it.duration ?? 0);
      durationBreakdown[t] ??= { count: 0, dur: 0, clamped: 0 };
      durationBreakdown[t].count++;
      durationBreakdown[t].dur = Math.round((durationBreakdown[t].dur + d) * 10) / 10;
      if (isAdjustable(it)) {
        adjustablePoolSeconds += d;
        adjustablePoolCount++;
      } else {
        durationBreakdown[t].clamped = Math.round((durationBreakdown[t].clamped + d) * 10) / 10;
      }
    }
    await logJob({ projectId, jobId: mediaJobId }, "match.final_duration_pass", {
      voiceoverSeconds,
      timelineSumSeconds: Math.round(finalNonIntroSum * 1000) / 1000,
      driftSeconds: Math.round(finalDriftSeconds * 100) / 100,
      orphanedResized,
      orphanedReclaimedSeconds: Math.round(orphanedReclaimedSeconds * 10) / 10,
      itemCount: items.filter((it) => it.type !== "intro").length,
      // Diagnostics for an unclosable drift: how much room the pass actually
      // had to shrink/grow, and where the fixed (non-adjustable) time sits.
      adjustablePoolSeconds: Math.round(adjustablePoolSeconds * 10) / 10,
      adjustablePoolCount,
      fixedSeconds: Math.round((finalNonIntroSum - adjustablePoolSeconds) * 10) / 10,
      durationBreakdown,
    });

    // Hard gate: never persist a timeline that the render-route guard would
    // reject. Failing here (instead of silently inserting a short timeline)
    // makes BullMQ retry the match and surfaces the drift in match logs,
    // rather than the operator discovering it at "Start render".
    if (Math.abs(finalDriftSeconds) > FINAL_TOLERANCE_SECONDS) {
      throw new Error(
        `match produced a timeline ${finalDriftSeconds.toFixed(1)}s off the voiceover ` +
          `(timeline ${finalNonIntroSum.toFixed(1)}s vs voiceover ${voiceoverSeconds.toFixed(1)}s, ` +
          `tolerance ±${FINAL_TOLERANCE_SECONDS}s) — refusing to persist a short timeline`,
      );
    }
  }

  await setMediaJob(mediaJobId, { progress: 80 });
  const { error: insErr } = await sb.from("timeline_items").insert(items);
  if (insErr) throw new Error(`insert timeline_items: ${insErr.message}`);

  // Verify the insert actually persisted every row. A single .insert(array)
  // is atomic in PostgREST (it cannot partially commit), but a count-back is
  // cheap insurance against the symptom that started this investigation —
  // the DB holding fewer rows than the matcher built — turning any future
  // silent shortfall into a loud, retryable failure instead of a blocked
  // render the operator has to diagnose by hand.
  {
    const { count, error: countErr } = await sb
      .from("timeline_items")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId);
    if (countErr) {
      await logJob({ projectId, jobId: mediaJobId }, "match.insert_count_check.failed", {
        err: countErr.message,
      });
    } else if ((count ?? 0) !== items.length) {
      throw new Error(
        `timeline_items insert persisted ${count ?? 0}/${items.length} rows — ` +
          `partial insert detected, failing the job for retry`,
      );
    }
  }

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

  } finally {
    // Stop the heartbeat on EVERY exit path — success, early-return failure,
    // or a thrown error that BullMQ will retry. A terminal media_jobs row is
    // ignored by the sweeper anyway, but leaving an interval running across a
    // retry would double up timers, so we always clear it here.
    stopHeartbeat();
  }
}

// Strip punctuation, lowercase, collapse whitespace. Used to compare a
// hint's narration text against doc paragraphs when assigning each hint
// to the paragraph it came from. Same normalization shape as
// reconcileBlocksAgainstSection in lib/ai/segments.ts so a hint that was
// already matched there will match here too.
function normalizeForParagraphMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  transcript: string,
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

  // Pre-compute per-paragraph normalized text so each hint can be tagged
  // with the doc paragraph its narration came from. The planner uses this
  // to refuse to merge hints from different paragraphs. We split on \n
  // because parse.ts joins paragraphs with single newlines (see
  // lib/gdocs/parse.ts:transcript).
  const paragraphNorms = transcript
    .split(/\n+/)
    .map((p) => normalizeForParagraphMatch(p))
    .filter((p) => p.length > 0);
  // Cursor walks forward across paragraphs as we resolve hints in narration
  // order — a hint's first 10 normalized words can appear in many places
  // verbatim (small "the", "and" tokens), but it can only legitimately
  // belong to a paragraph at-or-after the previous hint's paragraph.
  let paragraphCursor = 0;
  function paragraphIndexForHintText(hintText: string): number | null {
    if (paragraphNorms.length === 0) return null;
    const norm = normalizeForParagraphMatch(hintText);
    if (!norm) return null;
    const needle = norm.split(" ").slice(0, 10).join(" ");
    if (!needle) return null;
    for (let p = paragraphCursor; p < paragraphNorms.length; p++) {
      if (paragraphNorms[p].includes(needle)) {
        paragraphCursor = p;
        return p;
      }
    }
    return null;
  }

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
    // Resolve the section title for this segment's first block. Used only
    // as section_title metadata on the first hint — title cards themselves
    // come from the Google Doc, not from this field. Falls back to
    // segmentTopic so the metadata is always populated.
    const rawTitle = (u.sectionTitle && u.sectionTitle.trim())
      || (u.segmentTopic && u.segmentTopic.trim())
      || "";
    const resolvedSectionTitle = rawTitle
      ? rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1)
      : undefined;
    for (let i = 0; i < segBlocks.length; i++) {
      const b = segBlocks[i];
      // Title cards come EXCLUSIVELY from blue-bold paragraphs in the
      // Google Doc. Both AI-driven paths are permanently disabled:
      //   1. segment-opening auto-promotion (was gated on hasDocTitleCards)
      //   2. Gemini's per-block `recommended_visual_type: "title_card"`
      //      — demoted to footage so the AI can't insert chapter cards.
      const geminiSaidTitleCard = b.recommended_visual_type === "title_card";
      const effectiveVisualType = geminiSaidTitleCard
        ? "footage"
        : b.recommended_visual_type;
      hints.push({
        text: b.text,
        resolved_subject: b.resolved_subject || undefined,
        recommended_visual_type: effectiveVisualType,
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
        // Closed-world entity binding from analyze. The matcher uses
        // (type, name) as the verify target and as the routing signal
        // for celebrity_default blocks (which skip the noisy reference
        // search and go straight to the person fallback). Without this,
        // verifyName falls back to refs[0]/ents[0] which often contain
        // common nouns ("transcript", "announcement") that produce
        // pages of useless Gemini verify rejections.
        block_entity: b.block_entity
          ? { type: b.block_entity.type, name: (b.block_entity.name ?? "").trim() }
          : undefined,
        // Doc paragraph this hint's narration came from. Drives the
        // planner's no-merge-across-paragraph rule.
        paragraph_index: paragraphIndexForHintText(b.text),
      });
    }
  }
  // Sanity check: reject only a GROSSLY truncated hint stream (Gemini
  // returned a handful of blocks for a long script), because that would
  // force a degenerate timeline. We must NOT reject a merely coarse plan.
  //
  // These hints feed the transcript-driven builder, which is SENTENCE-driven:
  // it emits one block per sentence and looks each hint up as enrichment, so
  // the block-per-sentence coverage is what matters, not a fixed seconds/block
  // assumption. On long-form narration a legitimate analyze plan averages
  // ~10-15s of speech per block (one sentence each), i.e. ~voiceoverSeconds/12
  // hints. The previous threshold (voiceoverSeconds / 10 — "half of one block
  // per 5s") wrongly classified those complete plans as truncated: a real
  // 39-min King Charles script produced 184 valid blocks but needed 233 to
  // pass, so ALL 184 hints were discarded and the match fell back to the
  // legacy quota planner. That planner has no per-sentence vo_start telescoping
  // and its reclaim/proportional-fit passes could not reconcile the picture
  // timeline to the voiceover, so the final duration gate threw
  // "match produced a timeline 135s off the voiceover" (2026-07-19).
  //
  // A block roughly every 30s or coarser is the real truncation signal (e.g.
  // 5 blocks for a 40-min video); anything denser is a usable plan. Guard the
  // absolute floor at 2 so a very short project still needs a couple of blocks.
  const minReasonable = Math.max(2, Math.floor(voiceoverSeconds / 30));
  if (hints.length < minReasonable) return [];
  return hints;
}

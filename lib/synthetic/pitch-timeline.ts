import { getServerSupabase } from "@/lib/supabase/server";
import { logJob } from "@/lib/jobs/db";

// SALES-PITCH TIMELINE PLACEMENT (migrations 0025 / 0029).
//
// Places the project's sales-pitch video as a single timeline_item near its
// pitch_video_insert_seconds mark. Lives in lib/ rather than in the worker's
// _shared.ts because BOTH the worker (on finalize) and the web app (on upload)
// have to be able to place the pitch — and _shared.ts pulls in the BullMQ queue
// module, which has no business being imported into a Next.js route.
//
// The decision half (WHERE the pitch goes) and the write-plan half (in what
// ORDER the rows are updated) are pure functions, exported and unit-tested. The
// ordering in particular is load-bearing rather than cosmetic: it is what stops
// an interrupted renumber from leaving the pitch at position 0, which is the
// 2026-08-18 "sales pitch shows up at the first second" bug.

// Metadata flag stamped on the single sales-pitch timeline_item so we can find
// (and not duplicate) it across finalize re-runs. The row has no
// synthetic_segment_id, so this is its only stable identity.
const PITCH_TIMELINE_FLAG = "pitch_video";

// Position a freshly-inserted pitch row is parked at until the renumber below
// moves it into place. `timeline_items.position` is a plain `int not null` with
// no default, so the insert MUST supply something — and what it supplies is the
// row's position for as long as the renumber has not finished.
//
// It used to be 0, which meant any interruption between the insert and the
// renumber (a worker redeploy, a Supabase error, a killed job) left the pitch at
// position 0 and the render — which concatenates strictly in position order —
// played the sales pitch as the FIRST thing in the video. Nothing retried it:
// ensurePitchTimelineItem only runs from maybeFinalizeSynthetic, which stops
// firing once the last asset is done, so the broken order was permanent
// (reported 2026-08-18 by Joey: "the sales pitch feature is not working
// correctly / its showing up at the first second").
//
// Parking it past the end of any real timeline makes the worst case "the pitch
// plays last" instead of "the pitch plays first" — still wrong, but not
// video-ruining, and visible in the verification log below. Well under int4 max
// (2147483647) and far above any real block count.
const PITCH_PARKED_POSITION = 2_000_000_000;

/** The subset of a timeline_items row the placement decision needs. */
export interface PitchAnchorRow {
  id: string;
  position: number;
  duration: number | null;
  start_time: number | null;
  script_text: string | null;
}

export interface PitchPlacement {
  // Number of segment rows that play BEFORE the pitch — and, because the
  // renumber lays segments out contiguously from 0, also the pitch row's final
  // `position`.
  boundaryIndex: number;
  snapDeltaSeconds: number;
  // How far the sentence guard pushed the pitch past its nearest boundary.
  sentenceGuardShift: number;
  // Roughly where the pitch lands in the finished video.
  approxStartSeconds: number;
  timelineEndSeconds: number;
  // Durations were unusable and start_time was used to snap instead.
  usedStartTimeFallback: boolean;
  // The snap resolved to index 0 on a long timeline and was overridden.
  frontGuardApplied: boolean;
  // Neither durations nor start_times were usable, so there was nothing to snap
  // to and the pitch was sent to the end of the timeline.
  noTimingData: boolean;
}

/**
 * Decide WHERE the pitch goes: the segment boundary nearest the insert mark, so
 * it never cuts an avatar part mid-sentence.
 *
 * Pure, so the guards below are testable without a database — they exist
 * precisely because the failure they prevent (pitch at 0:00) is invisible until
 * a finished video is watched.
 */
export function planPitchPlacement(
  segmentRows: ReadonlyArray<PitchAnchorRow>,
  insertSeconds: number,
): PitchPlacement {
  // DURATION SANITY. The snap is driven by summing `duration`, so rows carrying
  // no usable duration collapse every boundary to cumulative 0 — and the
  // nearest-boundary search then picks index 0, i.e. the pitch plays first.
  // Fall back to the planner's start_time column, which is independent of it.
  // (Durations are preferred because the renderer's effective cut is
  // duration-driven, while start_time is planner-relative.)
  const totalDurationSeconds = segmentRows.reduce((a, r) => a + (Number(r.duration) || 0), 0);
  const usedStartTimeFallback = totalDurationSeconds <= 0;

  // Cumulative start of each segment row under whichever measure is usable.
  const startOf: number[] = [];
  let cumulative = 0;
  for (const row of segmentRows) {
    startOf.push(usedStartTimeFallback ? Number(row.start_time) || 0 : cumulative);
    cumulative += Number(row.duration) || 0;
  }
  const timelineEndSeconds = usedStartTimeFallback
    ? (startOf[startOf.length - 1] ?? 0)
    : totalDurationSeconds;

  let boundaryIndex = segmentRows.length; // default: append after the last row
  let bestDelta = Infinity;
  for (let i = 0; i < segmentRows.length; i++) {
    const delta = Math.abs(startOf[i] - insertSeconds);
    if (delta < bestDelta) {
      bestDelta = delta;
      boundaryIndex = i;
    }
  }
  // Also consider the very end boundary (after the last row) — covers the rare
  // case the whole video is barely longer than insertSeconds.
  if (Math.abs(timelineEndSeconds - insertSeconds) < bestDelta) {
    boundaryIndex = segmentRows.length;
    bestDelta = Math.abs(timelineEndSeconds - insertSeconds);
  }

  // FRONT GUARD. Index 0 means "play the pitch before anything else". That is a
  // legitimate answer only when the timeline genuinely starts near the insert
  // mark; on a video running well past it, index 0 means the timing data was
  // unusable and the snap fell through to its first candidate. Refuse it and
  // place by proportion of the timeline instead, so a data problem costs an
  // imprecise insertion point rather than a pitch at 0:00.
  //
  // The two failure shapes are handled separately because only one of them
  // leaves anything to reason with:
  //   • PARTIAL loss (durations gone, start_time intact, or the reverse) — the
  //     surviving measure gives a real timeline length, so place by proportion.
  //   • TOTAL loss (neither measure usable) — the timeline has no length at all,
  //     so there is no honest place to put the pitch. Send it to the END rather
  //     than guess: "plays last" is the documented safe direction (see
  //     PITCH_PARKED_POSITION) and "plays first" is the bug being fixed.
  let frontGuardApplied = false;
  let noTimingData = false;
  if (boundaryIndex === 0 && insertSeconds > 0 && segmentRows.length > 1) {
    if (timelineEndSeconds > insertSeconds) {
      const proportion = insertSeconds / timelineEndSeconds;
      boundaryIndex = Math.min(
        segmentRows.length,
        Math.max(1, Math.round(segmentRows.length * proportion)),
      );
      frontGuardApplied = true;
    } else if (timelineEndSeconds <= 0) {
      boundaryIndex = segmentRows.length;
      frontGuardApplied = true;
      noTimingData = true;
    }
    // Otherwise the timeline genuinely ends before the insert mark — a short
    // video, where index 0 is a legitimate answer and must not be overridden.
  }

  // SENTENCE GUARD (client 2026-07-03): a long sentence is time-split by the
  // planner into TWO timeline rows (two visuals, one continuous narration), and
  // both pieces keep the parent's full script. A boundary BETWEEN those pieces
  // is therefore mid-sentence — the narration pauses for the pitch and the
  // sentence resumes after it, which sounds broken. Detect it by adjacent rows
  // carrying identical non-empty script_text, and push the pitch FORWARD to the
  // first boundary after the sentence completes.
  const isMidSentence = (i: number): boolean => {
    if (i <= 0 || i >= segmentRows.length) return false;
    const prev = (segmentRows[i - 1].script_text ?? "").trim();
    const next = (segmentRows[i].script_text ?? "").trim();
    return prev.length > 0 && prev === next;
  };
  const rawBoundaryIndex = boundaryIndex;
  while (isMidSentence(boundaryIndex)) boundaryIndex++;

  return {
    boundaryIndex,
    snapDeltaSeconds: bestDelta,
    sentenceGuardShift: boundaryIndex - rawBoundaryIndex,
    approxStartSeconds: startOf[boundaryIndex] ?? timelineEndSeconds,
    timelineEndSeconds,
    usedStartTimeFallback,
    frontGuardApplied,
    noTimingData,
  };
}

/** One row to move, and where to. */
export interface PositionWrite {
  id: string;
  position: number;
}

/**
 * Decide in what ORDER to write the new positions.
 *
 * These are N separate round-trips with no transaction, so the sequence has to
 * leave a sane timeline at EVERY intermediate state:
 *
 *   1. Segment rows move first, HIGHEST target position first. Descending order
 *      means a row never takes a position another row still holds, so no two
 *      segments ever transiently collide.
 *   2. The pitch row moves LAST, in a single update. Until that write lands the
 *      pitch is parked past the end of the timeline — so an interruption
 *      anywhere in step 1 leaves it playing last, never first.
 *
 * Rows already at their target are omitted, so a settled timeline costs zero
 * writes. Rows that are neither segment nor pitch (an intro row) are left alone
 * — the renderer drops them.
 */
export function buildRenumberPlan(
  segmentIds: ReadonlyArray<string>,
  boundaryIndex: number,
  currentPositions: ReadonlyMap<string, number>,
): { segmentWrites: PositionWrite[]; pitchPosition: number } {
  const segmentWrites: PositionWrite[] = [];
  let p = 0;
  for (let i = 0; i < segmentIds.length; i++) {
    if (i === boundaryIndex) p++; // the slot the pitch will occupy
    const id = segmentIds[i];
    if (currentPositions.get(id) !== p) segmentWrites.push({ id, position: p });
    p++;
  }
  segmentWrites.sort((a, b) => b.position - a.position);
  // The renumber lays segments out contiguously from 0 and gives the pitch the
  // slot at boundaryIndex, so that index IS the pitch's final position.
  return { segmentWrites, pitchPosition: boundaryIndex };
}

/**
 * Insert (or re-position) the sales-pitch video as a single timeline_item near
 * the project's pitch_video_insert_seconds mark, SNAPPED to the nearest segment
 * boundary so it never cuts an avatar part mid-sentence — and, when that
 * boundary falls between the two visual pieces of one time-split sentence,
 * pushed forward past the sentence so the pitch always starts after a full
 * sentence (client 2026-07-03).
 *
 * Idempotent: keyed on metadata.kind === 'pitch_video', so repeated finalize
 * calls update the one row rather than inserting duplicates. After placing the
 * pitch row it renumbers EVERY timeline row (synthetic segments + the pitch row)
 * to contiguous integer positions in timeline order, since the pitch row carries
 * no synthetic_segment_id and is therefore invisible to the segment-only
 * renumber in maybeFinalizeSynthetic.
 *
 * The pitch block is non-voiceover-bearing: it consumes video time but the
 * narration pauses over it (handled in the render route's duration guard +
 * renderProcessor's audio splice). Its duration is the probed/uploaded length,
 * falling back to 0 only when unknown (the render worker re-probes the real
 * file regardless).
 */
export async function ensurePitchTimelineItem(projectId: string): Promise<void> {
  const sb = getServerSupabase();

  const { data: proj } = await sb
    .from("projects")
    .select("pitch_video_url, pitch_video_duration_seconds, pitch_video_insert_seconds")
    .eq("id", projectId)
    .single();
  if (!proj?.pitch_video_url) return; // no pitch video on this project

  const insertAt = Number(proj.pitch_video_insert_seconds);
  const insertSeconds = Number.isFinite(insertAt) && insertAt > 0 ? insertAt : 180;
  const pitchDuration = Number(proj.pitch_video_duration_seconds) || 0;

  // Pull current synthetic timeline rows in order. We rebuild their start_times
  // from the durations rather than trusting the (planner-relative) start_time
  // column, because the renderer's effective cut is duration-driven. start_time
  // is still selected as a FALLBACK for the degenerate case below.
  const { data: rowsRaw, error: rowsErr } = await sb
    .from("timeline_items")
    .select("id, position, duration, start_time, synthetic_segment_id, metadata, script_text")
    .eq("project_id", projectId)
    .order("position", { ascending: true });
  // Never place the pitch off a partial read. A failed select used to surface as
  // "no rows", which reads exactly like "no segments yet" and silently skipped
  // placement.
  if (rowsErr) throw new Error(`ensurePitchTimelineItem load: ${rowsErr.message}`);
  const rows = rowsRaw ?? [];

  // Separate the segment rows (everything with a segment id) from any existing
  // pitch row. We re-place the pitch row among the segment rows below.
  const segmentRows = rows.filter((r) => !!r.synthetic_segment_id);
  const existingPitch = rows.find(
    (r) => ((r.metadata ?? {}) as Record<string, unknown>).kind === PITCH_TIMELINE_FLAG,
  );
  if (segmentRows.length === 0) return; // nothing to anchor against yet

  const placement = planPitchPlacement(
    segmentRows.map((r) => ({
      id: r.id as string,
      position: Number(r.position),
      duration: r.duration as number | null,
      start_time: r.start_time as number | null,
      script_text: r.script_text as string | null,
    })),
    insertSeconds,
  );
  const { boundaryIndex } = placement;
  if (placement.frontGuardApplied) {
    await logJob({ projectId }, "synthetic.pitch_video.front_guard", {
      note:
        "nearest-boundary snap resolved to index 0 on a timeline longer than the " +
        "insert mark — timing data is unusable, placed by proportion instead",
      insertSeconds,
      timelineEndSeconds: Math.round(placement.timelineEndSeconds),
      usedStartTimeFallback: placement.usedStartTimeFallback,
      noTimingData: placement.noTimingData,
      segmentRows: segmentRows.length,
      fallbackBoundaryIndex: boundaryIndex,
    });
  }

  // Upsert the pitch row. A NEW row is parked past the end of the timeline
  // rather than at 0 — see PITCH_PARKED_POSITION. An EXISTING row keeps its
  // current position through this update; the renumber below is what moves it.
  const pitchPayload = {
    project_id: projectId,
    type: PITCH_TIMELINE_FLAG,
    start_time: insertSeconds,
    duration: pitchDuration,
    script_text: null,
    image_url: null,
    video_url: proj.pitch_video_url,
    right_image_url: null,
    approved: true, // not a per-row reviewed asset; pre-approved like the intro
    synthetic_segment_id: null,
    metadata: { kind: PITCH_TIMELINE_FLAG, insert_seconds: insertSeconds },
  };
  // The pitch's final position IS boundaryIndex: the renumber lays the segment
  // rows out contiguously from 0 and gives the pitch the slot at that index.
  // Knowing it up front lets an existing row be parked before anything moves.
  const pitchTargetPosition = boundaryIndex;

  let pitchId: string;
  if (existingPitch) {
    // Park an existing row too, unless it is already exactly where it belongs.
    // A re-run after the old position-0 bug starts with the pitch AT 0, and
    // leaving it there during the segment renumber would preserve the very
    // failure this function is being fixed for if that renumber is interrupted.
    // When it is already correct we write no position at all, so a settled
    // timeline costs zero writes.
    const alreadyPlaced = Number(existingPitch.position) === pitchTargetPosition;
    const { error } = await sb
      .from("timeline_items")
      .update(alreadyPlaced ? pitchPayload : { ...pitchPayload, position: PITCH_PARKED_POSITION })
      .eq("id", existingPitch.id);
    if (error) throw new Error(`ensurePitchTimelineItem update: ${error.message}`);
    pitchId = existingPitch.id as string;
  } else {
    const { data: inserted, error } = await sb
      .from("timeline_items")
      .insert({ ...pitchPayload, position: PITCH_PARKED_POSITION })
      .select("id")
      .single();
    if (error) throw new Error(`ensurePitchTimelineItem insert: ${error.message}`);
    if (!inserted?.id) throw new Error("ensurePitchTimelineItem insert: no id returned");
    pitchId = inserted.id as string;
  }

  // Renumber to contiguous integers in timeline order, splicing the pitch row in
  // at boundaryIndex. Rows that are neither segment nor pitch (an intro row) are
  // left alone, as before — the renderer drops them.
  //
  // WRITE ORDER IS THE FIX — see buildRenumberPlan. Segments move first in
  // descending order; the pitch, parked past the end of the timeline, moves last
  // in a single update. Errors are checked and thrown rather than discarded: a
  // half-finished renumber that reported success is what let a mis-ordered
  // timeline reach the renderer unnoticed.
  const currentPosition = new Map(rows.map((r) => [r.id as string, Number(r.position)]));
  const { segmentWrites, pitchPosition } = buildRenumberPlan(
    segmentRows.map((r) => r.id as string),
    boundaryIndex,
    currentPosition,
  );
  for (const w of segmentWrites) {
    const { error } = await sb.from("timeline_items").update({ position: w.position }).eq("id", w.id);
    if (error) throw new Error(`ensurePitchTimelineItem renumber ${w.id}: ${error.message}`);
  }

  const { error: pitchPosErr } = await sb
    .from("timeline_items")
    .update({ position: pitchPosition })
    .eq("id", pitchId);
  if (pitchPosErr) {
    throw new Error(`ensurePitchTimelineItem pitch position: ${pitchPosErr.message}`);
  }

  // VERIFY. Everything above is best-effort per-row writes against a timeline
  // another finalize may also be touching, so read back what actually landed
  // rather than reporting the intent. `verifiedPosition` disagreeing with
  // `snappedPosition`, or a pitch still parked, is the signal that placement
  // needs looking at — the previous version logged only its intent and so read
  // as a success even when the render disagreed.
  const { data: check } = await sb
    .from("timeline_items")
    .select("position")
    .eq("id", pitchId)
    .single();
  const verifiedPosition = check ? Number(check.position) : null;

  await logJob({ projectId }, "synthetic.pitch_video.placed", {
    insertSeconds,
    snappedBoundaryIndex: boundaryIndex,
    // Non-zero shift = the nearest boundary was inside a time-split sentence
    // and the pitch was pushed forward past it (sentence guard).
    sentenceGuardShift: placement.sentenceGuardShift,
    snapDeltaSeconds: Math.round(placement.snapDeltaSeconds * 100) / 100,
    pitchDurationSeconds: pitchDuration,
    totalRows: segmentRows.length + 1,
    snappedPosition: pitchPosition,
    verifiedPosition,
    // Roughly where the pitch lands in the finished video. The number to compare
    // against what the client reports seeing.
    approxStartSeconds: Math.round(placement.approxStartSeconds),
    segmentRowsRenumbered: segmentWrites.length,
    usedStartTimeFallback: placement.usedStartTimeFallback,
    frontGuardApplied: placement.frontGuardApplied,
  });

  if (verifiedPosition !== pitchPosition) {
    await logJob({ projectId }, "synthetic.pitch_video.placement_mismatch", {
      note:
        "pitch row is not at its intended position after renumber — a concurrent " +
        "finalize may have moved it; the next finalize will re-place it",
      expected: pitchPosition,
      actual: verifiedPosition,
    });
  }
}

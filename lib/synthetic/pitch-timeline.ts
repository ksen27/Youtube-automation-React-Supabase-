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
 *
 * `boundaryIndex = -1` means the project has no sales-pitch video: no slot is
 * reserved and the segments lay out contiguously from 0.
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

/** The subset of a timeline_items row the order reconciler needs. */
export interface TimelineOrderRow {
  id: string;
  position: number;
  synthetic_segment_id: string | null;
}

/**
 * Put the segment rows into their AUTHORITATIVE order.
 *
 * That order is `synthetic_segments.position` — NOT the timeline row's current
 * `position`. This distinction is the whole fix for the 2026-08-21 "the video
 * plays out of order" bug (project e8177073: the last 23 blocks played first and
 * the opening avatar played third). The old code trusted `timeline_items.position`
 * as the running order and only ever compacted it, so once anything scrambled
 * that column the damage was permanent and self-laundering: the compaction
 * rewrote a scrambled order into a *tidy* scrambled order — unique, contiguous,
 * and still wrong, which is exactly why nothing downstream noticed.
 *
 * Re-deriving from the segment table instead makes the reconcile idempotent AND
 * self-healing: any two concurrent runs compute the SAME target from the SAME
 * source, so interleaving their writes can no longer produce a hybrid ordering
 * (the mechanism that broke it — one pass numbering 193 rows while another
 * numbered 215, zippered together row by row).
 *
 * Rows whose segment no longer exists are returned separately: they are dead
 * (the segment was deleted or re-planned) and must not be given a slot.
 */
export function orderSegmentRows<T extends TimelineOrderRow>(
  rows: ReadonlyArray<T>,
  segmentPosition: ReadonlyMap<string, number>,
): { ordered: T[]; orphans: T[] } {
  const ordered: T[] = [];
  const orphans: T[] = [];
  for (const row of rows) {
    if (!row.synthetic_segment_id) continue; // pitch / intro — not a segment row
    if (segmentPosition.has(row.synthetic_segment_id)) ordered.push(row);
    else orphans.push(row);
  }
  ordered.sort((a, b) => {
    const delta =
      segmentPosition.get(a.synthetic_segment_id!)! - segmentPosition.get(b.synthetic_segment_id!)!;
    // Two rows on one segment should be impossible (the partial unique index
    // timeline_items_project_segment_uq), but a tie must still resolve the same
    // way in every process or concurrent reconciles would fight over the slot.
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
  return { ordered, orphans };
}

/**
 * The id order the finished timeline must be in: segments in segment order, with
 * the pitch row spliced in at `boundaryIndex`. Pass `pitchId = null` (and any
 * boundary) for a project with no sales-pitch video.
 */
export function expectedTimelineOrder(
  segmentIds: ReadonlyArray<string>,
  pitchId: string | null,
  boundaryIndex: number,
): string[] {
  const out = [...segmentIds];
  if (!pitchId) return out;
  out.splice(Math.max(0, Math.min(boundaryIndex, segmentIds.length)), 0, pitchId);
  return out;
}

/**
 * Reconcile the WHOLE synthetic timeline's play order, then verify it landed.
 *
 * Two jobs, in this order:
 *   1. Segment rows are renumbered into `synthetic_segments.position` order.
 *   2. The sales-pitch video row (if any) is placed at the segment boundary
 *      nearest its insert mark — snapped so it never cuts a sentence in half.
 *
 * Both are derived from scratch on every call, so this is idempotent, safe to
 * run concurrently, and REPAIRS a timeline that is already wrong. A settled
 * timeline costs zero writes (buildRenumberPlan omits rows already in place),
 * which is what makes it cheap enough to call again right before rendering.
 *
 * Returns whether the finished order verified against the intended one. Callers
 * about to render should refuse to render on `verified: false` rather than ship
 * a scrambled video.
 */
export async function reconcileTimelineOrder(projectId: string): Promise<{
  rows: number;
  writes: number;
  verified: boolean;
  orphanRows: number;
}> {
  const sb = getServerSupabase();

  const [projRes, segsRes, rowsRes] = await Promise.all([
    sb
      .from("projects")
      .select("pitch_video_url, pitch_video_duration_seconds, pitch_video_insert_seconds")
      .eq("id", projectId)
      .single(),
    sb.from("synthetic_segments").select("id, position").eq("project_id", projectId),
    sb
      .from("timeline_items")
      .select("id, position, duration, start_time, synthetic_segment_id, metadata, script_text")
      .eq("project_id", projectId)
      .order("position", { ascending: true }),
  ]);
  // Never reorder off a partial read. A failed select used to surface as "no
  // rows", which reads exactly like "nothing to do" and silently skipped the work.
  if (segsRes.error) throw new Error(`reconcileTimelineOrder segments: ${segsRes.error.message}`);
  if (rowsRes.error) throw new Error(`reconcileTimelineOrder load: ${rowsRes.error.message}`);

  const proj = projRes.data;
  const rows = (rowsRes.data ?? []).map((r) => ({
    id: r.id as string,
    position: Number(r.position),
    duration: r.duration as number | null,
    start_time: r.start_time as number | null,
    script_text: r.script_text as string | null,
    synthetic_segment_id: (r.synthetic_segment_id as string | null) ?? null,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
  const segmentPosition = new Map(
    (segsRes.data ?? []).map((s) => [s.id as string, Number(s.position)] as const),
  );

  const { ordered: segmentRows, orphans } = orderSegmentRows(rows, segmentPosition);
  const existingPitch = rows.find((r) => r.metadata.kind === PITCH_TIMELINE_FLAG);
  if (segmentRows.length === 0) {
    return { rows: rows.length, writes: 0, verified: true, orphanRows: orphans.length };
  }
  if (orphans.length > 0) {
    await logJob({ projectId }, "synthetic.timeline_order.orphan_rows", {
      note: "timeline rows whose synthetic_segment no longer exists — left unplaced",
      count: orphans.length,
    });
  }

  // ---- Where does the pitch go? ----------------------------------------
  // `boundaryIndex` doubles as the pitch row's final position: the renumber lays
  // the segments out contiguously from 0 and leaves it that one slot. -1 means
  // "no pitch on this project", which buildRenumberPlan reads as "leave no gap".
  const hasPitch = !!proj?.pitch_video_url;
  let boundaryIndex = -1;
  let pitchId: string | null = null;
  // Set when the pitch row was already at its slot and so was never parked —
  // there is then nothing to move it back from, and re-writing the position it
  // already holds is the one write that would stop a settled timeline from
  // costing zero.
  let pitchStayedPut = false;

  if (hasPitch) {
    const insertAt = Number(proj!.pitch_video_insert_seconds);
    const insertSeconds = Number.isFinite(insertAt) && insertAt > 0 ? insertAt : 180;
    const pitchDuration = Number(proj!.pitch_video_duration_seconds) || 0;

    // Snap against the rows IN SEGMENT ORDER. Snapping against the stored order
    // would sum the durations of a shuffled timeline, so a scrambled `position`
    // column used to drag the pitch out of place too.
    const placement = planPitchPlacement(
      segmentRows.map((r) => ({
        id: r.id,
        position: r.position,
        duration: r.duration,
        start_time: r.start_time,
        script_text: r.script_text,
      })),
      insertSeconds,
    );
    boundaryIndex = placement.boundaryIndex;
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
    // rather than at 0 — see PITCH_PARKED_POSITION. An EXISTING row is parked
    // too unless it is already exactly where it belongs, so an interrupted
    // renumber leaves the pitch playing LAST rather than first.
    const pitchPayload = {
      project_id: projectId,
      type: PITCH_TIMELINE_FLAG,
      start_time: insertSeconds,
      duration: pitchDuration,
      script_text: null,
      image_url: null,
      video_url: proj!.pitch_video_url,
      right_image_url: null,
      approved: true, // not a per-row reviewed asset; pre-approved like the intro
      synthetic_segment_id: null,
      metadata: { kind: PITCH_TIMELINE_FLAG, insert_seconds: insertSeconds },
    };
    const pitchAlreadyPlaced = !!existingPitch && existingPitch.position === boundaryIndex;
    if (existingPitch) {
      const { error } = await sb
        .from("timeline_items")
        .update(
          pitchAlreadyPlaced ? pitchPayload : { ...pitchPayload, position: PITCH_PARKED_POSITION },
        )
        .eq("id", existingPitch.id);
      if (error) throw new Error(`reconcileTimelineOrder pitch update: ${error.message}`);
      pitchId = existingPitch.id;
    } else {
      const { data: inserted, error } = await sb
        .from("timeline_items")
        .insert({ ...pitchPayload, position: PITCH_PARKED_POSITION })
        .select("id")
        .single();
      if (error) throw new Error(`reconcileTimelineOrder pitch insert: ${error.message}`);
      if (!inserted?.id) throw new Error("reconcileTimelineOrder pitch insert: no id returned");
      pitchId = inserted.id as string;
    }
    // The pitch is parked NOW, so the map the write plan reasons about has to say
    // so — otherwise the plan reads it as already in place and never brings it
    // back off the parking slot.
    if (pitchAlreadyPlaced) {
      pitchStayedPut = true;
    } else {
      const parked = rows.find((r) => r.id === pitchId);
      if (parked) parked.position = PITCH_PARKED_POSITION;
    }
  } else if (existingPitch) {
    // The pitch video was removed from the project but its row outlived it. Drop
    // it rather than leave a stale block in the render.
    const { error } = await sb.from("timeline_items").delete().eq("id", existingPitch.id);
    if (error) throw new Error(`reconcileTimelineOrder stale pitch delete: ${error.message}`);
  }

  // ---- Write the new order ---------------------------------------------
  // WRITE ORDER IS LOAD-BEARING — see buildRenumberPlan. Segments move first in
  // descending order; the pitch, parked past the end of the timeline, moves last
  // in a single update. Errors throw rather than being discarded: a half-finished
  // renumber that reported success is what let a mis-ordered timeline reach the
  // renderer unnoticed.
  const segmentIds = segmentRows.map((r) => r.id);
  const currentPosition = new Map(rows.map((r) => [r.id, r.position] as const));
  const { segmentWrites, pitchPosition } = buildRenumberPlan(
    segmentIds,
    boundaryIndex,
    currentPosition,
  );
  for (const w of segmentWrites) {
    const { error } = await sb.from("timeline_items").update({ position: w.position }).eq("id", w.id);
    if (error) throw new Error(`reconcileTimelineOrder renumber ${w.id}: ${error.message}`);
  }
  const pitchMoved = !!pitchId && !pitchStayedPut;
  if (pitchMoved) {
    const { error } = await sb
      .from("timeline_items")
      .update({ position: pitchPosition })
      .eq("id", pitchId!);
    if (error) throw new Error(`reconcileTimelineOrder pitch position: ${error.message}`);
  }

  // ---- VERIFY ----------------------------------------------------------
  // Everything above is best-effort per-row writes against a timeline another
  // finalize may also be touching, so read back what actually LANDED rather than
  // reporting the intent. This is the check that was missing: the old code
  // verified only the pitch row's position, so a scrambled SEGMENT order passed
  // inspection all the way into the finished video.
  const expected = expectedTimelineOrder(segmentIds, pitchId, boundaryIndex);
  const { data: after, error: afterErr } = await sb
    .from("timeline_items")
    .select("id, synthetic_segment_id, metadata")
    .eq("project_id", projectId)
    .order("position", { ascending: true });
  if (afterErr) throw new Error(`reconcileTimelineOrder verify: ${afterErr.message}`);
  const orphanIds = new Set(orphans.map((o) => o.id));
  const actual = (after ?? [])
    .filter((r) => !orphanIds.has(r.id as string))
    .filter(
      (r) =>
        !!r.synthetic_segment_id ||
        ((r.metadata ?? {}) as Record<string, unknown>).kind === PITCH_TIMELINE_FLAG,
    )
    .map((r) => r.id as string);
  const divergence = expected.findIndex((id, i) => actual[i] !== id);
  const verified = actual.length === expected.length && divergence === -1;

  await logJob({ projectId }, "synthetic.timeline_order.reconciled", {
    rows: rows.length,
    segmentRows: segmentRows.length,
    orphanRows: orphans.length,
    segmentRowsRenumbered: segmentWrites.length,
    hasPitch,
    snappedPosition: pitchId ? pitchPosition : null,
    verified,
    // Only meaningful on failure: where the landed order first disagrees.
    firstDivergenceIndex: verified ? null : divergence,
  });
  if (!verified) {
    await logJob({ projectId }, "synthetic.timeline_order.mismatch", {
      note:
        "timeline did not land in the intended order — a concurrent finalize may " +
        "have been mid-write. The render gate re-runs this and refuses to render " +
        "until it verifies.",
      expectedRows: expected.length,
      actualRows: actual.length,
      firstDivergenceIndex: divergence,
    });
  }

  return {
    rows: rows.length,
    writes: segmentWrites.length + (pitchMoved ? 1 : 0),
    verified,
    orphanRows: orphans.length,
  };
}

/**
 * Insert (or re-position) the sales-pitch video as a single timeline_item near
 * the project's pitch_video_insert_seconds mark, SNAPPED to the nearest segment
 * boundary so it never cuts an avatar part mid-sentence — and, when that
 * boundary falls between the two visual pieces of one time-split sentence,
 * pushed forward past the sentence so the pitch always starts after a full
 * sentence (client 2026-07-03).
 *
 * Thin wrapper now: placing the pitch is one half of reconciling the timeline's
 * play order, and doing either half on its own is what let the two disagree.
 * There is exactly ONE routine that writes `timeline_items.position`.
 */
export async function ensurePitchTimelineItem(projectId: string): Promise<void> {
  await reconcileTimelineOrder(projectId);
}

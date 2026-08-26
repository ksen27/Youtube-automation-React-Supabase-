// Fractional ordering for lists and cards.
//
// The rule from the brief — "do not rely only on array indexes" — exists because
// index-based ordering makes every reorder an O(n) rewrite of the column, which
// both costs a round trip per row and loses to a concurrent editor. Instead each
// row owns a `position` double and a move writes exactly ONE row: the midpoint
// between the two rows it landed between.
//
// The cost of midpoints is precision. Repeatedly dropping a card between the
// same two neighbours halves the gap each time, and a double runs out of
// mantissa after ~50 such moves. `needsNormalize` detects that BEFORE the gap
// collapses to zero (which would make two rows compare equal and the order
// non-deterministic); the caller then renumbers the column via the
// board_normalize_* SQL functions and recomputes.
//
// Pure module — no imports, no I/O — so it is cheap to unit-test exhaustively.

/**
 * Spacing between freshly numbered rows. Matches the literal used by
 * board_create / board_normalize_* in migration 0037 — change both together.
 */
export const POSITION_STEP = 65536;

/**
 * Smallest gap we are willing to split. Well above the point where doubles get
 * lossy, so a normalize is triggered with room to spare rather than after the
 * ordering has already degraded.
 */
export const MIN_GAP = 0.5;

/**
 * The position for a row dropped between `prev` and `next`.
 *
 * `null` means "no neighbour on that side": at the top of a column, at the
 * bottom, or into an empty column. Appending to the end keeps growing by a full
 * step, so the common case (add a card) never narrows a gap at all.
 */
export function positionBetween(prev: number | null, next: number | null): number {
  if (prev == null && next == null) return POSITION_STEP;
  if (prev == null) return (next as number) - POSITION_STEP;
  if (next == null) return prev + POSITION_STEP;
  return (prev + next) / 2;
}

/**
 * True when the gap between two neighbours is too small to split again, so the
 * caller must renumber the column first. Only meaningful when both neighbours
 * exist — an open end always has a full step of room.
 */
export function needsNormalize(prev: number | null, next: number | null): boolean {
  if (prev == null || next == null) return false;
  return Math.abs(next - prev) < MIN_GAP;
}

export interface Positioned {
  id: string;
  position: number;
}

/**
 * Resolve the neighbours of a drop target from the ordered rows of the
 * destination column.
 *
 * The client sends a target INDEX (what the drag library knows) rather than
 * neighbour ids, and the server re-reads the column to turn that index into
 * positions. Doing it server-side means a stale client — one whose column has
 * changed since its last fetch — lands next to whatever is actually there now
 * instead of writing a position derived from rows that have since moved.
 *
 * `movingId` is excluded first: when a card moves down within its own column,
 * the index the user sees already accounts for the hole it left behind.
 */
export function neighborsForIndex(
  ordered: readonly Positioned[],
  targetIndex: number,
  movingId?: string,
): { prev: number | null; next: number | null } {
  const rows = movingId ? ordered.filter((r) => r.id !== movingId) : [...ordered];
  const i = Math.max(0, Math.min(Math.trunc(targetIndex), rows.length));
  return {
    prev: i > 0 ? rows[i - 1].position : null,
    next: i < rows.length ? rows[i].position : null,
  };
}

/** Evenly spaced positions for `count` rows — mirrors the SQL normalize. */
export function normalizedPositions(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * POSITION_STEP);
}

/** Ascending by position, with created-at as the tiebreak, like the SQL does. */
export function byPosition<T extends { position: number; createdAt?: string }>(
  a: T,
  b: T,
): number {
  if (a.position !== b.position) return a.position - b.position;
  return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
}

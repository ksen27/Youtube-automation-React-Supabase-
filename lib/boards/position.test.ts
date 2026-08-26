import { describe, expect, it } from "vitest";
import {
  MIN_GAP,
  POSITION_STEP,
  byPosition,
  needsNormalize,
  neighborsForIndex,
  normalizedPositions,
  positionBetween,
} from "./position";

// Ordering is the part of a board that silently corrupts if it is wrong: a
// duplicated or NaN position means two cards compare equal and the column
// renders in a different order on every refresh. These tests pin the algebra.

describe("positionBetween", () => {
  it("seeds an empty column with a full step", () => {
    expect(positionBetween(null, null)).toBe(POSITION_STEP);
  });

  it("appends a full step past the last row", () => {
    expect(positionBetween(1000, null)).toBe(1000 + POSITION_STEP);
  });

  it("prepends a full step before the first row", () => {
    expect(positionBetween(1000, null)).toBeGreaterThan(1000);
    expect(positionBetween(null, 1000)).toBe(1000 - POSITION_STEP);
  });

  it("takes the midpoint between two neighbours", () => {
    expect(positionBetween(100, 200)).toBe(150);
  });

  it("stays strictly between its neighbours", () => {
    // The invariant the whole scheme rests on: a new position must sort after
    // `prev` and before `next`, never equal to either.
    const value = positionBetween(1, 2);
    expect(value).toBeGreaterThan(1);
    expect(value).toBeLessThan(2);
  });

  it("survives repeated inserts at the head of a column", () => {
    let head = POSITION_STEP;
    for (let i = 0; i < 50; i++) {
      const next = positionBetween(null, head);
      expect(next).toBeLessThan(head);
      head = next;
    }
  });
});

describe("needsNormalize", () => {
  it("is false at an open end, where there is always room", () => {
    expect(needsNormalize(null, 5)).toBe(false);
    expect(needsNormalize(5, null)).toBe(false);
  });

  it("is false for a healthy gap", () => {
    expect(needsNormalize(0, POSITION_STEP)).toBe(false);
  });

  it("is true once neighbours are within the precision floor", () => {
    expect(needsNormalize(1, 1 + MIN_GAP / 2)).toBe(true);
  });

  it("catches the gap collapse produced by repeated midpoints", () => {
    // Dropping between the same two rows over and over is the pathological
    // case; it must be flagged before the gap reaches zero, not after.
    const low = 0;
    let high = POSITION_STEP;
    let flagged = false;
    for (let i = 0; i < 60 && !flagged; i++) {
      const mid = positionBetween(low, high);
      flagged = needsNormalize(low, mid);
      high = mid;
    }
    expect(flagged).toBe(true);
    expect(high).toBeGreaterThan(low);
  });
});

describe("neighborsForIndex", () => {
  const column = [
    { id: "a", position: 100 },
    { id: "b", position: 200 },
    { id: "c", position: 300 },
  ];

  it("resolves the top of a column", () => {
    expect(neighborsForIndex(column, 0)).toEqual({ prev: null, next: 100 });
  });

  it("resolves the bottom of a column", () => {
    expect(neighborsForIndex(column, 3)).toEqual({ prev: 300, next: null });
  });

  it("resolves a middle slot", () => {
    expect(neighborsForIndex(column, 1)).toEqual({ prev: 100, next: 200 });
  });

  it("excludes the moving row so a downward move lands where the user sees it", () => {
    // Moving "a" to index 1 means "after b": with `a` removed the column is
    // [b, c], so index 1 sits between them. Without the exclusion this would
    // resolve to a's own slot and the card would not appear to move at all.
    expect(neighborsForIndex(column, 1, "a")).toEqual({ prev: 200, next: 300 });
  });

  it("clamps an out-of-range index instead of producing undefined neighbours", () => {
    expect(neighborsForIndex(column, 99)).toEqual({ prev: 300, next: null });
    expect(neighborsForIndex(column, -5)).toEqual({ prev: null, next: 100 });
  });

  it("treats an empty column as open at both ends", () => {
    expect(neighborsForIndex([], 0)).toEqual({ prev: null, next: null });
  });
});

describe("normalizedPositions", () => {
  it("spaces rows by the step, matching the SQL normalize", () => {
    expect(normalizedPositions(3)).toEqual([POSITION_STEP, POSITION_STEP * 2, POSITION_STEP * 3]);
  });

  it("restores room to insert after a collapse", () => {
    const [first, second] = normalizedPositions(2);
    expect(needsNormalize(first, second)).toBe(false);
  });
});

describe("byPosition", () => {
  it("sorts ascending by position", () => {
    const rows = [
      { id: "c", position: 300 },
      { id: "a", position: 100 },
      { id: "b", position: 200 },
    ];
    expect([...rows].sort(byPosition).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties on createdAt so equal positions still render deterministically", () => {
    const rows = [
      { id: "newer", position: 100, createdAt: "2026-08-02T00:00:00.000Z" },
      { id: "older", position: 100, createdAt: "2026-08-01T00:00:00.000Z" },
    ];
    expect([...rows].sort(byPosition).map((r) => r.id)).toEqual(["older", "newer"]);
  });
});

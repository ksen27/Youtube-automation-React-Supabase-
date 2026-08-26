import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  activeFilterCount,
  filterCards,
  isFilterActive,
  matchesFilter,
  toggleId,
  type BoardFilter,
} from "./filter";
import type { BoardCard } from "./types";

// `now` is fixed so "overdue"/"due today"/"this week" are deterministic rather
// than depending on when CI happens to run.
const NOW = new Date(2026, 7, 20, 12, 0, 0);

// Due dates are stored as UTC instants but bucketed by the VIEWER's calendar
// day, so these helpers build the fixtures from local components — hard-coding
// a Z-suffixed string would make the suite pass or fail depending on the
// machine's timezone rather than on the code.
const localIso = (year: number, month: number, day: number, hour = 12): string =>
  new Date(year, month - 1, day, hour).toISOString();

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "card-1",
    boardId: "board-1",
    listId: "list-1",
    title: "Write the script",
    description: "Draft the opening hook",
    position: 100,
    completed: false,
    startAt: null,
    dueAt: null,
    coverColor: null,
    coverImageUrl: null,
    createdBy: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    archivedAt: null,
    labelIds: [],
    memberIds: [],
    checklistTotal: 0,
    checklistDone: 0,
    commentCount: 0,
    attachmentCount: 0,
    ...overrides,
  };
}

const filter = (overrides: Partial<BoardFilter> = {}): BoardFilter => ({
  ...EMPTY_FILTER,
  ...overrides,
});

describe("keyword search", () => {
  it("matches the title case-insensitively", () => {
    expect(matchesFilter(card(), filter({ keyword: "SCRIPT" }), NOW)).toBe(true);
  });

  it("ignores descriptions unless asked", () => {
    expect(matchesFilter(card(), filter({ keyword: "hook" }), NOW)).toBe(false);
    expect(
      matchesFilter(card(), filter({ keyword: "hook", searchDescriptions: true }), NOW),
    ).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesFilter(card(), filter({ keyword: "invoice" }), NOW)).toBe(false);
  });
});

describe("member and label filters", () => {
  it("matches ANY of the selected members", () => {
    const assigned = card({ memberIds: ["m2"] });
    expect(matchesFilter(assigned, filter({ memberIds: ["m1", "m2"] }), NOW)).toBe(true);
    expect(matchesFilter(assigned, filter({ memberIds: ["m1"] }), NOW)).toBe(false);
  });

  it("matches ANY of the selected labels", () => {
    const labelled = card({ labelIds: ["l1"] });
    expect(matchesFilter(labelled, filter({ labelIds: ["l1", "l2"] }), NOW)).toBe(true);
    expect(matchesFilter(labelled, filter({ labelIds: ["l9"] }), NOW)).toBe(false);
  });

  it("ANDs across categories", () => {
    // Assigned to m1 but carrying the wrong label: the union inside each
    // category must not leak into a union across categories.
    const subject = card({ memberIds: ["m1"], labelIds: ["l1"] });
    expect(
      matchesFilter(subject, filter({ memberIds: ["m1"], labelIds: ["l2"] }), NOW),
    ).toBe(false);
  });
});

describe("due-date filter", () => {
  it("finds overdue cards", () => {
    const overdue = card({ dueAt: localIso(2026, 8, 19) });
    expect(matchesFilter(overdue, filter({ due: "overdue" }), NOW)).toBe(true);
  });

  it("never calls a completed card overdue", () => {
    const done = card({ dueAt: localIso(2026, 8, 19), completed: true });
    expect(matchesFilter(done, filter({ due: "overdue" }), NOW)).toBe(false);
  });

  it("finds cards due today", () => {
    const today = card({ dueAt: localIso(2026, 8, 20, 23) });
    expect(matchesFilter(today, filter({ due: "today" }), NOW)).toBe(true);
  });

  it("finds cards due within the week but not beyond it", () => {
    expect(
      matchesFilter(card({ dueAt: localIso(2026, 8, 25) }), filter({ due: "week" }), NOW),
    ).toBe(true);
    expect(
      matchesFilter(card({ dueAt: localIso(2026, 9, 25) }), filter({ due: "week" }), NOW),
    ).toBe(false);
  });

  it("finds cards with no due date", () => {
    expect(matchesFilter(card(), filter({ due: "none" }), NOW)).toBe(true);
    expect(
      matchesFilter(card({ dueAt: localIso(2026, 8, 25) }), filter({ due: "none" }), NOW),
    ).toBe(false);
  });

  it("excludes undated cards from every dated bucket", () => {
    expect(matchesFilter(card(), filter({ due: "overdue" }), NOW)).toBe(false);
    expect(matchesFilter(card(), filter({ due: "today" }), NOW)).toBe(false);
  });
});

describe("completion filter", () => {
  it("separates complete from incomplete", () => {
    expect(matchesFilter(card({ completed: true }), filter({ completion: "complete" }), NOW)).toBe(true);
    expect(matchesFilter(card({ completed: true }), filter({ completion: "incomplete" }), NOW)).toBe(false);
  });
});

describe("filterCards", () => {
  const cards = [
    card({ id: "a", title: "Record voiceover", memberIds: ["m1"] }),
    card({ id: "b", title: "Edit the cut", memberIds: ["m2"] }),
    card({ id: "c", title: "Publish", completed: true }),
  ];

  it("returns every card when nothing is filtered", () => {
    expect(filterCards(cards, EMPTY_FILTER, NOW)).toHaveLength(3);
  });

  it("filters without mutating the input — filtering must never lose data", () => {
    const result = filterCards(cards, filter({ completion: "incomplete" }), NOW);
    expect(result.map((c) => c.id)).toEqual(["a", "b"]);
    expect(cards).toHaveLength(3);
  });
});

describe("filter state helpers", () => {
  it("reports an empty filter as inactive", () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive(filter({ keyword: "   " }))).toBe(false);
  });

  it("counts one per active category", () => {
    expect(activeFilterCount(filter({ keyword: "x", memberIds: ["m1"], due: "overdue" }))).toBe(3);
  });

  it("toggles ids immutably", () => {
    const ids = ["a"];
    expect(toggleId(ids, "b")).toEqual(["a", "b"]);
    expect(toggleId(ids, "a")).toEqual([]);
    expect(ids).toEqual(["a"]);
  });
});

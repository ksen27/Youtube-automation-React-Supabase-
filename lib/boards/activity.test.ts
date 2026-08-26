import { describe, expect, it } from "vitest";
import { BOARD_ACTIONS, describeActivity } from "./activity";
import { formatDue, daysUntil, isOverdue } from "./dates";
import type { BoardActivityEntry } from "./types";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function entry(actionType: string, metadata: Record<string, unknown> = {}): BoardActivityEntry {
  return {
    id: "a1",
    boardId: "b1",
    cardId: "c1",
    actorMemberId: "m1",
    actionType,
    metadata,
    createdAt: "2026-08-20T11:00:00.000Z",
  };
}

describe("describeActivity", () => {
  it("renders a move using the list names in the metadata", () => {
    const text = describeActivity(
      entry(BOARD_ACTIONS.cardMoved, { fromList: "To Do", toList: "In Progress" }),
      "Sarah",
    );
    expect(text).toBe('Sarah moved this card from "To Do" to "In Progress"');
  });

  it("names the actor for creation", () => {
    expect(describeActivity(entry(BOARD_ACTIONS.cardCreated, { listTitle: "Ideas" }), "John")).toBe(
      'John added this card to "Ideas"',
    );
  });

  it("falls back to Someone when the member has been removed", () => {
    expect(describeActivity(entry(BOARD_ACTIONS.commentCreated), null)).toBe("Someone commented");
  });

  it("degrades gracefully when metadata is missing", () => {
    // Rows written by an older version must keep rendering rather than throwing
    // in the middle of the feed.
    expect(describeActivity(entry(BOARD_ACTIONS.cardMoved), "Sarah")).toBe("Sarah moved this card");
  });

  it("renders an unknown action type instead of blanking the feed", () => {
    expect(describeActivity(entry("card.teleported"), "Sarah")).toBe("Sarah updated this board");
  });

  it("distinguishes setting a due date from clearing it", () => {
    expect(
      describeActivity(entry(BOARD_ACTIONS.cardDatesChanged, { dueAt: "2026-08-25T00:00:00Z" }), "Ben"),
    ).toBe("Ben set the due date");
    expect(describeActivity(entry(BOARD_ACTIONS.cardDatesChanged, {}), "Ben")).toBe(
      "Ben cleared the due date",
    );
  });
});

describe("formatDue", () => {
  it("says Completed for a finished card, even a late one", () => {
    expect(formatDue("2026-08-01T00:00:00.000Z", true, NOW)).toEqual({
      text: "Completed",
      tone: "done",
    });
  });

  it("flags a past due date as overdue", () => {
    expect(formatDue("2026-08-18T00:00:00.000Z", false, NOW)?.tone).toBe("overdue");
  });

  it("says Due tomorrow", () => {
    expect(formatDue("2026-08-21T09:00:00.000Z", false, NOW)?.text).toBe("Due tomorrow");
  });

  it("falls back to a date beyond a week out", () => {
    const due = formatDue("2026-09-15T09:00:00.000Z", false, NOW);
    expect(due?.tone).toBe("neutral");
    expect(due?.text.startsWith("Due ")).toBe(true);
  });

  it("returns nothing when there is no due date", () => {
    expect(formatDue(null, false, NOW)).toBeNull();
  });

  it("ignores an unparseable stored value rather than rendering Invalid Date", () => {
    expect(formatDue("not-a-date", false, NOW)).toBeNull();
  });
});

describe("date helpers", () => {
  it("counts whole calendar days, not elapsed hours", () => {
    // 23:00 today and 01:00 tomorrow are two hours apart but one day apart.
    expect(daysUntil(new Date("2026-08-20T23:00:00"), new Date("2026-08-20T01:00:00"))).toBe(0);
    expect(daysUntil(new Date("2026-08-21T01:00:00"), new Date("2026-08-20T23:00:00"))).toBe(1);
  });

  it("treats a completed card as never overdue", () => {
    expect(isOverdue("2026-01-01T00:00:00.000Z", true, NOW)).toBe(false);
    expect(isOverdue("2026-01-01T00:00:00.000Z", false, NOW)).toBe(true);
  });
});

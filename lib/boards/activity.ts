// Activity events: the action vocabulary, and the sentence rendering.
//
// The brief's rule — "create an activity/event model instead of storing activity
// as plain text" — is why board_activity stores `action_type` + a jsonb
// `metadata` blob and nothing human-readable. The wording lives HERE, in one
// pure function, so changing copy (or adding a translation) is a code change
// rather than a backfill of every historical row.
//
// Metadata is deliberately typed as unknown-valued and read defensively: rows
// written by an older version of the app must keep rendering, so a missing key
// degrades to a vaguer sentence rather than throwing in the feed.

import type { BoardActivityEntry } from "./types";

export const BOARD_ACTIONS = {
  boardCreated: "board.created",
  boardUpdated: "board.updated",
  boardArchived: "board.archived",

  listCreated: "list.created",
  listRenamed: "list.renamed",
  listArchived: "list.archived",
  listDeleted: "list.deleted",
  listsReordered: "list.reordered",

  cardCreated: "card.created",
  cardMoved: "card.moved",
  cardRenamed: "card.renamed",
  cardDescribed: "card.described",
  cardDatesChanged: "card.dates_changed",
  cardCompleted: "card.completed",
  cardReopened: "card.reopened",
  cardArchived: "card.archived",
  cardRestored: "card.restored",
  cardDeleted: "card.deleted",

  memberAssigned: "card.member_assigned",
  memberUnassigned: "card.member_unassigned",
  labelAdded: "card.label_added",
  labelRemoved: "card.label_removed",

  checklistCreated: "checklist.created",
  checklistRenamed: "checklist.renamed",
  checklistDeleted: "checklist.deleted",
  checklistItemAdded: "checklist.item_added",
  checklistItemCompleted: "checklist.item_completed",
  checklistItemReopened: "checklist.item_reopened",
  checklistItemDeleted: "checklist.item_deleted",

  commentCreated: "comment.created",
  commentDeleted: "comment.deleted",

  attachmentAdded: "attachment.added",
  attachmentRemoved: "attachment.removed",
} as const;

export type BoardActionType = (typeof BOARD_ACTIONS)[keyof typeof BOARD_ACTIONS];

function str(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function quoted(value: string | null, fallback: string): string {
  return value ? `"${value}"` : fallback;
}

/**
 * Render one event as a sentence, e.g.
 *   `Sarah moved this card from "To Do" to "In Progress"`.
 *
 * `actorName` is resolved by the caller from the members list (null when the
 * member has since been removed — the event still stands, so it reads as
 * "Someone").
 */
export function describeActivity(entry: BoardActivityEntry, actorName: string | null): string {
  const who = actorName ?? "Someone";
  const m = entry.metadata ?? {};

  switch (entry.actionType) {
    case BOARD_ACTIONS.boardCreated:
      return `${who} created the board ${quoted(str(m, "name"), "")}`.trim();
    case BOARD_ACTIONS.boardUpdated:
      return `${who} updated the board details`;
    case BOARD_ACTIONS.boardArchived:
      return `${who} archived the board`;

    case BOARD_ACTIONS.listCreated:
      return `${who} added the list ${quoted(str(m, "title"), "")}`.trim();
    case BOARD_ACTIONS.listRenamed:
      return `${who} renamed ${quoted(str(m, "from"), "a list")} to ${quoted(str(m, "to"), "something else")}`;
    case BOARD_ACTIONS.listArchived:
      return `${who} archived the list ${quoted(str(m, "title"), "")}`.trim();
    case BOARD_ACTIONS.listDeleted:
      return `${who} deleted the list ${quoted(str(m, "title"), "")}`.trim();
    case BOARD_ACTIONS.listsReordered:
      return `${who} reordered the lists`;

    case BOARD_ACTIONS.cardCreated:
      return `${who} added this card to ${quoted(str(m, "listTitle"), "the board")}`;
    case BOARD_ACTIONS.cardMoved: {
      const from = str(m, "fromList");
      const to = str(m, "toList");
      if (!from && !to) return `${who} moved this card`;
      return `${who} moved this card from ${quoted(from, "another list")} to ${quoted(to, "another list")}`;
    }
    case BOARD_ACTIONS.cardRenamed:
      return `${who} renamed this card to ${quoted(str(m, "to"), "a new title")}`;
    case BOARD_ACTIONS.cardDescribed:
      return `${who} updated the description`;
    case BOARD_ACTIONS.cardDatesChanged: {
      const due = str(m, "dueAt");
      return due ? `${who} set the due date` : `${who} cleared the due date`;
    }
    case BOARD_ACTIONS.cardCompleted:
      return `${who} completed this card`;
    case BOARD_ACTIONS.cardReopened:
      return `${who} marked this card incomplete`;
    case BOARD_ACTIONS.cardArchived:
      return `${who} archived this card`;
    case BOARD_ACTIONS.cardRestored:
      return `${who} restored this card`;
    case BOARD_ACTIONS.cardDeleted:
      return `${who} deleted a card`;

    case BOARD_ACTIONS.memberAssigned:
      return `${who} assigned ${str(m, "memberName") ?? "someone"}`;
    case BOARD_ACTIONS.memberUnassigned:
      return `${who} unassigned ${str(m, "memberName") ?? "someone"}`;
    case BOARD_ACTIONS.labelAdded:
      return `${who} added the label ${quoted(str(m, "labelName") || str(m, "labelColor"), "")}`.trim();
    case BOARD_ACTIONS.labelRemoved:
      return `${who} removed the label ${quoted(str(m, "labelName") || str(m, "labelColor"), "")}`.trim();

    case BOARD_ACTIONS.checklistCreated:
      return `${who} added the checklist ${quoted(str(m, "title"), "")}`.trim();
    case BOARD_ACTIONS.checklistRenamed:
      return `${who} renamed a checklist to ${quoted(str(m, "to"), "something else")}`;
    case BOARD_ACTIONS.checklistDeleted:
      return `${who} deleted the checklist ${quoted(str(m, "title"), "")}`.trim();
    case BOARD_ACTIONS.checklistItemAdded:
      return `${who} added ${quoted(str(m, "title"), "an item")} to a checklist`;
    case BOARD_ACTIONS.checklistItemCompleted:
      return `${who} completed ${quoted(str(m, "title"), "a checklist item")}`;
    case BOARD_ACTIONS.checklistItemReopened:
      return `${who} reopened ${quoted(str(m, "title"), "a checklist item")}`;
    case BOARD_ACTIONS.checklistItemDeleted:
      return `${who} removed ${quoted(str(m, "title"), "a checklist item")}`;

    case BOARD_ACTIONS.commentCreated:
      return `${who} commented`;
    case BOARD_ACTIONS.commentDeleted:
      return `${who} deleted a comment`;

    case BOARD_ACTIONS.attachmentAdded:
      return `${who} attached ${quoted(str(m, "name"), "a file")}`;
    case BOARD_ACTIONS.attachmentRemoved:
      return `${who} removed the attachment ${quoted(str(m, "name"), "")}`.trim();

    default:
      // Forward compatibility: an event written by a newer deploy still renders
      // as something, rather than blanking the feed.
      return `${who} updated this board`;
  }
}

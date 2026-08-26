// Shared board types. Imported by both the server service layer and the client
// components, so this file must stay free of any server-only import.
//
// Naming: DB columns are snake_case; everything that crosses the API boundary
// is camelCase. The mapping happens once, in lib/boards/service.ts, so no UI
// code ever has to know a column name.

export type BoardRole = "owner" | "member" | "viewer";
export type BoardVisibility = "workspace" | "private";

export interface Board {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  theme: string;
  visibility: BoardVisibility;
  ownerMemberId: string | null;
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BoardSummary extends Board {
  listCount: number;
  cardCount: number;
  memberCount: number;
}

export interface BoardMember {
  id: string;
  boardId: string;
  displayName: string;
  role: BoardRole;
  color: string;
  createdAt: string;
}

export interface BoardLabel {
  id: string;
  boardId: string;
  name: string;
  color: string;
  position: number;
}

export interface BoardList {
  id: string;
  boardId: string;
  title: string;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A card as rendered in a column. Carries only the metadata the preview needs —
 * the heavy relations (checklist items, comments, attachments, activity) are
 * loaded on demand by the detail view, so opening a board never pays for them.
 */
export interface BoardCard {
  id: string;
  boardId: string;
  listId: string;
  title: string;
  description: string;
  position: number;
  completed: boolean;
  startAt: string | null;
  dueAt: string | null;
  coverColor: string | null;
  coverImageUrl: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  labelIds: string[];
  memberIds: string[];
  checklistTotal: number;
  checklistDone: number;
  commentCount: number;
  attachmentCount: number;
}

export interface BoardChecklistItem {
  id: string;
  checklistId: string;
  title: string;
  completed: boolean;
  position: number;
  assigneeMemberId: string | null;
  dueAt: string | null;
}

export interface BoardChecklist {
  id: string;
  cardId: string;
  title: string;
  position: number;
  items: BoardChecklistItem[];
}

export interface BoardComment {
  id: string;
  cardId: string;
  authorMemberId: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoardAttachment {
  id: string;
  cardId: string;
  name: string;
  url: string;
  storageKey: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  addedBy: string | null;
  createdAt: string;
}

/** A structured event. The sentence is built in the UI — see activity.ts. */
export interface BoardActivityEntry {
  id: string;
  boardId: string;
  cardId: string | null;
  actorMemberId: string | null;
  actionType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Everything the board page needs for its first paint, in one response. */
export interface BoardSnapshot {
  board: Board;
  members: BoardMember[];
  labels: BoardLabel[];
  lists: BoardList[];
  cards: BoardCard[];
}

/** The card detail view's payload — fetched only when a card is opened. */
export interface BoardCardDetail {
  card: BoardCard;
  checklists: BoardChecklist[];
  comments: BoardComment[];
  attachments: BoardAttachment[];
  activity: BoardActivityEntry[];
}

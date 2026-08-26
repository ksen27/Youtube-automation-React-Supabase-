// Database row shapes and the snake_case -> camelCase mapping.
//
// supabase-js returns untyped rows, and the alternative to declaring them is
// `any` leaking through the whole service layer. Keeping the row types and the
// mappers together in one file means there is exactly one place that knows a
// column name, and the compiler catches a renamed column at every call site.

import type {
  Board,
  BoardActivityEntry,
  BoardAttachment,
  BoardCard,
  BoardChecklist,
  BoardChecklistItem,
  BoardComment,
  BoardLabel,
  BoardList,
  BoardMember,
  BoardRole,
  BoardVisibility,
} from "./types";

export interface BoardRow {
  id: string;
  name: string;
  description: string;
  project_id: string | null;
  theme: string;
  visibility: string;
  owner_member_id: string | null;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardMemberRow {
  id: string;
  board_id: string;
  display_name: string;
  role: string;
  color: string;
  created_at: string;
}

export interface BoardLabelRow {
  id: string;
  board_id: string;
  name: string;
  color: string;
  position: number;
}

export interface BoardListRow {
  id: string;
  board_id: string;
  title: string;
  position: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardCardRow {
  id: string;
  board_id: string;
  list_id: string;
  title: string;
  description: string;
  position: number;
  completed: boolean;
  start_at: string | null;
  due_at: string | null;
  cover_color: string | null;
  cover_image_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface BoardChecklistRow {
  id: string;
  card_id: string;
  title: string;
  position: number;
}

export interface BoardChecklistItemRow {
  id: string;
  checklist_id: string;
  title: string;
  completed: boolean;
  position: number;
  assignee_member_id: string | null;
  due_at: string | null;
}

export interface BoardCommentRow {
  id: string;
  card_id: string;
  board_id: string;
  author_member_id: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface BoardAttachmentRow {
  id: string;
  card_id: string;
  board_id: string;
  name: string;
  url: string;
  storage_key: string | null;
  content_type: string | null;
  size_bytes: number | null;
  added_by: string | null;
  created_at: string;
}

export interface BoardActivityRow {
  id: string;
  board_id: string;
  card_id: string | null;
  actor_member_id: string | null;
  action_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Counts and relation ids the card preview needs, gathered by the service. */
export interface CardAggregates {
  labelIds: string[];
  memberIds: string[];
  checklistTotal: number;
  checklistDone: number;
  commentCount: number;
  attachmentCount: number;
}

const EMPTY_AGGREGATES: CardAggregates = {
  labelIds: [],
  memberIds: [],
  checklistTotal: 0,
  checklistDone: 0,
  commentCount: 0,
  attachmentCount: 0,
};

// The DB constrains these columns already; the casts below narrow the `string`
// PostgREST hands back to the union the app uses, and fall back to the safest
// value rather than trusting a row written before a constraint existed.
function asRole(value: string): BoardRole {
  return value === "owner" || value === "viewer" ? value : "member";
}

function asVisibility(value: string): BoardVisibility {
  return value === "private" ? "private" : "workspace";
}

export function mapBoard(row: BoardRow): Board {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    projectId: row.project_id,
    theme: row.theme,
    visibility: asVisibility(row.visibility),
    ownerMemberId: row.owner_member_id,
    revision: Number(row.revision),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapMember(row: BoardMemberRow): BoardMember {
  return {
    id: row.id,
    boardId: row.board_id,
    displayName: row.display_name,
    role: asRole(row.role),
    color: row.color,
    createdAt: row.created_at,
  };
}

export function mapLabel(row: BoardLabelRow): BoardLabel {
  return {
    id: row.id,
    boardId: row.board_id,
    name: row.name,
    color: row.color,
    position: row.position,
  };
}

export function mapList(row: BoardListRow): BoardList {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    position: row.position,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCard(row: BoardCardRow, aggregates: CardAggregates = EMPTY_AGGREGATES): BoardCard {
  return {
    id: row.id,
    boardId: row.board_id,
    listId: row.list_id,
    title: row.title,
    description: row.description,
    position: row.position,
    completed: row.completed,
    startAt: row.start_at,
    dueAt: row.due_at,
    coverColor: row.cover_color,
    coverImageUrl: row.cover_image_url,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    ...aggregates,
  };
}

export function mapChecklistItem(row: BoardChecklistItemRow): BoardChecklistItem {
  return {
    id: row.id,
    checklistId: row.checklist_id,
    title: row.title,
    completed: row.completed,
    position: row.position,
    assigneeMemberId: row.assignee_member_id,
    dueAt: row.due_at,
  };
}

export function mapChecklist(
  row: BoardChecklistRow,
  items: BoardChecklistItem[] = [],
): BoardChecklist {
  return {
    id: row.id,
    cardId: row.card_id,
    title: row.title,
    position: row.position,
    items,
  };
}

export function mapComment(row: BoardCommentRow): BoardComment {
  return {
    id: row.id,
    cardId: row.card_id,
    authorMemberId: row.author_member_id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAttachment(row: BoardAttachmentRow): BoardAttachment {
  return {
    id: row.id,
    cardId: row.card_id,
    name: row.name,
    url: row.url,
    storageKey: row.storage_key,
    contentType: row.content_type,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    addedBy: row.added_by,
    createdAt: row.created_at,
  };
}

export function mapActivity(row: BoardActivityRow): BoardActivityEntry {
  return {
    id: row.id,
    boardId: row.board_id,
    cardId: row.card_id,
    actorMemberId: row.actor_member_id,
    actionType: row.action_type,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

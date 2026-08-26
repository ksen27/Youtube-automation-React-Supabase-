"use client";

// Browser-side API client for boards.
//
// One `request` helper so every call attaches the acting identity the same way
// and surfaces server errors as real Error objects — which is what lets the
// optimistic mutations in components/boards/use-board.ts roll back on failure
// instead of leaving the UI showing a change the server rejected.

import { ACTOR_HEADER } from "./constants";
import type {
  Board,
  BoardAttachment,
  BoardCard,
  BoardCardDetail,
  BoardChecklist,
  BoardChecklistItem,
  BoardComment,
  BoardLabel,
  BoardList,
  BoardMember,
  BoardRole,
  BoardSnapshot,
  BoardSummary,
} from "./types";

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  actorId?: string | null;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.actorId ? { [ACTOR_HEADER]: options.actorId } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    // The API always answers with `{ error }`; fall back to the status when a
    // proxy or a crash returns something else entirely.
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

const base = (boardId: string) => `/api/boards/${boardId}`;

export const boardsApi = {
  listBoards: (includeArchived = false) =>
    request<{ boards: BoardSummary[] }>(`/api/boards${includeArchived ? "?archived=true" : ""}`).then(
      (r) => r.boards,
    ),

  createBoard: (input: {
    name: string;
    description?: string;
    ownerName: string;
    theme?: string;
    visibility?: "workspace" | "private";
    projectId?: string | null;
  }) => request<{ board: Board }>("/api/boards", { method: "POST", body: input }).then((r) => r.board),

  getSnapshot: (boardId: string, actorId: string | null, signal?: AbortSignal) =>
    request<BoardSnapshot>(base(boardId), { actorId, signal }),

  updateBoard: (
    boardId: string,
    actorId: string | null,
    input: {
      name?: string;
      description?: string;
      theme?: string;
      visibility?: "workspace" | "private";
      archived?: boolean;
    },
  ) => request<{ board: Board }>(base(boardId), { method: "PATCH", body: input, actorId }).then((r) => r.board),

  deleteBoard: (boardId: string, actorId: string | null) =>
    request<{ ok: true }>(base(boardId), { method: "DELETE", actorId }),

  // Lists -------------------------------------------------------------------
  createList: (boardId: string, actorId: string | null, title: string) =>
    request<{ list: BoardList }>(`${base(boardId)}/lists`, {
      method: "POST",
      body: { title },
      actorId,
    }).then((r) => r.list),

  updateList: (
    boardId: string,
    actorId: string | null,
    listId: string,
    input: { title?: string; archived?: boolean; targetIndex?: number },
  ) =>
    request<{ list: BoardList }>(`${base(boardId)}/lists/${listId}`, {
      method: "PATCH",
      body: input,
      actorId,
    }).then((r) => r.list),

  deleteList: (boardId: string, actorId: string | null, listId: string) =>
    request<{ ok: true }>(`${base(boardId)}/lists/${listId}`, { method: "DELETE", actorId }),

  // Cards -------------------------------------------------------------------
  createCard: (
    boardId: string,
    actorId: string | null,
    input: { listId: string; title: string; description?: string },
  ) =>
    request<{ card: BoardCard }>(`${base(boardId)}/cards`, { method: "POST", body: input, actorId }).then(
      (r) => r.card,
    ),

  getCardDetail: (boardId: string, actorId: string | null, cardId: string, signal?: AbortSignal) =>
    request<BoardCardDetail>(`${base(boardId)}/cards/${cardId}`, { actorId, signal }),

  updateCard: (
    boardId: string,
    actorId: string | null,
    cardId: string,
    input: {
      title?: string;
      description?: string;
      completed?: boolean;
      startAt?: string | null;
      dueAt?: string | null;
      coverColor?: string | null;
      archived?: boolean;
    },
  ) =>
    request<{ card: BoardCard }>(`${base(boardId)}/cards/${cardId}`, {
      method: "PATCH",
      body: input,
      actorId,
    }).then((r) => r.card),

  deleteCard: (boardId: string, actorId: string | null, cardId: string) =>
    request<{ ok: true }>(`${base(boardId)}/cards/${cardId}`, { method: "DELETE", actorId }),

  /** Called ONCE per drag, on drop — never while dragging. */
  moveCard: (
    boardId: string,
    actorId: string | null,
    cardId: string,
    input: { listId: string; targetIndex: number },
  ) =>
    request<{ card: BoardCard }>(`${base(boardId)}/cards/${cardId}/move`, {
      method: "POST",
      body: input,
      actorId,
    }).then((r) => r.card),

  toggleCardLabel: (
    boardId: string,
    actorId: string | null,
    cardId: string,
    labelId: string,
    attached: boolean,
  ) =>
    request<{ ok: true }>(`${base(boardId)}/cards/${cardId}/labels`, {
      method: "POST",
      body: { labelId, attached },
      actorId,
    }),

  toggleCardMember: (
    boardId: string,
    actorId: string | null,
    cardId: string,
    memberId: string,
    assigned: boolean,
  ) =>
    request<{ ok: true }>(`${base(boardId)}/cards/${cardId}/members`, {
      method: "POST",
      body: { memberId, assigned },
      actorId,
    }),

  // Checklists --------------------------------------------------------------
  createChecklist: (boardId: string, actorId: string | null, cardId: string, title: string) =>
    request<{ checklist: BoardChecklist }>(`${base(boardId)}/cards/${cardId}/checklists`, {
      method: "POST",
      body: { title },
      actorId,
    }).then((r) => r.checklist),

  updateChecklist: (boardId: string, actorId: string | null, checklistId: string, title: string) =>
    request<{ checklist: BoardChecklist }>(`${base(boardId)}/checklists/${checklistId}`, {
      method: "PATCH",
      body: { title },
      actorId,
    }).then((r) => r.checklist),

  deleteChecklist: (boardId: string, actorId: string | null, checklistId: string) =>
    request<{ ok: true }>(`${base(boardId)}/checklists/${checklistId}`, { method: "DELETE", actorId }),

  createChecklistItem: (
    boardId: string,
    actorId: string | null,
    checklistId: string,
    input: { title: string; assigneeMemberId?: string | null; dueAt?: string | null },
  ) =>
    request<{ item: BoardChecklistItem }>(`${base(boardId)}/checklists/${checklistId}/items`, {
      method: "POST",
      body: input,
      actorId,
    }).then((r) => r.item),

  updateChecklistItem: (
    boardId: string,
    actorId: string | null,
    itemId: string,
    input: {
      title?: string;
      completed?: boolean;
      assigneeMemberId?: string | null;
      dueAt?: string | null;
      targetIndex?: number;
    },
  ) =>
    request<{ item: BoardChecklistItem }>(`${base(boardId)}/checklist-items/${itemId}`, {
      method: "PATCH",
      body: input,
      actorId,
    }).then((r) => r.item),

  deleteChecklistItem: (boardId: string, actorId: string | null, itemId: string) =>
    request<{ ok: true }>(`${base(boardId)}/checklist-items/${itemId}`, { method: "DELETE", actorId }),

  // Comments ----------------------------------------------------------------
  createComment: (boardId: string, actorId: string | null, cardId: string, content: string) =>
    request<{ comment: BoardComment }>(`${base(boardId)}/cards/${cardId}/comments`, {
      method: "POST",
      body: { content },
      actorId,
    }).then((r) => r.comment),

  updateComment: (boardId: string, actorId: string | null, commentId: string, content: string) =>
    request<{ comment: BoardComment }>(`${base(boardId)}/comments/${commentId}`, {
      method: "PATCH",
      body: { content },
      actorId,
    }).then((r) => r.comment),

  deleteComment: (boardId: string, actorId: string | null, commentId: string) =>
    request<{ ok: true }>(`${base(boardId)}/comments/${commentId}`, { method: "DELETE", actorId }),

  // Attachments -------------------------------------------------------------
  createAttachment: (
    boardId: string,
    actorId: string | null,
    cardId: string,
    input: {
      name: string;
      url: string;
      storageKey?: string | null;
      contentType?: string | null;
      sizeBytes?: number | null;
    },
  ) =>
    request<{ attachment: BoardAttachment }>(`${base(boardId)}/cards/${cardId}/attachments`, {
      method: "POST",
      body: input,
      actorId,
    }).then((r) => r.attachment),

  presignAttachment: (
    boardId: string,
    actorId: string | null,
    cardId: string,
    input: { filename: string; contentType: string; size: number },
  ) =>
    request<{ uploadUrl: string; storageKey: string; publicUrl: string }>(
      `${base(boardId)}/cards/${cardId}/attachments/presign`,
      { method: "POST", body: input, actorId },
    ),

  deleteAttachment: (boardId: string, actorId: string | null, attachmentId: string) =>
    request<{ ok: true }>(`${base(boardId)}/attachments/${attachmentId}`, {
      method: "DELETE",
      actorId,
    }),

  // Labels & members --------------------------------------------------------
  createLabel: (boardId: string, actorId: string | null, input: { name: string; color: string }) =>
    request<{ label: BoardLabel }>(`${base(boardId)}/labels`, { method: "POST", body: input, actorId }).then(
      (r) => r.label,
    ),

  updateLabel: (
    boardId: string,
    actorId: string | null,
    labelId: string,
    input: { name?: string; color?: string },
  ) =>
    request<{ label: BoardLabel }>(`${base(boardId)}/labels/${labelId}`, {
      method: "PATCH",
      body: input,
      actorId,
    }).then((r) => r.label),

  deleteLabel: (boardId: string, actorId: string | null, labelId: string) =>
    request<{ ok: true }>(`${base(boardId)}/labels/${labelId}`, { method: "DELETE", actorId }),

  addMember: (
    boardId: string,
    actorId: string | null,
    input: { displayName: string; role?: BoardRole; color?: string },
  ) =>
    request<{ member: BoardMember }>(`${base(boardId)}/members`, {
      method: "POST",
      body: input,
      actorId,
    }).then((r) => r.member),

  updateMember: (
    boardId: string,
    actorId: string | null,
    memberId: string,
    input: { displayName?: string; role?: BoardRole; color?: string },
  ) =>
    request<{ member: BoardMember }>(`${base(boardId)}/members/${memberId}`, {
      method: "PATCH",
      body: input,
      actorId,
    }).then((r) => r.member),

  removeMember: (boardId: string, actorId: string | null, memberId: string) =>
    request<{ ok: true }>(`${base(boardId)}/members/${memberId}`, { method: "DELETE", actorId }),
};

// ---------------------------------------------------------------------------
// Acting identity
// ---------------------------------------------------------------------------

/**
 * Which board member "you" are, remembered per board in localStorage.
 *
 * This exists because the app authenticates an ORGANISATION, not a person (one
 * shared password — see lib/auth.ts). Attribution on a board still needs a
 * person, so the browser remembers which member you picked. It is a preference,
 * not a credential: the server re-checks that the id is a member of the board
 * before it will attribute anything to it, and never grants a role on the
 * strength of the claim alone.
 */
const ACTOR_KEY_PREFIX = "cf.board.actor.";

export function readStoredActor(boardId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTOR_KEY_PREFIX + boardId);
  } catch {
    return null; // private mode / storage disabled — the board still works
  }
}

const ACTOR_EVENT = "cf:board-actor-changed";

export function writeStoredActor(boardId: string, memberId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (memberId) window.localStorage.setItem(ACTOR_KEY_PREFIX + boardId, memberId);
    else window.localStorage.removeItem(ACTOR_KEY_PREFIX + boardId);
  } catch {
    /* non-fatal */
  }
  // localStorage only fires `storage` in OTHER tabs, so this synthetic event is
  // what tells the current tab's subscribers to re-read.
  window.dispatchEvent(new Event(ACTOR_EVENT));
}

/**
 * Subscribe to identity changes, for `useSyncExternalStore`.
 *
 * Reading localStorage this way (rather than in an effect that calls setState)
 * keeps the value out of React state entirely: the server renders "no identity
 * chosen", the client subscribes and re-reads, and a change in another tab
 * propagates for free through the `storage` event.
 */
export function subscribeStoredActor(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(ACTOR_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(ACTOR_EVENT, onChange);
  };
}

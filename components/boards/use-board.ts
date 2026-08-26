"use client";

// React Query wiring for a board: the snapshot query, the live stream, the
// acting identity, and the optimistic mutations.
//
// The whole board is ONE query (`["board", boardId]`) holding a BoardSnapshot.
// That is deliberate: drag-and-drop needs to move a card between two lists
// atomically from the UI's point of view, and with one cache entry that is a
// single `setQueryData` rather than a coordinated edit of two independent
// caches that can render mid-flight.
//
// Every mutation follows the same three-step shape React Query is built for:
//   onMutate   — cancel in-flight refetches, snapshot the cache, apply the
//                change locally so the UI responds instantly;
//   onError    — put the snapshot back and surface the message;
//   onSettled  — invalidate, so the server's version wins in the end.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  boardsApi,
  readStoredActor,
  subscribeStoredActor,
  writeStoredActor,
} from "@/lib/boards/client";
import { byPosition, positionBetween } from "@/lib/boards/position";
import type {
  BoardCard,
  BoardCardDetail,
  BoardMember,
  BoardSnapshot,
} from "@/lib/boards/types";

export const boardKey = (boardId: string) => ["board", boardId] as const;
export const cardKey = (boardId: string, cardId: string) =>
  ["board", boardId, "card", cardId] as const;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Who "you" are on this board.
 *
 * Read from localStorage on the client and defaulted to the board owner, so a
 * first-time visitor is attributed to someone real rather than to nobody.
 */
export function useBoardActor(boardId: string, members: BoardMember[]) {
  // The choice lives in localStorage, which is an external store — reading it
  // through useSyncExternalStore (rather than an effect that calls setState)
  // means the server snapshot is honestly "nothing chosen yet", the client
  // re-reads on subscribe, and switching identity in another tab propagates
  // here for free.
  const stored = useSyncExternalStore(
    subscribeStoredActor,
    () => readStoredActor(boardId),
    () => null,
  );

  const actorId = useMemo(() => {
    // A stored id that is no longer a member — that person was removed — falls
    // back to the first member rather than sending a claim the server rejects.
    if (stored && members.some((m) => m.id === stored)) return stored;
    return members[0]?.id ?? null;
  }, [stored, members]);

  const chooseActor = useCallback(
    (memberId: string | null) => writeStoredActor(boardId, memberId),
    [boardId],
  );

  const actor = useMemo(
    () => members.find((m) => m.id === actorId) ?? null,
    [members, actorId],
  );

  return { actorId, actor, chooseActor };
}

// ---------------------------------------------------------------------------
// Snapshot + live updates
// ---------------------------------------------------------------------------

export function useBoardSnapshot(boardId: string, initialData: BoardSnapshot, actorId: string | null) {
  return useQuery({
    queryKey: boardKey(boardId),
    queryFn: ({ signal }) => boardsApi.getSnapshot(boardId, actorId, signal),
    initialData,
    // The board is server-rendered for first paint and then kept fresh by the
    // SSE stream below, so background polling would be pure noise.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Subscribe to the board's SSE stream and refetch when the revision changes.
 *
 * The stream carries only a revision number — see the route's header for why —
 * so the reconciliation path is the ordinary query refetch, not a second,
 * subtly different merge implementation.
 *
 * `skipUntil` suppresses the refetch immediately after our own writes: our
 * optimistic state is already correct, and refetching mid-drag would fight the
 * user's cursor.
 */
export function useBoardStream(boardId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const suppressUntil = useRef(0);

  const suppress = useCallback((ms = 1200) => {
    suppressUntil.current = Date.now() + ms;
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const source = new EventSource(`/api/boards/${boardId}/events`);
    let firstMessage = true;

    source.onmessage = (event) => {
      // The stream always opens with the current revision; that first frame is
      // what we already have, so acting on it would refetch on every mount.
      if (firstMessage) {
        firstMessage = false;
        return;
      }
      if (Date.now() < suppressUntil.current) return;
      const payload = JSON.parse(event.data) as { revision?: number; error?: string };
      if (payload.revision !== undefined) {
        void queryClient.invalidateQueries({ queryKey: boardKey(boardId) });
      }
    };

    // A dropped stream is not worth surfacing: EventSource reconnects on its
    // own, and the board stays usable (and refetches on focus) meanwhile.
    source.onerror = () => {};

    return () => source.close();
  }, [boardId, enabled, queryClient]);

  return { suppress };
}

// ---------------------------------------------------------------------------
// Local snapshot helpers — pure functions over the cached board
// ---------------------------------------------------------------------------

export function cardsInList(snapshot: BoardSnapshot, listId: string): BoardCard[] {
  return snapshot.cards.filter((c) => c.listId === listId).sort(byPosition);
}

/**
 * Move a card in the CACHED snapshot, giving it a fractional position between
 * its new neighbours — the same algebra the server will apply. Computing a real
 * position (rather than relying on array order) means the optimistic state
 * sorts identically to the server's answer, so the card does not visibly jump
 * when the refetch lands.
 */
export function moveCardLocally(
  snapshot: BoardSnapshot,
  cardId: string,
  listId: string,
  targetIndex: number,
): BoardSnapshot {
  const moving = snapshot.cards.find((c) => c.id === cardId);
  if (!moving) return snapshot;

  const destination = snapshot.cards
    .filter((c) => c.listId === listId && c.id !== cardId)
    .sort(byPosition);
  const index = Math.max(0, Math.min(targetIndex, destination.length));
  const prev = index > 0 ? destination[index - 1].position : null;
  const next = index < destination.length ? destination[index].position : null;

  return {
    ...snapshot,
    cards: snapshot.cards.map((c) =>
      c.id === cardId ? { ...c, listId, position: positionBetween(prev, next) } : c,
    ),
  };
}

export function moveListLocally(
  snapshot: BoardSnapshot,
  listId: string,
  targetIndex: number,
): BoardSnapshot {
  const others = snapshot.lists.filter((l) => l.id !== listId).sort(byPosition);
  const index = Math.max(0, Math.min(targetIndex, others.length));
  const prev = index > 0 ? others[index - 1].position : null;
  const next = index < others.length ? others[index].position : null;

  return {
    ...snapshot,
    lists: snapshot.lists.map((l) =>
      l.id === listId ? { ...l, position: positionBetween(prev, next) } : l,
    ),
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface BoardMutationOptions {
  boardId: string;
  actorId: string | null;
  /** Surfaces a failure to the user; the cache has already been rolled back. */
  onError?: (message: string) => void;
  /** Called around our own writes so the SSE stream does not refetch over them. */
  suppressStream?: (ms?: number) => void;
}

export function useBoardMutations({ boardId, actorId, onError, suppressStream }: BoardMutationOptions) {
  const queryClient = useQueryClient();

  /** Snapshot → mutate → rollback, shared by every optimistic mutation below. */
  const optimistic = useCallback(
    async (mutate: (current: BoardSnapshot) => BoardSnapshot) => {
      await queryClient.cancelQueries({ queryKey: boardKey(boardId) });
      const previous = queryClient.getQueryData<BoardSnapshot>(boardKey(boardId));
      if (previous) queryClient.setQueryData(boardKey(boardId), mutate(previous));
      suppressStream?.();
      return { previous };
    },
    [boardId, queryClient, suppressStream],
  );

  const rollback = useCallback(
    (context: { previous?: BoardSnapshot } | undefined, error: unknown) => {
      if (context?.previous) queryClient.setQueryData(boardKey(boardId), context.previous);
      onError?.(error instanceof Error ? error.message : "Something went wrong.");
    },
    [boardId, queryClient, onError],
  );

  const settle = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: boardKey(boardId) });
  }, [boardId, queryClient]);

  const invalidateCard = useCallback(
    (cardId: string) => {
      void queryClient.invalidateQueries({ queryKey: cardKey(boardId, cardId) });
      void queryClient.invalidateQueries({ queryKey: boardKey(boardId) });
    },
    [boardId, queryClient],
  );

  // -- cards ---------------------------------------------------------------

  const createCard = useMutation({
    mutationFn: (input: { listId: string; title: string }) =>
      boardsApi.createCard(boardId, actorId, input),
    // No optimistic insert: a card has a server-assigned id, and rendering a
    // placeholder that cannot be opened or dragged is worse than the ~100ms
    // wait. The inline form keeps focus so typing the next card is unblocked.
    onError: (error) => onError?.(error instanceof Error ? error.message : "Could not add the card."),
    onSettled: settle,
  });

  const moveCard = useMutation({
    mutationFn: (input: { cardId: string; listId: string; targetIndex: number }) =>
      boardsApi.moveCard(boardId, actorId, input.cardId, {
        listId: input.listId,
        targetIndex: input.targetIndex,
      }),
    onMutate: (input) =>
      optimistic((current) => moveCardLocally(current, input.cardId, input.listId, input.targetIndex)),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: settle,
  });

  const updateCard = useMutation({
    mutationFn: (input: {
      cardId: string;
      patch: Parameters<typeof boardsApi.updateCard>[3];
    }) => boardsApi.updateCard(boardId, actorId, input.cardId, input.patch),
    onMutate: (input) =>
      optimistic((current) => ({
        ...current,
        cards: current.cards
          // `archived` is not a card field — an archived card leaves the board.
          .filter((c) => !(c.id === input.cardId && input.patch.archived === true))
          .map((c) =>
            c.id === input.cardId
              ? {
                  ...c,
                  ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
                  ...(input.patch.description !== undefined
                    ? { description: input.patch.description }
                    : {}),
                  ...(input.patch.completed !== undefined
                    ? { completed: input.patch.completed }
                    : {}),
                  ...(input.patch.dueAt !== undefined ? { dueAt: input.patch.dueAt } : {}),
                  ...(input.patch.startAt !== undefined ? { startAt: input.patch.startAt } : {}),
                  ...(input.patch.coverColor !== undefined
                    ? { coverColor: input.patch.coverColor }
                    : {}),
                }
              : c,
          ),
      })),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: (_data, _error, input) => invalidateCard(input.cardId),
  });

  const deleteCard = useMutation({
    mutationFn: (cardId: string) => boardsApi.deleteCard(boardId, actorId, cardId),
    onMutate: (cardId) =>
      optimistic((current) => ({ ...current, cards: current.cards.filter((c) => c.id !== cardId) })),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: settle,
  });

  const toggleLabel = useMutation({
    mutationFn: (input: { cardId: string; labelId: string; attached: boolean }) =>
      boardsApi.toggleCardLabel(boardId, actorId, input.cardId, input.labelId, input.attached),
    onMutate: (input) =>
      optimistic((current) => ({
        ...current,
        cards: current.cards.map((c) =>
          c.id === input.cardId
            ? {
                ...c,
                labelIds: input.attached
                  ? [...new Set([...c.labelIds, input.labelId])]
                  : c.labelIds.filter((id) => id !== input.labelId),
              }
            : c,
        ),
      })),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: (_data, _error, input) => invalidateCard(input.cardId),
  });

  const toggleMember = useMutation({
    mutationFn: (input: { cardId: string; memberId: string; assigned: boolean }) =>
      boardsApi.toggleCardMember(boardId, actorId, input.cardId, input.memberId, input.assigned),
    onMutate: (input) =>
      optimistic((current) => ({
        ...current,
        cards: current.cards.map((c) =>
          c.id === input.cardId
            ? {
                ...c,
                memberIds: input.assigned
                  ? [...new Set([...c.memberIds, input.memberId])]
                  : c.memberIds.filter((id) => id !== input.memberId),
              }
            : c,
        ),
      })),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: (_data, _error, input) => invalidateCard(input.cardId),
  });

  // -- lists ---------------------------------------------------------------

  const createList = useMutation({
    mutationFn: (title: string) => boardsApi.createList(boardId, actorId, title),
    onError: (error) => onError?.(error instanceof Error ? error.message : "Could not add the list."),
    onSettled: settle,
  });

  const updateList = useMutation({
    mutationFn: (input: { listId: string; title?: string; archived?: boolean }) =>
      boardsApi.updateList(boardId, actorId, input.listId, input),
    onMutate: (input) =>
      optimistic((current) => ({
        ...current,
        lists: current.lists
          .filter((l) => !(l.id === input.listId && input.archived === true))
          .map((l) =>
            l.id === input.listId && input.title !== undefined ? { ...l, title: input.title } : l,
          ),
      })),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: settle,
  });

  const moveList = useMutation({
    mutationFn: (input: { listId: string; targetIndex: number }) =>
      boardsApi.updateList(boardId, actorId, input.listId, { targetIndex: input.targetIndex }),
    onMutate: (input) =>
      optimistic((current) => moveListLocally(current, input.listId, input.targetIndex)),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: settle,
  });

  const deleteList = useMutation({
    mutationFn: (listId: string) => boardsApi.deleteList(boardId, actorId, listId),
    onMutate: (listId) =>
      optimistic((current) => ({
        ...current,
        lists: current.lists.filter((l) => l.id !== listId),
        cards: current.cards.filter((c) => c.listId !== listId),
      })),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: settle,
  });

  // -- board, labels, members ----------------------------------------------

  const updateBoard = useMutation({
    mutationFn: (input: Parameters<typeof boardsApi.updateBoard>[2]) =>
      boardsApi.updateBoard(boardId, actorId, input),
    onMutate: (input) =>
      optimistic((current) => ({ ...current, board: { ...current.board, ...input } })),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: settle,
  });

  const deleteBoard = useMutation({
    mutationFn: () => boardsApi.deleteBoard(boardId, actorId),
    // No optimistic removal: the caller navigates away from a board that no
    // longer exists, and rewriting the cache first would blank the screen
    // before the request has been accepted.
    onError: (error) => onError?.(error instanceof Error ? error.message : "Could not delete the board."),
  });

  const createLabel = useMutation({
    mutationFn: (input: { name: string; color: string }) =>
      boardsApi.createLabel(boardId, actorId, input),
    onError: (error) => onError?.(error instanceof Error ? error.message : "Could not add the label."),
    onSettled: settle,
  });

  const updateLabel = useMutation({
    mutationFn: (input: { labelId: string; name?: string; color?: string }) =>
      boardsApi.updateLabel(boardId, actorId, input.labelId, input),
    onMutate: (input) =>
      optimistic((current) => ({
        ...current,
        labels: current.labels.map((l) =>
          l.id === input.labelId
            ? { ...l, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.color ? { color: input.color } : {}) }
            : l,
        ),
      })),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: settle,
  });

  const deleteLabel = useMutation({
    mutationFn: (labelId: string) => boardsApi.deleteLabel(boardId, actorId, labelId),
    onMutate: (labelId) =>
      optimistic((current) => ({
        ...current,
        labels: current.labels.filter((l) => l.id !== labelId),
        cards: current.cards.map((c) => ({
          ...c,
          labelIds: c.labelIds.filter((id) => id !== labelId),
        })),
      })),
    onError: (error, _input, context) => rollback(context, error),
    onSettled: settle,
  });

  const addMember = useMutation({
    mutationFn: (input: { displayName: string; role?: BoardMember["role"] }) =>
      boardsApi.addMember(boardId, actorId, input),
    onError: (error) => onError?.(error instanceof Error ? error.message : "Could not add the member."),
    onSettled: settle,
  });

  const updateMember = useMutation({
    mutationFn: (input: { memberId: string; displayName?: string; role?: BoardMember["role"] }) =>
      boardsApi.updateMember(boardId, actorId, input.memberId, input),
    onError: (error) => onError?.(error instanceof Error ? error.message : "Could not update the member."),
    onSettled: settle,
  });

  const removeMember = useMutation({
    mutationFn: (memberId: string) => boardsApi.removeMember(boardId, actorId, memberId),
    onError: (error) => onError?.(error instanceof Error ? error.message : "Could not remove the member."),
    onSettled: settle,
  });

  return {
    createCard,
    moveCard,
    updateCard,
    deleteCard,
    toggleLabel,
    toggleMember,
    createList,
    updateList,
    moveList,
    deleteList,
    updateBoard,
    deleteBoard,
    createLabel,
    updateLabel,
    deleteLabel,
    addMember,
    updateMember,
    removeMember,
  };
}

// ---------------------------------------------------------------------------
// Card detail
// ---------------------------------------------------------------------------

/**
 * The heavy half of a card — checklists, comments, attachments, activity —
 * fetched only while its detail view is open, so a board with a long history
 * still opens instantly.
 */
export function useCardDetail(boardId: string, cardId: string | null, actorId: string | null) {
  return useQuery<BoardCardDetail>({
    queryKey: cardKey(boardId, cardId ?? "none"),
    queryFn: ({ signal }) => boardsApi.getCardDetail(boardId, actorId, cardId as string, signal),
    enabled: cardId != null,
    staleTime: 10_000,
  });
}

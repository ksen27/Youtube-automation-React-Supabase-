"use client";

import * as React from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { byPosition } from "@/lib/boards/position";
import { EMPTY_FILTER, filterCards, isFilterActive, type BoardFilter } from "@/lib/boards/filter";
import { can } from "@/lib/boards/permissions";
import type { BoardCard, BoardLabel, BoardMember, BoardSnapshot } from "@/lib/boards/types";
import {
  boardKey,
  cardsInList,
  moveCardLocally,
  useBoardActor,
  useBoardMutations,
  useBoardSnapshot,
  useBoardStream,
} from "./use-board";
import { BoardHeader } from "./board-header";
import { FilterBar } from "./filter-bar";
import { ListColumn } from "./list-column";
import { CardTile } from "./card-tile";
import { CardDetailDialog } from "./card-detail-dialog";

// The Kanban surface: layout, drag-and-drop, filtering, and the card dialog.
//
// DRAG-AND-DROP, in one paragraph. dnd-kit gives us pointer, touch and keyboard
// sensors over one DndContext; each column is a SortableContext of cards, and
// the board itself is a SortableContext of columns. While dragging, nothing is
// sent to the server — `onDragOver` only edits the CACHED snapshot so the card
// visibly re-homes between columns. On drop, exactly one request goes out
// (`POST …/cards/:id/move` with a target index). If it fails, the cache is
// restored to the snapshot captured at drag start, so the card animates back to
// where it was rather than lying about a move that did not happen.

export interface BoardViewProps {
  boardId: string;
  initialSnapshot: BoardSnapshot;
}

export function BoardView({ boardId, initialSnapshot }: BoardViewProps) {
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<BoardFilter>(EMPTY_FILTER);
  const [openCardId, setOpenCardId] = React.useState<string | null>(null);
  const [addingList, setAddingList] = React.useState(false);
  const [newListTitle, setNewListTitle] = React.useState("");

  // `now` is pinned per render pass rather than read inside each card, so every
  // due-date badge on the board agrees on what "today" is.
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { data: snapshot } = useBoardSnapshot(boardId, initialSnapshot, null);
  const { actorId, actor, chooseActor } = useBoardActor(boardId, snapshot.members);
  const { suppress } = useBoardStream(boardId, true);

  const mutations = useBoardMutations({
    boardId,
    actorId,
    onError: setError,
    suppressStream: suppress,
  });

  const role = actor?.role ?? "member";
  const canWriteCards = can(role, "card.write") && !snapshot.board.archivedAt;
  const canMoveCards = can(role, "card.move") && !snapshot.board.archivedAt;
  const canManageList = can(role, "list.manage") && !snapshot.board.archivedAt;
  const canManageBoard = can(role, "board.update");
  const canManageMembers = can(role, "members.manage");

  const labelsById = React.useMemo(
    () => new Map(snapshot.labels.map((l) => [l.id, l] as const)),
    [snapshot.labels],
  );
  const membersById = React.useMemo(
    () => new Map(snapshot.members.map((m) => [m.id, m] as const)),
    [snapshot.members],
  );

  const lists = React.useMemo(() => [...snapshot.lists].sort(byPosition), [snapshot.lists]);
  const visibleCards = React.useMemo(
    () => filterCards(snapshot.cards, filter, now),
    [snapshot.cards, filter, now],
  );
  const filtering = isFilterActive(filter);

  // -- drag state ----------------------------------------------------------

  const [activeCard, setActiveCard] = React.useState<BoardCard | null>(null);
  const [activeListId, setActiveListId] = React.useState<string | null>(null);
  // The board exactly as it was when the drag began — the rollback target.
  const dragStartSnapshot = React.useRef<BoardSnapshot | null>(null);

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so clicking a card to open
    // it does not register as a micro-drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Touch needs a hold instead: without it, dragging a card and scrolling the
    // column are the same gesture.
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const readCache = () =>
    queryClient.getQueryData<BoardSnapshot>(boardKey(boardId)) ?? snapshot;

  /** Which list does this drop target belong to? */
  const resolveListId = (
    current: BoardSnapshot,
    overId: string,
    overType: string | undefined,
  ): string | null => {
    if (overType === "list-drop") return overId.replace("list-drop:", "");
    if (overType === "list") return overId;
    if (overType === "card") return current.cards.find((c) => c.id === overId)?.listId ?? null;
    return null;
  };

  const onDragStart = (event: DragStartEvent) => {
    dragStartSnapshot.current = readCache();
    const type = event.active.data.current?.type;
    if (type === "card") {
      setActiveCard(readCache().cards.find((c) => c.id === event.active.id) ?? null);
    } else if (type === "list") {
      setActiveListId(String(event.active.id));
    }
  };

  /**
   * Cross-column hover. Re-homing the card in the cache here (rather than at
   * drop) is what makes the destination column open a gap under the cursor —
   * and it costs nothing, because no request is sent until the drop.
   */
  const onDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || active.data.current?.type !== "card") return;

    const current = readCache();
    const card = current.cards.find((c) => c.id === active.id);
    if (!card) return;

    const overListId = resolveListId(current, String(over.id), over.data.current?.type as string);
    if (!overListId || overListId === card.listId) return;

    const destination = cardsInList(current, overListId);
    const overIndex = destination.findIndex((c) => c.id === over.id);
    const index = overIndex >= 0 ? overIndex : destination.length;

    queryClient.setQueryData(
      boardKey(boardId),
      moveCardLocally(current, String(active.id), overListId, index),
    );
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const startSnapshot = dragStartSnapshot.current;
    setActiveCard(null);
    setActiveListId(null);
    dragStartSnapshot.current = null;

    if (!over) {
      // Dropped nowhere — undo whatever onDragOver did to the cache.
      if (startSnapshot) queryClient.setQueryData(boardKey(boardId), startSnapshot);
      return;
    }

    const current = readCache();
    const rollback = () => {
      if (startSnapshot) queryClient.setQueryData(boardKey(boardId), startSnapshot);
    };

    // --- reorder a column -------------------------------------------------
    if (active.data.current?.type === "list") {
      const ordered = [...current.lists].sort(byPosition);
      const overListId = resolveListId(current, String(over.id), over.data.current?.type as string);
      const targetIndex = ordered.findIndex((l) => l.id === overListId);
      const oldIndex = ordered.findIndex((l) => l.id === active.id);
      if (targetIndex < 0 || targetIndex === oldIndex) return;

      mutations.moveList.mutate(
        { listId: String(active.id), targetIndex },
        { onError: rollback },
      );
      return;
    }

    // --- move a card ------------------------------------------------------
    const card = current.cards.find((c) => c.id === active.id);
    if (!card) return;

    const listId = card.listId; // already re-homed by onDragOver if it changed
    const ordered = cardsInList(current, listId);
    const activeIndex = ordered.findIndex((c) => c.id === card.id);
    const startListId = startSnapshot?.cards.find((c) => c.id === card.id)?.listId ?? listId;
    const crossList = startListId !== listId;

    // The index the server receives is an index into the destination column
    // WITHOUT the moving card (see neighborsForIndex), and the two drag cases
    // reach that number differently:
    //
    //   cross-list — onDragOver already placed the card in the cached column, so
    //     the card's own index there is exactly the slot the user is looking at;
    //   same-list — the cache is untouched, so the target is the index of the
    //     card being hovered, which is dnd-kit's usual sortable semantics and
    //     lands correctly whether the drag went up or down.
    //
    // Using the hovered card's index for a cross-list drop would insert one slot
    // too far down, because the moving card is already occupying a slot above it.
    const overIndex = ordered.findIndex((c) => c.id === over.id);
    const targetIndex = crossList
      ? Math.max(0, activeIndex)
      : overIndex >= 0
        ? overIndex
        : Math.max(0, ordered.length - 1);

    const startOrder = startSnapshot
      ? cardsInList(startSnapshot, listId).findIndex((c) => c.id === card.id)
      : -1;
    if (!crossList && startOrder === targetIndex) return; // dropped where it began

    mutations.moveCard.mutate(
      { cardId: card.id, listId, targetIndex },
      { onError: rollback },
    );
  };

  // -- handlers ------------------------------------------------------------

  const addCard = async (listId: string, title: string) => {
    await mutations.createCard.mutateAsync({ listId, title });
  };

  const addList = () => {
    const title = newListTitle.trim();
    if (!title) return;
    mutations.createList.mutate(title);
    setNewListTitle("");
    setAddingList(false);
  };

  const openCard = React.useMemo(
    () => snapshot.cards.find((c) => c.id === openCardId) ?? null,
    [snapshot.cards, openCardId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BoardHeader
        snapshot={snapshot}
        actor={actor}
        canManageBoard={canManageBoard}
        canManageMembers={canManageMembers}
        onChooseActor={chooseActor}
        onUpdateBoard={(input) => mutations.updateBoard.mutate(input)}
        onAddMember={(displayName) => mutations.addMember.mutate({ displayName })}
        onUpdateMemberRole={(memberId, role) => mutations.updateMember.mutate({ memberId, role })}
        onRemoveMember={(memberId) => mutations.removeMember.mutate(memberId)}
        onDeleteBoard={() => mutations.deleteBoard.mutate()}
      >
        <FilterBar
          filter={filter}
          onChange={setFilter}
          labels={snapshot.labels}
          members={snapshot.members}
        />
      </BoardHeader>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          if (dragStartSnapshot.current) {
            queryClient.setQueryData(boardKey(boardId), dragStartSnapshot.current);
          }
          setActiveCard(null);
          setActiveListId(null);
          dragStartSnapshot.current = null;
        }}
      >
        {/* Horizontal scroller. Only this element scrolls sideways and only the
            card stacks scroll vertically, which avoids the nested-scroll traps
            a Kanban board is prone to. */}
        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden px-4 py-4 lg:px-6">
          <SortableContext
            items={lists.map((l) => l.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex h-full items-start gap-3">
              {lists.map((list) => {
                const listCards = visibleCards
                  .filter((c) => c.listId === list.id)
                  .sort(byPosition);
                const total = snapshot.cards.filter((c) => c.listId === list.id).length;
                return (
                  <ListColumn
                    key={list.id}
                    list={list}
                    cards={listCards}
                    labelsById={labelsById}
                    membersById={membersById}
                    now={now}
                    canManageList={canManageList}
                    canWriteCards={canWriteCards && canMoveCards}
                    filtered={filtering}
                    totalCount={total}
                    onOpenCard={setOpenCardId}
                    onAddCard={addCard}
                    onRename={(listId, title) => mutations.updateList.mutate({ listId, title })}
                    onArchive={(listId) => mutations.updateList.mutate({ listId, archived: true })}
                    onDelete={(listId) => {
                      if (
                        window.confirm(
                          `Delete "${list.title}" and its ${total} card${total === 1 ? "" : "s"}?`,
                        )
                      ) {
                        mutations.deleteList.mutate(listId);
                      }
                    }}
                  />
                );
              })}

              {/* Add another list ------------------------------------------ */}
              {canManageList && (
                <div className="w-[17rem] shrink-0">
                  {addingList ? (
                    <div className="rounded-[12px] border border-border bg-bg-elevated/80 p-2 space-y-2">
                      <Input
                        autoFocus
                        value={newListTitle}
                        placeholder="List title"
                        onChange={(e) => setNewListTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addList();
                          if (e.key === "Escape") {
                            setAddingList(false);
                            setNewListTitle("");
                          }
                        }}
                        className="h-8 text-sm"
                      />
                      <div className="flex items-center gap-2">
                        <Button size="sm" onClick={addList} disabled={!newListTitle.trim()}>
                          Add list
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          aria-label="Cancel"
                          onClick={() => {
                            setAddingList(false);
                            setNewListTitle("");
                          }}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAddingList(true)}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-[12px] border border-dashed border-border",
                        "bg-bg-elevated/40 px-3 py-2.5 text-sm text-fg-muted",
                        "hover:bg-surface-hover hover:text-fg transition-colors",
                      )}
                    >
                      <Plus className="h-4 w-4" />
                      Add another list
                    </button>
                  )}
                </div>
              )}
            </div>
          </SortableContext>
        </div>

        {/* The dragged item follows the cursor at full opacity while the
            original stays as a ghost — the standard dnd-kit overlay pattern. */}
        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}>
          {activeCard && (
            <CardTile
              overlay
              card={activeCard}
              labels={
                activeCard.labelIds.map((id) => labelsById.get(id)).filter(Boolean) as BoardLabel[]
              }
              members={
                activeCard.memberIds
                  .map((id) => membersById.get(id))
                  .filter(Boolean) as BoardMember[]
              }
              now={now}
              onOpen={() => {}}
            />
          )}
          {activeListId && (
            <div className="w-[17rem] rounded-[12px] border border-border-strong bg-bg-elevated p-3 shadow-lg">
              <p className="text-sm font-semibold text-fg">
                {lists.find((l) => l.id === activeListId)?.title}
              </p>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {openCard && (
        <CardDetailDialog
          boardId={boardId}
          card={openCard}
          snapshot={snapshot}
          actorId={actorId}
          actor={actor}
          now={now}
          onClose={() => setOpenCardId(null)}
          onError={setError}
          mutations={mutations}
        />
      )}

      {/* Errors surface here after the cache has already been rolled back, so
          the message explains a state the user can see, not one they cannot. */}
      {error && (
        <div className="pointer-events-auto fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-[10px] border border-danger/40 bg-surface px-3 py-2 shadow-lg">
            <span className="text-xs text-danger">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="Dismiss"
              className="text-fg-subtle hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

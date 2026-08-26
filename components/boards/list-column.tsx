"use client";

import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, GripVertical, MoreHorizontal, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BoardCard, BoardLabel, BoardList, BoardMember } from "@/lib/boards/types";
import { CardTile } from "./card-tile";
import { AddCardForm } from "./add-card-form";
import { InlineText } from "./inline-text";

// One Kanban column: a sortable container of sortable cards.
//
// The column is BOTH a sortable item (so columns can be reordered) and a
// droppable target (so a card can be dropped into an empty column, where there
// is no card to sort against).

export interface ListColumnProps {
  list: BoardList;
  cards: BoardCard[];
  labelsById: Map<string, BoardLabel>;
  membersById: Map<string, BoardMember>;
  now: Date;
  canManageList: boolean;
  canWriteCards: boolean;
  /** True when a filter is hiding cards, so the count can say so honestly. */
  filtered: boolean;
  totalCount: number;
  onOpenCard: (cardId: string) => void;
  onAddCard: (listId: string, title: string) => Promise<unknown>;
  onRename: (listId: string, title: string) => void;
  onArchive: (listId: string) => void;
  onDelete: (listId: string) => void;
}

export function ListColumn({
  list,
  cards,
  labelsById,
  membersById,
  now,
  canManageList,
  canWriteCards,
  filtered,
  totalCount,
  onOpenCard,
  onAddCard,
  onRename,
  onArchive,
  onDelete,
}: ListColumnProps) {
  // Destructured rather than kept as one object: the React Compiler lint reads
  // member access on a hook result that carries a ref setter as a ref read
  // during render, and destructuring is the idiomatic way to satisfy it.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: list.id,
    data: { type: "list" },
    disabled: !canManageList,
  });

  // Separate droppable for the column body, so dropping onto empty space below
  // the last card still resolves to this list.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `list-drop:${list.id}`,
    data: { type: "list-drop", listId: list.id },
  });

  const cardIds = React.useMemo(() => cards.map((c) => c.id), [cards]);

  return (
    <section
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "flex w-[17rem] shrink-0 flex-col rounded-[12px] border border-border bg-bg-elevated/80 max-h-full",
        isDragging && "opacity-50",
      )}
    >
      <header className="flex items-center gap-1 px-2 py-2 border-b border-border">
        {canManageList && (
          <button
            type="button"
            aria-label={`Reorder ${list.title}`}
            {...attributes}
            {...listeners}
            className="grid h-6 w-5 place-items-center rounded text-fg-subtle hover:text-fg cursor-grab active:cursor-grabbing"
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}

        <InlineText
          value={list.title}
          disabled={!canManageList}
          ariaLabel={`Rename ${list.title}`}
          onSave={(title) => onRename(list.id, title)}
          className="flex-1 text-sm font-semibold text-fg"
        />

        <span className="text-[11px] tabular-nums text-fg-subtle px-1">
          {filtered ? `${cards.length}/${totalCount}` : totalCount}
        </span>

        {canManageList && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`${list.title} actions`}
              className="grid h-6 w-6 place-items-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg"
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onArchive(list.id)}>
                <Archive className="h-4 w-4" />
                Archive list
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => onDelete(list.id)}>
                <Trash2 className="h-4 w-4" />
                Delete list and cards
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      <div
        ref={setDropRef}
        className={cn(
          // Only the card stack scrolls; the header and the composer stay put,
          // which is what stops the board from turning into nested scrollbars.
          "flex-1 min-h-[3rem] overflow-y-auto overscroll-contain px-2 py-2 space-y-2 transition-colors",
          isOver && "bg-brand-500/5",
        )}
      >
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              labels={card.labelIds.map((id) => labelsById.get(id)).filter(Boolean) as BoardLabel[]}
              members={
                card.memberIds.map((id) => membersById.get(id)).filter(Boolean) as BoardMember[]
              }
              now={now}
              onOpen={onOpenCard}
              draggable={canWriteCards}
            />
          ))}
        </SortableContext>

        {cards.length === 0 && (
          <p className="px-1 py-3 text-center text-[11px] text-fg-subtle">
            {filtered && totalCount > 0 ? "No cards match the filter" : "Nothing here yet"}
          </p>
        )}
      </div>

      <footer className="px-2 pb-2 pt-1 border-t border-border">
        <AddCardForm
          disabled={!canWriteCards}
          onSubmit={(title) => onAddCard(list.id, title)}
        />
      </footer>
    </section>
  );
}

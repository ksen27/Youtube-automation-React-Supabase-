"use client";

import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckSquare, Clock, MessageSquare, Paperclip, AlignLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDue } from "@/lib/boards/dates";
import { labelBarClass } from "@/lib/boards/theme";
import type { BoardCard, BoardLabel, BoardMember } from "@/lib/boards/types";
import { MemberStack } from "./member-avatar";

// The card preview. Metadata only appears when it exists, which is what keeps a
// board of bare titles looking calm while a heavily-annotated card still shows
// everything at a glance.

export interface CardTileProps {
  card: BoardCard;
  labels: BoardLabel[];
  members: BoardMember[];
  now: Date;
  onOpen: (cardId: string) => void;
  /** Read-only rendering for the drag overlay (no sortable wiring). */
  overlay?: boolean;
  draggable?: boolean;
}

const DUE_TONE: Record<string, string> = {
  overdue: "bg-danger/15 text-danger",
  soon: "bg-amber-500/15 text-amber-400",
  done: "bg-emerald-500/15 text-emerald-400",
  neutral: "bg-surface-hover text-fg-muted",
};

export function CardTile({
  card,
  labels,
  members,
  now,
  onOpen,
  overlay = false,
  draggable = true,
}: CardTileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", listId: card.listId },
    disabled: overlay || !draggable,
  });

  const due = formatDue(card.dueAt, card.completed, now);
  const hasChecklist = card.checklistTotal > 0;

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <article
      ref={overlay ? undefined : setNodeRef}
      style={overlay ? undefined : style}
      {...(overlay ? {} : attributes)}
      {...(overlay ? {} : listeners)}
      // Enter/Space opens the card; the drag sensors own the pointer gestures,
      // so this stays a keyboard affordance rather than fighting them.
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(card.id);
        }
      }}
      className={cn(
        "group rounded-[10px] border border-border bg-surface p-2.5 shadow-xs cursor-pointer",
        "hover:border-border-strong hover:bg-surface-hover transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
        // The original tile stays in the flow as a ghost while its overlay
        // follows the cursor — that is what makes the gap read as "it goes here".
        !overlay && isDragging && "opacity-40",
        overlay && "shadow-lg rotate-1 cursor-grabbing",
        card.completed && "opacity-70",
      )}
    >
      {card.coverColor && (
        <div className={cn("h-1.5 w-full rounded-full mb-2", labelBarClass(card.coverColor))} />
      )}

      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {labels.map((label) => (
            <span
              key={label.id}
              title={label.name || label.color}
              className={cn("h-1.5 w-8 rounded-full", labelBarClass(label.color))}
            />
          ))}
        </div>
      )}

      <p
        className={cn(
          "text-sm text-fg leading-snug break-words",
          card.completed && "line-through text-fg-muted",
        )}
      >
        {card.title}
      </p>

      {(due || hasChecklist || card.commentCount > 0 || card.attachmentCount > 0 || card.description) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-fg-muted">
          {due && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium",
                DUE_TONE[due.tone],
              )}
            >
              <Clock className="h-3 w-3" />
              {due.text}
            </span>
          )}
          {card.description && <AlignLeft className="h-3.5 w-3.5" aria-label="Has a description" />}
          {hasChecklist && (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                card.checklistDone === card.checklistTotal && "text-emerald-400",
              )}
            >
              <CheckSquare className="h-3.5 w-3.5" />
              {card.checklistDone}/{card.checklistTotal}
            </span>
          )}
          {card.commentCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="h-3.5 w-3.5" />
              {card.commentCount}
            </span>
          )}
          {card.attachmentCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Paperclip className="h-3.5 w-3.5" />
              {card.attachmentCount}
            </span>
          )}
          <span className="ml-auto">
            <MemberStack members={members} />
          </span>
        </div>
      )}
    </article>
  );
}

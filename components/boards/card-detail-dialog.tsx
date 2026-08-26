"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Calendar, Check, Tag, Trash2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { boardsApi } from "@/lib/boards/client";
import { formatDue, fromLocalInputValue, toLocalInputValue } from "@/lib/boards/dates";
import { can } from "@/lib/boards/permissions";
import { LABEL_COLORS, labelBarClass, labelClass } from "@/lib/boards/theme";
import type { BoardCard, BoardMember, BoardSnapshot } from "@/lib/boards/types";
import { boardKey, cardKey, useBoardMutations, useCardDetail } from "./use-board";
import { InlineText } from "./inline-text";
import { MemberAvatar } from "./member-avatar";
import { ChecklistSection } from "./checklist-section";
import { CommentsSection } from "./comments-section";
import { AttachmentsSection } from "./attachments-section";
import { ActivityList } from "./activity-list";

// The card detail view, as a modal over the board.
//
// A modal (rather than a route) is the right shape here: the board behind it is
// the context you are working in, and the existing app already uses
// components/ui/dialog for focused editing. The board keeps live-updating
// underneath, so a teammate's move is not lost while a card is open.
//
// The card's LIGHT fields come from the board snapshot already in the cache, so
// the header renders instantly; the heavy relations stream in behind a skeleton.

export interface CardDetailDialogProps {
  boardId: string;
  card: BoardCard;
  snapshot: BoardSnapshot;
  actorId: string | null;
  actor: BoardMember | null;
  now: Date;
  onClose: () => void;
  onError: (message: string) => void;
  mutations: ReturnType<typeof useBoardMutations>;
}

export function CardDetailDialog({
  boardId,
  card,
  snapshot,
  actorId,
  actor,
  now,
  onClose,
  onError,
  mutations,
}: CardDetailDialogProps) {
  const queryClient = useQueryClient();
  const { data: detail, isLoading } = useCardDetail(boardId, card.id, actorId);

  const role = actor?.role ?? "member";
  const canEdit = can(role, "card.write") && !snapshot.board.archivedAt;
  const canComment = can(role, "comment.write") && !snapshot.board.archivedAt;
  const canManageLabels = can(role, "labels.manage") && !snapshot.board.archivedAt;

  const membersById = React.useMemo(
    () => new Map(snapshot.members.map((m) => [m.id, m] as const)),
    [snapshot.members],
  );
  const list = snapshot.lists.find((l) => l.id === card.listId);
  const due = formatDue(card.dueAt, card.completed, now);

  /**
   * Run a card-detail write, then refresh both caches.
   *
   * Checklists, comments and attachments live in the card query, but they also
   * change the board (a checklist changes the "2/5" on the tile, a comment its
   * comment count) — so both keys are invalidated together rather than letting
   * the board drift until the next SSE tick.
   */
  const run = React.useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
        await queryClient.invalidateQueries({ queryKey: cardKey(boardId, card.id) });
        await queryClient.invalidateQueries({ queryKey: boardKey(boardId) });
      } catch (e) {
        onError(e instanceof Error ? e.message : "Something went wrong.");
      }
    },
    [boardId, card.id, onError, queryClient],
  );

  const patchCard = (patch: Parameters<typeof boardsApi.updateCard>[3]) =>
    mutations.updateCard.mutate({ cardId: card.id, patch });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] w-[min(96vw,880px)] overflow-y-auto p-0">
        {/* Header ---------------------------------------------------------- */}
        <div className="sticky top-0 z-10 border-b border-border bg-surface/95 px-5 py-4 backdrop-blur">
          <div className="flex items-start gap-3 pr-8">
            <input
              type="checkbox"
              checked={card.completed}
              disabled={!canEdit}
              aria-label="Mark card complete"
              onChange={(e) => patchCard({ completed: e.target.checked })}
              className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-brand-500)]"
            />
            <div className="min-w-0 flex-1">
              <DialogTitle asChild>
                <div>
                  <InlineText
                    value={card.title}
                    disabled={!canEdit}
                    ariaLabel="Rename card"
                    onSave={(title) => patchCard({ title })}
                    className={cn(
                      "text-base font-semibold text-fg",
                      card.completed && "line-through text-fg-muted",
                    )}
                  />
                </div>
              </DialogTitle>
              <DialogDescription className="mt-0.5 pl-1.5">
                in <span className="text-fg-muted underline-offset-2">{list?.title ?? "—"}</span>
                {due && (
                  <>
                    {" · "}
                    <span
                      className={cn(
                        due.tone === "overdue" && "text-danger",
                        due.tone === "soon" && "text-amber-400",
                        due.tone === "done" && "text-emerald-400",
                      )}
                    >
                      {due.text}
                    </span>
                  </>
                )}
              </DialogDescription>
            </div>
          </div>
        </div>

        <div className="grid gap-6 px-5 py-5 md:grid-cols-[1fr_15rem]">
          {/* Main column --------------------------------------------------- */}
          <div className="min-w-0 space-y-6">
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                Description
              </h3>
              <InlineText
                value={card.description}
                multiline
                disabled={!canEdit}
                placeholder="Add a more detailed description…"
                ariaLabel="Edit description"
                onSave={(description) => patchCard({ description })}
                className="text-sm text-fg-muted"
              >
                <span
                  className={cn(
                    "block whitespace-pre-wrap break-words",
                    !card.description && "text-fg-subtle",
                  )}
                >
                  {card.description || "Add a more detailed description…"}
                </span>
              </InlineText>
            </section>

            {isLoading || !detail ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : (
              <>
                <ChecklistSection
                  checklists={detail.checklists}
                  canEdit={canEdit}
                  onCreate={(title) =>
                    void run(() => boardsApi.createChecklist(boardId, actorId, card.id, title))
                  }
                  onRename={(checklistId, title) =>
                    void run(() => boardsApi.updateChecklist(boardId, actorId, checklistId, title))
                  }
                  onDelete={(checklistId) =>
                    void run(() => boardsApi.deleteChecklist(boardId, actorId, checklistId))
                  }
                  onAddItem={(checklistId, title) =>
                    void run(() =>
                      boardsApi.createChecklistItem(boardId, actorId, checklistId, { title }),
                    )
                  }
                  onUpdateItem={(itemId, patch) =>
                    void run(() => boardsApi.updateChecklistItem(boardId, actorId, itemId, patch))
                  }
                  onDeleteItem={(itemId) =>
                    void run(() => boardsApi.deleteChecklistItem(boardId, actorId, itemId))
                  }
                />

                <AttachmentsSection
                  boardId={boardId}
                  cardId={card.id}
                  actorId={actorId}
                  attachments={detail.attachments}
                  canEdit={canEdit}
                  now={now}
                  onChanged={() => void run(async () => {})}
                  onError={onError}
                />

                <CommentsSection
                  comments={detail.comments}
                  membersById={membersById}
                  actor={actor}
                  role={role}
                  now={now}
                  disabled={!canComment}
                  onCreate={(content) =>
                    void run(() => boardsApi.createComment(boardId, actorId, card.id, content))
                  }
                  onUpdate={(commentId, content) =>
                    void run(() => boardsApi.updateComment(boardId, actorId, commentId, content))
                  }
                  onDelete={(commentId) =>
                    void run(() => boardsApi.deleteComment(boardId, actorId, commentId))
                  }
                />

                <ActivityList activity={detail.activity} membersById={membersById} now={now} />
              </>
            )}
          </div>

          {/* Sidebar ------------------------------------------------------- */}
          <aside className="space-y-4">
            <div className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                Members
              </h3>
              <div className="flex flex-wrap items-center gap-1.5">
                {card.memberIds.map((id) => {
                  const member = membersById.get(id);
                  return member ? <MemberAvatar key={id} member={member} size="sm" /> : null;
                })}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="xs" variant="outline" disabled={!canEdit}>
                      <Users className="h-3.5 w-3.5" />
                      Assign
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel>Assign members</DropdownMenuLabel>
                    {snapshot.members.map((member) => {
                      const assigned = card.memberIds.includes(member.id);
                      return (
                        <DropdownMenuItem
                          key={member.id}
                          onSelect={(e) => {
                            e.preventDefault();
                            mutations.toggleMember.mutate({
                              cardId: card.id,
                              memberId: member.id,
                              assigned: !assigned,
                            });
                          }}
                        >
                          <MemberAvatar member={member} size="xs" />
                          <span className="flex-1 truncate">{member.displayName}</span>
                          {assigned && <Check className="h-3.5 w-3.5 text-brand-400" />}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <div className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Labels</h3>
              <div className="flex flex-wrap items-center gap-1.5">
                {card.labelIds.map((id) => {
                  const label = snapshot.labels.find((l) => l.id === id);
                  return label ? (
                    <span
                      key={id}
                      className={cn(
                        "inline-flex h-6 items-center rounded-full border px-2 text-[11px] font-medium",
                        labelClass(label.color),
                      )}
                    >
                      {label.name || label.color}
                    </span>
                  ) : null;
                })}

                <LabelPicker
                  card={card}
                  snapshot={snapshot}
                  disabled={!canEdit}
                  canManageLabels={canManageLabels}
                  mutations={mutations}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Dates</h3>
              <label className="block text-[11px] text-fg-subtle">
                Start
                <input
                  type="datetime-local"
                  disabled={!canEdit}
                  value={toLocalInputValue(card.startAt)}
                  onChange={(e) => patchCard({ startAt: fromLocalInputValue(e.target.value) })}
                  className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface px-2 text-xs text-fg"
                />
              </label>
              <label className="block text-[11px] text-fg-subtle">
                Due
                <input
                  type="datetime-local"
                  disabled={!canEdit}
                  value={toLocalInputValue(card.dueAt)}
                  onChange={(e) => patchCard({ dueAt: fromLocalInputValue(e.target.value) })}
                  className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface px-2 text-xs text-fg"
                />
              </label>
              {card.dueAt && canEdit && (
                <Button size="xs" variant="ghost" onClick={() => patchCard({ dueAt: null })}>
                  <Calendar className="h-3.5 w-3.5" />
                  Clear due date
                </Button>
              )}
            </div>

            <div className="space-y-1.5 border-t border-border pt-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                Actions
              </h3>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                disabled={!canEdit}
                onClick={() => {
                  // Archiving removes the card from the board but keeps its
                  // history — the reversible option, offered before delete.
                  patchCard({ archived: true });
                  onClose();
                }}
              >
                <Archive className="h-3.5 w-3.5" />
                Archive card
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="w-full justify-start text-danger hover:bg-danger/10"
                disabled={!canEdit}
                onClick={() => {
                  if (window.confirm(`Delete "${card.title}"? This cannot be undone.`)) {
                    mutations.deleteCard.mutate(card.id);
                    onClose();
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete card
              </Button>
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Attach existing labels, or define a new one for the whole board. */
function LabelPicker({
  card,
  snapshot,
  disabled,
  canManageLabels,
  mutations,
}: {
  card: BoardCard;
  snapshot: BoardSnapshot;
  disabled: boolean;
  canManageLabels: boolean;
  mutations: ReturnType<typeof useBoardMutations>;
}) {
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<string>(LABEL_COLORS[0]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="outline" disabled={disabled}>
          <Tag className="h-3.5 w-3.5" />
          Labels
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Board labels</DropdownMenuLabel>
        {snapshot.labels.map((label) => {
          const attached = card.labelIds.includes(label.id);
          return (
            <DropdownMenuItem
              key={label.id}
              onSelect={(e) => {
                e.preventDefault();
                mutations.toggleLabel.mutate({
                  cardId: card.id,
                  labelId: label.id,
                  attached: !attached,
                });
              }}
            >
              <span className={cn("h-2.5 w-6 rounded-full", labelBarClass(label.color))} />
              <span className="flex-1 truncate">{label.name || label.color}</span>
              {attached && <Check className="h-3.5 w-3.5 text-brand-400" />}
            </DropdownMenuItem>
          );
        })}

        {canManageLabels && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>New label</DropdownMenuLabel>
            <div className="space-y-2 p-1.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Label name"
                className="h-8 w-full rounded-md border border-border bg-surface px-2 text-xs text-fg placeholder:text-fg-subtle"
              />
              <div className="flex flex-wrap gap-1">
                {LABEL_COLORS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-label={option}
                    onClick={() => setColor(option)}
                    className={cn(
                      "h-5 w-7 rounded-full",
                      labelBarClass(option),
                      color === option && "ring-2 ring-fg/60",
                    )}
                  />
                ))}
              </div>
              <Button
                size="xs"
                className="w-full"
                onClick={() => {
                  mutations.createLabel.mutate({ name: name.trim(), color });
                  setName("");
                }}
              >
                Create label
              </Button>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

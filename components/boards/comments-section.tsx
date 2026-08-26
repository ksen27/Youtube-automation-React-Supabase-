"use client";

import * as React from "react";
import { MessageSquare, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/boards/dates";
import { canDeleteComment, canEditComment } from "@/lib/boards/permissions";
import type { BoardComment, BoardMember, BoardRole } from "@/lib/boards/types";
import { MemberAvatar } from "./member-avatar";

// Card comments. The edit/delete affordances mirror lib/boards/permissions.ts
// exactly — the same predicates the route handlers run — so a button is never
// offered for something the server will refuse.

export interface CommentsSectionProps {
  comments: BoardComment[];
  membersById: Map<string, BoardMember>;
  actor: BoardMember | null;
  role: BoardRole;
  now: Date;
  disabled?: boolean;
  onCreate: (content: string) => void;
  onUpdate: (commentId: string, content: string) => void;
  onDelete: (commentId: string) => void;
}

export function CommentsSection({
  comments,
  membersById,
  actor,
  role,
  now,
  disabled = false,
  onCreate,
  onUpdate,
  onDelete,
}: CommentsSectionProps) {
  const [draft, setDraft] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editDraft, setEditDraft] = React.useState("");

  const submit = () => {
    const content = draft.trim();
    if (!content) return;
    onCreate(content);
    setDraft("");
  };

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
        <MessageSquare className="h-3.5 w-3.5" />
        Comments
      </h3>

      <div className="flex gap-2">
        {actor && <MemberAvatar member={actor} size="sm" />}
        <div className="flex-1 space-y-2">
          <textarea
            rows={2}
            value={draft}
            disabled={disabled}
            placeholder={actor ? `Comment as ${actor.displayName}…` : "Write a comment…"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter posts; plain Enter keeps making paragraphs,
              // because comments are prose, not one-line card titles.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            className={cn(
              "w-full resize-none rounded-[10px] border border-border bg-surface px-2.5 py-2 text-sm text-fg",
              "placeholder:text-fg-subtle focus-visible:outline-none focus-visible:border-brand-500",
              "focus-visible:ring-2 focus-visible:ring-brand-500/20 disabled:opacity-50",
            )}
          />
          {draft.trim() && (
            <Button size="sm" onClick={submit} disabled={disabled}>
              Comment
            </Button>
          )}
        </div>
      </div>

      <ul className="space-y-3">
        {comments.map((comment) => {
          const author = comment.authorMemberId
            ? membersById.get(comment.authorMemberId) ?? null
            : null;
          const editable = canEditComment(role, actor?.id ?? null, comment.authorMemberId);
          const deletable = canDeleteComment(role, actor?.id ?? null, comment.authorMemberId);
          const editing = editingId === comment.id;

          return (
            <li key={comment.id} className="flex gap-2">
              {author ? (
                <MemberAvatar member={author} size="sm" />
              ) : (
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-hover text-[10px] text-fg-muted">
                  ?
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-fg">
                    {author?.displayName ?? "Someone"}
                  </span>
                  <span className="text-[11px] text-fg-subtle">
                    {relativeTime(comment.createdAt, now)}
                    {comment.updatedAt !== comment.createdAt && " · edited"}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {editable && !editing && (
                      <button
                        type="button"
                        aria-label="Edit comment"
                        onClick={() => {
                          setEditingId(comment.id);
                          setEditDraft(comment.content);
                        }}
                        className="text-fg-subtle hover:text-fg"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                    {deletable && (
                      <button
                        type="button"
                        aria-label="Delete comment"
                        onClick={() => onDelete(comment.id)}
                        className="text-fg-subtle hover:text-danger"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                </div>

                {editing ? (
                  <div className="mt-1 space-y-2">
                    <textarea
                      autoFocus
                      rows={2}
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="w-full resize-none rounded-md border border-brand-500 bg-surface px-2 py-1.5 text-sm text-fg focus-visible:outline-none"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="xs"
                        onClick={() => {
                          const content = editDraft.trim();
                          if (content) onUpdate(comment.id, content);
                          setEditingId(null);
                        }}
                      >
                        Save
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg-muted">
                    {comment.content}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {comments.length === 0 && <p className="text-xs text-fg-subtle">No comments yet.</p>}
    </section>
  );
}

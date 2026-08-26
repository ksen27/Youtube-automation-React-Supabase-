"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, Check, Settings, Trash2, UserPlus, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { boardThemeClass, BOARD_THEMES } from "@/lib/boards/theme";
import type { BoardMember, BoardSnapshot, BoardRole } from "@/lib/boards/types";
import { InlineText } from "./inline-text";
import { MemberAvatar } from "./member-avatar";

// Board chrome: name, description, who is here, who you are, and the settings
// menu. Everything destructive is behind the settings menu and gated on the
// owner role — the same check the server enforces (lib/boards/permissions.ts).

export interface BoardHeaderProps {
  snapshot: BoardSnapshot;
  actor: BoardMember | null;
  canManageBoard: boolean;
  canManageMembers: boolean;
  onChooseActor: (memberId: string | null) => void;
  onUpdateBoard: (input: { name?: string; description?: string; theme?: string; archived?: boolean }) => void;
  onAddMember: (displayName: string) => void;
  onUpdateMemberRole: (memberId: string, role: BoardRole) => void;
  onRemoveMember: (memberId: string) => void;
  onDeleteBoard: () => void;
  children?: React.ReactNode;
}

export function BoardHeader({
  snapshot,
  actor,
  canManageBoard,
  canManageMembers,
  onChooseActor,
  onUpdateBoard,
  onAddMember,
  onUpdateMemberRole,
  onRemoveMember,
  onDeleteBoard,
  children,
}: BoardHeaderProps) {
  const router = useRouter();
  const { board, members } = snapshot;
  const [newMember, setNewMember] = React.useState("");

  const addMember = () => {
    const name = newMember.trim();
    if (!name) return;
    onAddMember(name);
    setNewMember("");
  };

  return (
    <header
      className={cn(
        "shrink-0 border-b border-border bg-gradient-to-b px-4 py-3 lg:px-6",
        boardThemeClass(board.theme),
      )}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <InlineText
              value={board.name}
              disabled={!canManageBoard}
              ariaLabel="Rename board"
              onSave={(name) => onUpdateBoard({ name })}
              className="text-lg font-semibold tracking-tight text-fg"
            />
            {board.archivedAt && <Badge variant="warning">Archived</Badge>}
            {board.visibility === "private" && <Badge variant="outline">Private</Badge>}
          </div>

          <InlineText
            value={board.description}
            multiline
            disabled={!canManageBoard}
            placeholder="Add a description…"
            ariaLabel="Edit board description"
            onSave={(description) => onUpdateBoard({ description })}
            className="mt-0.5 text-xs text-fg-muted"
          >
            <span className={cn(!board.description && "text-fg-subtle")}>
              {board.description || "Add a description…"}
            </span>
          </InlineText>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {children}

          {/* Members ------------------------------------------------------ */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Users className="h-3.5 w-3.5" />
                <span className="flex -space-x-1.5">
                  {members.slice(0, 3).map((m) => (
                    <MemberAvatar key={m.id} member={m} size="xs" className="ring-2 ring-bg-elevated" />
                  ))}
                </span>
                {members.length > 3 && (
                  <span className="text-[11px] text-fg-muted">+{members.length - 3}</span>
                )}
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel>Board members</DropdownMenuLabel>
              {members.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-fg"
                >
                  <MemberAvatar member={member} size="sm" />
                  <span className="flex-1 truncate">{member.displayName}</span>
                  {canManageMembers && member.id !== board.ownerMemberId ? (
                    <>
                      <select
                        value={member.role}
                        onChange={(e) => onUpdateMemberRole(member.id, e.target.value as BoardRole)}
                        className="h-7 rounded-md border border-border bg-surface px-1.5 text-[11px] text-fg-muted"
                        aria-label={`Role for ${member.displayName}`}
                      >
                        <option value="owner">Owner</option>
                        <option value="member">Member</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button
                        type="button"
                        aria-label={`Remove ${member.displayName}`}
                        onClick={() => onRemoveMember(member.id)}
                        className="text-fg-subtle hover:text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <span className="text-[11px] text-fg-subtle capitalize">{member.role}</span>
                  )}
                </div>
              ))}

              <DropdownMenuSeparator />
              <div className="flex items-center gap-1.5 p-1.5">
                <Input
                  value={newMember}
                  onChange={(e) => setNewMember(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addMember();
                    }
                    // Radix would otherwise treat typing as menu type-ahead and
                    // steal the keystrokes out of this input.
                    e.stopPropagation();
                  }}
                  placeholder="Add someone by name"
                  className="h-8 text-xs"
                />
                <Button size="sm" onClick={addMember} disabled={!newMember.trim()}>
                  <UserPlus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Acting identity --------------------------------------------- */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5">
                {actor ? (
                  <>
                    <MemberAvatar member={actor} size="xs" />
                    <span className="hidden sm:inline text-xs">{actor.displayName}</span>
                  </>
                ) : (
                  <span className="text-xs text-fg-muted">Who are you?</span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>You are</DropdownMenuLabel>
              <p className="px-2.5 pb-1.5 text-[11px] leading-relaxed text-fg-subtle">
                This app signs in a team, not a person. Pick your name so cards,
                comments and history are attributed to you.
              </p>
              {snapshot.members.map((member) => (
                <DropdownMenuItem key={member.id} onSelect={() => onChooseActor(member.id)}>
                  <MemberAvatar member={member} size="xs" />
                  <span className="flex-1 truncate">{member.displayName}</span>
                  {actor?.id === member.id && <Check className="h-3.5 w-3.5 text-brand-400" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Settings ----------------------------------------------------- */}
          {canManageBoard && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Board settings">
                  <Settings className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Theme</DropdownMenuLabel>
                {BOARD_THEMES.map((theme) => (
                  <DropdownMenuItem key={theme} onSelect={() => onUpdateBoard({ theme })}>
                    <span
                      className={cn("h-3 w-6 rounded-full bg-gradient-to-r", boardThemeClass(theme))}
                    />
                    <span className="flex-1 capitalize">{theme}</span>
                    {board.theme === theme && <Check className="h-3.5 w-3.5 text-brand-400" />}
                  </DropdownMenuItem>
                ))}

                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onUpdateBoard({ archived: !board.archivedAt })}>
                  <Archive className="h-4 w-4" />
                  {board.archivedAt ? "Restore board" : "Archive board"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  destructive
                  onSelect={() => {
                    // Permanent and cascading, so it asks — the archive action
                    // above is the reversible option.
                    if (
                      window.confirm(
                        `Delete "${board.name}" and everything on it? This cannot be undone.`,
                      )
                    ) {
                      onDeleteBoard();
                      router.push("/boards");
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete board
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  );
}

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { avatarClass, initials } from "@/lib/boards/theme";
import type { BoardMember } from "@/lib/boards/types";

// Initials on a tinted disc. There are no user accounts and therefore no
// uploaded avatars, so identity is carried by initials + a colour derived from
// the person's name — stable enough to recognise at 24px across boards.

const SIZES = {
  xs: "h-5 w-5 text-[9px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
} as const;

export function MemberAvatar({
  member,
  size = "sm",
  className,
}: {
  member: BoardMember;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      title={`${member.displayName}${member.role === "owner" ? " (owner)" : ""}`}
      className={cn(
        "inline-grid place-items-center rounded-full font-semibold shrink-0 ring-1 ring-black/20",
        SIZES[size],
        avatarClass(member.color),
        className,
      )}
    >
      {initials(member.displayName)}
    </span>
  );
}

/**
 * Overlapping stack for a card preview. Caps at `max` and shows a "+N" disc —
 * a card assigned to eight people must not push its title off the tile.
 */
export function MemberStack({
  members,
  max = 3,
  size = "xs",
}: {
  members: BoardMember[];
  max?: number;
  size?: keyof typeof SIZES;
}) {
  if (members.length === 0) return null;
  const shown = members.slice(0, max);
  const overflow = members.length - shown.length;

  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map((m) => (
        <MemberAvatar key={m.id} member={m} size={size} className="ring-2 ring-surface" />
      ))}
      {overflow > 0 && (
        <span
          title={members
            .slice(max)
            .map((m) => m.displayName)
            .join(", ")}
          className={cn(
            "inline-grid place-items-center rounded-full bg-surface-hover text-fg-muted font-semibold ring-2 ring-surface",
            SIZES[size],
          )}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

"use client";

import * as React from "react";
import { History } from "lucide-react";
import { describeActivity } from "@/lib/boards/activity";
import { relativeTime } from "@/lib/boards/dates";
import type { BoardActivityEntry, BoardMember } from "@/lib/boards/types";
import { MemberAvatar } from "./member-avatar";

// The activity feed. Rows arrive as structured events (action type + metadata)
// and the sentence is composed here — see lib/boards/activity.ts for why the
// wording deliberately does not live in the database.

export function ActivityList({
  activity,
  membersById,
  now,
}: {
  activity: BoardActivityEntry[];
  membersById: Map<string, BoardMember>;
  now: Date;
}) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
        <History className="h-3.5 w-3.5" />
        Activity
      </h3>

      {activity.length === 0 && <p className="text-xs text-fg-subtle">Nothing has happened yet.</p>}

      <ul className="space-y-2">
        {activity.map((entry) => {
          const actor = entry.actorMemberId ? membersById.get(entry.actorMemberId) ?? null : null;
          return (
            <li key={entry.id} className="flex items-start gap-2">
              {actor ? (
                <MemberAvatar member={actor} size="xs" className="mt-0.5" />
              ) : (
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-hover text-[9px] text-fg-muted">
                  ?
                </span>
              )}
              <p className="text-xs leading-relaxed text-fg-muted">
                {describeActivity(entry, actor?.displayName ?? null)}
                <span className="ml-1.5 text-fg-subtle">{relativeTime(entry.createdAt, now)}</span>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

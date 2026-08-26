"use client";

import * as React from "react";
import { Check, Filter, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { labelBarClass } from "@/lib/boards/theme";
import {
  activeFilterCount,
  EMPTY_FILTER,
  toggleId,
  type BoardFilter,
  type CompletionFilter,
  type DueFilter,
} from "@/lib/boards/filter";
import type { BoardLabel, BoardMember } from "@/lib/boards/types";
import { MemberAvatar } from "./member-avatar";

// Search + filters. Presentation only: the predicate itself lives in
// lib/boards/filter.ts so it can be unit-tested and reused by any future view
// (a calendar, a "my cards" list) without dragging this component along.

const DUE_OPTIONS: { value: DueFilter; label: string }[] = [
  { value: "any", label: "Any due date" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "week", label: "Due this week" },
  { value: "none", label: "No due date" },
];

const COMPLETION_OPTIONS: { value: CompletionFilter; label: string }[] = [
  { value: "any", label: "Any status" },
  { value: "incomplete", label: "Not complete" },
  { value: "complete", label: "Complete" },
];

export function FilterBar({
  filter,
  onChange,
  labels,
  members,
}: {
  filter: BoardFilter;
  onChange: (next: BoardFilter) => void;
  labels: BoardLabel[];
  members: BoardMember[];
}) {
  const count = activeFilterCount(filter);

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
        <Input
          value={filter.keyword}
          onChange={(e) => onChange({ ...filter, keyword: e.target.value })}
          placeholder="Search cards"
          aria-label="Search cards"
          className="h-8 w-44 pl-8 text-xs sm:w-56"
        />
        {filter.keyword && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onChange({ ...filter, keyword: "" })}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Filter className="h-3.5 w-3.5" />
            Filter
            {count > 0 && (
              <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                {count}
              </Badge>
            )}
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-64 max-h-[70vh] overflow-y-auto">
          <DropdownMenuLabel>Members</DropdownMenuLabel>
          {members.length === 0 && (
            <p className="px-2.5 pb-1.5 text-xs text-fg-subtle">Nobody on this board yet</p>
          )}
          {members.map((member) => {
            const active = filter.memberIds.includes(member.id);
            return (
              <DropdownMenuItem
                key={member.id}
                // Radix closes on select by default; filters are usually chosen
                // several at a time, so the menu is kept open instead.
                onSelect={(e) => {
                  e.preventDefault();
                  onChange({ ...filter, memberIds: toggleId(filter.memberIds, member.id) });
                }}
              >
                <MemberAvatar member={member} size="xs" />
                <span className="flex-1 truncate">{member.displayName}</span>
                {active && <Check className="h-3.5 w-3.5 text-brand-400" />}
              </DropdownMenuItem>
            );
          })}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Labels</DropdownMenuLabel>
          {labels.map((label) => {
            const active = filter.labelIds.includes(label.id);
            return (
              <DropdownMenuItem
                key={label.id}
                onSelect={(e) => {
                  e.preventDefault();
                  onChange({ ...filter, labelIds: toggleId(filter.labelIds, label.id) });
                }}
              >
                <span className={cn("h-2.5 w-6 rounded-full", labelBarClass(label.color))} />
                <span className="flex-1 truncate">{label.name || label.color}</span>
                {active && <Check className="h-3.5 w-3.5 text-brand-400" />}
              </DropdownMenuItem>
            );
          })}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Due date</DropdownMenuLabel>
          {DUE_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onSelect={(e) => {
                e.preventDefault();
                onChange({ ...filter, due: option.value });
              }}
            >
              <span className="flex-1">{option.label}</span>
              {filter.due === option.value && <Check className="h-3.5 w-3.5 text-brand-400" />}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Status</DropdownMenuLabel>
          {COMPLETION_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onSelect={(e) => {
                e.preventDefault();
                onChange({ ...filter, completion: option.value });
              }}
            >
              <span className="flex-1">{option.label}</span>
              {filter.completion === option.value && <Check className="h-3.5 w-3.5 text-brand-400" />}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onChange({ ...filter, searchDescriptions: !filter.searchDescriptions });
            }}
          >
            <span className="flex-1">Search descriptions too</span>
            {filter.searchDescriptions && <Check className="h-3.5 w-3.5 text-brand-400" />}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onChange({ ...EMPTY_FILTER })}>
            <X className="h-3.5 w-3.5" />
            Clear all filters
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

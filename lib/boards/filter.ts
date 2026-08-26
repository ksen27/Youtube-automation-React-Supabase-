// Board filtering and search.
//
// Filtering is a pure predicate over already-loaded cards rather than a server
// round trip: a board's cards are all in memory anyway (the snapshot endpoint
// returns them together), so typing in the search box re-renders instead of
// re-fetching. That also guarantees the requirement that filtering never
// mutates data — this module cannot write anything.
//
// Keeping it pure and standalone is what makes it reusable for the future views
// mentioned in the brief (a calendar or a "my cards" list can call
// `matchesFilter` over the same snapshot).

import type { BoardCard } from "./types";
import { daysUntil } from "./dates";

export type DueFilter = "any" | "overdue" | "today" | "week" | "none";
export type CompletionFilter = "any" | "complete" | "incomplete";

export interface BoardFilter {
  keyword: string;
  /** Card matches if it is assigned to ANY of these (union, like Trello). */
  memberIds: string[];
  /** Card matches if it carries ANY of these. */
  labelIds: string[];
  due: DueFilter;
  completion: CompletionFilter;
  /** Search descriptions too. Off by default — titles are what people scan. */
  searchDescriptions: boolean;
}

export const EMPTY_FILTER: BoardFilter = {
  keyword: "",
  memberIds: [],
  labelIds: [],
  due: "any",
  completion: "any",
  searchDescriptions: false,
};

export function isFilterActive(filter: BoardFilter): boolean {
  return (
    filter.keyword.trim().length > 0 ||
    filter.memberIds.length > 0 ||
    filter.labelIds.length > 0 ||
    filter.due !== "any" ||
    filter.completion !== "any"
  );
}

/** Count of the distinct criteria in play — drives the badge on the filter button. */
export function activeFilterCount(filter: BoardFilter): number {
  let n = 0;
  if (filter.keyword.trim()) n++;
  if (filter.memberIds.length) n++;
  if (filter.labelIds.length) n++;
  if (filter.due !== "any") n++;
  if (filter.completion !== "any") n++;
  return n;
}

function matchesDue(card: BoardCard, due: DueFilter, now: Date): boolean {
  if (due === "any") return true;
  if (due === "none") return card.dueAt == null;
  if (!card.dueAt) return false;
  const date = new Date(card.dueAt);
  if (!Number.isFinite(date.getTime())) return false;

  switch (due) {
    case "overdue":
      // A completed card is never "overdue" — see formatDue for the reasoning.
      return !card.completed && date.getTime() < now.getTime();
    case "today":
      return daysUntil(date, now) === 0;
    case "week": {
      const d = daysUntil(date, now);
      return d >= 0 && d <= 7;
    }
    default:
      return true;
  }
}

/**
 * Criteria combine with AND across categories and OR within one — the behaviour
 * people expect from Trello: "cards for Sara OR Ben, that also carry the Blocked
 * label".
 */
export function matchesFilter(card: BoardCard, filter: BoardFilter, now: Date): boolean {
  const keyword = filter.keyword.trim().toLowerCase();
  if (keyword) {
    const inTitle = card.title.toLowerCase().includes(keyword);
    const inDescription =
      filter.searchDescriptions && card.description.toLowerCase().includes(keyword);
    if (!inTitle && !inDescription) return false;
  }

  if (filter.memberIds.length > 0) {
    if (!filter.memberIds.some((id) => card.memberIds.includes(id))) return false;
  }

  if (filter.labelIds.length > 0) {
    if (!filter.labelIds.some((id) => card.labelIds.includes(id))) return false;
  }

  if (filter.completion === "complete" && !card.completed) return false;
  if (filter.completion === "incomplete" && card.completed) return false;

  return matchesDue(card, filter.due, now);
}

export function filterCards(
  cards: readonly BoardCard[],
  filter: BoardFilter,
  now: Date,
): BoardCard[] {
  if (!isFilterActive(filter)) return [...cards];
  return cards.filter((c) => matchesFilter(c, filter, now));
}

/** Immutable toggle used by the filter popover's checkbox rows. */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

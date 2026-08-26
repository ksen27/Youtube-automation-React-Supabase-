// Due-date presentation and the day-bucket maths the due filter shares with it.
//
// Pure and `now`-injected: every function takes the current time as an argument
// instead of calling Date.now() internally, so the tests can pin a date and the
// server and client can agree on a bucket without one of them being "live".

export type DueTone = "neutral" | "soon" | "overdue" | "done";

export interface DueDisplay {
  text: string;
  tone: DueTone;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between two instants, counted by calendar day, not by elapsed ms. */
export function daysUntil(due: Date, now: Date): number {
  const a = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / DAY_MS);
}

export function isOverdue(dueAt: string | null, completed: boolean, now: Date): boolean {
  if (!dueAt || completed) return false;
  const due = new Date(dueAt);
  return Number.isFinite(due.getTime()) && due.getTime() < now.getTime();
}

/**
 * The badge shown on a card and in the detail view: "Due tomorrow", "Due Aug 25",
 * "Overdue", "Completed". A completed card never reads as overdue — finishing
 * something late is still finishing it, and a red badge there is just noise.
 */
export function formatDue(dueAt: string | null, completed: boolean, now: Date): DueDisplay | null {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime())) return null;

  if (completed) return { text: "Completed", tone: "done" };

  const days = daysUntil(due, now);
  if (due.getTime() < now.getTime()) {
    return { text: days === 0 ? "Due today" : "Overdue", tone: "overdue" };
  }
  if (days === 0) return { text: "Due today", tone: "soon" };
  if (days === 1) return { text: "Due tomorrow", tone: "soon" };
  if (days <= 7) return { text: `Due ${weekday(due)}`, tone: "soon" };
  return { text: `Due ${shortDate(due)}`, tone: "neutral" };
}

/** "Aug 25" / "Aug 25, 2027" — the year only when it isn't the current one. */
export function shortDate(date: Date, now: Date = date): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString(undefined, opts);
}

function weekday(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "long" });
}

/** "2m ago", "3h ago", "Aug 12" — used by comments and the activity feed. */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return "";
  const diff = now.getTime() - then.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return shortDate(then, now);
}

/**
 * `<input type="datetime-local">` speaks local wall-clock with no zone, while
 * the DB stores timestamptz. These two convert between them without the usual
 * `toISOString().slice(0,16)` bug, which silently shifts the displayed time by
 * the viewer's UTC offset.
 */
export function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

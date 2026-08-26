"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// Click-to-edit text, used for the board name, list titles and card titles.
//
// The interaction rules are the ones people already expect from Trello and are
// worth stating because they are easy to get subtly wrong:
//   * Enter saves (single-line) / Cmd+Enter saves (multi-line);
//   * Escape cancels and restores the original value;
//   * blur saves, because clicking away after typing means "keep it";
//   * an empty value is a cancel, not a save — nobody means to name a list "".
//
// It is rendered as a real <button> when idle so keyboard users can reach and
// open the editor, which a click-handler on a <div> would not give them.

export interface InlineTextProps {
  value: string;
  onSave: (next: string) => void;
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  /** Rendered instead of the raw value when idle (e.g. muted placeholder). */
  children?: React.ReactNode;
  ariaLabel?: string;
}

export function InlineText({
  value,
  onSave,
  multiline = false,
  placeholder,
  disabled = false,
  className,
  inputClassName,
  children,
  ariaLabel,
}: InlineTextProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [lastValue, setLastValue] = React.useState(value);
  const ref = React.useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  // A teammate's edit (or an optimistic rollback) can change `value` underneath
  // us. Adopt it only while idle, so it never overwrites what someone is
  // mid-way through typing.
  //
  // Adjusted DURING render rather than in an effect — React's documented way to
  // reset state from props (https://react.dev/reference/react/useState). An
  // effect would render the stale draft first and then immediately re-render.
  if (!editing && value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  React.useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === value) {
      setDraft(value);
      return;
    }
    onSave(next);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setEditing(true)}
        className={cn(
          "text-left w-full rounded-md px-1.5 py-1 -mx-1.5 transition-colors",
          !disabled && "hover:bg-surface-hover",
          disabled && "cursor-default",
          className,
        )}
      >
        {children ?? value ?? placeholder}
      </button>
    );
  }

  const shared = {
    ref,
    value: draft,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: commit,
    className: cn(
      "w-full rounded-md border border-brand-500 bg-surface px-1.5 py-1 -mx-1.5 text-inherit",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25",
      inputClassName,
    ),
  };

  return multiline ? (
    <textarea
      {...shared}
      rows={3}
      onKeyDown={(e) => {
        if (e.key === "Escape") cancel();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
      }}
    />
  ) : (
    <input
      {...shared}
      onKeyDown={(e) => {
        if (e.key === "Escape") cancel();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

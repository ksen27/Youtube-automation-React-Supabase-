"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// "+ Add a card" → inline composer.
//
// Behaviour worth being deliberate about: after a successful save the form
// stays OPEN and clears, because adding cards is a burst activity — someone
// emptying their notes into a column should be able to type, Enter, type,
// Enter. Escape (or the X) is the way out.

export interface AddCardFormProps {
  onSubmit: (title: string) => Promise<unknown>;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
}

export function AddCardForm({
  onSubmit,
  disabled = false,
  label = "Add a card",
  placeholder = "What needs doing?",
}: AddCardFormProps) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setTitle("");
    setError(null);
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setTitle("");
      inputRef.current?.focus();
    } catch (e) {
      // The card was NOT added; keep the text so nothing the user typed is lost.
      setError(e instanceof Error ? e.message : "Could not add the card.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-fg-muted",
          "hover:bg-surface-hover hover:text-fg transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
          disabled && "opacity-50 pointer-events-none",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
        {label}
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        ref={inputRef}
        rows={2}
        value={title}
        placeholder={placeholder}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          // Enter saves; Shift+Enter is a newline, since a card title can wrap.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") close();
        }}
        className={cn(
          "w-full resize-none rounded-[10px] border border-brand-500 bg-surface px-2.5 py-2 text-sm text-fg",
          "placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25",
        )}
      />
      {error && <p className="text-[11px] text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={!title.trim() || saving}>
          {saving ? "Adding…" : "Add card"}
        </Button>
        <Button size="icon" variant="ghost" onClick={close} aria-label="Cancel" className="h-8 w-8">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

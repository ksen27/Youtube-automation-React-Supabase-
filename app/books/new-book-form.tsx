"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clampInt, estimateChapters } from "./_shared";

type BookType = "normal" | "cooking";

/** A row of the reference library, as returned by GET /api/books/references. */
interface ReferenceBook {
  id: string;
  title: string;
  author: string | null;
  source: "upload" | "generated";
  status: "PENDING" | "GENERATING" | "DONE" | "FAILED";
  wordCount: number;
  sectionCount: number;
  error: string | null;
}

/**
 * Submit a book for generation: a TITLE and a REFERENCE BOOK.
 *
 * The title is the book's subject — with no channel behind it, nothing else
 * says what the book is about. The reference supplies the voice it is written
 * in.
 *
 * Stays on the page after a successful submit rather than navigating to the new
 * book: books run in parallel up to the server-side cap, so the common next
 * action is queueing another one. The confirmation links through instead.
 */
export function NewBookForm() {
  const router = useRouter();
  const [referenceId, setReferenceId] = useState("");
  const [references, setReferences] = useState<ReferenceBook[] | null>(null);
  const [title, setTitle] = useState("");
  const [bookType, setBookType] = useState<BookType>("normal");
  const [recipeCount, setRecipeCount] = useState(60);
  const [pages, setPages] = useState(100);
  const [illustrations, setIllustrations] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{
    id: string;
    title: string;
    queued: boolean;
    position: number;
    mismatch?: string;
  } | null>(null);

  // The library is small (one owner, a handful of books), so it loads whole
  // rather than paging. `null` is "still loading" and distinguishes an empty
  // library from an unfetched one — they need different messages.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/books/references")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setReferences(d.references ?? []);
      })
      .catch(() => {
        if (!cancelled) setReferences([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only a fully extracted reference can supply a voice; a PENDING one is still
  // being read. Shown but not selectable, so its absence is not a mystery.
  const usable = (references ?? []).filter((r) => r.status === "DONE");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || !referenceId) {
      setError(
        !trimmedTitle && !referenceId
          ? "Enter a book title and choose a reference book."
          : !trimmedTitle
            ? "Enter a book title — it is what the book will be about."
            : "Choose a reference book to write in the style of.",
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    setStarted(null);
    try {
      const res = await fetch("/api/books/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          referenceBookIds: [referenceId],
          options: {
            bookTitle: trimmedTitle,
            bookType,
            targetPages: clampInt(pages, 10, 200, 100),
            includeIllustrations: illustrations,
            // Fallback only — a count in the title overrides this on the backend.
            ...(bookType === "cooking" ? { recipeCount: clampInt(recipeCount, 10, 120, 60) } : {}),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not start the book");
        setSubmitting(false);
        return;
      }
      setTitle("");
      setStarted({
        id: data.projectId,
        title: trimmedTitle,
        queued: Boolean(data.queued),
        position: Number(data.queuePosition) || 0,
        // Advisory: the book is already running. Says the reference's own shape
        // disagrees with the chosen book type, so only its voice carries over.
        ...(data.referenceTypeMismatch ? { mismatch: String(data.referenceTypeMismatch) } : {}),
      });
      setSubmitting(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the book");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="referenceBook">Reference book</Label>
          <select
            id="referenceBook"
            value={referenceId}
            onChange={(e) => setReferenceId(e.target.value)}
            className="flex h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            <option value="">
              {references === null ? "Loading…" : usable.length === 0 ? "No reference books yet" : "Choose one…"}
            </option>
            {usable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
                {r.source === "generated" ? " (generated)" : ""}
              </option>
            ))}
          </select>
          <p className="text-xs text-fg-subtle">The new book is written in this book&rsquo;s voice.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bookTitle">Book title</Label>
          <Input
            id="bookTitle"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. The Complete Guide to Sourdough"
          />
          <p className="text-xs text-fg-subtle">
            The title is the subject — name what the book is about, not just its format.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bookType">Book type</Label>
          <select
            id="bookType"
            value={bookType}
            onChange={(e) => setBookType(e.target.value as BookType)}
            className="flex h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            <option value="normal">Normal</option>
            <option value="cooking">Cookbook</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pages">Target pages</Label>
          <Input
            id="pages"
            type="number"
            min={10}
            max={200}
            value={pages}
            onChange={(e) => setPages(Number(e.target.value))}
          />
          <p className="text-xs text-fg-subtle">≈ {estimateChapters(pages)} chapters</p>
        </div>
      </div>

      {bookType === "cooking" && (
        <div className="space-y-1.5 max-w-xs">
          <Label htmlFor="recipeCount">Recipes</Label>
          <Input
            id="recipeCount"
            type="number"
            min={10}
            max={120}
            value={recipeCount}
            onChange={(e) => setRecipeCount(Number(e.target.value))}
          />
          <p className="text-xs text-fg-subtle">
            A number in the title (e.g. “101 Recipes”) overrides this.
          </p>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-fg-muted">
        <input
          type="checkbox"
          checked={illustrations}
          onChange={(e) => setIllustrations(e.target.checked)}
          className="h-4 w-4 rounded border-border accent-[var(--color-brand-500)]"
        />
        Generate in-chapter illustrations
      </label>

      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}

      {started && (
        <div className="rounded-md border border-border bg-surface/60 px-4 py-3 text-sm">
          <p className="text-fg">
            <span className="font-medium">{started.title}</span>{" "}
            {started.queued
              ? `is queued${started.position ? ` (position ${started.position})` : ""} and will start automatically.`
              : "is generating now."}
          </p>
          {started.mismatch && (
            <p className="mt-1 text-xs text-amber-400">{started.mismatch}</p>
          )}
          <Link
            href={`/books/${started.id}`}
            className="mt-1 inline-flex items-center gap-1 text-brand-300 hover:underline"
          >
            Watch its progress <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button type="submit" variant="gradient" size="lg" disabled={submitting}>
          <BookOpen className="h-4 w-4" />
          {submitting ? "Starting…" : "Start book"}
        </Button>
      </div>
    </form>
  );
}

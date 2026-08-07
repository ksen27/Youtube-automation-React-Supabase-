"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { BookOpen, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clampInt, estimateChapters } from "./_shared";

type BookType = "normal" | "cooking";

/**
 * Submit a channel for book generation.
 *
 * Stays on the page after a successful submit rather than navigating to the new
 * book: books run in parallel up to the server-side cap, so the common next
 * action is queueing another one. The confirmation links through instead.
 */
export function NewBookForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [bookType, setBookType] = useState<BookType>("normal");
  const [recipeCount, setRecipeCount] = useState(60);
  const [pages, setPages] = useState(100);
  const [videos, setVideos] = useState(30);
  const [illustrations, setIllustrations] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ id: string; title: string; queued: boolean; position: number } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedUrl = url.trim();
    if (!trimmedTitle || !trimmedUrl) {
      setError(
        !trimmedTitle && !trimmedUrl
          ? "Enter a book title and a YouTube channel URL."
          : !trimmedTitle
            ? "Enter a book title."
            : "Enter a YouTube channel URL.",
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
          channelUrl: trimmedUrl,
          options: {
            bookTitle: trimmedTitle,
            bookType,
            targetPages: clampInt(pages, 10, 200, 100),
            maxVideos: clampInt(videos, 5, 50, 30),
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
      setUrl("");
      setStarted({
        id: data.projectId,
        title: trimmedTitle,
        queued: Boolean(data.queued),
        position: Number(data.queuePosition) || 0,
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
          <Label htmlFor="channelUrl">YouTube channel URL</Label>
          <Input
            id="channelUrl"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/@SomeChannel"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bookTitle">Book title</Label>
          <Input
            id="bookTitle"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. The Complete Guide to Sourdough"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
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
        <div className="space-y-1.5">
          <Label htmlFor="videos">Videos to analyze</Label>
          <Input
            id="videos"
            type="number"
            min={5}
            max={50}
            value={videos}
            onChange={(e) => setVideos(Number(e.target.value))}
          />
          <p className="text-xs text-fg-subtle">More videos = richer book, slower run</p>
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

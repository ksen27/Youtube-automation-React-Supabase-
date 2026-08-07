"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  FileText,
  Loader2,
  PenLine,
  RotateCcw,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PIPELINE_STAGES,
  badgeVariantFor,
  humanizeStatus,
  isActiveStatus,
  isQueuedStatus,
  stageIndex,
} from "../_shared";
import { LandingPageCard } from "./landing-page-card";

interface Props {
  id: string;
  initialStatus: string;
  initialError: string | null;
}

interface BookChapter {
  id: string;
  position: number;
  title: string;
  wordCount: number;
  wordTarget: number;
  status: string;
}

interface BookData {
  title: string | null;
  estimatedPages: number;
  chapters: BookChapter[];
}

export function BookDetail({ id, initialStatus, initialError }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [pending, setPending] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(initialError);
  const [book, setBook] = useState<BookData | null>(null);
  const [busy, setBusy] = useState(false);

  // Whether there was a pipeline to watch AT MOUNT. Captured from the initial
  // prop rather than from live state: the effect must decide once, and
  // depending on the status the stream itself updates would tear down and
  // re-open the EventSource on every status change.
  const [watchPipeline] = useState(() => isActiveStatus(initialStatus));

  // `isCancelled` guards the state write so a fetch resolving after unmount
  // (navigating away mid-request) doesn't setState on a dead component.
  const loadBook = useCallback(async (isCancelled?: () => boolean) => {
    try {
      const res = await fetch(`/api/books/projects/${id}/book`, { cache: "no-store" });
      if (!res.ok || isCancelled?.()) return;
      const data = await res.json();
      if (isCancelled?.()) return;
      setBook(data.book ?? null);
    } catch {
      /* transient — the next tick will try again */
    }
  }, [id]);

  // Live pipeline progress, and the book itself once there is one to show.
  //
  // One effect covering both: the SSE stream ends itself on COMPLETED/FAILED, at
  // which point the book is fetched. Kept together so every setState happens in
  // an async/event callback rather than synchronously in the effect body, which
  // is what react-hooks/set-state-in-effect requires.
  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;

    // A finished book has no stream to open — just load it. Microtask rather
    // than a direct call: a cache-warm fetch can resolve inside the effect and
    // cascade a render (react-hooks/set-state-in-effect).
    if (!watchPipeline) {
      queueMicrotask(() => {
        if (!cancelled) void loadBook(isCancelled);
      });
      return () => { cancelled = true; };
    }

    const es = new EventSource(`/api/books/projects/${id}/events`);
    es.onmessage = (ev) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(ev.data);
        if (data.error) return;
        if (data.status) setStatus(data.status);
        if (data.pending) setPending(data.pending);
        if (data.status === "COMPLETED" || data.status === "FAILED") {
          es.close();
          void loadBook(isCancelled);
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => es.close();
    return () => {
      cancelled = true;
      es.close();
    };
  }, [id, loadBook, watchPipeline]);

  async function retry() {
    setBusy(true);
    try {
      const res = await fetch(`/api/books/projects/${id}/retry`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Retry failed");
      else {
        setErr(null);
        setStatus(data.status ?? status);
      }
    } finally {
      setBusy(false);
    }
  }

  async function exportBook(format: "pdf" | "docx" | "both") {
    setBusy(true);
    try {
      const res = await fetch("/api/books/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id, format }),
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Export failed");
    } finally {
      setBusy(false);
    }
  }

  const current = stageIndex(status);
  const done = status === "COMPLETED";
  const failed = status === "FAILED";

  return (
    <div className="px-6 lg:px-8 py-8 max-w-5xl mx-auto space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/books"
            className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All books
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg truncate">
            {book?.title?.trim() || "Book"}
          </h1>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant={badgeVariantFor(status)}>{humanizeStatus(status)}</Badge>
            {book && (
              <span className="text-xs text-fg-subtle">
                ~{book.estimatedPages} pages · {book.chapters.length} chapters
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {done && (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => exportBook("both")}>
                <Download className="h-4 w-4" /> Export
              </Button>
              <Button asChild size="sm" variant="gradient">
                <Link href={`/books/${id}/editor`}>
                  <PenLine className="h-4 w-4" /> Edit chapters
                </Link>
              </Button>
            </>
          )}
          {failed && (
            <Button variant="outline" size="sm" disabled={busy} onClick={retry}>
              <RotateCcw className="h-4 w-4" /> Retry
            </Button>
          )}
        </div>
      </div>

      {err && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{err}</span>
        </div>
      )}

      {isQueuedStatus(status) && (
        <Card>
          <CardContent className="py-6 text-sm text-fg-muted">
            Waiting for a free slot — this book starts automatically when one of the
            running books finishes.
          </CardContent>
        </Card>
      )}

      {!done && !isQueuedStatus(status) && (
        <Card>
          <CardHeader>
            <CardTitle>Progress</CardTitle>
            <CardDescription>
              {failed
                ? "The pipeline stopped. Retry re-runs the failed stage with its original inputs."
                : "Each stage runs on its own queue; fan-out stages show how many items remain."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-1">
              {PIPELINE_STAGES.map((stage, i) => {
                const isDone = current > i;
                const isCurrent = current === i;
                const remaining = pending[stage.status];
                return (
                  <li
                    key={stage.status}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                      isCurrent && "bg-surface-hover",
                    )}
                  >
                    <span className="grid h-5 w-5 shrink-0 place-items-center">
                      {isDone ? (
                        <Check className="h-4 w-4 text-emerald-400" />
                      ) : isCurrent ? (
                        failed ? (
                          <AlertTriangle className="h-4 w-4 text-red-400" />
                        ) : (
                          <Loader2 className="h-4 w-4 animate-spin text-brand-400" />
                        )
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-border" />
                      )}
                    </span>
                    <span
                      className={cn(
                        "flex-1 truncate",
                        isDone ? "text-fg-muted" : isCurrent ? "text-fg font-medium" : "text-fg-subtle",
                      )}
                    >
                      {stage.label}
                    </span>
                    {isCurrent && typeof remaining === "number" && remaining > 0 && (
                      <span className="text-xs text-fg-subtle">{remaining} left</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
      )}

      {book && book.chapters.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Chapters</CardTitle>
            <CardDescription>
              {book.chapters.filter((c) => c.status === "DONE").length} of{" "}
              {book.chapters.length} written
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {book.chapters.map((ch) => (
              <div
                key={ch.id}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-surface-hover"
              >
                <FileText className="h-4 w-4 shrink-0 text-fg-subtle" />
                <span className="w-6 shrink-0 text-xs text-fg-subtle">{ch.position}</span>
                <span className="flex-1 truncate text-fg">{ch.title}</span>
                <span className="shrink-0 text-xs text-fg-subtle">
                  {ch.wordCount.toLocaleString()} / {ch.wordTarget.toLocaleString()} words
                </span>
                <Badge variant={ch.status === "DONE" ? "success" : "secondary"}>
                  {ch.status.toLowerCase()}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {done && <LandingPageCard projectId={id} />}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Save, Sparkles } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface Chapter {
  id: string;
  position: number;
  title: string;
  topic: string;
  wordCount: number;
  wordTarget: number;
  status: string;
  version: number;
  content: string | null;
}

export function ChapterEditor({ projectId }: { projectId: string }) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Unsaved edits only, plus the "<chapterId>:<version>" they belong to. See the
  // derivation of `draft` below.
  const [editedKey, setEditedKey] = useState("");
  const [editedText, setEditedText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // `isCancelled` guards the state writes so a fetch resolving after unmount
  // doesn't setState on a dead component.
  const load = useCallback(async (isCancelled?: () => boolean) => {
    try {
      const res = await fetch(`/api/books/projects/${projectId}/book`, { cache: "no-store" });
      const data = await res.json();
      if (isCancelled?.()) return;
      const list: Chapter[] = data.book?.chapters ?? [];
      setChapters(list);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
    } catch {
      if (!isCancelled?.()) setErr("Could not load the book");
    } finally {
      if (!isCancelled?.()) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    // Kicked off from a microtask rather than called straight from the effect
    // body: `load` resolves synchronously from the HTTP cache often enough that
    // its setState lands during the effect, which is the cascading render
    // react-hooks/set-state-in-effect exists to prevent.
    queueMicrotask(() => {
      if (!cancelled) void load(() => cancelled);
    });
    return () => { cancelled = true; };
  }, [load]);

  const selected = chapters.find((c) => c.id === selectedId) ?? null;

  // The editor's text for the selected chapter.
  //
  // Derived during render rather than mirrored into state by an effect: `draft`
  // holds only the user's UNSAVED edits, keyed by chapter id and version. When a
  // regenerate lands (new version) or another chapter is selected, that key no
  // longer matches and the freshly-loaded content shows through — which is the
  // behaviour the old effect was reaching for, without the extra render pass.
  const draftKey = selected ? `${selected.id}:${selected.version}` : "";
  const draft = editedKey === draftKey ? editedText : (selected?.content ?? "");

  function setDraft(text: string) {
    setEditedKey(draftKey);
    setEditedText(text);
  }

  async function save() {
    if (!selected) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/books/chapters/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, content: draft }),
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Could not save");
      else {
        setMsg(`Saved — ${data.wordCount.toLocaleString()} words (v${data.version})`);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (!selected) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/books/chapters/${selected.id}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Could not regenerate");
      else {
        setMsg("Regenerating — this chapter will update when the job finishes.");
        setInstructions("");
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center py-24 text-fg-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="px-6 lg:px-8 py-8 max-w-7xl mx-auto space-y-6">
      <div>
        <Link
          href={`/books/${projectId}`}
          className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to the book
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg">Edit chapters</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <nav className="space-y-1">
          {chapters.map((ch) => (
            <button
              key={ch.id}
              onClick={() => setSelectedId(ch.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                ch.id === selectedId
                  ? "bg-surface-hover text-fg"
                  : "text-fg-muted hover:bg-surface-hover hover:text-fg",
              )}
            >
              <span className="w-5 shrink-0 text-xs text-fg-subtle">{ch.position}</span>
              <span className="flex-1 truncate">{ch.title}</span>
            </button>
          ))}
        </nav>

        {selected ? (
          <div className="space-y-4 min-w-0">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{selected.title}</CardTitle>
                    <CardDescription className="truncate">{selected.topic}</CardDescription>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={selected.status === "DONE" ? "success" : "secondary"}>
                      v{selected.version}
                    </Badge>
                    <span className="text-xs text-fg-subtle">
                      {selected.wordCount.toLocaleString()} / {selected.wordTarget.toLocaleString()}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={24}
                  className="font-mono text-sm leading-relaxed"
                  placeholder="This chapter has not been written yet."
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="gradient" disabled={busy} onClick={save}>
                    <Save className="h-4 w-4" /> Save
                  </Button>
                  {msg && <span className="text-xs text-emerald-400">{msg}</span>}
                  {err && <span className="text-xs text-red-400">{err}</span>}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Regenerate with Claude</CardTitle>
                <CardDescription>
                  Rewrites this chapter from the book&apos;s research. The previous
                  version is kept in history.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="instructions">Instructions (optional)</Label>
                  <Input
                    id="instructions"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="e.g. More concrete examples, less theory"
                  />
                </div>
                <Button size="sm" variant="outline" disabled={busy} onClick={regenerate}>
                  <Sparkles className="h-4 w-4" /> Regenerate chapter
                </Button>
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center text-sm text-fg-muted">
              This book has no chapters yet.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

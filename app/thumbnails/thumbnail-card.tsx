"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Download, Eye, Loader2, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ThumbnailRow {
  id: string;
  title: string;
  prompt: string;
  reference_urls: string[];
  output_url: string | null;
  status: "pending" | "completed" | "failed";
  error: string | null;
  created_at: string;
}

// One entry in the thumbnail gallery: the generated image (or a status
// placeholder), the title, a download link, and Preview / Edit / Delete
// actions. Edit re-runs generation with an edited prompt; Delete removes the
// row and its stored image.
export function ThumbnailCard({ thumbnail: t }: { thumbnail: ThumbnailRow }) {
  const router = useRouter();
  const [preview, setPreview] = useState(false);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(t.prompt);
  const [busy, setBusy] = useState<null | "regen" | "delete">(null);
  const [error, setError] = useState<string | null>(null);

  async function onRegenerate() {
    if (!prompt.trim() || busy) return;
    setBusy("regen");
    setError(null);
    try {
      const r = await fetch(`/api/thumbnails/${t.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `Regenerate failed (${r.status})`);
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Regenerate failed");
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (busy) return;
    if (!window.confirm("Delete this thumbnail? This cannot be undone.")) return;
    setBusy("delete");
    setError(null);
    try {
      const r = await fetch(`/api/thumbnails/${t.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error ?? `Delete failed (${r.status})`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(null);
    }
  }

  const done = t.status === "completed" && t.output_url;

  return (
    <div className="group rounded-[14px] border border-border bg-bg-elevated overflow-hidden">
      <div className="relative aspect-video bg-surface-hover">
        {done ? (
          <button
            type="button"
            onClick={() => setPreview(true)}
            className="block h-full w-full"
            title="Click to preview"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={t.output_url!} alt={t.title || t.prompt} className="h-full w-full object-cover" loading="lazy" />
          </button>
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            {t.status === "failed" ? (
              <Badge variant="destructive">Failed</Badge>
            ) : (
              <Badge variant="warning">Generating…</Badge>
            )}
          </div>
        )}
      </div>

      <div className="p-3 space-y-1.5">
        <p className="text-sm text-fg line-clamp-2" title={t.prompt}>
          {t.title || t.prompt}
        </p>
        {t.status === "failed" && t.error && (
          <p className="text-xs text-danger line-clamp-2" title={t.error}>
            {t.error}
          </p>
        )}
        {error && <p className="text-xs text-danger line-clamp-2">{error}</p>}

        <div className="flex items-center justify-between pt-0.5">
          <span className="text-[11px] text-fg-subtle tabular-nums">
            {new Date(t.created_at).toLocaleDateString()}
          </span>
          <div className="flex items-center gap-1">
            {done && (
              <button
                type="button"
                onClick={() => setPreview(true)}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-fg-muted hover:bg-surface-hover"
                title="Preview"
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => { setPrompt(t.prompt); setEditing(true); }}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-fg-muted hover:bg-surface-hover"
              title="Edit prompt & regenerate"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={busy === "delete"}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-fg-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
              title="Delete"
            >
              {busy === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
            {done && (
              <a
                href={t.output_url!}
                download
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand-300 hover:underline ml-1"
              >
                <Download className="h-3 w-3" /> Download
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Preview modal — full-size image */}
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent className="max-w-4xl">
          <DialogTitle className="sr-only">Thumbnail preview</DialogTitle>
          <DialogDescription className="sr-only">{t.title || t.prompt}</DialogDescription>
          {t.output_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={t.output_url} alt={t.title || t.prompt} className="w-full rounded-md" />
          )}
          <div className="flex items-center justify-between pt-2">
            <p className="text-sm text-fg-muted line-clamp-1" title={t.title}>{t.title}</p>
            {t.output_url && (
              <a
                href={t.output_url}
                download
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand-300 hover:underline"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </a>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit modal — edit the prompt and regenerate */}
      <Dialog open={editing} onOpenChange={(o) => !busy && setEditing(o)}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>Edit &amp; regenerate</DialogTitle>
          <DialogDescription>
            Adjust the prompt and generate a new version of this thumbnail (same channel &amp; subjects).
          </DialogDescription>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            className="mt-1"
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy === "regen"}>
              Cancel
            </Button>
            <Button variant="gradient" onClick={onRegenerate} disabled={!prompt.trim() || busy === "regen"}>
              {busy === "regen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
              {busy === "regen" ? "Regenerating…" : "Regenerate"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

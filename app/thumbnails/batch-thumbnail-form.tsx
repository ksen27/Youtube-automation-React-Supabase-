"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Layers, Loader2, Plus, Upload, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ChannelRow } from "./new-thumbnail-form";

// BATCH thumbnail generation (fire-and-poll). A separate tool from the single
// NewThumbnailForm: queue up to MAX_BATCH FULLY INDEPENDENT thumbnails — each
// with its own channel, title, custom changes, subjects, and prompt — then
// "Generate all" inserts them as `pending`, returns immediately, and the page
// polls /api/thumbnails/status until every row finishes. The gallery below
// shows each card flip Generating… → done live.

const MAX_BATCH = 4;
const MAX_SUBJECTS = 2;
const POLL_INTERVAL_MS = 3000;

let nextId = 1;

interface Subject {
  key: number;
  url: string;
  uploading: boolean;
}
const newSubject = (): Subject => ({ key: nextId++, url: "", uploading: false });

interface BatchRow {
  key: number;
  channelId: string | null;
  title: string;
  customPrompt: string;
  subjects: Subject[];
  prompt: string; // the built, editable final prompt
  building: boolean;
  notice: string | null;
  rowError: string | null;
}
function newRow(defaultChannelId: string | null): BatchRow {
  return {
    key: nextId++,
    channelId: defaultChannelId,
    title: "",
    customPrompt: "",
    subjects: [newSubject()],
    prompt: "",
    building: false,
    notice: null,
    rowError: null,
  };
}

export function BatchThumbnailForm({ channels }: { channels: ChannelRow[] }) {
  const router = useRouter();
  const defaultChannelId = channels[0]?.id ?? null;
  const [rows, setRows] = useState<BatchRow[]>([newRow(defaultChannelId)]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ids of the batch we're polling; while non-empty a poller runs.
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  const fileInputs = useRef<Record<number, HTMLInputElement | null>>({});

  const patchRow = useCallback((key: number, patch: Partial<BatchRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  function addRow() {
    setRows((rs) => (rs.length >= MAX_BATCH ? rs : [...rs, newRow(defaultChannelId)]));
  }
  function removeRow(key: number) {
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((r) => r.key !== key)));
  }

  // ----- subject rows within a batch row -----
  function patchSubject(rowKey: number, subKey: number, patch: Partial<Subject>) {
    setRows((rs) =>
      rs.map((r) =>
        r.key === rowKey
          ? { ...r, subjects: r.subjects.map((s) => (s.key === subKey ? { ...s, ...patch } : s)) }
          : r,
      ),
    );
  }
  function addSubject(rowKey: number) {
    setRows((rs) =>
      rs.map((r) =>
        r.key === rowKey && r.subjects.length < MAX_SUBJECTS
          ? { ...r, subjects: [...r.subjects, newSubject()] }
          : r,
      ),
    );
  }
  function removeSubject(rowKey: number, subKey: number) {
    setRows((rs) =>
      rs.map((r) =>
        r.key === rowKey
          ? {
              ...r,
              subjects:
                r.subjects.length <= 1
                  ? [newSubject()]
                  : r.subjects.filter((s) => s.key !== subKey),
            }
          : r,
      ),
    );
  }
  async function onUpload(rowKey: number, subKey: number, file: File) {
    setError(null);
    patchSubject(rowKey, subKey, { uploading: true });
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/thumbnails/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json()).error ?? `Upload failed (${r.status})`);
      const { url } = await r.json();
      patchSubject(rowKey, subKey, { url, uploading: false });
    } catch (err) {
      patchSubject(rowKey, subKey, { uploading: false });
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  // ----- per-row: build the editable prompt -----
  async function onBuildPrompt(row: BatchRow) {
    if (!row.channelId || !row.title.trim() || row.building) return;
    if (row.subjects.some((s) => s.uploading)) return;
    patchRow(row.key, { building: true, rowError: null, notice: null });
    try {
      const r = await fetch("/api/thumbnails/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: row.channelId,
          title: row.title.trim(),
          customPrompt: row.customPrompt.trim(),
          subjects: row.subjects.filter((s) => s.url.trim()).map((s) => s.url.trim()),
          formatImages: [],
        }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `Build failed (${r.status})`);
      const notices: string[] = [];
      if (json.usedFallback) {
        notices.push(
          json.fallbackReason === "gemini_not_configured"
            ? "AI prompt-writing is not configured — this is just the channel style."
            : "AI prompt-writing failed — the title was not woven in (fallback).",
        );
      }
      patchRow(row.key, {
        prompt: json.prompt as string,
        building: false,
        notice: notices.length ? notices.join(" ") : null,
      });
    } catch (err) {
      patchRow(row.key, {
        building: false,
        rowError: err instanceof Error ? err.message : "Failed to build prompt",
      });
    }
  }

  // ----- poll the batch until every row is terminal -----
  useEffect(() => {
    if (pendingIds.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/thumbnails/status?ids=${pendingIds.join(",")}`, {
          cache: "no-store",
        });
        if (!r.ok) return;
        const json = (await r.json()) as {
          thumbnails: Array<{ id: string; status: string }>;
        };
        const stillPending = json.thumbnails.filter((t) => t.status === "pending").map((t) => t.id);
        // Refresh the gallery so completed/failed cards render their result.
        router.refresh();
        if (!cancelled && stillPending.length === 0) {
          setPendingIds([]);
        }
      } catch {
        // transient — keep polling on the next tick.
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingIds, router]);

  // ----- generate the whole batch -----
  const readyRows = rows.filter((r) => r.channelId && r.title.trim() && r.prompt.trim());
  const anyUploading = rows.some((r) => r.subjects.some((s) => s.uploading));

  async function onGenerateAll() {
    if (generating || anyUploading || readyRows.length === 0) return;
    setGenerating(true);
    setError(null);
    try {
      const r = await fetch("/api/thumbnails/generate/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: readyRows.map((row) => ({
            channelId: row.channelId,
            title: row.title.trim(),
            prompt: row.prompt.trim(),
            subjects: row.subjects.filter((s) => s.url.trim()).map((s) => s.url.trim()),
          })),
        }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `Generate failed (${r.status})`);
      // Reset the form to a single empty row and start polling the new batch.
      setRows([newRow(defaultChannelId)]);
      setPendingIds((json.ids as string[]) ?? []);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch generation failed");
    } finally {
      setGenerating(false);
    }
  }

  if (channels.length === 0) {
    return (
      <p className="text-sm text-fg-muted">Analyze a channel first, then batch-generate here.</p>
    );
  }

  return (
    <div className="space-y-4">
      {pendingIds.length > 0 && (
        <p className="flex items-center gap-2 rounded-md border border-brand-400/40 bg-brand-500/10 px-3 py-2 text-xs text-brand-200">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Generating {pendingIds.length} thumbnail{pendingIds.length > 1 ? "s" : ""} in the
          background — they appear in the gallery below as they finish. You can queue another batch.
        </p>
      )}

      {rows.map((row, idx) => (
        <div key={row.key} className="rounded-xl border border-border bg-surface/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">Thumbnail {idx + 1}</span>
            {rows.length > 1 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(row.key)}>
                <X className="h-4 w-4" /> Remove
              </Button>
            )}
          </div>

          {/* Channel */}
          <div className="space-y-1.5">
            <Label>Channel</Label>
            <div className="flex flex-wrap gap-2">
              {channels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => patchRow(row.key, { channelId: c.id })}
                  className={`rounded-full border px-3 h-8 text-xs font-medium transition-colors ${
                    c.id === row.channelId
                      ? "border-brand-400 bg-brand-500/15 text-brand-200"
                      : "border-border text-fg-muted hover:bg-surface-hover"
                  }`}
                  title={c.channel_input}
                >
                  {c.channel_title || c.channel_input}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label>Video title</Label>
            <Input
              value={row.title}
              onChange={(e) => patchRow(row.key, { title: e.target.value })}
              placeholder="e.g. Rome's Collapse"
            />
          </div>

          {/* Custom changes */}
          <div className="space-y-1.5">
            <Label>Custom changes (optional)</Label>
            <Input
              value={row.customPrompt}
              onChange={(e) => patchRow(row.key, { customPrompt: e.target.value })}
              placeholder="e.g. make it darker, shocked face, no arrows"
            />
          </div>

          {/* Subjects */}
          <div className="space-y-2">
            <Label>Subject images (optional)</Label>
            {row.subjects.map((s, i) => (
              <div key={s.key} className="flex items-center gap-2">
                <div className="h-10 w-[71px] shrink-0 rounded-md border border-border bg-surface-hover overflow-hidden grid place-items-center">
                  {s.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewFor(s.url)} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <ImageIcon className="h-3.5 w-3.5 text-fg-subtle" />
                  )}
                </div>
                <Input
                  value={s.url}
                  onChange={(e) => patchSubject(row.key, s.key, { url: e.target.value })}
                  placeholder={
                    i === 0 ? "Celebrity / person / avatar — URL or upload" : "Second person (optional)"
                  }
                  disabled={s.uploading}
                />
                <input
                  ref={(el) => {
                    fileInputs.current[s.key] = el;
                  }}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUpload(row.key, s.key, f);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title="Upload image"
                  disabled={s.uploading}
                  onClick={() => fileInputs.current[s.key]?.click()}
                >
                  {s.uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="Remove"
                  onClick={() => removeSubject(row.key, s.key)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {row.subjects.length < MAX_SUBJECTS && (
              <Button type="button" variant="ghost" size="sm" onClick={() => addSubject(row.key)}>
                <Plus className="h-4 w-4" /> Add person
              </Button>
            )}
          </div>

          {/* Build prompt */}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onBuildPrompt(row)}
              disabled={!row.channelId || !row.title.trim() || row.building || row.subjects.some((s) => s.uploading)}
            >
              {row.building ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {row.building ? "Building…" : "Build prompt"}
            </Button>
          </div>

          {row.notice && (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              {row.notice}
            </p>
          )}
          {row.rowError && <p className="text-xs text-danger">{row.rowError}</p>}

          {row.prompt && (
            <div className="space-y-1.5">
              <Label>Prompt (review &amp; edit)</Label>
              <Textarea
                value={row.prompt}
                onChange={(e) => patchRow(row.key, { prompt: e.target.value })}
                rows={4}
              />
            </div>
          )}
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        {rows.length < MAX_BATCH && (
          <Button type="button" variant="outline" onClick={addRow}>
            <Plus className="h-4 w-4" /> Add another thumbnail
          </Button>
        )}
        <Button
          type="button"
          variant="gradient"
          size="lg"
          onClick={onGenerateAll}
          disabled={generating || anyUploading || readyRows.length === 0}
        >
          <Layers className="h-4 w-4" />
          {generating
            ? "Queuing…"
            : `Generate ${readyRows.length || ""} thumbnail${readyRows.length === 1 ? "" : "s"}`.trim()}
        </Button>
        {readyRows.length < rows.length && (
          <span className="text-xs text-fg-subtle">
            Only rows with a channel, title, and built prompt are generated.
          </span>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}

// A YouTube link previews via its thumbnail; a direct URL previews as itself.
function previewFor(url: string): string {
  const m = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/,
  );
  if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
  return url;
}

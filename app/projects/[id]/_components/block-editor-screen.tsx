"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Plus, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fmtMinutes, type ClipRow, type TimelineRow } from "../_shared";
import { SceneBlock } from "./blocks/scene-block";

export function BlockEditorScreen({
  projectId,
  selectedId,
  onSelect,
}: {
  projectId: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const qc = useQueryClient();

  const tlQ = useQuery<{ items: TimelineRow[] }>({
    queryKey: ["project-timeline", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/timeline`).then((r) => r.json()),
    refetchInterval: 5000,
  });

  const clipsQ = useQuery<{ clips: ClipRow[] }>({
    queryKey: ["project-clips", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/clips`).then((r) => r.json()),
  });

  const items = useMemo(
    () => (tlQ.data?.items ?? []).slice().sort((a, b) => a.position - b.position),
    [tlQ.data?.items],
  );
  const clips = useMemo(() => clipsQ.data?.clips ?? [], [clipsQ.data?.clips]);
  const clipById = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);

  const [editingClipFor, setEditingClipFor] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: async (body: {
      items: Array<{ id: string; [k: string]: unknown }>;
      approve_all?: boolean;
    }) => {
      const r = await fetch(`/api/projects/${projectId}/timeline`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-timeline", projectId] }),
  });

  const rematch = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/rematch`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-timeline", projectId] });
      qc.invalidateQueries({ queryKey: ["project-jobs", projectId] });
    },
  });

  function reorder(itemId: string, dir: -1 | 1) {
    const idx = items.findIndex((i) => i.id === itemId);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= items.length) return;
    const a = items[idx];
    const b = items[swap];
    patch.mutate({
      items: [
        { id: a.id, position: b.position },
        { id: b.id, position: a.position },
      ],
    });
  }

  function reorderTo(itemId: string, targetIndex: number) {
    const fromIdx = items.findIndex((i) => i.id === itemId);
    if (fromIdx < 0 || fromIdx === targetIndex) return;
    const dir = targetIndex > fromIdx ? 1 : -1;
    let cur = fromIdx;
    while (cur !== targetIndex) {
      reorder(itemId, dir as -1 | 1);
      cur += dir;
    }
  }

  function removeItem(id: string) {
    if (selectedId === id) onSelect(null);
    patch.mutate({ items: [{ id, delete: true }] });
  }

  function replaceClip(itemId: string, clipId: string) {
    patch.mutate({ items: [{ id: itemId, clip_id: clipId }] });
    setEditingClipFor(null);
  }

  const totalSec = items.reduce((s, i) => s + i.duration, 0);
  const approvedCount = items.filter((i) => i.approved).length;
  const allApproved = items.length > 0 && approvedCount === items.length;

  if (tlQ.isLoading) {
    return (
      <div className="max-w-4xl mx-auto space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="max-w-3xl mx-auto">
        <EmptyState
          icon={<Sparkles className="h-5 w-5" />}
          title="No scenes yet"
          description="Once processing finishes, your scene blocks will appear here."
        />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-border bg-surface px-4 py-3">
        <div className="text-sm">
          <span className="font-semibold text-fg tabular-nums">{items.length}</span>
          <span className="text-fg-muted"> scenes · </span>
          <span className="text-fg-muted tabular-nums">{fmtMinutes(totalSec)}</span>
          <span className="text-fg-muted"> · </span>
          <span className={cn("tabular-nums", allApproved ? "text-emerald-400" : "text-fg-muted")}>
            {approvedCount}/{items.length} approved
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled>
            <Plus className="h-3.5 w-3.5" /> Add scene
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={rematch.isPending}
            onClick={() => {
              if (confirm("Re-run matching against the current clips? Your draft scenes will be replaced.")) {
                rematch.mutate();
              }
            }}
            title="Re-run Gemini matching against the current clip set. Useful when a previous match degraded."
          >
            <RefreshCw className={cn("h-3.5 w-3.5", rematch.isPending && "animate-spin")} />
            Re-match
          </Button>
          <Button
            variant="gradient"
            size="sm"
            disabled={allApproved || patch.isPending}
            onClick={() => patch.mutate({ items: [], approve_all: true })}
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Approve all
          </Button>
        </div>
        {rematch.isError && (
          <p className="basis-full text-xs text-danger">
            {(rematch.error as Error).message}
          </p>
        )}
      </div>

      <ol className="space-y-2" onDragOver={(e) => e.preventDefault()}>
        {items.map((it, i) => {
          const clip = it.clip_id ? clipById.get(it.clip_id) : null;
          // Image blocks have no clip_id but may carry a fetched image_url
          // populated by the matcher's image-pool step. Prefer the clip
          // thumbnail when present (footage/intro), otherwise fall back to
          // the image-block's own image_url.
          const thumbnail = clip?.thumbnail_url ?? it.image_url ?? null;
          return (
            <li
              key={it.id}
              draggable
              onDragStart={() => setDraggingId(it.id)}
              onDragEnd={() => setDraggingId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingId && draggingId !== it.id) reorderTo(draggingId, i);
                setDraggingId(null);
              }}
              className={cn(
                "transition-opacity",
                draggingId === it.id && "opacity-40",
              )}
            >
              <SceneBlock
                index={i}
                thumbnail={thumbnail}
                scriptText={it.script_text}
                overlayText={it.overlay_text}
                durationSec={it.duration}
                type={it.type}
                approved={it.approved}
                selected={selectedId === it.id}
                onSelect={() => onSelect(selectedId === it.id ? null : it.id)}
                onReplace={() => setEditingClipFor(editingClipFor === it.id ? null : it.id)}
                onDelete={() => removeItem(it.id)}
              />

              {editingClipFor === it.id && (
                <div className="mt-2 ml-12 rounded-[10px] border border-border bg-bg-elevated p-3">
                  <div className="mb-2 text-xs font-medium text-fg-muted">
                    Replace with another clip
                  </div>
                  {clips.length === 0 ? (
                    <p className="text-xs text-fg-subtle">No clips available.</p>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2 max-h-56 overflow-y-auto">
                      {clips.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => replaceClip(it.id, c.id)}
                          className="aspect-video bg-bg-elevated rounded overflow-hidden border border-border hover:border-brand-500 transition-colors"
                        >
                          {c.thumbnail_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={c.thumbnail_url}
                              alt=""
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

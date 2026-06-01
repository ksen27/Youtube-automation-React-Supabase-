"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, ImageIcon, Play, Plus, RefreshCw, Sparkles, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fmtClock, fmtMinutes, type ClipRow, type TimelineRow } from "../_shared";
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

  // Per-block fallback URLs. When a scene's saved image_url fails to load
  // in the browser (hotlink-block, CORS, expired CDN URL, transient 404),
  // we walk THIS block's own matcher-considered candidates from
  // metadata.image_candidates — i.e. other URLs the matcher found for this
  // specific sentence. We DO NOT borrow image_urls from other scenes
  // anymore: that produced misleading cards showing a topically-unrelated
  // image from a different block (e.g. "The Conversation" poster appearing
  // under courtroom narration because another block had been matched to
  // the word "conversation"). When all of this block's candidates fail
  // too, the SceneBlock falls back to a typed placeholder — the user can
  // see the row's image is broken and click Replace.
  const fallbackUrlsByItemId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const it of items) {
      const meta = it.metadata as Record<string, unknown> | null | undefined;
      const candidates = Array.isArray(meta?.image_candidates)
        ? (meta!.image_candidates as Array<{ url?: unknown }>)
        : [];
      const urls: string[] = [];
      const seen = new Set<string>();
      for (const c of candidates) {
        const url = typeof c?.url === "string" ? c.url : null;
        if (!url || seen.has(url) || url === it.image_url) continue;
        seen.add(url);
        urls.push(url);
      }
      map.set(it.id, urls);
    }
    return map;
  }, [items]);

  // The block whose media is being replaced. When non-null, the replace
  // modal opens. We track the whole row so the modal can decide what tab
  // to default to (footage → Clips, image → Images).
  const [replaceTarget, setReplaceTarget] = useState<TimelineRow | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [previewClip, setPreviewClip] = useState<ClipRow | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);

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

  // Swap the row's media. The modal lets you pick either a clip or an image
  // regardless of the row's current type — when crossing types we update
  // `type` too and clear the old field (clip_id ↔ image_url). The row's
  // existing duration is preserved so the timeline still matches voiceover.
  function pickClip(target: TimelineRow, clipId: string) {
    const patchOne: { id: string; [k: string]: unknown } = {
      id: target.id,
      clip_id: clipId,
    };
    if (target.type === "image") {
      patchOne.type = "footage";
      patchOne.image_url = null;
    }
    patch.mutate({ items: [patchOne] });
    setReplaceTarget(null);
  }

  function pickImage(target: TimelineRow, imageUrl: string) {
    const patchOne: { id: string; [k: string]: unknown } = {
      id: target.id,
      image_url: imageUrl,
    };
    if (target.type !== "image") {
      patchOne.type = "image";
      patchOne.clip_id = null;
    }
    patch.mutate({ items: [patchOne] });
    setReplaceTarget(null);
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
          // thumbnail when present (footage/intro), then the image-block's
          // own image_url, then any metadata.thumbnail_url set by the
          // doc-driven flow (intro_card markers + title_card forced footage
          // both write a YouTube poster URL into metadata so the editor
          // can render a tile instead of an empty grey box).
          const metaThumb =
            (it.metadata as Record<string, unknown> | null | undefined)?.thumbnail_url;
          const thumbnail =
            clip?.thumbnail_url ??
            it.image_url ??
            (typeof metaThumb === "string" ? metaThumb : null);
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
                fallbackThumbnails={fallbackUrlsByItemId.get(it.id) ?? []}
                scriptText={it.script_text}
                overlayText={it.overlay_text}
                durationSec={it.duration}
                type={it.type}
                approved={it.approved}
                selected={selectedId === it.id}
                onSelect={() => onSelect(selectedId === it.id ? null : it.id)}
                onPlay={clip?.clip_url ? () => setPreviewClip(clip) : undefined}
                onReplace={() => setReplaceTarget(it)}
                onDelete={() => removeItem(it.id)}
              />
            </li>
          );
        })}
      </ol>

      <ReplaceMediaDialog
        target={replaceTarget}
        clips={clips}
        items={items}
        onClose={() => setReplaceTarget(null)}
        onPickClip={(clipId) => replaceTarget && pickClip(replaceTarget, clipId)}
        onPickImage={(url) => replaceTarget && pickImage(replaceTarget, url)}
        onPreviewClip={setPreviewClip}
        onPreviewImage={setPreviewImage}
      />
      <ClipPreviewDialog clip={previewClip} onClose={() => setPreviewClip(null)} />
      <ImagePreviewDialog url={previewImage} onClose={() => setPreviewImage(null)} />
    </div>
  );
}

function ClipPreviewDialog({
  clip,
  onClose,
}: {
  clip: ClipRow | null;
  onClose: () => void;
}) {
  const open = clip !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="p-0 overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
          <div className="min-w-0">
            <DialogTitle className="truncate">
              {clip?.source?.title ?? "Clip preview"}
            </DialogTitle>
            {clip && (
              <DialogDescription className="tabular-nums">
                {fmtClock(clip.start_time)} → {fmtClock(clip.end_time)} ·{" "}
                {Math.round(clip.duration)}s
              </DialogDescription>
            )}
          </div>
        </div>
        <div className="bg-black aspect-video">
          {clip?.clip_url ? (
            <video
              key={clip.id}
              src={clip.clip_url}
              poster={clip.thumbnail_url ?? undefined}
              controls
              autoPlay
              className="h-full w-full"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImagePreviewDialog({
  url,
  onClose,
}: {
  url: string | null;
  onClose: () => void;
}) {
  const open = url !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="p-0 overflow-hidden">
        <div className="px-4 pt-3 pb-2">
          <DialogTitle>Image preview</DialogTitle>
        </div>
        <div className="bg-black aspect-video grid place-items-center">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="" className="max-h-full max-w-full object-contain" />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Replace-media modal. Lists every clip on the project plus every image
// currently sitting on an image row, with each tile marked as "Used" if it
// already appears somewhere on the timeline. The same clip is still
// selectable when used — duplicates are allowed in the final render.
//
// Cross-type swaps are permitted: a footage row can adopt an image and
// vice-versa. The caller patches `type` accordingly.
function ReplaceMediaDialog({
  target,
  clips,
  items,
  onClose,
  onPickClip,
  onPickImage,
  onPreviewClip,
  onPreviewImage,
}: {
  target: TimelineRow | null;
  clips: ClipRow[];
  items: TimelineRow[];
  onClose: () => void;
  onPickClip: (clipId: string) => void;
  onPickImage: (url: string) => void;
  onPreviewClip: (c: ClipRow) => void;
  onPreviewImage: (url: string) => void;
}) {
  const open = target !== null;

  const usedClipIds = useMemo(
    () => new Set(items.map((it) => it.clip_id).filter((v): v is string => !!v)),
    [items],
  );
  const usedImageUrls = useMemo(
    () => new Set(items.map((it) => it.image_url).filter((v): v is string => !!v)),
    [items],
  );

  // The project's image pool, in two tiers:
  //   1. For the row currently being edited, the matcher's per-block
  //      candidates from metadata.image_candidates (the URLs it actually
  //      considered for THIS sentence — winner + the alternatives it
  //      rejected). These are listed first because they're the relevant
  //      swap options for the open block.
  //   2. Then every other image_url already used on the timeline, deduped.
  //      These act as "borrow from another scene" picks.
  // Without tier 1 the pool only showed images already assigned somewhere
  // on the timeline, so the user could never swap in a candidate the matcher
  // looked at but didn't pick — leading to the "where's this image from?"
  // problem the editor was reporting.
  const imagePool = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const targetCandidates = Array.isArray(target?.metadata?.image_candidates)
      ? (target!.metadata!.image_candidates as Array<{ url?: unknown }>)
      : [];
    for (const c of targetCandidates) {
      const url = typeof c?.url === "string" ? c.url : null;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    for (const it of items) {
      const url = it.image_url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }, [items, target]);

  const currentTab = target?.type === "image" ? "images" : "clips";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <div className="px-4 pt-3 pb-2">
          <DialogTitle>Replace media</DialogTitle>
          <DialogDescription>
            Pick a clip or an image to use in this scene. The
            <span className="ml-1 inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
              Used
            </span>{" "}
            badge marks items already on the timeline — still pickable.
          </DialogDescription>
        </div>

        <Tabs defaultValue={currentTab} className="px-4 pb-4">
          <TabsList>
            <TabsTrigger value="clips">
              <Video className="h-3.5 w-3.5 mr-1.5" />
              Clips
              <span className="ml-1.5 text-fg-subtle tabular-nums">{clips.length}</span>
            </TabsTrigger>
            <TabsTrigger value="images">
              <ImageIcon className="h-3.5 w-3.5 mr-1.5" />
              Images
              <span className="ml-1.5 text-fg-subtle tabular-nums">{imagePool.length}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="clips">
            {clips.length === 0 ? (
              <p className="text-sm text-fg-subtle py-6 text-center">No clips available.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 max-h-[60vh] overflow-y-auto">
                {clips.map((c) => {
                  const isUsed = usedClipIds.has(c.id);
                  const isCurrent = target?.clip_id === c.id;
                  return (
                    <MediaTile
                      key={c.id}
                      thumbnail={c.thumbnail_url}
                      durationSec={c.duration}
                      isUsed={isUsed}
                      isCurrent={isCurrent}
                      title={c.source?.title ?? undefined}
                      onSelect={() => onPickClip(c.id)}
                      onPreview={c.clip_url ? () => onPreviewClip(c) : undefined}
                    />
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="images">
            {imagePool.length === 0 ? (
              <p className="text-sm text-fg-subtle py-6 text-center">
                No images yet — the matcher hasn&apos;t assigned any.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 max-h-[60vh] overflow-y-auto">
                {imagePool.map((url) => {
                  const isUsed = usedImageUrls.has(url);
                  const isCurrent = target?.image_url === url;
                  return (
                    <MediaTile
                      key={url}
                      thumbnail={url}
                      isUsed={isUsed}
                      isCurrent={isCurrent}
                      onSelect={() => onPickImage(url)}
                      onPreview={() => onPreviewImage(url)}
                    />
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function MediaTile({
  thumbnail,
  durationSec,
  isUsed,
  isCurrent,
  title,
  onSelect,
  onPreview,
}: {
  thumbnail: string | null;
  durationSec?: number;
  isUsed: boolean;
  isCurrent: boolean;
  title?: string;
  onSelect: () => void;
  onPreview?: () => void;
}) {
  return (
    <div
      className={cn(
        "relative group/tile aspect-video rounded-md overflow-hidden border-2 transition-colors",
        isCurrent
          ? "border-brand-500 ring-2 ring-brand-500/40"
          : isUsed
            ? "border-amber-500/70 hover:border-amber-400"
            : "border-border hover:border-brand-500",
      )}
      title={title}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={isUsed ? "Use this item (already on timeline)" : "Use this item"}
        className="absolute inset-0 bg-bg-elevated"
      >
        {thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnail}
            alt=""
            className={cn(
              "h-full w-full object-cover transition-opacity",
              isUsed && !isCurrent && "opacity-70 group-hover/tile:opacity-100",
            )}
            loading="lazy"
          />
        ) : null}
      </button>

      {durationSec !== undefined && (
        <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white tabular-nums">
          {Math.round(durationSec)}s
        </span>
      )}

      {isCurrent ? (
        <span className="absolute top-1 left-1 rounded bg-brand-500 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
          Current
        </span>
      ) : isUsed ? (
        <span className="absolute top-1 left-1 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black">
          Used
        </span>
      ) : (
        <span className="absolute top-1 left-1 rounded bg-emerald-500/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
          Free
        </span>
      )}

      {onPreview && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPreview();
          }}
          aria-label="Preview"
          title="Preview"
          className="absolute bottom-1 right-1 grid place-items-center h-7 w-7 rounded-full bg-black/70 text-white opacity-0 group-hover/tile:opacity-100 transition-opacity hover:bg-black/90"
        >
          <Play className="h-3.5 w-3.5 ml-0.5" />
        </button>
      )}
    </div>
  );
}

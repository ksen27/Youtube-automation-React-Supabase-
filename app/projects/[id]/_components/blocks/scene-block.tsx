"use client";

import * as React from "react";
import {
  GripVertical,
  Play,
  RefreshCw,
  Replace,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SceneBlockProps {
  index: number;
  thumbnail?: string | null;
  /**
   * Ordered list of previously-used image URLs from elsewhere on the timeline.
   * When `thumbnail` 404s/fails to load, the tile walks this list until one
   * resolves so a scene is never rendered blank.
   */
  fallbackThumbnails?: string[];
  scriptText?: string | null;
  overlayText?: string | null;
  durationSec: number;
  type: string;
  approved?: boolean;
  selected?: boolean;
  matchScore?: number;
  isLoading?: boolean;
  onSelect?: () => void;
  onPlay?: () => void;
  onReplace?: () => void;
  onRegenerate?: () => void;
  onDelete?: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
}

export function SceneBlock(p: SceneBlockProps) {
  // Walk the fallback list when the primary thumbnail fails. -1 = show
  // primary, 0..n-1 = show fallbacks[idx], n = exhausted (show placeholder).
  // Reset whenever the primary changes (user replaces media) so the new URL
  // gets a fresh try before falling back again.
  const [fallbackIdx, setFallbackIdx] = React.useState(-1);
  React.useEffect(() => {
    setFallbackIdx(-1);
  }, [p.thumbnail]);
  const fallbacks = React.useMemo(
    () =>
      (p.fallbackThumbnails ?? []).filter(
        (u): u is string => !!u && u !== p.thumbnail,
      ),
    [p.fallbackThumbnails, p.thumbnail],
  );
  const exhausted = fallbackIdx >= fallbacks.length;
  const displayedThumb = exhausted
    ? null
    : fallbackIdx < 0
      ? p.thumbnail
      : fallbacks[fallbackIdx];

  return (
    <div
      onClick={p.onSelect}
      className={cn(
        "group relative flex gap-3 rounded-[12px] border bg-surface p-3 transition-all cursor-pointer",
        "hover:bg-surface-hover hover:border-border-strong",
        p.selected
          ? "border-brand-500 shadow-glow ring-1 ring-brand-500/30"
          : "border-border",
      )}
    >
      <button
        {...p.dragHandleProps}
        type="button"
        aria-label={`Drag scene ${p.index + 1}`}
        onClick={(e) => e.stopPropagation()}
        className="flex w-5 shrink-0 items-center justify-center text-fg-subtle opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing transition-opacity"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <div className="flex w-7 shrink-0 items-start justify-center pt-1">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-bg-elevated text-[11px] font-medium tabular-nums text-fg-muted border border-border">
          {p.index + 1}
        </span>
      </div>

      <div className="relative w-40 aspect-video shrink-0 overflow-hidden rounded-md bg-bg-elevated border border-border">
        {p.isLoading ? (
          <div className="skeleton h-full w-full" />
        ) : displayedThumb ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={displayedThumb}
              src={displayedThumb}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              onError={() => setFallbackIdx((i) => i + 1)}
            />
            {p.onPlay && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  p.onPlay?.();
                }}
                aria-label="Play preview"
                className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <span className="grid place-items-center h-9 w-9 rounded-full bg-white/95 text-black shadow-lg">
                  <Play className="h-4 w-4 ml-0.5" />
                </span>
              </button>
            )}
          </>
        ) : (
          <div className="grid h-full w-full place-items-center text-xs text-fg-subtle">
            {p.type}
          </div>
        )}
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] font-medium tabular-nums text-white">
          {Math.round(p.durationSec)}s
        </span>
      </div>

      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle font-medium">
            {p.type}
          </span>
          {p.approved && (
            <span className="text-[10px] font-medium text-emerald-400">● approved</span>
          )}
          {p.matchScore != null && (
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-fg-subtle">
              <Sparkles className="h-3 w-3" />
              {Math.round(p.matchScore * 100)}% match
            </span>
          )}
        </div>
        {p.scriptText ? (
          <p className="text-sm text-fg leading-relaxed line-clamp-3">{p.scriptText}</p>
        ) : (
          <p className="text-sm text-fg-subtle italic">No script text</p>
        )}
        {p.overlayText && (
          <p className="text-xs text-fg-muted italic line-clamp-1">overlay: {p.overlayText}</p>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconAction
          onClick={p.onReplace}
          label="Replace clip"
          icon={<Replace className="h-3.5 w-3.5" />}
        />
        <IconAction
          onClick={p.onRegenerate}
          label="Regenerate"
          icon={<RefreshCw className="h-3.5 w-3.5" />}
        />
        <IconAction
          onClick={p.onDelete}
          label="Delete"
          icon={<Trash2 className="h-3.5 w-3.5" />}
          danger
        />
      </div>
    </div>
  );
}

function IconAction({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick?: () => void;
}) {
  if (!onClick) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      className={cn("h-7 w-7", danger && "hover:bg-danger/10 hover:text-danger")}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {icon}
    </Button>
  );
}

"use client";

import * as React from "react";
import { CheckCircle2, Play } from "lucide-react";
import { cn } from "@/lib/utils";

export type VideoCardSourceType = "interview" | "news" | "archival" | "other";

export interface VideoCardProps {
  thumbnail: string;
  title: string;
  channel: string;
  durationSec: number;
  score?: number;          // 0–100 percentage to render in the bar
  rawScore?: number;       // raw ranker score, shown in the tooltip
  selected: boolean;
  reasons?: string[];
  sourceType?: VideoCardSourceType;
  // YouTube video id used to build the embed URL when the user clicks
  // the play overlay. Required for the inline preview to work. If
  // omitted, the play overlay is hidden and the card behaves like the
  // legacy thumbnail-only version.
  videoId?: string;
  onToggle?: () => void;
  className?: string;
}

export function VideoCard({
  thumbnail,
  title,
  channel,
  durationSec,
  score,
  rawScore,
  selected,
  reasons,
  sourceType,
  videoId,
  onToggle,
  className,
}: VideoCardProps) {
  // Inline-preview state. Click the play overlay → swap the thumbnail
  // for a YouTube iframe so the user can actually watch the source
  // before approving it. The card stays a button so the rest of the
  // surface still toggles selection; the iframe area lives OUTSIDE
  // the button so clicks on the player don't toggle the card.
  const [playing, setPlaying] = React.useState(false);

  return (
    <div
      aria-pressed={selected}
      className={cn(
        // Selected state is signaled THREE ways:
        //   1. Heavy ring (ring-4 ring-brand-500) — the most visible
        //      indicator from any distance, works against any thumbnail.
        //   2. Brand-tinted background on the metadata block (below).
        //   3. Persistent "SELECTED" badge in the top-right (overrides
        //      the source-type chip while picked).
        // The previous border+shadow combo got lost against colorful
        // thumbnails; ring-4 sits OUTSIDE the border so it's never
        // obscured by the card's content.
        "group relative w-full text-left rounded-[10px] border bg-surface overflow-hidden transition-all",
        "hover:bg-surface-hover hover:-translate-y-px hover:shadow-md",
        selected
          ? "border-brand-500 ring-4 ring-brand-500/60 shadow-glow"
          : "border-border",
        className,
      )}
    >
      {/* Persistent SELECTED badge — rendered OUTSIDE the thumbnail
        wrapper so it survives the player-vs-thumbnail switch. Sits
        in the top-right where the source-type chip would normally
        live; we hide the source-type chip while selected so they
        don't overlap (the user has already picked it, the editorial
        bucket is no longer the priority signal). */}
      {selected && (
        <span className="absolute top-1.5 right-1.5 z-10 grid place-items-center gap-1 rounded-full gradient-brand px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white shadow-lg">
          <span className="flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Selected
          </span>
        </span>
      )}
      <div className="relative aspect-video bg-bg-elevated">
        {playing && videoId ? (
          // Embedded YouTube player. autoplay=1 starts immediately;
          // rel=0 hides "more from this channel" suggestions; modestbranding
          // strips the YouTube logo. The iframe sits ABOVE the toggle
          // button so a click on the video doesn't accidentally toggle
          // the card's selection state.
          <iframe
            src={`https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`}
            title={title}
            className="h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnail}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
            {/* Play overlay — only rendered when we have a videoId. */}
            {videoId && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPlaying(true);
                }}
                className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="Preview source video"
              >
                <span className="grid h-12 w-12 place-items-center rounded-full bg-white/95 text-black shadow-lg">
                  <Play className="h-5 w-5 fill-current ml-0.5" />
                </span>
              </button>
            )}
            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">
              {fmt(durationSec)}
            </span>
            {/* Source-type chip only when NOT selected — when the user
              has picked the card, the SELECTED badge takes the
              top-right slot instead. */}
            {sourceType && !selected && <SourceTypeBadge type={sourceType} />}
          </>
        )}
      </div>
      {/* Toggle target — only the metadata block toggles selection
        when the player is open, so the user can pick/unpick without
        having to close the preview first. Selected cards get a
        brand-tinted background here so the picked state is visible
        even when the player iframe is filling the top half of the
        card. */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "block w-full text-left p-3 space-y-1.5 transition-colors",
          selected
            ? "bg-brand-500/15 hover:bg-brand-500/20"
            : "hover:bg-surface-hover/40",
        )}
      >
        <p className="line-clamp-2 text-sm font-medium leading-snug text-fg">{title}</p>
        <p className="truncate text-xs text-fg-muted">{channel}</p>
        {score != null && <ConfidencePip value={score} rawScore={rawScore} />}
        {reasons && reasons.length > 0 && (
          <p className="text-[11px] text-fg-subtle line-clamp-1">{reasons.join(" · ")}</p>
        )}
      </button>
    </div>
  );
}

// Small colored chip in the top-right of the thumbnail showing the source's
// editorial bucket. Color-coded so the user can spot redundancy patterns
// at a glance (e.g. "all five candidates are orange News, I should pick a
// different lane").
function SourceTypeBadge({ type }: { type: VideoCardSourceType }) {
  const config = {
    interview: { label: "Interview", classes: "bg-blue-500/85 text-white" },
    news:      { label: "News",      classes: "bg-orange-500/85 text-white" },
    archival:  { label: "Archival",  classes: "bg-purple-500/85 text-white" },
    other:     { label: "Other",     classes: "bg-slate-600/85 text-white" },
  }[type];
  return (
    <span
      className={cn(
        "absolute top-1.5 right-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shadow-sm",
        config.classes,
      )}
    >
      {config.label}
    </span>
  );
}

function ConfidencePip({ value, rawScore }: { value: number; rawScore?: number }) {
  // `value` is already a 0–100 percentage. The previous version multiplied by
  // 100, which saturated every bar at full because raw scores >= 1 became
  // 100% — that's why every preview card looked identical.
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const tone = pct >= 75 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-slate-500";
  const tooltip = rawScore != null ? `Raw: ${Math.round(rawScore)} · ${pct}%` : `${pct}%`;
  return (
    <div className="flex items-center gap-1.5" title={tooltip}>
      <div className="h-1 flex-1 rounded-full bg-bg-elevated overflow-hidden">
        <div className={cn("h-full transition-[width] duration-500", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-fg-subtle">{pct}</span>
    </div>
  );
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = String(s % 60).padStart(2, "0");
  return `${m}:${r}`;
}

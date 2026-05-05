"use client";

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface VideoCardProps {
  thumbnail: string;
  title: string;
  channel: string;
  durationSec: number;
  score?: number;          // 0–100 percentage to render in the bar
  rawScore?: number;       // raw ranker score, shown in the tooltip
  selected: boolean;
  reasons?: string[];
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
  onToggle,
  className,
}: VideoCardProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        "group relative w-full text-left rounded-[10px] border bg-surface overflow-hidden transition-all",
        "hover:bg-surface-hover hover:-translate-y-px hover:shadow-md",
        selected ? "border-brand-500 shadow-glow" : "border-border",
        className,
      )}
    >
      <div className="relative aspect-video bg-bg-elevated">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbnail}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">
          {fmt(durationSec)}
        </span>
        {selected && (
          <span className="absolute top-1.5 left-1.5 grid place-items-center h-6 w-6 rounded-full gradient-brand text-white shadow-md">
            <CheckCircle2 className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className="p-3 space-y-1.5">
        <p className="line-clamp-2 text-sm font-medium leading-snug text-fg">{title}</p>
        <p className="truncate text-xs text-fg-muted">{channel}</p>
        {score != null && <ConfidencePip value={score} rawScore={rawScore} />}
        {reasons && reasons.length > 0 && (
          <p className="text-[11px] text-fg-subtle line-clamp-1">{reasons.join(" · ")}</p>
        )}
      </div>
    </button>
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

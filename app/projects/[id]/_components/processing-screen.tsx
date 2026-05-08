"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, AlertCircle, Circle, Scissors, Download } from "lucide-react";
import { StepCard, type StepState } from "@/components/ui/step-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { JobsResp, JobSourceRow } from "../_shared";

const PIPELINE_STEPS = [
  { type: "search", label: "Search & extract", hint: "Finding the right moments" },
  { type: "match", label: "Match to script", hint: "Aligning clips to your text" },
] as const;

type MediaJob = JobsResp["media_jobs"][number];

export function ProcessingScreen({
  jobs,
  onRetry,
}: {
  projectId: string;
  jobs: JobsResp | undefined;
  onRetry?: () => void;
}) {
  const rawMediaJobs = jobs?.media_jobs ?? [];
  const sources = jobs?.video_sources ?? [];
  // Collapse duplicate download attempts for the same YouTube video (retries,
  // fallback re-promotions) to a single row — keep the most recent job, since
  // that is the one whose status reflects what the user can act on.
  const mediaJobs = dedupeDownloadJobs(rawMediaJobs);
  const failedCount = mediaJobs.filter((j) => j.status === "failed").length;

  const downloadState = aggregateState("download", mediaJobs);
  const clipState = aggregateState("clip", mediaJobs);
  const allDone =
    aggregateState("search", mediaJobs) === "done" &&
    downloadState === "done" &&
    clipState === "done" &&
    aggregateState("match", mediaJobs) === "done";

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="text-center pt-4 pb-2">
        <div
          className={
            allDone
              ? "inline-grid h-16 w-16 place-items-center rounded-2xl bg-emerald-500/15 border border-emerald-500/30"
              : "inline-grid h-16 w-16 place-items-center rounded-2xl gradient-brand shadow-glow"
          }
        >
          {allDone ? (
            <span className="text-emerald-400 text-xl">✓</span>
          ) : (
            <Loader2 className="h-7 w-7 text-white animate-spin" />
          )}
        </div>
        <h2 className="mt-4 text-xl font-semibold text-fg">
          {allDone ? "Processing complete" : "Building your video"}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {allDone
            ? "Your scenes are ready to review."
            : "You can leave this page — we'll keep working in the background."}
        </p>
      </div>

      <div className="space-y-2">
        {/* Step 01 — Search (no per-item drilldown) */}
        <StepCard
          index={0}
          label={PIPELINE_STEPS[0].label}
          hint={aggregateState("search", mediaJobs) === "running" ? PIPELINE_STEPS[0].hint : undefined}
          state={aggregateState("search", mediaJobs)}
          progress={aggregateProgress("search", mediaJobs)}
          stat={aggregateStat("search", mediaJobs)}
        />

        {/* Step 02 — Download (expandable per source) */}
        <ExpandableStep
          index={1}
          label="Download videos"
          hint="Pulling source files"
          icon={<Download className="h-4 w-4" />}
          state={downloadState}
          stat={aggregateStat("download", mediaJobs)}
          progress={aggregateProgress("download", mediaJobs)}
        >
          <DownloadList jobs={mediaJobs} sources={sources} />
        </ExpandableStep>

        {/* Step 03 — Clip (expandable per source) */}
        <ExpandableStep
          index={2}
          label="Generate clips"
          hint="Cutting 4–5s clips"
          icon={<Scissors className="h-4 w-4" />}
          state={clipState}
          stat={aggregateStat("clip", mediaJobs)}
          progress={aggregateProgress("clip", mediaJobs)}
        >
          <ClipList jobs={mediaJobs} sources={sources} />
        </ExpandableStep>

        {/* Step 04 — Match */}
        <StepCard
          index={3}
          label={PIPELINE_STEPS[1].label}
          hint={aggregateState("match", mediaJobs) === "running" ? PIPELINE_STEPS[1].hint : undefined}
          state={aggregateState("match", mediaJobs)}
          progress={aggregateProgress("match", mediaJobs)}
          stat={aggregateStat("match", mediaJobs)}
        />
      </div>

      {failedCount > 0 && (
        <div className="rounded-[10px] border border-danger/30 bg-danger/5 p-4 flex items-start gap-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-danger/15 text-danger">
            !
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-fg">
              {failedCount} job{failedCount === 1 ? "" : "s"} failed
            </p>
            <p className="text-xs text-fg-muted mt-0.5">
              Usually transient — try again, or remove the failing source.
            </p>
          </div>
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry failed
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expandable container that mirrors the StepCard look but holds a child list.
// ---------------------------------------------------------------------------

function ExpandableStep({
  index,
  label,
  hint,
  icon,
  state,
  stat,
  progress,
  children,
}: {
  index: number;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  state: StepState;
  stat?: string;
  progress?: number;
  children: React.ReactNode;
}) {
  // Auto-expand while running so the user sees per-item activity without
  // a click; collapse on done so the screen stays compact.
  const [open, setOpen] = useState<boolean | null>(null);
  const effectiveOpen = open ?? (state === "running" || state === "failed");

  return (
    <div
      className={cn(
        "rounded-[10px] border bg-surface transition-colors",
        state === "running" && "border-brand-500/50 shadow-[0_0_0_1px_rgba(99,102,241,0.25)]",
        state === "done" && "border-emerald-500/30",
        state === "failed" && "border-danger/40",
        state === "pending" && "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!effectiveOpen)}
        className="w-full text-left p-3 flex items-start gap-3"
      >
        <div
          className={cn(
            "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border",
            state === "done" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
            state === "running" && "border-brand-500/40 bg-brand-500/10 text-brand-300",
            state === "failed" && "border-danger/40 bg-danger/10 text-danger",
            state === "pending" && "border-border text-fg-subtle",
          )}
        >
          <StepIcon state={state} fallback={icon} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-fg-subtle">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span
              className={cn(
                "text-sm font-medium truncate",
                state === "pending" && "text-fg-muted",
              )}
            >
              {label}
            </span>
            {stat && (
              <span className="ml-auto text-[11px] tabular-nums text-fg-subtle shrink-0">
                {stat}
              </span>
            )}
            {effectiveOpen ? (
              <ChevronDown className="h-4 w-4 text-fg-subtle shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-fg-subtle shrink-0" />
            )}
          </div>
          {hint && state === "running" && (
            <p className="text-xs text-fg-subtle mt-0.5 truncate">{hint}</p>
          )}
          {state === "running" && progress != null && (
            <div className="mt-2 h-1 rounded-full bg-bg-elevated overflow-hidden">
              <div
                className="h-full gradient-brand transition-[width] duration-500"
                style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
              />
            </div>
          )}
        </div>
      </button>

      {effectiveOpen && (
        <div className="border-t border-border px-3 py-2 space-y-1.5">
          {children}
        </div>
      )}
    </div>
  );
}

function StepIcon({ state, fallback }: { state: StepState; fallback?: React.ReactNode }) {
  if (state === "done") return <CheckCircle2 className="h-4 w-4" />;
  if (state === "running") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (state === "failed") return <AlertCircle className="h-4 w-4" />;
  return <>{fallback ?? <Circle className="h-4 w-4" />}</>;
}

// ---------------------------------------------------------------------------
// Per-source rows: download list and clip list.
// ---------------------------------------------------------------------------

function DownloadList({
  jobs,
  sources,
}: {
  jobs: MediaJob[];
  sources: JobSourceRow[];
}) {
  const downloadJobs = jobs.filter((j) => j.type === "download");
  if (downloadJobs.length === 0) {
    return <p className="text-xs text-fg-subtle px-1 py-1">No downloads queued yet.</p>;
  }

  // Each download job carries either videoSourceId (after upsert), or
  // youtube_video_id (set at job creation time, before the source row exists).
  return (
    <>
      {downloadJobs.map((j) => {
        const md = j.metadata ?? {};
        const sourceId = (md.videoSourceId as string | undefined) ?? null;
        const ytId = (md.youtube_video_id as string | undefined) ?? null;
        const source =
          (sourceId && sources.find((s) => s.id === sourceId)) ||
          (ytId && sources.find((s) => s.youtube_video_id === ytId)) ||
          null;

        const title = source?.title || (md.title as string | undefined) || ytId || "Unknown video";
        const promotedFrom = md.promoted_from as string | undefined;
        const promotionReason = md.promotion_reason as string | undefined;

        return (
          <SourceRow
            key={j.id}
            title={title}
            subtitle={ytId ? `youtube.com/watch?v=${ytId}` : undefined}
            statusBadge={downloadStatusBadge(j, source)}
            progress={j.status === "running" ? j.progress : undefined}
            error={errorMessage(j, source)}
            note={
              promotedFrom
                ? `Replacement for ${promotedFrom}${promotionReason ? ` (${promotionReason})` : ""}`
                : undefined
            }
          />
        );
      })}
    </>
  );
}

function ClipList({
  jobs,
  sources,
}: {
  jobs: MediaJob[];
  sources: JobSourceRow[];
}) {
  const clipJobs = jobs.filter((j) => j.type === "clip");
  if (clipJobs.length === 0) {
    return <p className="text-xs text-fg-subtle px-1 py-1">No clip jobs yet — waiting on downloads.</p>;
  }

  return (
    <>
      {clipJobs.map((j) => {
        const md = j.metadata ?? {};
        const sourceId = md.videoSourceId as string | undefined;
        const source = sourceId ? sources.find((s) => s.id === sourceId) ?? null : null;

        const title = source?.title || sourceId || "Unknown source";
        const total = (md.totalClips as number | undefined) ?? null;
        const succeeded = md.succeeded as number | undefined;
        const failed = md.failed as number | undefined;
        const skippedReason = md.skipped_reason as string | undefined;
        const current = md.currentClip as
          | { index: number; total: number; startSeconds: number }
          | undefined;

        let subtitle: string | undefined;
        if (j.status === "running" && current) {
          subtitle = `Cutting clip ${current.index} of ${current.total} at ${fmtClockShort(current.startSeconds)}`;
        } else if (j.status === "completed" && skippedReason) {
          subtitle = `Skipped — ${humanReason(skippedReason)}`;
        } else if (j.status === "completed" && total != null) {
          subtitle = `${succeeded ?? source?.clip_count ?? 0} of ${total} clips ready${failed ? ` · ${failed} failed` : ""}`;
        } else if (j.status === "queued") {
          subtitle = "Waiting…";
        }

        return (
          <SourceRow
            key={j.id}
            title={title}
            subtitle={subtitle}
            statusBadge={clipStatusBadge(j, total, succeeded, failed)}
            progress={j.status === "running" ? j.progress : undefined}
            error={j.status === "failed" ? j.error || "clipping failed" : undefined}
          />
        );
      })}
    </>
  );
}

function SourceRow({
  title,
  subtitle,
  statusBadge,
  progress,
  error,
  note,
}: {
  title: string;
  subtitle?: string;
  statusBadge: React.ReactNode;
  progress?: number;
  error?: string;
  note?: string;
}) {
  return (
    <div className="rounded-[8px] border border-border/50 bg-bg-elevated/40 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-fg truncate flex-1 min-w-0" title={title}>
          {title}
        </span>
        {statusBadge}
      </div>
      {subtitle && (
        <p className="text-[11px] text-fg-subtle mt-0.5 truncate">{subtitle}</p>
      )}
      {note && (
        <p className="text-[11px] text-fg-muted mt-0.5 truncate italic">{note}</p>
      )}
      {progress != null && (
        <div className="mt-1.5 h-1 rounded-full bg-bg-elevated overflow-hidden">
          <div
            className="h-full gradient-brand transition-[width] duration-500"
            style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
          />
        </div>
      )}
      {error && (
        <p className="text-[11px] text-danger mt-1 break-words">{error}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge helpers
// ---------------------------------------------------------------------------

function downloadStatusBadge(j: MediaJob, source: JobSourceRow | null) {
  if (j.status === "queued") return <Badge variant="outline">Queued</Badge>;
  if (j.status === "running") return <Badge variant="info">Downloading</Badge>;
  if (j.status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (j.status === "completed") {
    if (source?.status === "failed") return <Badge variant="destructive">Failed</Badge>;
    if (j.metadata && (j.metadata as Record<string, unknown>).cached) {
      return <Badge variant="success">Cached</Badge>;
    }
    return <Badge variant="success">Downloaded</Badge>;
  }
  return <Badge variant="outline">{j.status}</Badge>;
}

function clipStatusBadge(
  j: MediaJob,
  total: number | null,
  succeeded: number | undefined,
  failed: number | undefined,
) {
  if (j.status === "queued") return <Badge variant="outline">Queued</Badge>;
  if (j.status === "running") return <Badge variant="info">Cutting</Badge>;
  if (j.status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (j.status === "completed") {
    if (failed && failed > 0 && (succeeded ?? 0) === 0) {
      return <Badge variant="destructive">Failed</Badge>;
    }
    if ((j.metadata as Record<string, unknown>)?.skipped_reason) {
      return <Badge variant="warning">Skipped</Badge>;
    }
    return <Badge variant="success">{total != null ? `${succeeded ?? total} clips` : "Done"}</Badge>;
  }
  return <Badge variant="outline">{j.status}</Badge>;
}

function errorMessage(j: MediaJob, source: JobSourceRow | null): string | undefined {
  if (j.status === "failed") return j.error || source?.error || "download failed";
  if (source?.status === "failed") return source.error ?? "source failed";
  return undefined;
}

function humanReason(code: string): string {
  switch (code) {
    case "project_clip_cap_reached": return "project clip budget already met";
    case "no_video_stream": return "no usable video stream";
    case "age_gated": return "age-restricted by YouTube";
    case "private": return "video is private";
    case "unavailable": return "video unavailable";
    case "geo_blocked": return "geo-blocked";
    case "members_only": return "members-only";
    case "no_compatible_format": return "no compatible format";
    case "source_too_long": return "source video too long";
    case "download_failed": return "download failed";
    default: return code.replace(/_/g, " ");
  }
}

function fmtClockShort(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = String(s % 60).padStart(2, "0");
  return `${m}:${r}`;
}

// ---------------------------------------------------------------------------
// Aggregates (matches the prior summary semantics in the original screen)
// ---------------------------------------------------------------------------

function jobsOfType(type: string, jobs: MediaJob[]) {
  return jobs.filter((j) => j.type === type);
}

// Each download attempt for the same YouTube video produces a fresh media_job
// (retry-failed, fallback promotion, etc.) — left raw, the same video shows
// up multiple times. Keep only the most recent job per youtube_video_id;
// non-download jobs pass through untouched.
function dedupeDownloadJobs(jobs: MediaJob[]): MediaJob[] {
  const latestByVideo = new Map<string, MediaJob>();
  const passthrough: MediaJob[] = [];
  for (const j of jobs) {
    if (j.type !== "download") {
      passthrough.push(j);
      continue;
    }
    const ytId = (j.metadata?.youtube_video_id as string | undefined) ?? null;
    if (!ytId) {
      passthrough.push(j);
      continue;
    }
    const prev = latestByVideo.get(ytId);
    if (!prev || new Date(j.created_at) > new Date(prev.created_at)) {
      latestByVideo.set(ytId, j);
    }
  }
  return [...passthrough, ...latestByVideo.values()];
}

function aggregateState(type: string, jobs: MediaJob[]): StepState {
  const list = jobsOfType(type, jobs);
  if (list.length === 0) return "pending";
  const failed = list.filter((j) => j.status === "failed").length;
  const running = list.filter((j) => j.status === "running" || j.status === "queued").length;
  const done = list.filter((j) => j.status === "completed").length;
  if (running > 0) return "running";
  if (done + failed === list.length) return done === 0 ? "failed" : "done";
  return "pending";
}

function aggregateProgress(type: string, jobs: MediaJob[]): number | undefined {
  const list = jobsOfType(type, jobs);
  if (list.length === 0) return undefined;
  const sum = list.reduce((s, j) => s + (j.progress ?? 0), 0);
  return Math.round(sum / list.length);
}

function aggregateStat(type: string, jobs: MediaJob[]): string | undefined {
  const list = jobsOfType(type, jobs);
  if (list.length === 0) return undefined;
  const done = list.filter((j) => j.status === "completed").length;
  const failed = list.filter((j) => j.status === "failed").length;
  return failed > 0 ? `${done}/${list.length} · ${failed} failed` : `${done}/${list.length}`;
}

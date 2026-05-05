"use client";

import Link from "next/link";
import { ChevronLeft, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ProjectResp, WorkspacePhase, JobsResp } from "../_shared";
import { jobsBusy, statusToTone } from "../_shared";

const PHASE_LABEL: Record<WorkspacePhase, string> = {
  intake: "Intake",
  analysis: "Analyze",
  processing: "Processing",
  editor: "Edit",
  export: "Export",
};

const PHASE_ORDER: WorkspacePhase[] = ["intake", "analysis", "processing", "editor", "export"];

export function ProjectHeader({
  project,
  phase,
  derivedPhase,
  jobs,
  onExport,
  exportDisabled,
  onPhaseSelect,
}: {
  project: ProjectResp["project"] | undefined;
  phase: WorkspacePhase;
  derivedPhase?: WorkspacePhase;
  jobs: JobsResp | undefined;
  onExport?: () => void;
  exportDisabled?: boolean;
  onPhaseSelect?: (phase: WorkspacePhase) => void;
}) {
  const busy = jobsBusy(jobs);
  const statusTone = project ? statusToTone(project.status) : "default";
  const badgeVariant =
    statusTone === "success"
      ? "success"
      : statusTone === "warning"
        ? "warning"
        : statusTone === "danger"
          ? "destructive"
          : statusTone === "info"
            ? "info"
            : statusTone === "muted"
              ? "secondary"
              : "default";

  return (
    <header className="shrink-0 border-b border-border bg-bg-elevated/60 backdrop-blur supports-[backdrop-filter]:bg-bg-elevated/40">
      <div className="flex h-14 items-center gap-3 px-6 lg:px-8">
        <Link
          href="/dashboard"
          className="grid place-items-center h-7 w-7 rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg transition-colors"
          aria-label="Back to dashboard"
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold tracking-tight truncate">
              {project?.title ?? "Loading…"}
            </h1>
            {project && (
              <Badge variant={badgeVariant} className="shrink-0">
                {project.status.replace(/_/g, " ")}
              </Badge>
            )}
            {busy && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-300">
                <Loader2 className="h-3 w-3 animate-spin" /> working…
              </span>
            )}
          </div>
        </div>

        <PhasePill
          current={phase}
          maxReached={derivedPhase ?? phase}
          onSelect={onPhaseSelect}
        />

        <Button
          variant="gradient"
          size="sm"
          onClick={onExport}
          disabled={exportDisabled}
        >
          <Download className="h-3.5 w-3.5" /> Export
        </Button>
      </div>
    </header>
  );
}

function PhasePill({
  current,
  maxReached,
  onSelect,
}: {
  current: WorkspacePhase;
  maxReached: WorkspacePhase;
  onSelect?: (phase: WorkspacePhase) => void;
}) {
  const idx = PHASE_ORDER.indexOf(current);
  const maxIdx = PHASE_ORDER.indexOf(maxReached);
  return (
    <div className="hidden lg:flex items-center gap-1 rounded-full border border-border bg-surface p-1">
      {PHASE_ORDER.map((p, i) => {
        const done = i < idx;
        const active = i === idx;
        const reachable = i <= maxIdx;
        const clickable = !!onSelect && reachable && !active;
        return (
          <button
            key={p}
            type="button"
            onClick={clickable ? () => onSelect!(p) : undefined}
            disabled={!clickable}
            aria-current={active ? "step" : undefined}
            className={cn(
              "px-2.5 h-6 inline-flex items-center rounded-full text-[11px] font-medium transition-colors",
              active && "gradient-brand text-white shadow-sm",
              done && !active && "text-fg-muted",
              !done && !active && "text-fg-subtle",
              clickable && "cursor-pointer hover:bg-surface-hover hover:text-fg",
              !clickable && !active && "cursor-not-allowed",
            )}
          >
            {PHASE_LABEL[p]}
          </button>
        );
      })}
    </div>
  );
}

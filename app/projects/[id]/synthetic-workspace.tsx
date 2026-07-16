"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Loader2 } from "lucide-react";
import { WorkspaceLayout } from "@/components/shell/workspace-layout";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { SyntheticIntakeScreen } from "./_synthetic/intake-screen";
import { SyntheticProgressScreen } from "./_synthetic/progress-screen";
import { SyntheticReviewScreen } from "./_synthetic/review-screen";
import { SyntheticRenderScreen } from "./_synthetic/render-screen";
import type { SyntheticResp } from "./_synthetic/types";

// Self-contained workspace for the SYNTHETIC engine. The sourced workspace
// (workspace.tsx) is never entered for these projects, so the two pipelines'
// UIs can't regress one another. Screen routing is derived from the project's
// status, which the backend advances through the pipeline.
type SyntheticPhase = "intake" | "progress" | "review" | "render";

// Early-pipeline statuses (no segments to show yet) -> the progress screen.
const EARLY_PROGRESS = new Set(["voiceover", "aligning", "planning"]);
// Asset-generation statuses -> STAY on the planner/review screen, which shows
// per-segment generation status inline. The user never navigates away to a
// separate progress view once the plan exists.
const ASSET_GENERATING = new Set(["generating_images", "generating_clips", "generating_avatars"]);

function derivePhase(resp: SyntheticResp | undefined): SyntheticPhase {
  if (!resp?.project) return "intake";
  const s = resp.project.status;
  if (s === "created" || s === "draft") return "intake";
  // The planner/review screen is "home" once a plan exists:
  //   plan_ready          -> review the plan, click Generate
  //   generating_*        -> assets generating; per-segment status shown inline
  //   ready_for_review    -> all assets done; click Render
  if (s === "plan_ready" || s === "ready_for_review" || ASSET_GENERATING.has(s)) return "review";
  if (EARLY_PROGRESS.has(s)) return "progress";
  if (s === "rendering" || s === "completed" || s === "failed") return "render";
  return "intake";
}

function syntheticBusy(resp: SyntheticResp | undefined): boolean {
  if (!resp?.project) return false;
  const s = resp.project.status;
  if (EARLY_PROGRESS.has(s) || ASSET_GENERATING.has(s) || s === "rendering") return true;
  return (resp.media_jobs ?? []).some((j) => j.status === "queued" || j.status === "running");
}

export function SyntheticWorkspace({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const q = useQuery<SyntheticResp>({
    queryKey: ["synthetic", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/synthetic`).then((r) => r.json()),
    refetchInterval: (query) => (syntheticBusy(query.state.data) ? 2500 : 10_000),
  });

  const [override, setOverride] = useState<SyntheticPhase | null>(null);

  if (q.isLoading) {
    return (
      <div className="grid place-items-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
      </div>
    );
  }
  if (q.isError || !q.data?.project) {
    return (
      <div className="p-8">
        <EmptyState title="Project not found" description="It may have been deleted, or the link is invalid." />
      </div>
    );
  }

  const resp = q.data;
  const derived = derivePhase(resp);
  // Allow stepping back to review from render, but never skip ahead.
  const ORDER: SyntheticPhase[] = ["intake", "progress", "review", "render"];
  const phase: SyntheticPhase =
    override && ORDER.indexOf(override) <= ORDER.indexOf(derived) ? override : derived;

  const refetch = () => qc.invalidateQueries({ queryKey: ["synthetic", projectId] });

  return (
    <WorkspaceLayout
      header={
        <header className="flex items-center gap-3 border-b border-border px-6 lg:px-8 py-4">
          <Link
            href="/dashboard"
            className="grid place-items-center h-7 w-7 shrink-0 rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg transition-colors"
            aria-label="Back to dashboard"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-sm font-semibold text-fg truncate">{resp.project.title}</h1>
          <Badge variant="info">Synthetic</Badge>
          <Badge variant="secondary">{resp.project.status.replace(/_/g, " ")}</Badge>
          <nav className="ml-auto flex items-center gap-1 text-xs">
            {ORDER.map((p) => {
              const reachable = ORDER.indexOf(p) <= ORDER.indexOf(derived);
              const active = p === phase;
              return (
                <button
                  key={p}
                  type="button"
                  disabled={!reachable}
                  onClick={() => setOverride(p === derived ? null : p)}
                  className={[
                    "rounded-md px-2.5 py-1 capitalize transition-colors",
                    active ? "bg-brand-500/15 text-brand-300" : "text-fg-subtle",
                    reachable ? "hover:text-fg" : "opacity-40 cursor-not-allowed",
                  ].join(" ")}
                >
                  {p}
                </button>
              );
            })}
          </nav>
        </header>
      }
    >
      {phase === "intake" && <SyntheticIntakeScreen projectId={projectId} resp={resp} onChange={refetch} />}
      {phase === "progress" && <SyntheticProgressScreen projectId={projectId} resp={resp} onChange={refetch} />}
      {phase === "review" && (
        <SyntheticReviewScreen
          projectId={projectId}
          resp={resp}
          onChange={refetch}
          onGoToRender={() => setOverride("render")}
        />
      )}
      {phase === "render" && <SyntheticRenderScreen projectId={projectId} resp={resp} onChange={refetch} />}
    </WorkspaceLayout>
  );
}

"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { WorkspaceLayout } from "@/components/shell/workspace-layout";
import { EmptyState } from "@/components/ui/empty-state";
import {
  derivePhase,
  jobsBusy,
  type JobsResp,
  type ProjectResp,
  type TimelineRow,
  type WorkspacePhase,
} from "./_shared";
import { ProjectHeader } from "./_components/project-header";
import { IntakeScreen } from "./_components/intake-screen";
import { AnalysisScreen } from "./_components/analysis-screen";
import { ProcessingScreen } from "./_components/processing-screen";
import { BlockEditorScreen } from "./_components/block-editor-screen";
import { ExportScreen } from "./_components/export-screen";
import { RightPanel } from "./_components/panels/right-panel";

export function ProjectWorkspace({
  projectId,
  autoAnalyze = false,
}: {
  projectId: string;
  autoAnalyze?: boolean;
}) {
  const projectQ = useQuery<ProjectResp>({
    queryKey: ["project", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}`).then((r) => r.json()),
  });

  const jobsQ = useQuery<JobsResp>({
    queryKey: ["project-jobs", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/jobs`).then((r) => r.json()),
    refetchInterval: (q) => (jobsBusy(q.state.data) ? 2000 : 8000),
  });

  const timelineQ = useQuery<{ items: TimelineRow[] }>({
    queryKey: ["project-timeline", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/timeline`).then((r) => r.json()),
    refetchInterval: 8000,
  });

  const [phaseOverride, setPhaseOverride] = useState<WorkspacePhase | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  if (projectQ.isLoading) {
    return (
      <div className="grid place-items-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
      </div>
    );
  }

  if (projectQ.isError || !projectQ.data?.project) {
    return (
      <div className="p-8">
        <EmptyState
          title="Project not found"
          description="It may have been deleted, or the link is invalid."
        />
      </div>
    );
  }

  const project = projectQ.data;
  const jobs = jobsQ.data;
  const timelineCount = timelineQ.data?.items.length ?? 0;
  const derived = derivePhase(project, jobs, timelineCount);
  const PHASE_ORDER: WorkspacePhase[] = ["intake", "analysis", "processing", "editor", "export"];
  const derivedIdx = PHASE_ORDER.indexOf(derived);
  const overrideIdx = phaseOverride ? PHASE_ORDER.indexOf(phaseOverride) : -1;
  // Export is reachable from editor — derivePhase only returns "export" once a
  // render job exists, so without this special-case the user can't navigate to
  // the export screen to start the first render. Allow override to "export"
  // whenever the timeline is ready (derived === "editor" or beyond).
  const editorReached = derivedIdx >= PHASE_ORDER.indexOf("editor");
  const overrideAllowed =
    phaseOverride !== null &&
    overrideIdx >= 0 &&
    (overrideIdx <= derivedIdx || (phaseOverride === "export" && editorReached));
  const phase: WorkspacePhase = overrideAllowed ? phaseOverride! : derived;
  const canExport = derived === "editor" || derived === "export";

  const onPhaseSelect = (target: WorkspacePhase) => {
    const targetIdx = PHASE_ORDER.indexOf(target);
    if (targetIdx < 0) return;
    // Same export special-case as above: allow jumping to export once editor
    // is reached, even though derivedPhase still says "editor".
    if (targetIdx > derivedIdx && !(target === "export" && editorReached)) return;
    setPhaseOverride(targetIdx === derivedIdx ? null : target);
  };

  return (
    <WorkspaceLayout
      header={
        <ProjectHeader
          project={project.project}
          phase={phase}
          derivedPhase={derived}
          jobs={jobs}
          exportDisabled={!canExport}
          onExport={() => setPhaseOverride("export")}
          onPhaseSelect={onPhaseSelect}
        />
      }
      right={
        <RightPanel
          projectId={projectId}
          phase={phase}
          project={project}
          jobs={jobs}
          selectedBlockId={selectedBlockId}
        />
      }
    >
      {phase === "intake" && (
        <IntakeScreen projectId={projectId} project={project.project} />
      )}
      {phase === "analysis" && (
        <AnalysisScreen projectId={projectId} autoStart={autoAnalyze} />
      )}
      {phase === "processing" && (
        <ProcessingScreen
          projectId={projectId}
          jobs={jobs}
          onRetry={async () => {
            await fetch(`/api/projects/${projectId}/retry-failed`, { method: "POST" });
            jobsQ.refetch();
          }}
        />
      )}
      {phase === "editor" && (
        <BlockEditorScreen
          projectId={projectId}
          selectedId={selectedBlockId}
          onSelect={setSelectedBlockId}
        />
      )}
      {phase === "export" && <ExportScreen projectId={projectId} jobs={jobs} />}
    </WorkspaceLayout>
  );
}

// Shared types and helpers for the project workspace screens.
// API shapes mirror the existing /api/projects/[id]/* endpoints — keep in sync.

export interface ProjectResp {
  project: {
    id: string;
    title: string;
    transcript: string | null;
    voiceover_url: string | null;
    status: string;
    created_at: string;
    updated_at: string;
  };
  entities: Array<{ id: string; type: string; value: string }>;
  search_results: Array<{
    id: string;
    title: string | null;
    channel_title: string | null;
    score: number;
    status: string;
    duration_seconds: number | null;
  }>;
  video_sources: Array<{
    id: string;
    title: string | null;
    status: string;
    youtube_video_id: string;
  }>;
}

export interface JobSourceRow {
  id: string;
  youtube_video_id: string;
  title: string | null;
  status: string;
  error: string | null;
  duration_seconds: number | null;
  clip_count: number;
}

export interface JobsResp {
  project_status: string | null;
  media_jobs: Array<{
    id: string;
    type: string;
    status: string;
    progress: number;
    error: string | null;
    created_at: string;
    metadata: Record<string, unknown>;
  }>;
  render_jobs: Array<{
    id: string;
    status: string;
    progress: number;
    output_url: string | null;
    error: string | null;
    created_at: string;
  }>;
  video_sources: JobSourceRow[];
}

export interface TimelineRow {
  id: string;
  clip_id: string | null;
  type: string;
  position: number;
  duration: number;
  script_text: string | null;
  overlay_text: string | null;
  approved: boolean;
}

export interface ClipRow {
  id: string;
  thumbnail_url: string | null;
  source: { title: string | null } | null;
}

export type WorkspacePhase =
  | "intake"      // no transcript yet — show intake card
  | "analysis"   // transcript present, no confirmed sources, awaiting analyze + selection
  | "processing" // sources confirmed, jobs running (download/clip/match)
  | "editor"     // timeline rows exist, no active render
  | "export";    // render queued/running/completed

export function isJobBusy(j: { status: string }): boolean {
  return j.status === "queued" || j.status === "running";
}

export function jobsBusy(d: JobsResp | undefined): boolean {
  if (!d) return false;
  return d.media_jobs.some(isJobBusy) || d.render_jobs.some(isJobBusy);
}

/**
 * Decide which workspace screen to render. Order matters — earliest phase
 * the data is in wins.
 *
 * - intake:     no transcript saved yet
 * - analysis:   transcript exists but no source has been confirmed
 * - processing: sources confirmed, media jobs still running and timeline is empty
 * - export:     a render job exists (queued/running/completed)
 * - editor:     timeline has rows and no render is active
 */
export function derivePhase(
  project: ProjectResp | undefined,
  jobs: JobsResp | undefined,
  timelineCount: number,
): WorkspacePhase {
  if (!project?.project) return "intake";

  const hasTranscript = !!project.project.transcript?.trim();
  if (!hasTranscript) return "intake";

  const hasConfirmedSources = (project.search_results ?? []).some((s) => s.status === "selected");
  if (!hasConfirmedSources) return "analysis";

  const renders = jobs?.render_jobs ?? [];
  if (renders.length > 0) return "export";

  const mediaBusy = (jobs?.media_jobs ?? []).some(isJobBusy);
  if (mediaBusy && timelineCount === 0) return "processing";
  if (timelineCount === 0) return "processing";

  return "editor";
}

export function statusToTone(s: string): "default" | "success" | "warning" | "danger" | "info" | "muted" {
  switch (s) {
    case "completed":
      return "success";
    case "ready_for_review":
      return "warning";
    case "failed":
      return "danger";
    case "draft":
      return "muted";
    case "rendering":
    case "matching":
    case "clipping":
    case "downloading":
    case "searching":
    case "extracting":
      return "info";
    default:
      return "default";
  }
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = String(s % 60).padStart(2, "0");
  return `${m}:${r}`;
}

export function fmtMinutes(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m} min`;
  return `${m} min ${s}s`;
}

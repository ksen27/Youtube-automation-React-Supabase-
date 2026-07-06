"use client";

import { useMemo, useState } from "react";
import { StepCard, type StepState } from "@/components/ui/step-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Volume2, Download } from "lucide-react";
import type { SyntheticResp, SyntheticMediaJob, SyntheticSegmentRow } from "./types";

// STEP-by-step generation progress. Aggregates media_jobs by type for the
// pipeline stages (voiceover/alignment/planner) and synthetic_segments by
// block_type for the asset-generation stages, with per-failed-segment retry.

function jobsOfType(jobs: SyntheticMediaJob[], type: string) {
  return jobs.filter((j) => j.type === type);
}

function aggregateState(jobs: SyntheticMediaJob[]): StepState {
  if (jobs.length === 0) return "pending";
  if (jobs.some((j) => j.status === "running" || j.status === "queued")) return "running";
  if (jobs.some((j) => j.status === "completed")) return "done";
  if (jobs.every((j) => j.status === "failed")) return "failed";
  return "pending";
}

function segState(segs: SyntheticSegmentRow[]): StepState {
  if (segs.length === 0) return "pending";
  const allTerminal = segs.every((s) => s.status === "ready" || s.status === "failed" || s.status === "skipped");
  if (!allTerminal) return "running";
  if (segs.some((s) => s.status === "ready")) return "done";
  return "failed";
}

export function SyntheticProgressScreen({
  projectId,
  resp,
  onChange,
}: {
  projectId: string;
  resp: SyntheticResp;
  onChange: () => void;
}) {
  const jobs = resp.media_jobs ?? [];
  const segs = resp.segments ?? [];

  const byType = useMemo(() => ({
    avatar: segs.filter((s) => s.block_type === "avatar"),
    image: segs.filter((s) => s.block_type === "image"),
    ai_clip: segs.filter((s) => s.block_type === "ai_clip"),
    split_2: segs.filter((s) => s.block_type === "split_2"),
  }), [segs]);

  async function retrySegment(segmentId: string) {
    await fetch(`/api/projects/${projectId}/synthetic/segments/${segmentId}`, { method: "POST" });
    onChange();
  }

  // Re-run a failed early pipeline step (voiceover or planner). Unlike Refresh
  // (which only re-reads state), this re-enqueues the job so it actually runs
  // again — e.g. after fixing a config/network issue.
  async function retryStep(step: "voiceover" | "planner") {
    await fetch(`/api/projects/${projectId}/synthetic/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step }),
    });
    onChange();
  }

  const failedSegs = segs.filter((s) => s.status === "failed");
  const readyCount = (g: SyntheticSegmentRow[]) => g.filter((s) => s.status === "ready").length;
  const stat = (g: SyntheticSegmentRow[]) =>
    g.length ? `${readyCount(g)}/${g.length}${g.some((s) => s.status === "failed") ? ` · ${g.filter((s) => s.status === "failed").length} failed` : ""}` : undefined;

  const ttsJobs = jobsOfType(jobs, "tts");
  const planJobs = jobsOfType(jobs, "plan_synthetic");
  // Newest job's error message for a step (jobs are ordered ascending, so last).
  const lastError = (js: SyntheticMediaJob[]): string | null => {
    const failed = js.filter((j) => j.status === "failed" && j.error);
    return failed.length ? (failed[failed.length - 1].error ?? null) : null;
  };

  const steps: Array<{
    label: string; hint: string; state: StepState; stat?: string;
    retryStep?: "voiceover" | "planner"; error?: string | null;
  }> = [
    { label: "Voiceover", hint: "69labs TTS / uploaded audio", state: aggregateState(ttsJobs), retryStep: "voiceover", error: lastError(ttsJobs) },
    { label: "Alignment", hint: "Deepgram word timings", state: ttsJobs.some((j) => j.status === "completed") ? "done" : aggregateState(ttsJobs), retryStep: "voiceover", error: lastError(ttsJobs) },
    { label: "Planner", hint: "Gemini segments the script", state: aggregateState(planJobs), retryStep: "planner", error: lastError(planJobs) },
    { label: "Images", hint: "nano-banana stills", state: segState(byType.image), stat: stat(byType.image) },
    { label: "AI Clips", hint: "fal.ai animated clips", state: segState(byType.ai_clip), stat: stat(byType.ai_clip) },
    { label: "Avatars + Split", hint: "HeyGen avatar videos", state: segState([...byType.avatar, ...byType.split_2]), stat: stat([...byType.avatar, ...byType.split_2]) },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg-muted">Generating your video</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onChange}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {/* Generated voiceover — listen to verify it before assets generate, and
          regenerate it (keeping existing assets) if 69labs produced a corrupted
          / low-volume take. */}
      {resp.project.voiceover_url && (
        <VoiceoverPlayer
          projectId={projectId}
          url={resp.project.voiceover_url}
          durationSeconds={resp.project.voiceover_duration_seconds}
          onChange={onChange}
        />
      )}

      <div className="space-y-2">
        {steps.map((s, i) => (
          <div key={s.label} className="space-y-1">
            <StepCard index={i} label={s.label} hint={s.hint} state={s.state} stat={s.stat}
              progress={s.state === "running" ? 50 : undefined} />
            {s.state === "failed" && s.retryStep && (
              <div className="ml-10 flex items-center gap-2 text-xs">
                {s.error && <span className="text-danger truncate flex-1" title={s.error}>{s.error}</span>}
                <Button type="button" variant="soft" size="xs" className="ml-auto shrink-0" onClick={() => retryStep(s.retryStep!)}>
                  <RefreshCw className="h-3.5 w-3.5" /> Retry step
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {failedSegs.length > 0 && (
        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="text-danger text-sm">{failedSegs.length} block(s) failed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {failedSegs.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-xs">
                <Badge variant="secondary">{s.block_type}</Badge>
                <span className="text-fg-subtle truncate flex-1">{s.script.slice(0, 80) || s.error || "—"}</span>
                <Button type="button" variant="soft" size="xs" onClick={() => retrySegment(s.id)}>
                  <RefreshCw className="h-3.5 w-3.5" /> Retry
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Inline player for the generated master voiceover, so the user can listen and
// verify it before assets are generated (or download it). Also exposes a
// "Regenerate voiceover" action: 69labs occasionally renders a stretch of a long
// voiceover at the wrong voice / a dropped volume (a provider defect baked into
// the audio). This re-runs ONLY the TTS + alignment — the existing images/clips/
// avatars are kept — so a corrupted voiceover can be replaced without redoing the
// whole (expensive) asset generation. The user re-renders afterward to pick it up.
function VoiceoverPlayer({
  projectId, url, durationSeconds, onChange,
}: {
  projectId: string;
  url: string;
  durationSeconds: number | null;
  onChange: () => void;
}) {
  const [regenerating, setRegenerating] = useState(false);

  async function regenerate() {
    if (regenerating) return;
    if (!window.confirm(
      "Regenerate the voiceover? This re-runs the 69labs TTS (keeping your existing images/clips/avatars). "
      + "Use this if the voiceover has a corrupted or low-volume section. You'll need to re-render afterward."
    )) return;
    setRegenerating(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/synthetic/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "voiceover_only" }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        window.alert(`Could not start regeneration: ${msg?.error ?? res.statusText}`);
        return;
      }
      onChange();
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Volume2 className="h-4 w-4 text-brand-300" />
          <span className="text-sm font-medium text-fg">Voiceover</span>
          {durationSeconds != null && (
            <span className="text-[11px] text-fg-subtle tabular-nums">
              {Math.floor(durationSeconds / 60)}:{String(durationSeconds % 60).padStart(2, "0")}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={regenerate}
              disabled={regenerating}
              className="text-[11px] text-brand-300 hover:underline inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Re-run 69labs TTS, keeping existing assets — for a corrupted/low-volume voiceover"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${regenerating ? "animate-spin" : ""}`} />
              {regenerating ? "Regenerating…" : "Regenerate voiceover"}
            </button>
            <a href={url} download className="text-[11px] text-brand-300 hover:underline inline-flex items-center gap-1">
              <Download className="h-3.5 w-3.5" /> Download
            </a>
          </div>
        </div>
        <audio src={url} controls preload="metadata" className="w-full h-9" />
      </CardContent>
    </Card>
  );
}

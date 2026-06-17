"use client";

import { useMemo } from "react";
import { StepCard, type StepState } from "@/components/ui/step-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw } from "lucide-react";
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

  const failedSegs = segs.filter((s) => s.status === "failed");
  const readyCount = (g: SyntheticSegmentRow[]) => g.filter((s) => s.status === "ready").length;
  const stat = (g: SyntheticSegmentRow[]) =>
    g.length ? `${readyCount(g)}/${g.length}${g.some((s) => s.status === "failed") ? ` · ${g.filter((s) => s.status === "failed").length} failed` : ""}` : undefined;

  const ttsJobs = jobsOfType(jobs, "tts");
  const planJobs = jobsOfType(jobs, "plan_synthetic");

  const steps: Array<{ label: string; hint: string; state: StepState; stat?: string; group?: SyntheticSegmentRow[] }> = [
    { label: "Voiceover", hint: "69labs TTS / uploaded audio", state: aggregateState(ttsJobs) },
    { label: "Alignment", hint: "Deepgram word timings", state: ttsJobs.some((j) => j.status === "completed") ? "done" : aggregateState(ttsJobs) },
    { label: "Planner", hint: "Gemini segments the script", state: aggregateState(planJobs) },
    { label: "Images", hint: "nano-banana stills", state: segState(byType.image), stat: stat(byType.image), group: byType.image },
    { label: "AI Clips", hint: "fal.ai animated clips", state: segState(byType.ai_clip), stat: stat(byType.ai_clip), group: byType.ai_clip },
    { label: "Avatars + Split", hint: "HeyGen avatar videos", state: segState([...byType.avatar, ...byType.split_2]), stat: stat([...byType.avatar, ...byType.split_2]), group: [...byType.avatar, ...byType.split_2] },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg-muted">Generating your video</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onChange}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="space-y-2">
        {steps.map((s, i) => (
          <StepCard key={s.label} index={i} label={s.label} hint={s.hint} state={s.state} stat={s.stat}
            progress={s.state === "running" ? 50 : undefined} />
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

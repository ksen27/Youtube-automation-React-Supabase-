"use client";

import { useQuery, useMutation } from "@tanstack/react-query";
import { Download, Film, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SyntheticResp } from "./types";

interface RenderJob {
  id: string;
  status: string;
  progress: number;
  output_url: string | null;
  error: string | null;
}
interface JobsResp { render_jobs?: RenderJob[] }

// STEP: render progress + preview + download. Reuses the existing render
// pipeline (POST /render from the review screen, polled via /jobs) so the
// synthetic engine adds NO new render infrastructure beyond the split-screen
// avatar compositor.
export function SyntheticRenderScreen({
  projectId,
  resp,
  onChange,
}: {
  projectId: string;
  resp: SyntheticResp;
  onChange: () => void;
}) {
  const jobsQ = useQuery<JobsResp>({
    queryKey: ["synthetic-render", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/jobs`).then((r) => r.json()),
    refetchInterval: (q) => {
      const latest = q.state.data?.render_jobs?.[0];
      return latest && (latest.status === "queued" || latest.status === "running") ? 2500 : 10_000;
    },
  });

  const render = jobsQ.data?.render_jobs?.[0];
  const status = render?.status ?? (resp.project.status === "rendering" ? "running" : "queued");
  const progress = render?.progress ?? 5;
  const done = status === "completed" && render?.output_url;

  // Re-render kicks a fresh render job. The /render route refuses one only while
  // a render_job is queued/running, so this is safe once the current job is
  // terminal (completed / failed / manually cancelled). Used to recover a render
  // that got stuck on the worker and was cancelled.
  const rerender = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/render`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).error ?? `render failed (${r.status})`);
    },
    onSuccess: onChange,
  });

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Film className="h-4 w-4" /> Render
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === "failed" ? (
            <div className="space-y-3">
              <p className="text-sm text-danger">{render?.error ?? "Render failed."}</p>
              <Button type="button" variant="gradient" disabled={rerender.isPending} onClick={() => rerender.mutate()}>
                <RotateCcw className={`h-4 w-4 ${rerender.isPending ? "animate-spin" : ""}`} />
                {rerender.isPending ? "Starting render…" : "Re-render"}
              </Button>
              {rerender.error && <p className="text-xs text-danger">{(rerender.error as Error).message}</p>}
            </div>
          ) : done ? (
            <>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video src={render!.output_url!} controls className="w-full aspect-video rounded-[10px] bg-black" />
              <Button asChild variant="gradient">
                <a href={render!.output_url!} download>
                  <Download className="h-4 w-4" /> Download MP4
                </a>
              </Button>
              <p className="break-all text-[11px] text-fg-subtle">{render!.output_url}</p>
            </>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-fg-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Rendering… ({status})
              </div>
              <Progress value={progress} />
              <span className="text-xs text-fg-subtle tabular-nums">{progress}%</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Button type="button" variant="ghost" size="sm" onClick={onChange}>Refresh status</Button>
    </div>
  );
}

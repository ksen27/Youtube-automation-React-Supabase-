"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtMinutes, type ClipRow, type JobsResp, type TimelineRow } from "../_shared";

export function ExportScreen({
  projectId,
  jobs,
}: {
  projectId: string;
  jobs: JobsResp | undefined;
}) {
  const qc = useQueryClient();
  const tlQ = useQuery<{ items: TimelineRow[] }>({
    queryKey: ["project-timeline", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/timeline`).then((r) => r.json()),
  });
  const clipsQ = useQuery<{ clips: ClipRow[] }>({
    queryKey: ["project-clips", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/clips`).then((r) => r.json()),
  });

  const startRender = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/render`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
  });

  const items = tlQ.data?.items ?? [];
  const clipsCount = clipsQ.data?.clips.length ?? 0;
  const totalSec = items.reduce((s, i) => s + i.duration, 0);
  const latest = jobs?.render_jobs?.[0];
  const status = latest?.status;
  const isRunning = status === "running" || status === "queued";
  const isDone = status === "completed";
  const isFailed = status === "failed";

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Card className="overflow-hidden">
        {isDone && latest?.output_url ? (
          <video
            src={latest.output_url}
            controls
            className="w-full aspect-video bg-black"
          />
        ) : (
          <div className="aspect-video bg-bg-elevated grid place-items-center">
            <div className="text-center">
              {isRunning ? (
                <>
                  <Loader2 className="h-8 w-8 mx-auto animate-spin text-brand-300" />
                  <p className="mt-3 text-sm text-fg-muted">
                    Rendering — {Math.round(latest?.progress ?? 0)}%
                  </p>
                  <div className="mx-auto mt-4 h-1 w-48 rounded-full bg-bg overflow-hidden">
                    <div
                      className="h-full gradient-brand transition-[width] duration-500"
                      style={{ width: `${latest?.progress ?? 0}%` }}
                    />
                  </div>
                </>
              ) : isFailed ? (
                <>
                  <div className="grid h-12 w-12 mx-auto place-items-center rounded-full bg-danger/15 text-danger text-xl">
                    !
                  </div>
                  <p className="mt-3 text-sm text-fg">Render failed</p>
                  {latest?.error && (
                    <p className="mt-1 text-xs text-danger max-w-xs mx-auto">
                      {latest.error}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <Download className="h-8 w-8 mx-auto text-fg-subtle" />
                  <p className="mt-3 text-sm text-fg-muted">Not rendered yet</p>
                </>
              )}
            </div>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Duration" value={fmtMinutes(totalSec)} />
        <Stat label="Scenes" value={String(items.length)} />
        <Stat label="Clips" value={String(clipsCount)} />
      </div>

      <div className="flex flex-wrap gap-2">
        {isDone && latest?.output_url && (
          <Button variant="gradient" size="lg" asChild>
            <a href={latest.output_url} download>
              <Download className="h-4 w-4" /> Download MP4
            </a>
          </Button>
        )}
        <Button
          variant={isDone ? "outline" : "gradient"}
          size="lg"
          onClick={() => startRender.mutate()}
          disabled={startRender.isPending || isRunning}
        >
          {startRender.isPending || isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {isDone ? "Render again" : isRunning ? "Rendering…" : "Start render"}
        </Button>
      </div>
      {startRender.error && (
        <div className="rounded-[10px] border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {(startRender.error as Error).message}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-fg-subtle">{label}</div>
        <div className="mt-1 text-xl font-semibold tabular-nums text-fg">{value}</div>
      </CardContent>
    </Card>
  );
}

"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Music, RefreshCw, Trash2, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fmtMinutes,
  type ClipRow,
  type JobsResp,
  type ProjectResp,
  type TimelineRow,
} from "../_shared";
import { uploadAudioDirect } from "@/lib/client/upload-audio-direct";

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
  const projectQ = useQuery<ProjectResp>({
    queryKey: ["project", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}`).then((r) => r.json()),
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

      <BgMusicCard
        // Remount when the upload URL changes so the local volume state
        // resyncs to whatever the server stored for the new file.
        key={projectQ.data?.project?.bg_music_url ?? "none"}
        projectId={projectId}
        project={projectQ.data?.project}
        disabled={isRunning}
      />

      <SfxCard
        // Remount when the list length changes so the upload input resets
        // and the local gain state resyncs to the server.
        key={`sfx-${projectQ.data?.project?.sfx_urls?.length ?? 0}`}
        projectId={projectId}
        project={projectQ.data?.project}
        disabled={isRunning}
      />

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

function BgMusicCard({
  projectId,
  project,
  disabled,
}: {
  projectId: string;
  project: ProjectResp["project"] | undefined;
  disabled: boolean;
}) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep the slider responsive locally and PATCH on release. The parent
  // remounts this component (via `key`) whenever bg_music_url changes, so
  // the initial value here stays in sync with the server's stored gain
  // for the active file without an effect-driven resync.
  const initialGain = project?.bg_music_gain ?? 0.15;
  const [gainPct, setGainPct] = useState(() => Math.round(initialGain * 100));

  const upload = useMutation({
    mutationFn: (file: File) => uploadAudioDirect("bg-music", projectId, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/bg-music`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
  });

  const saveGain = useMutation({
    mutationFn: async (value: number) => {
      const r = await fetch(`/api/projects/${projectId}/bg-music`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bg_music_gain: value }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  const uploading = upload.isPending;
  const removing = remove.isPending;
  const busy = disabled || uploading || removing;
  const hasMusic = !!project?.bg_music_url;

  return (
    <Card aria-disabled={busy} className={busy ? "opacity-80" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Music className="h-4 w-4 text-fg-muted" />
          Background music
        </CardTitle>
        <CardDescription>
          Optional audio bed. Plays under the voiceover at the volume below.
          Loops if shorter than the voiceover, and is cut at the video&rsquo;s end if longer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="bgm">Audio file</Label>
          <Input
            id="bgm"
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
            }}
          />
        </div>

        {uploading && (
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…
          </div>
        )}
        {upload.error && (
          <p className="text-xs text-danger">{(upload.error as Error).message}</p>
        )}
        {remove.error && (
          <p className="text-xs text-danger">{(remove.error as Error).message}</p>
        )}

        {hasMusic && !uploading && (
          <>
            <audio
              controls
              src={project!.bg_music_url!}
              className="w-full rounded-md border border-border bg-bg-elevated"
            />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="bgm-vol">Volume</Label>
                <span className="text-xs tabular-nums text-fg-muted">{gainPct}%</span>
              </div>
              <input
                id="bgm-vol"
                type="range"
                min={0}
                max={50}
                step={1}
                value={gainPct}
                disabled={busy}
                onChange={(e) => setGainPct(Number(e.target.value))}
                onMouseUp={() => saveGain.mutate(gainPct / 100)}
                onTouchEnd={() => saveGain.mutate(gainPct / 100)}
                onKeyUp={() => saveGain.mutate(gainPct / 100)}
                className="w-full accent-brand-300"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => remove.mutate()}
                disabled={busy}
              >
                {removing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Remove
              </Button>
              {saveGain.isPending && (
                <span className="text-xs text-fg-muted">Saving…</span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SfxCard({
  projectId,
  project,
  disabled,
}: {
  projectId: string;
  project: ProjectResp["project"] | undefined;
  disabled: boolean;
}) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mirrors BgMusicCard's responsive-slider pattern. Default 0.7 sits
  // between bg music (~0.15) and voiceover (~1.0). The parent remounts
  // this component when the list length changes, so the initial gain
  // resyncs to the server on add/remove.
  const initialGain = project?.sfx_gain ?? 0.7;
  const [gainPct, setGainPct] = useState(() => Math.round(initialGain * 100));

  const urls = project?.sfx_urls ?? [];

  const upload = useMutation({
    mutationFn: (file: File) => uploadAudioDirect("sfx", projectId, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
  });

  const removeOne = useMutation({
    mutationFn: async (url: string) => {
      const r = await fetch(
        `/api/projects/${projectId}/sfx?url=${encodeURIComponent(url)}`,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  const saveGain = useMutation({
    mutationFn: async (value: number) => {
      const r = await fetch(`/api/projects/${projectId}/sfx`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sfx_gain: value }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  const uploading = upload.isPending;
  const busy = disabled || uploading || removeOne.isPending;
  const hasAny = urls.length > 0;

  return (
    <Card aria-disabled={busy} className={busy ? "opacity-80" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Volume2 className="h-4 w-4 text-fg-muted" />
          Transition sound effects
        </CardTitle>
        <CardDescription>
          Optional clicks or swipes layered onto image transitions. Fires on
          every 3rd image transition and rotates through the uploaded files.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="sfx-file">Add an SFX clip</Label>
          <Input
            id="sfx-file"
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
            }}
          />
        </div>

        {uploading && (
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…
          </div>
        )}
        {upload.error && (
          <p className="text-xs text-danger">{(upload.error as Error).message}</p>
        )}
        {removeOne.error && (
          <p className="text-xs text-danger">{(removeOne.error as Error).message}</p>
        )}

        {hasAny && (
          <>
            <ul className="space-y-2">
              {urls.map((url, i) => (
                <li
                  key={url}
                  className="flex items-center gap-2 rounded-md border border-border bg-bg-elevated p-2"
                >
                  <span className="text-xs tabular-nums text-fg-subtle w-6 text-center">
                    {i + 1}
                  </span>
                  <audio controls src={url} className="flex-1 min-w-0" />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeOne.mutate(url)}
                    disabled={busy}
                    aria-label="Remove SFX clip"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="sfx-vol">Volume</Label>
                <span className="text-xs tabular-nums text-fg-muted">{gainPct}%</span>
              </div>
              <input
                id="sfx-vol"
                type="range"
                min={0}
                max={100}
                step={1}
                value={gainPct}
                disabled={busy}
                onChange={(e) => setGainPct(Number(e.target.value))}
                onMouseUp={() => saveGain.mutate(gainPct / 100)}
                onTouchEnd={() => saveGain.mutate(gainPct / 100)}
                onKeyUp={() => saveGain.mutate(gainPct / 100)}
                className="w-full accent-brand-300"
              />
              {saveGain.isPending && (
                <span className="text-xs text-fg-muted">Saving…</span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

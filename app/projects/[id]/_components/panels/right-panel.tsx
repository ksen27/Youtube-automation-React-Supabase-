"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Info, ListChecks, Sparkles } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Textarea } from "@/components/ui/textarea";
import {
  type ClipRow,
  type JobsResp,
  type ProjectResp,
  type TimelineRow,
  type WorkspacePhase,
  fmtMinutes,
  jobsBusy,
} from "../../_shared";

export function RightPanel({
  projectId,
  phase,
  project,
  jobs,
  selectedBlockId,
}: {
  projectId: string;
  phase: WorkspacePhase;
  project: ProjectResp | undefined;
  jobs: JobsResp | undefined;
  selectedBlockId: string | null;
}) {
  if (phase === "editor" && selectedBlockId) {
    return (
      <BlockInspector
        projectId={projectId}
        selectedBlockId={selectedBlockId}
      />
    );
  }
  if (phase === "analysis" || phase === "intake") {
    return <ProjectInfoPanel project={project} />;
  }
  if (phase === "processing" || phase === "export") {
    return <ActivityPanel jobs={jobs} />;
  }
  return <ProjectInfoPanel project={project} />;
}

// =====================================================================
// Project info — entities, source counts, last updated.
// =====================================================================

function ProjectInfoPanel({ project }: { project: ProjectResp | undefined }) {
  const entities = project?.entities ?? [];
  const sources = project?.video_sources ?? [];
  const transcript = project?.project.transcript ?? "";
  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
  const estMin = wordCount > 0 ? Math.max(1, Math.round(wordCount / 150)) : 0;

  return (
    <PanelShell
      title="Project"
      icon={<Info className="h-3.5 w-3.5" />}
    >
      <Section label="Stats">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Words" value={String(wordCount)} />
          <Stat label="Est. duration" value={estMin > 0 ? fmtMinutes(estMin * 60) : "—"} />
          <Stat label="Entities" value={String(entities.length)} />
          <Stat label="Sources" value={String(sources.length)} />
        </div>
      </Section>

      {entities.length > 0 && (
        <Section label="Extracted entities">
          <div className="flex flex-wrap gap-1.5">
            {entities.slice(0, 24).map((e) => (
              <Chip key={e.id} tone={toneForEntity(e.type)}>
                {e.value}
              </Chip>
            ))}
            {entities.length > 24 && (
              <span className="text-xs text-fg-subtle self-center">
                +{entities.length - 24} more
              </span>
            )}
          </div>
        </Section>
      )}

      {sources.length > 0 && (
        <Section label={`Source videos (${sources.length})`}>
          <ul className="space-y-1">
            {sources.slice(0, 8).map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="truncate text-fg">
                  {s.title ?? s.youtube_video_id}
                </span>
                <Chip tone={s.status === "downloaded" ? "success" : "neutral"}>
                  {s.status}
                </Chip>
              </li>
            ))}
            {sources.length > 8 && (
              <li className="text-xs text-fg-subtle">+{sources.length - 8} more</li>
            )}
          </ul>
        </Section>
      )}
    </PanelShell>
  );
}

function toneForEntity(type: string): "person" | "place" | "topic" | "keyword" | "neutral" {
  switch (type) {
    case "celebrity":
    case "related_person":
      return "person";
    case "place":
      return "place";
    case "movie":
    case "tv_show":
    case "song":
    case "event":
      return "topic";
    case "year":
    case "age":
    case "company":
      return "keyword";
    default:
      return "neutral";
  }
}

// =====================================================================
// Activity feed — running / failed jobs + recent media work.
// =====================================================================

function ActivityPanel({ jobs }: { jobs: JobsResp | undefined }) {
  const busy = jobsBusy(jobs);
  const media = jobs?.media_jobs ?? [];
  const renders = jobs?.render_jobs ?? [];
  const recent = [...media]
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
    .slice(0, 12);

  return (
    <PanelShell
      title="Activity"
      icon={<Activity className="h-3.5 w-3.5" />}
      live={busy}
    >
      {renders.length > 0 && (
        <Section label="Render">
          <ul className="space-y-1.5">
            {renders.slice(0, 3).map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between rounded-md bg-bg-elevated border border-border px-2.5 py-1.5"
              >
                <span className="text-xs text-fg-muted truncate">
                  {new Date(r.created_at).toLocaleTimeString()}
                </span>
                <Chip tone={toneForJobStatus(r.status)}>{r.status}</Chip>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section label="Media jobs">
        {recent.length === 0 ? (
          <p className="text-xs text-fg-subtle">No activity yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {recent.map((j) => (
              <li
                key={j.id}
                className="rounded-md bg-bg-elevated border border-border px-2.5 py-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-fg">{j.type}</span>
                  <Chip tone={toneForJobStatus(j.status)}>{j.status}</Chip>
                </div>
                {j.error && (
                  <p className="mt-1 text-[11px] text-danger truncate" title={j.error}>
                    {j.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </PanelShell>
  );
}

function toneForJobStatus(
  s: string,
): "success" | "danger" | "keyword" | "warning" | "neutral" {
  if (s === "completed") return "success";
  if (s === "failed") return "danger";
  if (s === "running") return "keyword";
  if (s === "queued") return "warning";
  return "neutral";
}

// =====================================================================
// Block inspector — selected scene block, editable script + overlay.
// =====================================================================

function BlockInspector({
  projectId,
  selectedBlockId,
}: {
  projectId: string;
  selectedBlockId: string;
}) {
  const tlQ = useQuery<{ items: TimelineRow[] }>({
    queryKey: ["project-timeline", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/timeline`).then((r) => r.json()),
  });
  const clipsQ = useQuery<{ clips: ClipRow[] }>({
    queryKey: ["project-clips", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/clips`).then((r) => r.json()),
  });

  const item = (tlQ.data?.items ?? []).find((i) => i.id === selectedBlockId);

  if (!item) {
    return (
      <PanelShell title="Inspector" icon={<ListChecks className="h-3.5 w-3.5" />}>
        <p className="text-xs text-fg-subtle">Block not found.</p>
      </PanelShell>
    );
  }

  const clip = item.clip_id
    ? (clipsQ.data?.clips ?? []).find((c) => c.id === item.clip_id)
    : null;

  // Image blocks have no clip_id; their thumbnail comes from the row's
  // image_url (fetched into the project pool at match time).
  const inspectorThumb = clip?.thumbnail_url ?? item.image_url ?? null;

  return (
    <BlockInspectorForm
      key={item.id}
      projectId={projectId}
      item={item}
      clipThumb={inspectorThumb}
    />
  );
}

function BlockInspectorForm({
  projectId,
  item,
  clipThumb,
}: {
  projectId: string;
  item: TimelineRow;
  clipThumb: string | null;
}) {
  const qc = useQueryClient();
  const [script, setScript] = useState(item.script_text ?? "");
  const [overlay, setOverlay] = useState(item.overlay_text ?? "");

  const patch = useMutation({
    mutationFn: async (body: {
      items: Array<{ id: string; [k: string]: unknown }>;
    }) => {
      const r = await fetch(`/api/projects/${projectId}/timeline`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-timeline", projectId] }),
  });

  return (
    <PanelShell
      title="Inspector"
      icon={<ListChecks className="h-3.5 w-3.5" />}
      subtitle={`Scene · ${item.type}`}
    >
      <div className="aspect-video rounded-md bg-bg-elevated border border-border overflow-hidden">
        {clipThumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={clipThumb}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="h-full w-full grid place-items-center text-xs text-fg-subtle">
            {item.type}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Duration" value={`${Math.round(item.duration)}s`} />
        <Stat label="Position" value={String(item.position + 1)} />
        <Stat
          label="Status"
          value={item.approved ? "approved" : "draft"}
          highlight={item.approved}
        />
      </div>

      <Section label="Script">
        <Textarea
          rows={4}
          value={script}
          onChange={(e) => setScript(e.target.value)}
          placeholder="Spoken script for this scene"
        />
      </Section>

      <Section label="Overlay text">
        <Textarea
          rows={2}
          value={overlay}
          onChange={(e) => setOverlay(e.target.value)}
          placeholder="On-screen caption"
        />
      </Section>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="gradient"
          size="sm"
          disabled={
            patch.isPending ||
            (script === (item.script_text ?? "") && overlay === (item.overlay_text ?? ""))
          }
          onClick={() =>
            patch.mutate({
              items: [
                {
                  id: item.id,
                  script_text: script,
                  overlay_text: overlay,
                },
              ],
            })
          }
        >
          <Sparkles className="h-3.5 w-3.5" /> Save
        </Button>
        <Button
          variant={item.approved ? "outline" : "soft"}
          size="sm"
          disabled={patch.isPending}
          onClick={() =>
            patch.mutate({
              items: [{ id: item.id, approved: !item.approved }],
            })
          }
        >
          {item.approved ? "Unapprove" : "Approve"}
        </Button>
      </div>
    </PanelShell>
  );
}

// =====================================================================
// Shared panel layout primitives
// =====================================================================

function PanelShell({
  title,
  subtitle,
  icon,
  live,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
        <div className="grid place-items-center h-6 w-6 rounded-md bg-surface text-fg-muted">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-fg uppercase tracking-wider">
            {title}
          </div>
          {subtitle && (
            <div className="text-[11px] text-fg-subtle truncate">{subtitle}</div>
          )}
        </div>
        {live && (
          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            live
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">
        {children}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="text-[10px] font-medium text-fg-subtle uppercase tracking-wider">
        {label}
      </div>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={
        "rounded-md border bg-surface px-2.5 py-2 " +
        (highlight ? "border-emerald-500/30" : "border-border")
      }
    >
      <div className="text-[10px] text-fg-subtle uppercase tracking-wider">
        {label}
      </div>
      <div
        className={
          "mt-0.5 text-sm font-semibold tabular-nums " +
          (highlight ? "text-emerald-400" : "text-fg")
        }
      >
        {value}
      </div>
    </div>
  );
}

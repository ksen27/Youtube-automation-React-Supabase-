"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Loader2, RefreshCcw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Live status panel for script-doc markers. Polls every 2s while any clip
// is still downloading; backs off to 10s once all clips are ready/failed.
// Each row shows the marker's kind, identifying text/window, status badge,
// and (for failed rows) a Retry button.

export interface ScriptMarker {
  id: string;
  kind: "intro_card" | "title_card" | "title_card_clip" | "lower_third";
  text: string;
  ordinal: number;
  paragraph_index: number | null;
  char_offset: number | null;
  youtube_url: string | null;
  start_seconds: number | null;
  end_seconds: number | null;
  download_status: "pending" | "downloading" | "ready" | "failed";
  download_error: string | null;
  clip_storage_url: string | null;
  audio_storage_url: string | null;
  download_updated_at: string | null;
}

export interface ScriptMarkersResponse {
  markers: ScriptMarker[];
  summary: {
    total: number;
    clips: number;
    ready: number;
    downloading: number;
    pending: number;
    failed: number;
    allClipsReady: boolean;
    anyClipFailed: boolean;
    stillDownloading: number;
  };
}

function fmtRange(start: number | null, end: number | null): string {
  if (start == null || end == null) return "?";
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s - m * 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  };
  return `${fmt(start)}–${fmt(end)}`;
}

function StatusBadge({ status }: { status: ScriptMarker["download_status"] }) {
  switch (status) {
    case "ready":
      return (
        <Badge variant="success" className="gap-1">
          <CheckCircle2 className="h-3 w-3" /> Ready
        </Badge>
      );
    case "downloading":
      return (
        <Badge variant="info" className="gap-1">
          <Loader2 className="h-3 w-3 animate-spin" /> Downloading
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" /> Failed
        </Badge>
      );
    case "pending":
    default:
      return (
        <Badge variant="outline" className="gap-1">
          <Circle className="h-3 w-3" /> Pending
        </Badge>
      );
  }
}

export function ScriptMarkersPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();

  const q = useQuery<ScriptMarkersResponse>({
    queryKey: ["script-markers", projectId],
    queryFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/script-markers`);
      if (!r.ok) throw new Error(`failed ${r.status}`);
      return r.json();
    },
    // Poll fast while any clip is still in flight. Once everything has
    // settled, back off so a quiet project doesn't generate constant
    // traffic — but keep polling cheaply so a manual retry's status flips
    // are still visible within a few seconds.
    refetchInterval: (query) => {
      const data = query.state.data as ScriptMarkersResponse | undefined;
      if (!data) return 2000;
      return data.summary.stillDownloading > 0 ? 2000 : 10_000;
    },
  });

  const retry = useMutation({
    mutationFn: async (markerId: string) => {
      const r = await fetch(
        `/api/projects/${projectId}/script-markers/${markerId}/retry`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["script-markers", projectId] }),
  });

  const grouped = useMemo(() => {
    const markers = q.data?.markers ?? [];
    return {
      intro: markers.filter((m) => m.kind === "intro_card"),
      titleCards: markers.filter(
        (m) => m.kind === "title_card" || m.kind === "title_card_clip",
      ),
      lowerThirds: markers.filter((m) => m.kind === "lower_third"),
    };
  }, [q.data]);

  if (q.isLoading) {
    return <p className="text-xs text-fg-muted">Loading script markers…</p>;
  }
  if (q.error) {
    return (
      <p className="text-xs text-danger">
        Could not load script markers: {(q.error as Error).message}
      </p>
    );
  }
  const summary = q.data?.summary;
  if (!summary || summary.total === 0) return null;

  return (
    <div className="rounded-md border border-border bg-bg-elevated p-3 text-xs space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">Script doc</p>
        <p className="text-fg-muted">
          {summary.ready}/{summary.clips} clips ready
          {summary.failed > 0 && <span className="text-danger"> · {summary.failed} failed</span>}
          {summary.stillDownloading > 0 && (
            <span className="text-sky-400"> · {summary.stillDownloading} in flight</span>
          )}
        </p>
      </div>

      {grouped.intro.length > 0 && (
        <Section title="Intro clips">
          {grouped.intro.map((m) => (
            <MarkerRow
              key={m.id}
              label={m.text ? `${m.text}` : `Intro ${m.ordinal + 1}`}
              detail={fmtRange(m.start_seconds, m.end_seconds)}
              marker={m}
              onRetry={() => retry.mutate(m.id)}
              retrying={retry.isPending && retry.variables === m.id}
            />
          ))}
        </Section>
      )}

      {grouped.titleCards.length > 0 && (
        <Section title="Title cards">
          {grouped.titleCards.map((m) =>
            // Clipless title card: a blue-bold heading with no force clip
            // under it. It renders as a standalone on-screen title card with
            // no source clip to download, so there's no timestamp range and
            // no download status to show — render a simple label row instead
            // of a MarkerRow (which would show a bogus "?" range + Pending).
            m.kind === "title_card" && !m.youtube_url ? (
              <div key={m.id} className="flex items-center gap-2 py-1">
                <span className="truncate text-fg" title={m.text}>
                  {m.text || "(no title text)"}
                </span>
                <span className="text-fg-muted">— title card (no clip)</span>
              </div>
            ) : (
              <MarkerRow
                key={m.id}
                label={
                  m.kind === "title_card"
                    ? m.text || "(no title text)"
                    : `↳ extra clip ${m.ordinal}`
                }
                detail={fmtRange(m.start_seconds, m.end_seconds)}
                marker={m}
                onRetry={() => retry.mutate(m.id)}
                retrying={retry.isPending && retry.variables === m.id}
              />
            ),
          )}
        </Section>
      )}

      {grouped.lowerThirds.length > 0 && (
        <Section title="Lower-thirds">
          {grouped.lowerThirds.map((m) => (
            <div key={m.id} className="flex items-center gap-2 py-1">
              <span className="truncate text-fg" title={m.text}>{m.text}</span>
              <span className="text-fg-muted">— text overlay (no clip)</span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-fg-muted mb-1">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function MarkerRow({
  label,
  detail,
  marker,
  onRetry,
  retrying,
}: {
  label: string;
  detail: string;
  marker: ScriptMarker;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="flex items-start gap-2 py-1">
      <div className="flex-1 min-w-0">
        <p className="truncate text-fg" title={label}>{label}</p>
        <p className="text-fg-muted text-[11px]">{detail}</p>
        {marker.download_status === "failed" && marker.download_error && (
          <p
            className="text-danger text-[11px] mt-0.5 line-clamp-2"
            title={marker.download_error}
          >
            {marker.download_error}
          </p>
        )}
      </div>
      <StatusBadge status={marker.download_status} />
      {marker.download_status === "failed" && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCcw className="h-3 w-3" />
          )}
          Retry
        </Button>
      )}
    </div>
  );
}

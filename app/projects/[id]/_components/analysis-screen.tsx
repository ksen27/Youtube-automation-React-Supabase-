"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { StepCard, type StepState } from "@/components/ui/step-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VideoCard } from "@/components/ui/video-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fmtMinutes } from "../_shared";
import { ScriptMarkersPanel, type ScriptMarkersResponse } from "./script-markers-panel";

interface PreviewCandidate {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  durationSeconds: number;
  thumbnailUrl: string;
  score: number;          // raw score (can exceed 100 in theory)
  displayScore: number;   // 0–100 normalized for the UI bar
  reasons: string[];
  rejected: boolean;
  rejectReason?: string;
  // Editorial type chip shown on the picker card. Optional because older
  // saved payloads predate the classifier — those candidates render
  // without a chip.
  source_type?: "interview" | "news" | "archival" | "other";
  // Provenance flags (entity-driven payloads): surfaced as badges so the user
  // can see at a glance that a source came from a reference channel or was
  // previously approved.
  from_reference_channel?: boolean;
  from_approved?: boolean;
  // Footage style (entity-driven payloads): "interview", "red carpet",
  // "talk show", "show", etc. Shown as a chip so the user can see variety.
  footage_style?: string;
}

interface SegmentUnderstanding {
  mainTopic: string;
  people: string[];
  places: string[];
  events: string[];
  topics: string[];
  relatedKeywords: string[];
  // Optional fields — older saved payloads predate the global-subject anchor
  // work and won't have these. Default to empty/false on read so we don't
  // crash the workspace when re-hydrating an analyze run from before the change.
  segmentSubject?: string;
  inheritedSubject?: boolean;
  segmentTopic?: string;
  searchIntents: { label: string; query: string }[];
}

interface SegmentPlan {
  durationSeconds: number;
  blockCount: number;
  footageNeeded: number;
  imagesNeeded: number;
  generatedClips: number;
  requiredClips: number;
}

interface SegmentAnalysis {
  index: number;
  startSeconds: number;
  endSeconds: number;
  wordCount: number;
  textPreview: string;
  understanding: SegmentUnderstanding;
  candidates: PreviewCandidate[];
  plan: SegmentPlan;
}

interface TimelinePlanSummary {
  voiceoverSeconds: number;
  avgBlockSeconds: number;
  totalBlocks: number;
  footageBlocks: number;
  imageBlocks: number;
  bucket: "short" | "medium" | "long";
  generatedClips: number;
}

// One source-video pool per celebrity/entity — the primary review unit in the
// subject-first redesign. `target` is how many of these the user should select
// for this entity (duration-driven). Candidates are pre-ranked desc.
interface EntityGroup {
  value: string;
  type: string;
  target: number;
  candidates: PreviewCandidate[];
}

interface AnalyzeResponse {
  projectId: string;
  totalDurationSeconds: number;
  voiceoverDurationSeconds: number;
  estimatedDurationSeconds: number;
  wordCount: number;
  // Duration-driven counts (present on entity-driven payloads).
  sourceTarget?: number;
  reviewPoolSize?: number;
  plan: TimelinePlanSummary;
  // Primary view (entity-driven payloads). Older payloads only have segments.
  entities?: EntityGroup[];
  segments: SegmentAnalysis[];
}

type Phase = "idle" | "understanding" | "segmenting" | "searching" | "results" | "confirming" | "done" | "error";

const STEPS = [
  { key: "understanding" as const, label: "Understanding content", icon: Sparkles },
  { key: "segmenting" as const, label: "Breaking into parts", icon: Layers },
  { key: "searching" as const, label: "Finding source videos", icon: Search },
  { key: "results" as const, label: "Ready for review", icon: PlayCircle },
];

// All videoIds present in a payload — entity pools when entity-driven, else
// segment pools. Used to drop stale saved selections that no longer exist.
function collectVideoIds(d: AnalyzeResponse): Set<string> {
  const ids = new Set<string>();
  if (d.entities?.length) {
    for (const e of d.entities) for (const c of e.candidates) ids.add(c.videoId);
  } else {
    for (const seg of d.segments) for (const c of seg.candidates) ids.add(c.videoId);
  }
  return ids;
}

// The AI-suggested default selection. Entity-driven: top `target` videos per
// entity (the duration-derived count). Legacy: top 5 per segment.
function defaultSelection(d: AnalyzeResponse): Set<string> {
  const ids = new Set<string>();
  if (d.entities?.length) {
    for (const e of d.entities) {
      for (const c of e.candidates.slice(0, Math.max(1, e.target))) ids.add(c.videoId);
    }
  } else {
    for (const seg of d.segments) {
      for (const c of seg.candidates.slice(0, 5)) ids.add(c.videoId);
    }
  }
  return ids;
}

export function AnalysisScreen({
  projectId,
  autoStart,
}: {
  projectId: string;
  autoStart: boolean;
}) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyzeResponse | null>(null);
  const [openSegments, setOpenSegments] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Per-entity expand/collapse state (entity-driven view).
  const [openEntities, setOpenEntities] = useState<Set<string>>(new Set());
  // Cards the user explicitly removed (wrong person / unrelated). Hidden from
  // view and dropped from selection. Distinct from "unselected" — a removed
  // card doesn't come back when toggling selection.
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  // Hydrate from the saved analyze job so re-visiting the screen doesn't
  // wipe and re-run Gemini + YouTube search. The POST handler persists the
  // full AnalyzeResponse in media_jobs.metadata.payload, and the PUT
  // handler stores the user's last source-video selection in
  // metadata.selectedVideoIds so picks survive navigation.
  const savedQ = useQuery<{
    payload: AnalyzeResponse | null;
    selectedVideoIds: string[] | null;
  }>({
    queryKey: ["analyze", projectId],
    queryFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/analyze`);
      if (!r.ok) throw new Error(`load analyze: ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
  });

  // Script-doc clip download state. We block the "Analyze & Search" button
  // while any doc clip is still being downloaded so the user can't kick off
  // generate before their forced footage is ready. The render path has its
  // own fallback (yt-dlp at render time) but failing during a 10-minute
  // render is much worse UX than waiting an extra few seconds here.
  const markersQ = useQuery<ScriptMarkersResponse>({
    queryKey: ["script-markers", projectId],
    queryFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/script-markers`);
      if (!r.ok) throw new Error(`load script markers: ${r.status}`);
      return r.json();
    },
    refetchInterval: (query) => {
      const d = query.state.data as ScriptMarkersResponse | undefined;
      if (!d) return 2000;
      return d.summary.stillDownloading > 0 ? 2000 : 10_000;
    },
  });
  const clipsStillDownloading = (markersQ.data?.summary.stillDownloading ?? 0) > 0;
  const hasScriptMarkers = (markersQ.data?.summary.total ?? 0) > 0;

  const runAnalyze = useMutation<AnalyzeResponse, Error, void>({
    mutationFn: async () => {
      setPhase("understanding");
      setTimeout(() => setPhase((p) => (p === "understanding" ? "segmenting" : p)), 1200);
      setTimeout(() => setPhase((p) => (p === "segmenting" ? "searching" : p)), 4500);
      const r = await fetch(`/api/projects/${projectId}/analyze`, { method: "POST" });
      if (!r.ok)
        throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
      return r.json();
    },
    onSuccess: (d) => {
      setData(d);
      setSelected(defaultSelection(d));
      setOpenSegments(new Set([0]));
      if (d.entities?.length) setOpenEntities(new Set([d.entities[0].value]));
      setPhase("results");
      // Refresh the saved-payload cache so a future remount re-hydrates from
      // the new run instead of the previous one. selectedVideoIds=null so
      // the rehydration path uses the "top 5 per segment" default for this
      // fresh run; subsequent user toggles will get persisted via the
      // debounced PUT below.
      qc.setQueryData(["analyze", projectId], { payload: d, selectedVideoIds: null });
    },
    onError: (e) => {
      setError(e.message);
      setPhase("error");
    },
  });

  // Manually add a YouTube URL to a specific segment's candidate pool.
  // The backend hydrates metadata, runs the same rank+verify filters as
  // the AI search, and (on accept) returns a candidate row in the same
  // shape the analyze step emits. We splice it into the segment's
  // candidates state so the new card shows up immediately, and
  // auto-select it (the user explicitly chose this URL — opt-in by
  // default matches the existing "top 5 pre-selected" UX).
  const addSource = useMutation<
    { accepted: boolean; reason?: string; candidate?: PreviewCandidate },
    Error,
    { videoUrl: string; segmentIndex?: number; entityValue?: string }
  >({
    mutationFn: async ({ videoUrl, segmentIndex, entityValue }) => {
      const r = await fetch(`/api/projects/${projectId}/analyze/add-source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl, segmentIndex, entityValue }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      return j;
    },
    onSuccess: (j, vars) => {
      if (!j.accepted || !j.candidate) return;
      // Mutate the in-memory analyze payload so the picker re-renders with the
      // new card. Immutable update so React detects the change. Entity path
      // appends to the entity pool; legacy path to the segment pool.
      setData((cur) => {
        if (!cur) return cur;
        if (vars.entityValue && cur.entities?.length) {
          const next = { ...cur, entities: cur.entities.map((e) => ({ ...e })) };
          const ent = next.entities!.find((e) => e.value === vars.entityValue);
          if (!ent) return cur;
          ent.candidates = [...ent.candidates, j.candidate!];
          return next;
        }
        const next = { ...cur, segments: cur.segments.map((s) => ({ ...s })) };
        const seg = next.segments.find((s) => s.index === vars.segmentIndex);
        if (!seg) return cur;
        seg.candidates = [...seg.candidates, j.candidate!];
        seg.plan = { ...seg.plan, generatedClips: seg.candidates.length };
        return next;
      });
      // Auto-select the new candidate. Skip if the user happened to
      // already select it via a duplicate paste somewhere.
      setSelected((cur) => {
        if (cur.has(j.candidate!.videoId)) return cur;
        const next = new Set(cur);
        next.add(j.candidate!.videoId);
        return next;
      });
    },
  });

  const confirm = useMutation<{ ok: boolean; queued: number }, Error, void>({
    mutationFn: async () => {
      setPhase("confirming");
      const r = await fetch(`/api/projects/${projectId}/confirm-sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedVideoIds: Array.from(selected) }),
      });
      if (!r.ok)
        throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
      return r.json();
    },
    onSuccess: () => {
      setPhase("done");
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["project-jobs", projectId] });
    },
    onError: (e) => {
      setError(e.message);
      setPhase("error");
    },
  });

  useEffect(() => {
    if (phase !== "idle") return;
    // Wait for the saved-payload fetch to settle before deciding what to do.
    if (savedQ.isLoading) return;
    const saved = savedQ.data?.payload ?? null;
    const savedSelected = savedQ.data?.selectedVideoIds ?? null;
    if (saved) {
      // Rehydrate prior results — no Gemini/YouTube spend on re-visit.
      setData(saved);
      let initial: Set<string>;
      if (savedSelected && savedSelected.length > 0) {
        // User has a saved selection from a previous visit — restore exactly
        // what they had checked. Filter to IDs that still exist in the
        // current payload (stale IDs that were removed from candidates
        // should not appear as ghost selections).
        const validIds = collectVideoIds(saved);
        initial = new Set(savedSelected.filter((v) => validIds.has(v)));
      } else {
        // No saved selection — fall back to the AI-suggested default
        // (top `target` per entity, or top 5 per segment for old payloads).
        initial = defaultSelection(saved);
      }
      setSelected(initial);
      setOpenSegments(new Set([0]));
      if (saved.entities?.length) setOpenEntities(new Set([saved.entities[0].value]));
      setPhase("results");
      return;
    }
    // Hold the auto-start trigger until all script-doc clips have settled
    // (ready or failed). Without this, the doc-driven matcher can race the
    // forced-clip downloads and emit timeline rows that point at not-yet-
    // uploaded clips.
    if (autoStart && !clipsStillDownloading) runAnalyze.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, savedQ.isLoading, savedQ.data, clipsStillDownloading]);

  // Debounced persistence of the user's source-video selection.
  //
  // Toggling a card updates the local `selected` Set immediately for
  // snappy UI. We then PUT the full set to the analyze endpoint after
  // ~500ms of idle so a burst of rapid toggles only writes once at the
  // end. Without this, navigating away and coming back used to silently
  // re-run the top-5-per-segment default and wipe the user's actual
  // picks.
  //
  // Skip the save while phase is still "idle" (rehydration just
  // populated `selected` from the saved set — re-saving it immediately
  // is a no-op write) or "confirming" / "done" (the confirm-sources
  // endpoint takes over from here; no point recording further toggles).
  useEffect(() => {
    if (phase !== "results") return;
    if (!data) return;
    const ids = Array.from(selected);
    const timer = setTimeout(() => {
      void fetch(`/api/projects/${projectId}/analyze`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedVideoIds: ids }),
      }).catch(() => { /* best-effort — failure leaves the in-memory state correct */ });
    }, 500);
    return () => clearTimeout(timer);
  }, [selected, phase, data, projectId]);

  const totals = useMemo(() => {
    if (!data) return { selected: 0, segments: 0, durationSec: 0 };
    return {
      selected: selected.size,
      segments: data.segments.length,
      durationSec: data.totalDurationSeconds,
    };
  }, [data, selected]);

  if (phase === "idle") {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        {hasScriptMarkers && <ScriptMarkersPanel projectId={projectId} />}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand-300" /> Analyze &amp; Search
            </CardTitle>
            <CardDescription>
              We&apos;ll read your content, break it into parts, and find source videos for each part. You confirm the sources before anything is downloaded.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button
              variant="gradient"
              size="lg"
              onClick={() => runAnalyze.mutate()}
              disabled={clipsStillDownloading}
            >
              <Sparkles className="h-4 w-4" /> Analyze &amp; Search
            </Button>
            {clipsStillDownloading && (
              <p className="text-xs text-fg-muted">
                Waiting for {markersQ.data?.summary.stillDownloading ?? 0} script-doc clip(s) to finish downloading before analysis.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="max-w-3xl mx-auto">
        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-danger">
              <AlertCircle className="h-5 w-5" /> Something went wrong
            </CardTitle>
            <CardDescription>{error ?? "Please try again."}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => {
                setError(null);
                runAnalyze.mutate();
              }}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <ProgressStepper phase={phase} />

      {!data ? (
        <SegmentSkeletons />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-fg-muted">
              Not happy with these results? Re-run analysis to regenerate segments and source candidates.
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={
                runAnalyze.isPending ||
                phase === "confirming" ||
                phase === "done" ||
                clipsStillDownloading
              }
              onClick={() => {
                if (
                  typeof window !== "undefined" &&
                  !window.confirm(
                    "Re-analyze this project? Existing source candidates and selections will be replaced.",
                  )
                ) {
                  return;
                }
                setSelected(new Set());
                setOpenSegments(new Set());
                setData(null);
                runAnalyze.mutate();
              }}
            >
              {runAnalyze.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Re-analyze
            </Button>
          </div>
          <SummaryStrip
            durationSec={totals.durationSec}
            segmentCount={totals.segments}
            selected={totals.selected}
            sourceTarget={data.sourceTarget}
            plan={data.plan}
          />

          {/* In-app YouTube search — manually find + add source videos on top
            of the AI search. Searches whole YouTube + reference channels. */}
          {data.entities?.length ? (
            <YoutubeSearchBox
              projectId={projectId}
              entities={data.entities.map((e) => e.value)}
              alreadyAddedIds={collectVideoIds(data)}
              onAdded={(entityValue, candidate) => {
                setData((cur) => {
                  if (!cur?.entities) return cur;
                  const next = { ...cur, entities: cur.entities.map((e) => ({ ...e })) };
                  const ent = next.entities!.find((e) => e.value === entityValue);
                  if (!ent) return cur;
                  if (ent.candidates.some((c) => c.videoId === candidate.videoId)) return cur;
                  ent.candidates = [candidate, ...ent.candidates];
                  return next;
                });
                setSelected((cur) => new Set(cur).add(candidate.videoId));
                setOpenEntities((cur) => new Set(cur).add(entityValue));
              }}
            />
          ) : null}

          {data.entities?.length ? (
            // Primary: per-entity source-video pools.
            <div className="space-y-3">
              {data.entities.map((ent) => (
                <EntityPanel
                  key={ent.value}
                  entity={ent}
                  open={openEntities.has(ent.value)}
                  onToggle={() => {
                    const next = new Set(openEntities);
                    if (next.has(ent.value)) next.delete(ent.value);
                    else next.add(ent.value);
                    setOpenEntities(next);
                  }}
                  selectedIds={selected}
                  removedIds={removed}
                  onToggleVideo={(videoId) => {
                    const next = new Set(selected);
                    if (next.has(videoId)) next.delete(videoId);
                    else next.add(videoId);
                    setSelected(next);
                  }}
                  onRemoveVideo={(videoId) => {
                    setRemoved((cur) => new Set(cur).add(videoId));
                    setSelected((cur) => {
                      if (!cur.has(videoId)) return cur;
                      const next = new Set(cur);
                      next.delete(videoId);
                      return next;
                    });
                  }}
                  onAddSource={(videoUrl) =>
                    addSource.mutateAsync({ videoUrl, entityValue: ent.value })
                  }
                  addingSource={addSource.isPending}
                />
              ))}
            </div>
          ) : (
            // Legacy fallback: per-segment panels (old saved payloads).
            <div className="space-y-3">
              {data.segments.map((seg) => (
                <SegmentPanel
                  key={seg.index}
                  segment={seg}
                  open={openSegments.has(seg.index)}
                  onToggle={() => {
                    const next = new Set(openSegments);
                    if (next.has(seg.index)) next.delete(seg.index);
                    else next.add(seg.index);
                    setOpenSegments(next);
                  }}
                  selectedIds={selected}
                  onToggleVideo={(videoId) => {
                    const next = new Set(selected);
                    if (next.has(videoId)) next.delete(videoId);
                    else next.add(videoId);
                    setSelected(next);
                  }}
                  onAddSource={(videoUrl) =>
                    addSource.mutateAsync({ videoUrl, segmentIndex: seg.index })
                  }
                  addingSource={addSource.isPending}
                />
              ))}
            </div>
          )}

          <StickyConfirmBar
            selected={totals.selected}
            loading={phase === "confirming"}
            done={phase === "done"}
            onConfirm={() => confirm.mutate()}
          />
        </>
      )}
    </div>
  );
}

function ProgressStepper({ phase }: { phase: Phase }) {
  const order: Phase[] = ["understanding", "segmenting", "searching", "results"];
  const activeIndex = order.indexOf(phase);
  const reachedResults = phase === "results" || phase === "confirming" || phase === "done";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {STEPS.map((s, i) => {
        const Icon = s.icon;
        const isDone = i < activeIndex || reachedResults;
        const isCurrent = i === activeIndex && !reachedResults;
        const state: StepState = isDone ? "done" : isCurrent ? "running" : "pending";
        return (
          <StepCard
            key={s.key}
            index={i}
            label={s.label}
            hint={hintFor(s.key, state)}
            state={state}
            progress={state === "running" ? 65 : undefined}
            icon={<Icon className="h-4 w-4" />}
          />
        );
      })}
    </div>
  );
}

function hintFor(key: string, state: StepState): string {
  if (state === "done") return "Done";
  if (state === "pending") return "Waiting";
  switch (key) {
    case "understanding":
      return "Reading your script…";
    case "segmenting":
      return "Splitting into 5-minute parts…";
    case "searching":
      return "Querying YouTube…";
    case "results":
      return "Preparing preview…";
    default:
      return "";
  }
}

function SummaryStrip({
  durationSec,
  segmentCount,
  selected,
  sourceTarget,
  plan,
}: {
  durationSec: number;
  segmentCount: number;
  selected: number;
  sourceTarget?: number;
  plan: TimelinePlanSummary;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Voiceover duration" value={fmtMinutes(durationSec)} />
        {sourceTarget != null ? (
          <Stat label="Suggested sources" value={String(sourceTarget)} />
        ) : (
          <Stat label="Parts" value={String(segmentCount)} />
        )}
        <Stat label="Videos selected" value={String(selected)} highlight={selected > 0} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Avg block" value={`${plan.avgBlockSeconds.toFixed(1)}s`} />
        <Stat label="Total blocks" value={String(plan.totalBlocks)} />
        <Stat label="Footage blocks" value={String(plan.footageBlocks)} />
        <Stat label="Image blocks" value={String(plan.imageBlocks)} />
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-[10px] border bg-surface p-3",
        highlight ? "border-brand-500/40" : "border-border",
      )}
    >
      <div className="text-xs text-fg-subtle">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular-nums", highlight && "text-brand-300")}>
        {value}
      </div>
    </div>
  );
}

function SegStat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-md border bg-surface-2 px-2.5 py-2",
        warn ? "border-amber-500/40" : "border-border",
      )}
    >
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className={cn("mt-0.5 text-sm font-semibold tabular-nums", warn && "text-amber-300")}>
        {value}
      </div>
    </div>
  );
}

function SegmentSkeletons() {
  return (
    <div className="space-y-3">
      {[0, 1].map((i) => (
        <Card key={i}>
          <CardContent className="p-5 space-y-3">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
              {[0, 1, 2].map((j) => (
                <Skeleton key={j} className="aspect-video" />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// Per-entity source-video pool — the primary review unit. Shows one collapsible
// card per celebrity/entity with its candidate grid, the duration-driven
// selection target, and per-card select / remove actions.
// In-app YouTube search picker. The user types a query, sees thumbnail results
// from the whole of YouTube + their reference channels, picks which entity a
// result belongs to, and clicks Add — the video is added directly (no quality
// filtering) to that entity's pool and auto-selected. This sits on top of the
// AI search so the user can hand-pick sources they know are correct.
function YoutubeSearchBox({
  projectId,
  entities,
  alreadyAddedIds,
  onAdded,
}: {
  projectId: string;
  entities: string[];
  alreadyAddedIds: Set<string>;
  onAdded: (entityValue: string, candidate: PreviewCandidate) => void;
}) {
  interface YtSearchResult {
    videoId: string;
    url: string;
    title: string;
    channelTitle: string;
    durationSeconds: number;
    thumbnailUrl: string;
    from_reference_channel: boolean;
  }

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<YtSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which entity each picked video should be assigned to. Defaults to the
  // first (main) entity; the user can change it per result before adding.
  const [entityFor, setEntityFor] = useState<string>(entities[0] ?? "");
  // Per-result add state so each button shows its own spinner/added tick.
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());

  const search = useMutation<{ results: YtSearchResult[] }, Error, string>({
    mutationFn: async (q) => {
      const r = await fetch(`/api/projects/${projectId}/analyze/search-youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Search failed (${r.status})`);
      return j;
    },
    onSuccess: (j) => { setResults(j.results); setError(null); },
    onError: (e) => { setError(e.message); setResults(null); },
  });

  async function addResult(res: YtSearchResult) {
    const target = entityFor || entities[0];
    if (!target) return;
    setAdding((cur) => new Set(cur).add(res.videoId));
    try {
      const r = await fetch(`/api/projects/${projectId}/analyze/add-source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl: res.url, entityValue: target, skipFilters: true }),
      });
      const j = await r.json();
      if (!r.ok || !j.accepted) {
        setError(j.reason ?? j.error ?? "Could not add this video.");
        return;
      }
      setAdded((cur) => new Set(cur).add(res.videoId));
      onAdded(target, j.candidate as PreviewCandidate);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding((cur) => { const n = new Set(cur); n.delete(res.videoId); return n; });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="h-4 w-4 text-brand-300" /> Search YouTube for sources
        </CardTitle>
        <CardDescription>
          Find and add source videos yourself — searches all of YouTube and your reference channels. Added videos skip the quality filters.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex items-stretch gap-2"
          onSubmit={(e) => { e.preventDefault(); const q = query.trim(); if (q) search.mutate(q); }}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. David Walliams BGT red carpet"
            disabled={search.isPending}
          />
          <Button type="submit" variant="gradient" disabled={!query.trim() || search.isPending}>
            {search.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search YouTube
          </Button>
        </form>

        {/* Entity assignment — which pool added videos go into. */}
        {entities.length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Add picks to:</span>
            <select
              value={entityFor}
              onChange={(e) => setEntityFor(e.target.value)}
              className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {entities.map((ev) => (
                <option key={ev} value={ev}>{ev}</option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {results && results.length === 0 && (
          <p className="text-sm text-fg-muted">No results for “{query}”.</p>
        )}

        {results && results.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {results.map((res) => (
              <SearchResultCard
                key={res.videoId}
                res={res}
                isAdded={added.has(res.videoId) || alreadyAddedIds.has(res.videoId)}
                isAdding={adding.has(res.videoId)}
                onAdd={() => addResult(res)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// One search-result card with inline click-to-play preview. Clicking the play
// overlay swaps the thumbnail for a YouTube iframe so the user can watch the
// video before adding it — mirrors the AI-search VideoCard's preview. Each card
// owns its own `playing` state so multiple previews can be open independently.
function SearchResultCard({
  res,
  isAdded,
  isAdding,
  onAdd,
}: {
  res: {
    videoId: string;
    url: string;
    title: string;
    channelTitle: string;
    durationSeconds: number;
    thumbnailUrl: string;
    from_reference_channel: boolean;
  };
  isAdded: boolean;
  isAdding: boolean;
  onAdd: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="group relative overflow-hidden rounded-[10px] border border-border bg-surface">
      <div className="relative aspect-video bg-bg-elevated">
        {playing ? (
          <iframe
            src={`https://www.youtube.com/embed/${res.videoId}?autoplay=1&rel=0&modestbranding=1`}
            title={res.title}
            className="h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={res.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => setPlaying(true)}
              className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="Preview video"
            >
              <span className="grid h-11 w-11 place-items-center rounded-full bg-white/95 text-black shadow-lg">
                <PlayCircle className="h-6 w-6" />
              </span>
            </button>
            {res.from_reference_channel && (
              <span className="absolute top-1.5 left-1.5 rounded bg-indigo-600/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                Reference channel
              </span>
            )}
            {res.durationSeconds > 0 && (
              <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">
                {fmtClock(res.durationSeconds)}
              </span>
            )}
          </>
        )}
      </div>
      <div className="p-2.5 space-y-1.5">
        <p className="line-clamp-2 text-xs font-medium leading-snug text-fg">{res.title}</p>
        <p className="truncate text-[11px] text-fg-muted">{res.channelTitle}</p>
        <Button
          type="button"
          size="sm"
          variant={isAdded ? "outline" : "soft"}
          className="w-full"
          disabled={isAdded || isAdding}
          onClick={onAdd}
        >
          {isAdding ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : isAdded ? <><Check className="h-3.5 w-3.5" /> Added</>
            : <><Plus className="h-3.5 w-3.5" /> Add source</>}
        </Button>
      </div>
    </div>
  );
}

// mm:ss clock for the search result thumbnails.
function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const r = String(Math.max(0, s % 60)).padStart(2, "0");
  return `${m}:${r}`;
}

function EntityPanel({
  entity,
  open,
  onToggle,
  selectedIds,
  removedIds,
  onToggleVideo,
  onRemoveVideo,
  onAddSource,
  addingSource,
}: {
  entity: EntityGroup;
  open: boolean;
  onToggle: () => void;
  selectedIds: Set<string>;
  removedIds: Set<string>;
  onToggleVideo: (videoId: string) => void;
  onRemoveVideo: (videoId: string) => void;
  onAddSource: (videoUrl: string) => Promise<{ accepted: boolean; reason?: string }>;
  addingSource: boolean;
}) {
  const visible = entity.candidates.filter((c) => !removedIds.has(c.videoId));
  const selectedCount = visible.filter((c) => selectedIds.has(c.videoId)).length;
  // Manual add-source state — one input per entity pool.
  const [addUrl, setAddUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between p-5 text-left hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg gradient-brand text-white text-sm font-semibold shadow-sm">
            {entity.value.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="text-base font-semibold truncate">{entity.value}</div>
            <div className="text-xs text-fg-muted capitalize">{entity.type.replace(/_/g, " ")}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Chip tone={selectedCount >= entity.target ? "keyword" : "person"}>
            {selectedCount} / {entity.target} selected
          </Chip>
          {open ? (
            <ChevronDown className="h-4 w-4 text-fg-muted" />
          ) : (
            <ChevronRight className="h-4 w-4 text-fg-muted" />
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border p-5">
          {/* Manual add-source. Paste a known-good YouTube URL to append it to
            this entity's pool; the backend runs the same rank + verify filters
            as the AI search and surfaces a rejection reason inline. */}
          <form
            className="mb-3 flex items-stretch gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const url = addUrl.trim();
              if (!url) return;
              setAddBusy(true);
              setAddError(null);
              try {
                const res = await onAddSource(url);
                if (res.accepted) setAddUrl("");
                else setAddError(res.reason ?? "Could not add this video.");
              } catch (err) {
                setAddError((err as Error).message);
              } finally {
                setAddBusy(false);
              }
            }}
          >
            <input
              type="url"
              value={addUrl}
              onChange={(e) => { setAddUrl(e.target.value); setAddError(null); }}
              placeholder={`Paste a YouTube URL to add a ${entity.value} source…`}
              className="flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-brand-500"
              disabled={addBusy || addingSource}
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={!addUrl.trim() || addBusy || addingSource}
            >
              {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add source"}
            </Button>
          </form>
          {addError && (
            <div className="mb-3 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{addError}</span>
            </div>
          )}
          {selectedCount < entity.target && visible.length >= entity.target && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              Select {entity.target} source{entity.target === 1 ? "" : "s"} for {entity.value} for the best footage coverage.
            </div>
          )}
          {visible.length === 0 ? (
            <EmptyState
              icon={<Search className="h-5 w-5" />}
              title="No source videos"
              description="Nothing found for this entity, or all were removed."
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((c) => (
                <div key={c.videoId} className="relative">
                  {/* Origin + footage-style badges + remove overlay. EVERY card
                    shows where it came from: Approved (previously approved for
                    this entity), Reference channel (one of the user's curated
                    channels), or YouTube (open whole-YouTube search). */}
                  <div className="absolute top-1.5 left-1.5 z-20 flex flex-wrap gap-1 max-w-[80%]">
                    {c.from_approved && (
                      <span className="rounded bg-emerald-600/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                        Approved
                      </span>
                    )}
                    {c.from_reference_channel && (
                      <span className="rounded bg-indigo-600/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                        Reference channel
                      </span>
                    )}
                    {!c.from_reference_channel && !c.from_approved && (
                      <span className="rounded bg-rose-600/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                        YouTube
                      </span>
                    )}
                    {c.footage_style === "show" && (
                      <span className="rounded bg-amber-600/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
                        Show footage
                      </span>
                    )}
                    {c.footage_style && !["show", "approved", "general", "interview"].includes(c.footage_style) && (
                      <span className="rounded bg-slate-700/90 px-1.5 py-0.5 text-[10px] font-medium capitalize text-white shadow-sm">
                        {c.footage_style}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveVideo(c.videoId)}
                    className="absolute bottom-1.5 left-1.5 z-20 rounded bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-danger/90 transition-colors"
                    aria-label="Remove (wrong person / unrelated)"
                    title="Remove this source (wrong person / unrelated)"
                  >
                    Remove
                  </button>
                  <VideoCard
                    videoId={c.videoId}
                    thumbnail={c.thumbnailUrl}
                    title={c.title}
                    channel={c.channelTitle}
                    durationSec={c.durationSeconds}
                    score={c.displayScore}
                    rawScore={c.score}
                    reasons={c.reasons}
                    sourceType={c.source_type}
                    selected={selectedIds.has(c.videoId)}
                    onToggle={() => onToggleVideo(c.videoId)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SegmentPanel({
  segment,
  open,
  onToggle,
  selectedIds,
  onToggleVideo,
  onAddSource,
  addingSource,
}: {
  segment: SegmentAnalysis;
  open: boolean;
  onToggle: () => void;
  selectedIds: Set<string>;
  onToggleVideo: (videoId: string) => void;
  onAddSource: (videoUrl: string) => Promise<{ accepted: boolean; reason?: string }>;
  addingSource: boolean;
}) {
  const u = segment.understanding;
  const segSelected = segment.candidates.filter((c) => selectedIds.has(c.videoId)).length;
  // Manual-add-source state. Lives inside SegmentPanel because each
  // segment has its own input — the user picks which segment a URL
  // belongs to by where they paste it.
  const [addUrl, setAddUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between p-5 text-left hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg gradient-brand text-white text-sm font-semibold shadow-sm">
            {segment.index + 1}
          </span>
          <div className="min-w-0">
            <div className="text-base font-semibold truncate">
              Part {segment.index + 1}{" "}
              <span className="text-fg-subtle font-normal">
                · {formatRange(segment.startSeconds, segment.endSeconds)}
              </span>
            </div>
            <div className="text-xs text-fg-muted truncate">{u.mainTopic}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Chip tone="keyword">
            {segSelected} / {segment.candidates.length} sources
          </Chip>
          {open ? (
            <ChevronDown className="h-4 w-4 text-fg-muted" />
          ) : (
            <ChevronRight className="h-4 w-4 text-fg-muted" />
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 px-5 pt-4 pb-1 text-xs">
            <SegStat label="Segment duration" value={fmtMinutes(segment.plan.durationSeconds)} />
            <SegStat label="Blocks" value={String(segment.plan.blockCount)} />
            <SegStat label="Footage needed" value={String(segment.plan.footageNeeded)} />
            <SegStat label="Images needed" value={String(segment.plan.imagesNeeded)} />
            <SegStat
              label="Clips ready"
              value={`${segment.plan.generatedClips} / ${segment.plan.requiredClips}`}
              warn={segment.plan.generatedClips < segment.plan.requiredClips}
            />
          </div>
          <Tabs defaultValue="understanding">
            <div className="px-5 pt-4">
              <TabsList>
                <TabsTrigger value="understanding">Understanding</TabsTrigger>
                <TabsTrigger value="queries">
                  Search queries ({u.searchIntents.length})
                </TabsTrigger>
                <TabsTrigger value="sources">Sources ({segment.candidates.length})</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="understanding" className="px-5 pb-5 space-y-4 mt-4">
              <SubjectHeader
                segmentSubject={u.segmentSubject}
                inheritedSubject={u.inheritedSubject}
                segmentTopic={u.segmentTopic}
              />
              <ChipGroup label="People" tone="person" values={u.people} />
              <ChipGroup label="Places" tone="place" values={u.places} />
              <ChipGroup label="Events" tone="topic" values={u.events} />
              <ChipGroup label="Topics" tone="topic" values={u.topics} />
              <ChipGroup label="Related keywords" tone="keyword" values={u.relatedKeywords} />
            </TabsContent>

            <TabsContent value="queries" className="px-5 pb-5 space-y-2 mt-4">
              {u.searchIntents.length === 0 ? (
                <p className="text-sm text-fg-muted">No queries yet.</p>
              ) : (
                u.searchIntents.map((it, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2.5 rounded-md border border-border bg-surface-2 p-3"
                  >
                    <Search className="mt-0.5 h-3.5 w-3.5 text-brand-300 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-fg">{it.label}</p>
                      <code className="text-xs text-fg-subtle break-all">{it.query}</code>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>

            <TabsContent value="sources" className="px-5 pb-5 mt-4">
              {/* Manual add-source input. Lets the editor paste a known-good
                YouTube URL and append it to this segment's candidate pool.
                The backend runs the same rank + verify filters as the AI
                search; a rejected URL surfaces the reason inline so the
                user can pick a different one. Sits above the candidate
                grid so it's always visible alongside the cards. */}
              <form
                className="mb-3 flex items-stretch gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const url = addUrl.trim();
                  if (!url) return;
                  setAddBusy(true);
                  setAddError(null);
                  try {
                    const res = await onAddSource(url);
                    if (res.accepted) {
                      setAddUrl("");
                    } else {
                      setAddError(res.reason ?? "Could not add this video.");
                    }
                  } catch (err) {
                    setAddError((err as Error).message);
                  } finally {
                    setAddBusy(false);
                  }
                }}
              >
                <input
                  type="url"
                  value={addUrl}
                  onChange={(e) => { setAddUrl(e.target.value); setAddError(null); }}
                  placeholder="Paste YouTube URL to add as a source…"
                  className="flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-brand-500"
                  disabled={addBusy || addingSource}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={!addUrl.trim() || addBusy || addingSource}
                >
                  {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add source"}
                </Button>
              </form>
              {addError && (
                <div className="mb-3 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>{addError}</span>
                </div>
              )}
              {segSelected < 3 && segment.candidates.length >= 3 && (
                <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  Fewer than 3 sources selected — visual variety may suffer.
                </div>
              )}
              {segment.candidates.length === 0 ? (
                <EmptyState
                  icon={<Search className="h-5 w-5" />}
                  title="No matches found"
                  description="Try editing the script — fewer named entities help search."
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {segment.candidates.map((c) => (
                    <VideoCard
                      key={c.videoId}
                      videoId={c.videoId}
                      thumbnail={c.thumbnailUrl}
                      title={c.title}
                      channel={c.channelTitle}
                      durationSec={c.durationSeconds}
                      score={c.displayScore}
                      rawScore={c.score}
                      reasons={c.reasons}
                      sourceType={c.source_type}
                      selected={selectedIds.has(c.videoId)}
                      onToggle={() => onToggleVideo(c.videoId)}
                    />
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}
    </Card>
  );
}

function SubjectHeader({
  segmentSubject,
  inheritedSubject,
  segmentTopic,
}: {
  segmentSubject?: string;
  inheritedSubject?: boolean;
  segmentTopic?: string;
}) {
  // Older payloads predate this surface — keep the tab tidy by rendering
  // nothing when neither field is populated.
  if (!segmentSubject && !segmentTopic) return null;
  return (
    <div className="rounded-md border border-border bg-surface-2 p-3 space-y-2">
      {segmentSubject ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">Segment subject</div>
          <div className="mt-0.5 flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-fg">{segmentSubject}</span>
            {inheritedSubject ? (
              <Chip tone="keyword">inherited from project topic</Chip>
            ) : null}
          </div>
        </div>
      ) : null}
      {segmentTopic ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">Segment topic</div>
          <div className="mt-0.5 text-sm text-fg">{segmentTopic}</div>
        </div>
      ) : null}
    </div>
  );
}

function ChipGroup({
  label,
  tone,
  values,
}: {
  label: string;
  tone: "person" | "place" | "topic" | "keyword";
  values: string[];
}) {
  if (!values || values.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-fg-subtle uppercase tracking-wider">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <Chip key={v} tone={tone}>
            {v}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function StickyConfirmBar({
  selected,
  loading,
  done,
  onConfirm,
}: {
  selected: number;
  loading: boolean;
  done: boolean;
  onConfirm: () => void;
}) {
  return (
    <div className="sticky bottom-0 -mx-6 lg:-mx-8 mt-6 px-6 lg:px-8 py-3 border-t border-border bg-bg-elevated/90 backdrop-blur supports-[backdrop-filter]:bg-bg-elevated/60">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-fg-muted">
          <span className="font-semibold text-fg tabular-nums">{selected}</span> source
          {selected === 1 ? "" : "s"} selected — only these will be downloaded.
        </p>
        <Button
          variant="gradient"
          size="lg"
          disabled={selected === 0 || loading || done}
          onClick={onConfirm}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {done ? "Confirmed" : loading ? "Confirming…" : "Confirm & start processing"}
        </Button>
      </div>
    </div>
  );
}

function formatRange(startSec: number, endSec: number): string {
  return `${Math.floor(startSec / 60)}–${Math.floor(endSec / 60)} min`;
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  PlayCircle,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { StepCard, type StepState } from "@/components/ui/step-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VideoCard } from "@/components/ui/video-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fmtMinutes } from "../_shared";

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

interface AnalyzeResponse {
  projectId: string;
  totalDurationSeconds: number;
  voiceoverDurationSeconds: number;
  estimatedDurationSeconds: number;
  wordCount: number;
  plan: TimelinePlanSummary;
  segments: SegmentAnalysis[];
}

type Phase = "idle" | "understanding" | "segmenting" | "searching" | "results" | "confirming" | "done" | "error";

const STEPS = [
  { key: "understanding" as const, label: "Understanding content", icon: Sparkles },
  { key: "segmenting" as const, label: "Breaking into parts", icon: Layers },
  { key: "searching" as const, label: "Finding source videos", icon: Search },
  { key: "results" as const, label: "Ready for review", icon: PlayCircle },
];

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

  // Hydrate from the saved analyze job so re-visiting the screen doesn't
  // wipe and re-run Gemini + YouTube search. The POST handler persists the
  // full AnalyzeResponse in media_jobs.metadata.payload.
  const savedQ = useQuery<{ payload: AnalyzeResponse | null }>({
    queryKey: ["analyze", projectId],
    queryFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/analyze`);
      if (!r.ok) throw new Error(`load analyze: ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
  });

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
      const initial = new Set<string>();
      for (const seg of d.segments) {
        for (const c of seg.candidates.slice(0, 5)) initial.add(c.videoId);
      }
      setSelected(initial);
      setOpenSegments(new Set([0]));
      setPhase("results");
      // Refresh the saved-payload cache so a future remount re-hydrates from
      // the new run instead of the previous one.
      qc.setQueryData(["analyze", projectId], { payload: d });
    },
    onError: (e) => {
      setError(e.message);
      setPhase("error");
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
    if (saved) {
      // Rehydrate prior results — no Gemini/YouTube spend on re-visit.
      setData(saved);
      const initial = new Set<string>();
      for (const seg of saved.segments) {
        for (const c of seg.candidates.slice(0, 5)) initial.add(c.videoId);
      }
      setSelected(initial);
      setOpenSegments(new Set([0]));
      setPhase("results");
      return;
    }
    if (autoStart) runAnalyze.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, savedQ.isLoading, savedQ.data]);

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
      <div className="max-w-3xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand-300" /> Analyze &amp; Search
            </CardTitle>
            <CardDescription>
              We&apos;ll read your content, break it into parts, and find source videos for each part. You confirm the sources before anything is downloaded.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="gradient" size="lg" onClick={() => runAnalyze.mutate()}>
              <Sparkles className="h-4 w-4" /> Analyze &amp; Search
            </Button>
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
          <SummaryStrip
            durationSec={totals.durationSec}
            segmentCount={totals.segments}
            selected={totals.selected}
            plan={data.plan}
          />

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
              />
            ))}
          </div>

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
  plan,
}: {
  durationSec: number;
  segmentCount: number;
  selected: number;
  plan: TimelinePlanSummary;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Voiceover duration" value={fmtMinutes(durationSec)} />
        <Stat label="Parts" value={String(segmentCount)} />
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

function SegmentPanel({
  segment,
  open,
  onToggle,
  selectedIds,
  onToggleVideo,
}: {
  segment: SegmentAnalysis;
  open: boolean;
  onToggle: () => void;
  selectedIds: Set<string>;
  onToggleVideo: (videoId: string) => void;
}) {
  const u = segment.understanding;
  const segSelected = segment.candidates.filter((c) => selectedIds.has(c.videoId)).length;

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
                      thumbnail={c.thumbnailUrl}
                      title={c.title}
                      channel={c.channelTitle}
                      durationSec={c.durationSeconds}
                      score={c.displayScore}
                      rawScore={c.score}
                      reasons={c.reasons}
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

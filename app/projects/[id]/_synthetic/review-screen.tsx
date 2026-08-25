"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { RefreshCw, Trash2, Save, Film, Sparkles, Volume2, Loader2, Play, Maximize2, Images, History, RotateCcw, Recycle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { SyntheticResp, SyntheticSegmentRow, AssetVersion } from "./types";

const BLOCK_TYPES = ["avatar", "image", "ai_clip", "split_2"] as const;

// STEP: review the planned timeline before render. Per-block: thumbnail,
// prompt, script, type; actions Regenerate / Change Type / Edit Prompt /
// Delete. A "Render" action kicks off the existing render pipeline.
export function SyntheticReviewScreen({
  projectId,
  resp,
  onChange,
  onGoToRender,
}: {
  projectId: string;
  resp: SyntheticResp;
  onChange: () => void;
  // Navigate to the render step (parent owns step routing). Used when a render
  // is already in flight: the Render button becomes "View render" instead of
  // POSTing a second render the route would 409 with "render already in progress".
  onGoToRender?: () => void;
}) {
  const segs = resp.segments ?? [];
  // Two gates share this screen:
  //   plan_ready        -> review the PLAN, click Generate to produce assets
  //   ready_for_review  -> assets generated, click Render to assemble the video
  const isPlanGate = resp.project.status === "plan_ready";

  const generate = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/synthetic/generate-assets`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).error ?? `generate failed (${r.status})`);
    },
    onSuccess: onChange,
  });

  // Re-run ONLY the planner against the existing voiceover — re-segments the
  // script (e.g. after fixing avatar marks) WITHOUT regenerating the voiceover.
  // Rebuilds the segment list, so it discards per-segment edits + any generated
  // assets; we confirm before firing.
  const replan = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/synthetic/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "planner" }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `re-plan failed (${r.status})`);
    },
    onSuccess: onChange,
  });

  const render = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/render`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).error ?? `render failed (${r.status})`);
    },
    onSuccess: onChange,
  });

  // Bulk-retry every FAILED segment in one click. dispatchSegments fans them
  // all out at once, so the worker renders them in parallel (up to
  // IMAGE_GEN_CONCURRENCY) instead of the user clicking Retry per row.
  const regenerateAll = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/synthetic/regenerate-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "failed" }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `regenerate failed (${r.status})`);
    },
    onSuccess: onChange,
  });

  // Bulk-retry every STUCK segment: one whose status is 'generating' but whose
  // render already died (its latest job is terminal) so it will never advance on
  // its own. Without this the block spins forever with no Retry affordance —
  // it's neither 'failed' (so "Retry all failed" skips it) nor actually in
  // flight. Server-side "stuck" scope re-checks the job so a live render is never
  // clobbered.
  const regenerateStuck = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/synthetic/regenerate-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "stuck" }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `regenerate failed (${r.status})`);
    },
    onSuccess: onChange,
  });

  // Regenerate EVERY image-bearing block (image / ai_clip / split_2) against the
  // CURRENT prompts — even ones already 'ready'. This re-runs the image
  // generation with the latest STYLE_PROMPT, so a prompt change (e.g. the
  // no-text / single-subject rules) can be tested on THIS project without
  // re-planning or creating a new one. Avatars are left as-is (client likes
  // them; re-rendering them is slow). Destructive of existing images, so confirm.
  const regenerateImages = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/synthetic/regenerate-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "images" }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `regenerate images failed (${r.status})`);
    },
    onSuccess: onChange,
  });
  const onRegenerateImages = () => {
    if (confirm("Regenerate ALL images (image, animation, and split blocks) against the current prompts? This re-creates every image — including ones already generated — so the latest prompt changes take effect. Avatars are kept. Continue?")) {
      regenerateImages.mutate();
    }
  };

  // Three states share this one screen (the user never leaves it during asset
  // generation):
  //   plan_ready        -> review the plan, click "Generate assets"
  //   generating_*      -> assets in flight; per-segment status shown inline,
  //                        with per-row Retry on any failed block
  //   ready_for_review  -> every block ready; click "Render video"
  const isGenerating =
    resp.project.status === "generating_images" ||
    resp.project.status === "generating_clips" ||
    resp.project.status === "generating_avatars";
  // A render is already running for this project. The render route refuses a
  // second one (409 "render already in progress"), so when the user steps back
  // here mid-render we offer navigation to the render step instead of a re-POST.
  //
  // This reads render_jobs — the EXACT table (and statuses) the route's 409
  // guard queries — so the button we show can never contradict what the route
  // will do. Deriving it from media_jobs + project.status instead is what
  // produced the dead-end: a render whose processor died before its first DB
  // write left a queued render_jobs row (permanent 409) while project.status sat
  // at ready_for_review and the media_job at 'queued', so this screen offered a
  // plain "Render video" button that could only ever fail. Zombie render_jobs
  // rows are now cleared by sweepZombieRenderJobs (worker/reconcile.ts), which
  // turns this back into a real "Render video" within a sweep interval.
  const hasLiveRender = (resp.render_jobs ?? []).some(
    (j) => j.status === "queued" || j.status === "running",
  );
  const isRendering = hasLiveRender;
  // Stuck: status says rendering but the render job is dead/cancelled (e.g.
  // manually cancelled on the fly.io worker). Nothing live to "view", and the
  // route accepts a re-POST — so offer a real re-render.
  const isStuckRendering = resp.project.status === "rendering" && !hasLiveRender;
  const generatingCount = segs.filter((s) => s.status === "generating" || s.status === "pending").length;
  const failedCount = segs.filter((s) => s.status === "failed").length;
  const allReady = segs.length > 0 && segs.every((s) => s.status === "ready" || s.status === "skipped");

  // Stuck segments: 'generating' but their render already died. A segment is
  // stuck when its status is 'generating' AND its latest linked media_job is
  // terminal (failed/completed) — no live job will ever advance it, so the row
  // would otherwise spin forever with no Retry. Computed here from media_jobs so
  // both the toolbar "Retry all stuck" button and each SegmentRow can react.
  const stuckSegmentIds = computeStuckSegmentIds(segs, resp.media_jobs);
  const stuckCount = stuckSegmentIds.size;

  // Re-plan is available in ALL states (not just the plan gate) — re-segmenting
  // is useful even after generation started (e.g. to fix avatar marks). It
  // discards the current plan + generated assets, so it always confirms.
  const onReplan = () => {
    if (confirm("Re-plan re-segments the script from scratch and discards the current plan, edits, and any generated assets. The voiceover is kept. Continue?")) {
      replan.mutate();
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-fg">
            {isPlanGate ? "Review plan" : isGenerating ? "Generating assets" : isRendering ? "Rendering video" : "Review timeline"}
          </h2>
          <p className="text-xs text-fg-subtle">
            {segs.length} blocks{isPlanGate
              ? " · edit types/prompts before generating"
              : ` · ${resp.summary.ready} ready · ${resp.summary.failed} failed${isGenerating ? ` · ${generatingCount} generating` : ""}${stuckCount > 0 ? ` · ${stuckCount} stuck` : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Bulk-retry all failed blocks at once (renders in parallel). Shown
              outside the plan gate whenever there's at least one failure. */}
          {!isPlanGate && failedCount > 0 && (
            <Button type="button" variant="gradient" size="sm" disabled={regenerateAll.isPending} onClick={() => regenerateAll.mutate()}>
              <RefreshCw className={`h-4 w-4 ${regenerateAll.isPending ? "animate-spin" : ""}`} />
              {regenerateAll.isPending ? "Retrying…" : `Retry all failed (${failedCount})`}
            </Button>
          )}
          {/* Bulk-retry blocks stuck at 'generating' whose render died (latest
              job terminal). These aren't 'failed', so the button above skips
              them — without this they'd spin forever and keep the Render button
              disabled. Shown outside the plan gate whenever any block is stuck. */}
          {!isPlanGate && stuckCount > 0 && (
            <Button type="button" variant="gradient" size="sm" disabled={regenerateStuck.isPending} onClick={() => regenerateStuck.mutate()}>
              <RefreshCw className={`h-4 w-4 ${regenerateStuck.isPending ? "animate-spin" : ""}`} />
              {regenerateStuck.isPending ? "Retrying…" : `Retry all stuck (${stuckCount})`}
            </Button>
          )}
          {/* Regenerate all images against the current prompts — re-tests a
              prompt/STYLE_PROMPT change on this project without re-planning or a
              new project. Shown outside the plan gate (once images exist). */}
          {!isPlanGate && (
            <Button type="button" variant="soft" size="sm" disabled={regenerateImages.isPending} onClick={onRegenerateImages}>
              <Images className={`h-4 w-4 ${regenerateImages.isPending ? "animate-spin" : ""}`} />
              {regenerateImages.isPending ? "Regenerating…" : "Regenerate all images"}
            </Button>
          )}
          {/* Re-plan: always available, re-runs only the planner. */}
          <Button type="button" variant="soft" size="sm" disabled={replan.isPending} onClick={onReplan}>
            <RefreshCw className={`h-4 w-4 ${replan.isPending ? "animate-spin" : ""}`} /> Re-plan
          </Button>
        {isPlanGate ? (
            <Button type="button" variant="gradient" disabled={segs.length === 0 || generate.isPending} onClick={() => generate.mutate()}>
              <Sparkles className="h-4 w-4" /> {generate.isPending ? "Starting…" : "Generate assets"}
            </Button>
        ) : isGenerating ? (
          // Still generating — no primary action; the per-segment rows show
          // live status and offer Retry on failures. A Refresh keeps it live
          // even if polling lapses.
          <Button type="button" variant="ghost" size="sm" onClick={onChange}>
            <RefreshCw className="h-4 w-4 animate-spin" /> Generating…
          </Button>
        ) : isRendering ? (
          // A render is already in flight. Don't re-POST (the route 409s) —
          // send the user to the render step to watch progress / download.
          <Button type="button" variant="gradient" onClick={() => onGoToRender?.()}>
            <Film className="h-4 w-4" /> View render
          </Button>
        ) : isStuckRendering ? (
          // status is "rendering" but the render job is dead/cancelled (e.g.
          // stuck on the fly.io worker). Offer a real re-render — /render accepts
          // it since no render_job is queued/running.
          <Button type="button" variant="gradient" disabled={render.isPending} onClick={() => render.mutate()}>
            <Film className="h-4 w-4" /> {render.isPending ? "Starting render…" : "Re-render video"}
          </Button>
        ) : (
          <Button type="button" variant="gradient" disabled={!allReady || render.isPending} onClick={() => render.mutate()}>
            <Film className="h-4 w-4" /> {render.isPending ? "Starting render…" : "Render video"}
          </Button>
        )}
        </div>
      </div>
      {generate.error && <p className="text-xs text-danger">{(generate.error as Error).message}</p>}
      {render.error && <p className="text-xs text-danger">{(render.error as Error).message}</p>}
      {replan.error && <p className="text-xs text-danger">{(replan.error as Error).message}</p>}
      {regenerateAll.error && <p className="text-xs text-danger">{(regenerateAll.error as Error).message}</p>}
      {regenerateStuck.error && <p className="text-xs text-danger">{(regenerateStuck.error as Error).message}</p>}
      {regenerateImages.error && <p className="text-xs text-danger">{(regenerateImages.error as Error).message}</p>}

      {/* Master voiceover — listen before committing to asset generation/render. */}
      {resp.project.voiceover_url && (
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <Volume2 className="h-4 w-4 text-brand-300 shrink-0" />
            <audio src={resp.project.voiceover_url} controls preload="metadata" className="w-full h-9" />
          </CardContent>
        </Card>
      )}

      {/* Sales-pitch video (read-only). Not a planned segment — it's spliced
          into the timeline at render time near the insert mark, with the
          narration pausing over it. Shown here so the user can see/confirm it's
          included and where it lands. Edit/remove it back on the Intake step. */}
      {resp.project.pitch_video_url && (
        <Card className="border-brand-300/40">
          <CardContent className="p-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2 sm:w-56 shrink-0">
              <Film className="h-4 w-4 text-brand-300 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Sales pitch video</p>
                <p className="text-[11px] text-fg-subtle">
                  Inserted at ~{fmtClock(resp.project.pitch_video_insert_seconds ?? 180)}
                  {resp.project.pitch_video_duration_seconds
                    ? ` · ${fmtClock(resp.project.pitch_video_duration_seconds)} long`
                    : ""}
                  {" "}· narration pauses, plays its own audio
                </p>
              </div>
            </div>
            <video
              src={resp.project.pitch_video_url}
              controls
              preload="metadata"
              className="w-full max-w-sm rounded-[10px] border border-border bg-black"
            />
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {segs.map((s) => (
          <SegmentRow key={s.id} projectId={projectId} segment={s} isStuck={stuckSegmentIds.has(s.id)} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}

function thumbUrl(s: SyntheticSegmentRow): string | null {
  return s.image_url ?? s.right_image_url ?? null;
}

// A media_job that can no longer advance its segment. queued/running are still
// live (an in-flight render kept fresh by the server's heartbeat), so a segment
// waiting on one is NOT stuck.
const TERMINAL_JOB_STATUSES = new Set(["failed", "completed"]);

// Ids of segments stuck at 'generating' whose render already died: status is
// 'generating' but the LATEST linked media_job is terminal, so nothing will ever
// flip the segment to 'ready'/'failed'. Mirrors the server's "stuck" scope so the
// UI shows the same set the bulk-retry acts on. A generating segment with a live
// job — or none yet — is not stuck.
function computeStuckSegmentIds(
  segments: SyntheticSegmentRow[],
  mediaJobs: SyntheticResp["media_jobs"],
): Set<string> {
  const generating = segments.filter((s) => s.status === "generating");
  if (generating.length === 0) return new Set();

  // Pick each segment's newest job by COMPARING created_at rather than trusting
  // arrival order. The route sends jobs ascending, but relying on that made this
  // silently wrong the moment the list was clipped by PostgREST's max-rows: the
  // "last" entry for a segment was then an old dead job, not its live one, and
  // every affected block rendered as stuck. The route pages properly now; this
  // comparison means a future ordering change can't resurrect that bug.
  const latestBySegment = new Map<string, { status: string; at: number }>();
  for (const j of mediaJobs) {
    const segId = (j.metadata as { segmentId?: string } | null)?.segmentId;
    if (!segId) continue;
    const at = Date.parse(j.created_at);
    const prev = latestBySegment.get(segId);
    // NaN (a malformed/absent created_at) loses to any real timestamp but still
    // seeds an empty slot, so such a job is never silently dropped.
    if (!prev || (Number.isFinite(at) && !(at < prev.at))) {
      latestBySegment.set(segId, { status: j.status, at: Number.isFinite(at) ? at : -Infinity });
    }
  }

  const stuck = new Set<string>();
  for (const s of generating) {
    const latest = latestBySegment.get(s.id);
    if (latest !== undefined && TERMINAL_JOB_STATUSES.has(latest.status)) stuck.add(s.id);
  }
  return stuck;
}

// Seconds -> "m:ss" for the pitch-video card.
function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// One previous-version tile in a segment's history: a thumbnail (image) or a
// small inline player (video), with a Restore button. Clicking a still opens a
// full-size preview; videos play inline.
function HistoryVersion({
  version,
  label,
  restoring,
  onRestore,
}: {
  version: AssetVersion;
  label: string;
  restoring: boolean;
  onRestore: () => void;
}) {
  const [preview, setPreview] = useState(false);
  const img = version.image_url ?? version.right_image_url ?? null;
  const vid = version.video_url ?? null;
  return (
    <div className="w-28 shrink-0 space-y-1">
      <div className="relative aspect-video overflow-hidden rounded border border-border bg-black">
        {vid ? (
          <video src={vid} className="h-full w-full object-cover" muted preload="metadata" controls />
        ) : img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={label}
            className="h-full w-full cursor-pointer object-cover"
            onClick={() => setPreview(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-fg-subtle">no asset</div>
        )}
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] text-fg-subtle tabular-nums">{label}</span>
        <Button type="button" variant="ghost" size="xs" disabled={restoring} onClick={onRestore} title="Make this version the active one">
          <RotateCcw className={`h-3 w-3 ${restoring ? "animate-spin" : ""}`} /> Restore
        </Button>
      </div>
      {img && preview && (
        <Dialog open={preview} onOpenChange={setPreview}>
          <DialogContent className="max-w-3xl">
            <DialogTitle>Previous version — {label}</DialogTitle>
            <DialogDescription className="sr-only">A previously generated asset for this segment</DialogDescription>
            <div className="overflow-hidden rounded-md border border-border bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img} alt={label} className="max-h-[70vh] w-full object-contain bg-black" />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function SegmentRow({
  projectId,
  segment,
  isStuck,
  onChange,
}: {
  projectId: string;
  segment: SyntheticSegmentRow;
  // 'generating' but its render already died (latest job terminal). Rendered as
  // a retryable dead state instead of an endless spinner.
  isStuck: boolean;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // split_2 has BOTH an avatar video and a right-half image. The main preview
  // shows the avatar video; this separate state opens the right image so it can
  // be reviewed too (previously the image half had no preview at all).
  const [previewingImage, setPreviewingImage] = useState(false);
  const [blockType, setBlockType] = useState(segment.block_type);
  const [imagePrompt, setImagePrompt] = useState(segment.image_prompt ?? "");
  const [animationPrompt, setAnimationPrompt] = useState(segment.animation_prompt ?? "");
  const [script, setScript] = useState(segment.script);

  const base = `/api/projects/${projectId}/synthetic/segments/${segment.id}`;

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockType, imagePrompt, animationPrompt, script }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "save failed");
    },
    onSuccess: () => { setEditing(false); onChange(); },
  });
  const regenerate = useMutation({
    mutationFn: async () => { await fetch(base, { method: "POST" }); },
    onSuccess: onChange,
  });
  // split_2 only: regenerate ONLY the right-half image, keeping the avatar video
  // (no HeyGen re-render). The full Regenerate above redoes both.
  const regenerateImage = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${base}?imageOnly=1`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).error ?? `regenerate image failed (${r.status})`);
    },
    onSuccess: onChange,
  });
  // Regenerate ONLY the AI image prompt for this segment (re-runs Gemini for
  // this block's script with the single-subject/no-text rules). Does not rebuild
  // the image — the user reviews the new prompt, then clicks Regenerate.
  const regeneratePrompt = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${base}/regenerate-prompt`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).error ?? `regenerate prompt failed (${r.status})`);
    },
    onSuccess: onChange,
  });
  const del = useMutation({
    mutationFn: async () => { await fetch(base, { method: "DELETE" }); },
    onSuccess: onChange,
  });
  // Restore a previous asset version (history). index = position in asset_history.
  const restore = useMutation({
    mutationFn: async (index: number) => {
      const r = await fetch(`${base}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `restore failed (${r.status})`);
    },
    onSuccess: onChange,
  });
  const [showHistory, setShowHistory] = useState(false);
  const history = segment.asset_history ?? [];

  const thumb = thumbUrl(segment);
  // Reused-from-library marker (worker sets segment.metadata.reused on a library
  // hit). Drives the "Reused" badge below. Narrowed from the loose metadata bag.
  const reused = segment.metadata?.reused;
  // A stuck segment is 'generating' in the DB but its render is dead — surface it
  // like a failure (destructive badge, "stuck" label, Retry) rather than a live
  // spinner. isSpinning is the genuine in-flight case (generating, not stuck).
  const isSpinning = segment.status === "generating" && !isStuck;
  const statusVariant =
    segment.status === "ready" ? "success"
      : segment.status === "failed" || isStuck ? "destructive"
        : segment.status === "generating" ? "info"
          : "secondary";
  const isGenerating = isSpinning;
  const isFailed = segment.status === "failed";
  // Every segment type can be reviewed at full size: video blocks (avatar /
  // ai_clip) play their mp4; image blocks enlarge the still. The thumbnail is
  // the click target whenever ANY asset exists — previously only video_url
  // segments got a preview, leaving image blocks with no way to inspect them.
  const previewKind: "video" | "image" | null = segment.video_url
    ? "video"
    : thumb
      ? "image"
      : null;
  // For split_2, the right-half IMAGE is separate from the avatar video. Expose
  // it as its own preview so both halves are reviewable. (For non-split blocks
  // the image IS the main asset and already previews via previewKind.)
  const splitRightImage =
    segment.block_type === "split_2" ? (segment.right_image_url ?? null) : null;

  return (
    <Card className={isFailed || isStuck ? "border-danger/40" : undefined}>
      <CardContent className="flex gap-4 p-3">
        {/* Thumbnail — click to review the asset (video or still) in a dialog. */}
        {previewKind ? (
          <button
            type="button"
            onClick={() => setPreviewing(true)}
            className="group relative h-20 w-32 shrink-0 rounded-[8px] overflow-hidden border border-border bg-bg-elevated grid place-items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            aria-label={previewKind === "video" ? "Play video preview" : "View image preview"}
          >
            {previewKind === "video" ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video src={segment.video_url!} className="h-full w-full object-cover" muted preload="metadata" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumb!} alt="" className="h-full w-full object-cover" />
            )}
            <span className="absolute inset-0 grid place-items-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100">
              {previewKind === "video" ? (
                <Play className="h-6 w-6 text-white drop-shadow" fill="currentColor" />
              ) : (
                <Maximize2 className="h-5 w-5 text-white drop-shadow" />
              )}
            </span>
          </button>
        ) : (
          <div className="h-20 w-32 shrink-0 rounded-[8px] overflow-hidden border border-border bg-bg-elevated grid place-items-center">
            {isGenerating ? (
              <Loader2 className="h-5 w-5 animate-spin text-brand-300" />
            ) : isFailed ? (
              <span className="text-[10px] text-danger">failed</span>
            ) : isStuck ? (
              <span className="text-[10px] text-danger">stuck</span>
            ) : (
              <span className="text-[10px] text-fg-subtle">no preview</span>
            )}
          </div>
        )}

        {/* split_2 right-image preview dialog. The thumbnail above shows the
            avatar video; this lets the user also inspect the image half. The
            trigger button lives in the action row below. */}
        {splitRightImage && previewingImage && (
          <Dialog open={previewingImage} onOpenChange={setPreviewingImage}>
            <DialogContent className="max-w-3xl">
              <DialogTitle>Image half — #{segment.position + 1} split</DialogTitle>
              <DialogDescription className="sr-only">
                Generated right-half image for split segment #{segment.position + 1}
              </DialogDescription>
              <div className="overflow-hidden rounded-md border border-border bg-black">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={splitRightImage} alt="" className="max-h-[70vh] w-full object-contain bg-black" />
              </div>
            </DialogContent>
          </Dialog>
        )}

        {/* Preview dialog — full controls for video; full-size still for image. */}
        {previewKind && (
          <Dialog open={previewing} onOpenChange={setPreviewing}>
            <DialogContent className="max-w-3xl">
              <DialogTitle>
                Preview — #{segment.position + 1} {segment.block_type}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {previewKind === "video"
                  ? `Rendered video for segment #${segment.position + 1}`
                  : `Generated image for segment #${segment.position + 1}`}
              </DialogDescription>
              <div className="overflow-hidden rounded-md border border-border bg-black">
                {previewKind === "video" ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video
                    src={segment.video_url!}
                    className="max-h-[70vh] w-full bg-black"
                    controls
                    autoPlay
                    preload="metadata"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumb!} alt="" className="max-h-[70vh] w-full object-contain bg-black" />
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}

        <div className="flex-1 min-w-0 space-y-2">
          {/* Meta line: identity + status only. Actions moved to their own row
              below so the many per-type buttons (esp. split_2) no longer cram
              onto the same line and overflow. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs tabular-nums text-fg-subtle">#{segment.position + 1}</span>
            <Badge variant="outline">{segment.block_type}</Badge>
            <Badge variant={statusVariant as "success" | "destructive" | "info" | "secondary"}>{isStuck ? "stuck" : segment.status}</Badge>
            {/* Reused-from-library badge (migration 0030): this asset was fetched
                from a prior generation instead of being generated fresh — a cost
                saving. Shows the match type + similarity so the reuse is auditable. */}
            {reused && (
              <Badge
                variant="success"
                className="gap-1"
                title={`Fetched from the asset library (${reused.via} match, ${(reused.similarity * 100).toFixed(1)}% similar) instead of generating — no provider cost.`}
              >
                <Recycle className="h-3 w-3" /> Reused
              </Badge>
            )}
            <span className="text-[11px] text-fg-subtle tabular-nums">{segment.duration.toFixed(1)}s</span>
            {segment.provider && <span className="text-[11px] text-fg-subtle">via {segment.provider}</span>}
          </div>

          {/* Action row: wraps on its own line, so buttons flow instead of
              overflowing the header. Delete is pushed to the far right. */}
          <div className="flex flex-wrap items-center gap-1">
            {/* split_2: a quick way to inspect the IMAGE half (the thumbnail
                shows the avatar video). */}
            {splitRightImage && (
              <Button type="button" variant="ghost" size="xs" onClick={() => setPreviewingImage(true)} title="Preview the image half">
                <Images className="h-3.5 w-3.5" /> View image
              </Button>
            )}
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : "Edit"}</Button>
            {/* AI-regenerate this segment's image prompt (Gemini rewrites the
                scene with the single-subject/no-text rules). Non-avatar only —
                avatars have no image prompt. Rewrites the prompt only; click
                Regenerate after to rebuild the image. */}
            {segment.block_type !== "avatar" && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={regeneratePrompt.isPending || isGenerating}
                onClick={() => regeneratePrompt.mutate()}
                title="Re-run AI to rewrite this segment's image prompt"
              >
                <Sparkles className={`h-3.5 w-3.5 ${regeneratePrompt.isPending ? "animate-spin" : ""}`} />
                {regeneratePrompt.isPending ? "Rewriting…" : "Regenerate prompt"}
              </Button>
            )}
            {/* split_2 only: regenerate just the right image, keep the avatar
                video. The full Regenerate to the right redoes BOTH (incl. a
                HeyGen avatar render). */}
            {segment.block_type === "split_2" && (
              <Button
                type="button"
                variant="soft"
                size="xs"
                disabled={regenerateImage.isPending || isGenerating}
                onClick={() => regenerateImage.mutate()}
                title="Regenerate only the image half (keep the avatar video)"
              >
                <Images className={`h-3.5 w-3.5 ${regenerateImage.isPending ? "animate-spin" : ""}`} />
                {regenerateImage.isPending ? "Image…" : "Regenerate image"}
              </Button>
            )}
            <Button
              type="button"
              variant={isFailed || isStuck ? "gradient" : "soft"}
              size="xs"
              disabled={regenerate.isPending || isGenerating}
              onClick={() => regenerate.mutate()}
              title={
                isStuck
                  ? "This block's render died — retry it"
                  : segment.block_type === "split_2"
                    ? "Regenerate the avatar video AND the image"
                    : undefined
              }
            >
              <RefreshCw className={`h-3.5 w-3.5 ${regenerate.isPending ? "animate-spin" : ""}`} />
              {isFailed || isStuck ? "Retry" : segment.block_type === "split_2" ? "Regenerate all" : "Regenerate"}
            </Button>
            <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => del.mutate()} disabled={del.isPending} title="Delete this block">
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </Button>
          </div>

          {editing ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-xs text-fg-muted">Type</label>
                <select
                  value={blockType}
                  onChange={(e) => setBlockType(e.target.value as typeof blockType)}
                  className="rounded-md border border-border bg-surface px-2 h-7 text-xs text-fg"
                >
                  {BLOCK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <Textarea value={script} onChange={(e) => setScript(e.target.value)} rows={2} placeholder="Script" />
              {blockType !== "avatar" && (
                <Textarea value={imagePrompt} onChange={(e) => setImagePrompt(e.target.value)} rows={2} placeholder="Image prompt" />
              )}
              {blockType === "ai_clip" && (
                <Textarea value={animationPrompt} onChange={(e) => setAnimationPrompt(e.target.value)} rows={2} placeholder="Animation prompt" />
              )}
              <Button type="button" variant="gradient" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                <Save className="h-4 w-4" /> Save changes
              </Button>
              <p className="text-[11px] text-fg-subtle">After saving, click Regenerate to rebuild this block&apos;s asset.</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-fg-muted line-clamp-2">{segment.script || <span className="text-fg-subtle">no script</span>}</p>
              {segment.image_prompt && <p className="text-[11px] text-fg-subtle line-clamp-1">🖼 {segment.image_prompt}</p>}
              {regeneratePrompt.error && <p className="text-[11px] text-danger line-clamp-1">{(regeneratePrompt.error as Error).message}</p>}
              {regenerateImage.error && <p className="text-[11px] text-danger line-clamp-1">{(regenerateImage.error as Error).message}</p>}
              {restore.error && <p className="text-[11px] text-danger line-clamp-1">{(restore.error as Error).message}</p>}
              {segment.error && <p className="text-[11px] text-danger line-clamp-1">{segment.error}</p>}
              {/* Stuck-but-no-error: the render died without writing an error onto
                  the segment (e.g. a regen job that exhausted its retries). Tell
                  the user why it's not spinning and that Retry will requeue it. */}
              {isStuck && !segment.error && (
                <p className="text-[11px] text-danger line-clamp-2">
                  Stuck — its render stopped without finishing. Click Retry to requeue this block.
                </p>
              )}

              {/* Previous versions. Each regenerate archives the prior asset here
                  (newest last), so the user can preview and restore an old one. */}
              {history.length > 0 && (
                <div className="pt-1">
                  <Button type="button" variant="ghost" size="xs" onClick={() => setShowHistory((v) => !v)}>
                    <History className="h-3.5 w-3.5" /> {showHistory ? "Hide" : "Show"} previous versions ({history.length})
                  </Button>
                  {showHistory && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {/* Render newest-first for review. The API index is the
                          ORIGINAL position in asset_history, so map back. */}
                      {history.map((v, origIdx) => ({ v, origIdx }))
                        .slice()
                        .reverse()
                        .map(({ v, origIdx }) => (
                          <HistoryVersion
                            key={origIdx}
                            version={v}
                            label={`v${origIdx + 1}`}
                            restoring={restore.isPending}
                            onRestore={() => restore.mutate(origIdx)}
                          />
                        ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

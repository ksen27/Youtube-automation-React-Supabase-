"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { RefreshCw, Trash2, Save, Film, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import type { SyntheticResp, SyntheticSegmentRow } from "./types";

const BLOCK_TYPES = ["avatar", "image", "ai_clip", "split_2"] as const;

// STEP: review the planned timeline before render. Per-block: thumbnail,
// prompt, script, type; actions Regenerate / Change Type / Edit Prompt /
// Delete. A "Render" action kicks off the existing render pipeline.
export function SyntheticReviewScreen({
  projectId,
  resp,
  onChange,
}: {
  projectId: string;
  resp: SyntheticResp;
  onChange: () => void;
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

  const render = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/render`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).error ?? `render failed (${r.status})`);
    },
    onSuccess: onChange,
  });

  const allReady = segs.length > 0 && segs.every((s) => s.status === "ready" || s.status === "skipped");

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-fg">{isPlanGate ? "Review plan" : "Review timeline"}</h2>
          <p className="text-xs text-fg-subtle">
            {segs.length} blocks{isPlanGate
              ? " · edit types/prompts before generating"
              : ` · ${resp.summary.ready} ready · ${resp.summary.failed} failed`}
          </p>
        </div>
        {isPlanGate ? (
          <Button type="button" variant="gradient" disabled={segs.length === 0 || generate.isPending} onClick={() => generate.mutate()}>
            <Sparkles className="h-4 w-4" /> {generate.isPending ? "Starting…" : "Generate assets"}
          </Button>
        ) : (
          <Button type="button" variant="gradient" disabled={!allReady || render.isPending} onClick={() => render.mutate()}>
            <Film className="h-4 w-4" /> {render.isPending ? "Starting render…" : "Render video"}
          </Button>
        )}
      </div>
      {generate.error && <p className="text-xs text-danger">{(generate.error as Error).message}</p>}
      {render.error && <p className="text-xs text-danger">{(render.error as Error).message}</p>}

      <div className="space-y-3">
        {segs.map((s) => (
          <SegmentRow key={s.id} projectId={projectId} segment={s} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}

function thumbUrl(s: SyntheticSegmentRow): string | null {
  return s.image_url ?? s.right_image_url ?? null;
}

function SegmentRow({
  projectId,
  segment,
  onChange,
}: {
  projectId: string;
  segment: SyntheticSegmentRow;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
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
  const del = useMutation({
    mutationFn: async () => { await fetch(base, { method: "DELETE" }); },
    onSuccess: onChange,
  });

  const thumb = thumbUrl(segment);
  const statusVariant =
    segment.status === "ready" ? "success" : segment.status === "failed" ? "destructive" : segment.status === "generating" ? "info" : "secondary";

  return (
    <Card>
      <CardContent className="flex gap-4 p-3">
        {/* Thumbnail */}
        <div className="h-20 w-32 shrink-0 rounded-[8px] overflow-hidden border border-border bg-bg-elevated grid place-items-center">
          {segment.video_url ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={segment.video_url} className="h-full w-full object-cover" muted preload="metadata" />
          ) : thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-[10px] text-fg-subtle">no preview</span>
          )}
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-fg-subtle">#{segment.position + 1}</span>
            <Badge variant="outline">{segment.block_type}</Badge>
            <Badge variant={statusVariant as "success" | "destructive" | "info" | "secondary"}>{segment.status}</Badge>
            <span className="text-[11px] text-fg-subtle tabular-nums">{segment.duration.toFixed(1)}s</span>
            {segment.provider && <span className="text-[11px] text-fg-subtle">via {segment.provider}</span>}
            <div className="ml-auto flex items-center gap-1">
              <Button type="button" variant="ghost" size="xs" onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : "Edit"}</Button>
              <Button type="button" variant="soft" size="xs" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>
                <RefreshCw className="h-3.5 w-3.5" /> Regenerate
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={() => del.mutate()} disabled={del.isPending}>
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </Button>
            </div>
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
              {segment.error && <p className="text-[11px] text-danger line-clamp-1">{segment.error}</p>}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

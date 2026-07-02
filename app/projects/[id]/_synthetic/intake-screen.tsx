"use client";

import { useState, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles, Upload, Check, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { uploadVoiceoverDirect } from "@/lib/client/upload-voiceover";
import { uploadPitchVideoDirect } from "@/lib/client/upload-pitch-video";
import type { SyntheticResp } from "./types";


// STEP 1 of the AI-Avatar flow: gather inputs, then BUILD THE PLAN (it stops at
// a review gate before any assets generate).
//   * Google Doc URL  — narration script; RED/ORANGE text marks avatar parts
//   * voiceover upload — optional; overrides TTS when present
//   * avatar image     — required (the face HeyGen animates)
//   * voice selection  — only when generating voiceover from the doc transcript
export function SyntheticIntakeScreen({
  projectId,
  resp,
  onChange,
}: {
  projectId: string;
  resp: SyntheticResp;
  onChange: () => void;
}) {
  const p = resp.project;
  const [docUrl, setDocUrl] = useState(p.script_doc_url ?? "");
  const [voiceId, setVoiceId] = useState(p.tts_voice_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [voPct, setVoPct] = useState<number | null>(null);
  const [pitchPct, setPitchPct] = useState<number | null>(null);
  const voInput = useRef<HTMLInputElement>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const pitchInput = useRef<HTMLInputElement>(null);

  const voicesQ = useQuery<{ configured: boolean }>({
    queryKey: ["synthetic-voices"],
    queryFn: () => fetch(`/api/synthetic/voices`).then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  // Ingest the Google Doc: fetch text + red/orange avatar marks, store on project.
  const ingestDoc = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/synthetic/script-doc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: docUrl.trim() }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `doc ingest failed (${r.status})`);
    },
    onSuccess: () => { setError(null); onChange(); },
    onError: (e) => setError((e as Error).message),
  });

  const uploadVoiceover = useMutation({
    mutationFn: async (file: File) => {
      setVoPct(0);
      try {
        return await uploadVoiceoverDirect(projectId, file, (l, t) => setVoPct(t > 0 ? Math.round((l / t) * 100) : null));
      } finally {
        setVoPct(null);
      }
    },
    onSuccess: onChange,
    onError: (e) => setError((e as Error).message),
  });

  const uploadAvatar = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/projects/${projectId}/avatar-image`, { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json()).error ?? `avatar upload failed (${r.status})`);
    },
    onSuccess: onChange,
    onError: (e) => setError((e as Error).message),
  });


  // Sales-pitch video: uploaded direct to R2, inserted near the 3:00 mark of
  // the final render (snapped to the nearest segment boundary). Plays its own
  // audio while the narration pauses, then narration resumes.
  const uploadPitch = useMutation({
    mutationFn: async (file: File) => {
      setPitchPct(0);
      try {
        return await uploadPitchVideoDirect(projectId, file, (l, t) => setPitchPct(t > 0 ? Math.round((l / t) * 100) : null));
      } finally {
        setPitchPct(null);
      }
    },
    onSuccess: onChange,
    onError: (e) => setError((e as Error).message),
  });

  const removePitch = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/pitch-video`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error ?? `remove failed (${r.status})`);
    },
    onSuccess: onChange,
    onError: (e) => setError((e as Error).message),
  });

  // BUILD PLAN: voiceover -> alignment -> planner, then STOP at the review gate.
  const buildPlan = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/projects/${projectId}/generate-synthetic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttsVoiceId: voiceId || undefined }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `build plan failed (${r.status})`);
    },
    onSuccess: onChange,
    onError: (e) => setError((e as Error).message),
  });

  const hasDoc = !!p.transcript && p.transcript.trim().length > 0;
  const hasVoiceover = !!p.voiceover_url;
  const hasAvatar = !!p.avatar_image_url;
  const hasPitch = !!p.pitch_video_url;
  const pitchInsertSeconds = p.pitch_video_insert_seconds ?? 180;
  const markCount = p.avatar_mark_ranges?.length ?? 0;
  const hasInput = hasVoiceover || hasDoc; // need a script (doc) or an uploaded voiceover
  const canBuild = hasAvatar && hasInput && !buildPlan.isPending;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>1 · Script (Google Doc)</CardTitle>
          <CardDescription>
            Paste the Google Doc URL of your narration. <span className="text-red-400">Red</span> or{" "}
            <span className="text-orange-400">orange</span> highlighted text becomes <strong>avatar</strong> (talking-head)
            segments; the rest is auto-assigned to images / clips / split-screens.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="docUrl">Google Doc URL</Label>
              <Input
                id="docUrl"
                value={docUrl}
                onChange={(e) => setDocUrl(e.target.value)}
                placeholder="https://docs.google.com/document/d/…"
              />
            </div>
            <Button type="button" variant="soft" disabled={!docUrl.trim() || ingestDoc.isPending} onClick={() => ingestDoc.mutate()}>
              <FileText className="h-4 w-4" /> {ingestDoc.isPending ? "Reading…" : "Load doc"}
            </Button>
          </div>

          {hasDoc && (
            <div className="rounded-[10px] border border-border bg-bg-elevated p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1 text-emerald-400"><Check className="h-3.5 w-3.5" /> Script loaded</span>
                <span className="text-fg-subtle">{p.transcript!.length} chars</span>
                <span className="text-fg-subtle">· {markCount} avatar mark{markCount === 1 ? "" : "s"}</span>
              </div>
              <p className="text-xs text-fg-muted line-clamp-3 whitespace-pre-wrap">{p.transcript!.slice(0, 400)}{p.transcript!.length > 400 ? "…" : ""}</p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <input
              ref={voInput}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadVoiceover.mutate(f); }}
            />
            <Button type="button" variant="soft" size="sm" onClick={() => voInput.current?.click()} disabled={uploadVoiceover.isPending}>
              <Upload className="h-4 w-4" /> {hasVoiceover ? "Replace voiceover" : "Upload voiceover (optional)"}
            </Button>
            {voPct != null && <span className="text-xs text-fg-muted tabular-nums">{voPct}%</span>}
            {hasVoiceover && <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><Check className="h-3.5 w-3.5" /> Voiceover ready</span>}
          </div>

          {!hasVoiceover && (
            <div className="space-y-1.5">
              <Label htmlFor="voice">
                69labs voice ID {voicesQ.data?.configured === false && <span className="text-fg-subtle">(TTS not configured)</span>}
              </Label>
              <Input
                id="voice"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                placeholder="e.g. Gr7mLjPA3HhuWxZidxPW"
              />
              <p className="text-[11px] text-fg-subtle">
                Paste the 69labs voice ID to narrate the script. Leave blank to use the default voice.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2 · Avatar image</CardTitle>
          <CardDescription>The photo your AI avatar is generated from. A clear, front-facing portrait works best.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            ref={avatarInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar.mutate(f); }}
          />
          <div className="flex items-center gap-4">
            {hasAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.avatar_image_url!} alt="avatar" className="h-20 w-20 rounded-[10px] object-cover border border-border" />
            ) : (
              <div className="h-20 w-20 rounded-[10px] border border-dashed border-border grid place-items-center text-fg-subtle text-xs">none</div>
            )}
            <Button type="button" variant="soft" size="sm" onClick={() => avatarInput.current?.click()} disabled={uploadAvatar.isPending}>
              <Upload className="h-4 w-4" /> {hasAvatar ? "Replace image" : "Upload image"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3 · Sales pitch video <span className="text-fg-subtle font-normal">(optional)</span></CardTitle>
          <CardDescription>
            Inserted near the {fmtClock(pitchInsertSeconds)} mark of the final video (snapped to the nearest scene so it
            never cuts an avatar mid-sentence). The narration pauses while it plays its own audio, then resumes —
            everything after the insertion point shifts later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            ref={pitchInput}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPitch.mutate(f); }}
          />
          <div className="flex items-center gap-3">
            <Button type="button" variant="soft" size="sm" onClick={() => pitchInput.current?.click()} disabled={uploadPitch.isPending}>
              <Upload className="h-4 w-4" /> {hasPitch ? "Replace pitch video" : "Upload pitch video"}
            </Button>
            {pitchPct != null && <span className="text-xs text-fg-muted tabular-nums">{pitchPct}%</span>}
            {hasPitch && !uploadPitch.isPending && (
              <>
                <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                  <Check className="h-3.5 w-3.5" /> Pitch video ready
                  {p.pitch_video_duration_seconds ? <span className="text-fg-subtle">· {fmtClock(p.pitch_video_duration_seconds)}</span> : null}
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => removePitch.mutate()} disabled={removePitch.isPending}>
                  Remove
                </Button>
              </>
            )}
          </div>
          {hasPitch && (
            <video src={p.pitch_video_url!} controls className="w-full max-w-md rounded-[10px] border border-border bg-bg-elevated" />
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="button" variant="gradient" size="lg" disabled={!canBuild} onClick={() => buildPlan.mutate()}>
          <Sparkles className="h-4 w-4" />
          {buildPlan.isPending ? "Starting…" : "Build plan"}
        </Button>
        {!hasAvatar && <span className="text-xs text-fg-subtle">Avatar image required</span>}
        {!hasInput && <span className="text-xs text-fg-subtle">Load a Google Doc or upload a voiceover</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      <p className="text-xs text-fg-subtle">
        “Build plan” generates the voiceover (if needed), aligns it, and segments your script — then stops so you can
        review every block before any image/clip/avatar is generated.
      </p>
    </div>
  );
}

// Seconds -> "m:ss" for the pitch-insert label and duration chip.
function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

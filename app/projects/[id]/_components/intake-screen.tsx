"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectResp } from "../_shared";
import { uploadVoiceoverDirect } from "@/lib/client/upload-voiceover";

export function IntakeScreen({
  projectId,
  project,
}: {
  projectId: string;
  project: ProjectResp["project"] | undefined;
}) {
  return (
    <IntakeForm
      key={project?.id ?? "loading"}
      projectId={projectId}
      project={project}
    />
  );
}

// Parse the mm:ss / m:ss / plain-seconds string the user types in the
// intro start field. Returns null for blank input (treated as "not set")
// and throws on malformed input so the form can surface a message.
function parseMmSs(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(\d+):([0-5]?\d)(?:\.(\d+))?$/);
  if (!m) throw new Error("Use mm:ss (e.g. 0:32) or plain seconds");
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  const frac = m[3] ? Number(`0.${m[3]}`) : 0;
  return minutes * 60 + seconds + frac;
}

function formatMmSs(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const total = Math.max(0, Number(seconds));
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const sStr = Number.isInteger(s) ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  return `${m}:${sStr}`;
}

function IntakeForm({
  projectId,
  project,
}: {
  projectId: string;
  project: ProjectResp["project"] | undefined;
}) {
  const qc = useQueryClient();
  const [transcript, setTranscript] = useState(project?.transcript ?? "");

  // After the voiceover upload returns a fresh transcript, the project query
  // refetches and we want the textarea to reflect that new text instead of
  // staying on whatever the user last typed (which was probably empty).
  useEffect(() => {
    if (project?.transcript && project.transcript !== transcript) {
      setTranscript(project.transcript);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.transcript]);

  const saveTranscript = useMutation({
    mutationFn: async (value: string) => {
      const r = await fetch(`/api/projects/${projectId}/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: value }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const uploadVoiceover = useMutation({
    mutationFn: async (file: File) => {
      setUploadPct(0);
      try {
        return await uploadVoiceoverDirect(projectId, file, (loaded, total) => {
          setUploadPct(total > 0 ? Math.round((loaded / total) * 100) : null);
        });
      } finally {
        setUploadPct(null);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  // Intro source — optional user override that replaces the auto-pick of an
  // intro window from the matched-source pool. When set, the renderer cuts
  // the intro video AND audio from exactly this URL+window, so the intro
  // shows the celebrity's real voice instead of a narrator's voiceover
  // that happened to land at the start of a different source.
  const [introUrl, setIntroUrl] = useState(project?.intro_source_youtube_url ?? "");
  const [introStart, setIntroStart] = useState(formatMmSs(project?.intro_source_start_seconds));
  const [introDuration, setIntroDuration] = useState(
    project?.intro_duration_seconds != null ? String(project.intro_duration_seconds) : "6",
  );
  const [introError, setIntroError] = useState<string | null>(null);

  useEffect(() => {
    setIntroUrl(project?.intro_source_youtube_url ?? "");
    setIntroStart(formatMmSs(project?.intro_source_start_seconds));
    if (project?.intro_duration_seconds != null) {
      setIntroDuration(String(project.intro_duration_seconds));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project?.intro_source_youtube_url,
    project?.intro_source_start_seconds,
    project?.intro_duration_seconds,
  ]);

  const saveIntro = useMutation({
    mutationFn: async (payload: {
      intro_source_youtube_url: string | null;
      intro_source_start_seconds: number | null;
      intro_duration_seconds: number | null;
    }) => {
      const r = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  function onSaveIntro() {
    setIntroError(null);
    try {
      const url = introUrl.trim();
      if (!url) {
        saveIntro.mutate({
          intro_source_youtube_url: null,
          intro_source_start_seconds: null,
          intro_duration_seconds: null,
        });
        return;
      }
      const start = parseMmSs(introStart);
      if (start == null) throw new Error("Enter a start time");
      const dur = Number(introDuration);
      if (!Number.isFinite(dur) || dur < 1 || dur > 15) throw new Error("Duration must be 1–15 seconds");
      saveIntro.mutate({
        intro_source_youtube_url: url,
        intro_source_start_seconds: start,
        intro_duration_seconds: dur,
      });
    } catch (e) {
      setIntroError((e as Error).message);
    }
  }

  function onClearIntro() {
    setIntroError(null);
    setIntroUrl("");
    setIntroStart("");
    setIntroDuration("6");
    saveIntro.mutate({
      intro_source_youtube_url: null,
      intro_source_start_seconds: null,
      intro_duration_seconds: null,
    });
  }

  const introSaving = saveIntro.isPending;
  const transcribing = uploadVoiceover.isPending;
  const pasting = saveTranscript.isPending;

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <p className="text-sm text-fg-muted text-center">
        Provide your script either by pasting it or by uploading a voiceover — we'll transcribe the audio for you.
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card aria-disabled={transcribing} className={transcribing ? "opacity-60" : undefined}>
          <CardHeader>
            <CardTitle>Paste transcript</CardTitle>
            <CardDescription>
              Paste your script. We use this for entity extraction and matching.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              rows={11}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Today on the channel, we're talking about…"
              disabled={transcribing}
            />
            <div className="flex items-center gap-3">
              <Button
                variant="gradient"
                onClick={() => saveTranscript.mutate(transcript)}
                disabled={!transcript.trim() || pasting || transcribing}
              >
                <Sparkles className="h-4 w-4" />
                {pasting ? "Saving…" : "Save & continue"}
              </Button>
              {saveTranscript.error && (
                <p className="text-xs text-danger">
                  {(saveTranscript.error as Error).message}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card aria-disabled={pasting} className={pasting ? "opacity-60" : undefined}>
          <CardHeader>
            <CardTitle>Upload voiceover</CardTitle>
            <CardDescription>
              We'll transcribe the audio and use it as your script. The audio is also included in the final render.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="vo">Audio file</Label>
              <Input
                id="vo"
                type="file"
                accept="audio/*"
                disabled={transcribing || pasting}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadVoiceover.mutate(f);
                }}
              />
            </div>
            {transcribing && (
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {uploadPct != null && uploadPct < 100
                  ? `Uploading ${uploadPct}%`
                  : "Transcribing — this can take a minute for long audio."}
              </div>
            )}
            {uploadVoiceover.error && (
              <p className="text-xs text-danger">
                {(uploadVoiceover.error as Error).message}
              </p>
            )}
            {project?.voiceover_url && !transcribing && (
              <audio
                controls
                src={project.voiceover_url}
                className="w-full rounded-md border border-border bg-bg-elevated"
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Intro clip (optional)</CardTitle>
          <CardDescription>
            Paste the YouTube link and timestamp for the exact intro you want. We'll cut both the video and the audio from this window so the intro plays the celebrity's real voice, not the channel narrator. Leave blank to let the system pick automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="intro-url">YouTube URL</Label>
            <Input
              id="intro-url"
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={introUrl}
              onChange={(e) => setIntroUrl(e.target.value)}
              disabled={introSaving}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="intro-start">Start (mm:ss)</Label>
              <Input
                id="intro-start"
                type="text"
                inputMode="numeric"
                placeholder="0:32"
                value={introStart}
                onChange={(e) => setIntroStart(e.target.value)}
                disabled={introSaving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="intro-duration">Duration (seconds)</Label>
              <Input
                id="intro-duration"
                type="number"
                min={1}
                max={15}
                step={0.5}
                placeholder="6"
                value={introDuration}
                onChange={(e) => setIntroDuration(e.target.value)}
                disabled={introSaving}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="gradient"
              onClick={onSaveIntro}
              disabled={introSaving}
            >
              {introSaving ? "Saving…" : "Save intro source"}
            </Button>
            {(project?.intro_source_youtube_url || introUrl) && (
              <Button
                variant="outline"
                onClick={onClearIntro}
                disabled={introSaving}
              >
                Clear
              </Button>
            )}
            {introError && <p className="text-xs text-danger">{introError}</p>}
            {saveIntro.error && !introError && (
              <p className="text-xs text-danger">{(saveIntro.error as Error).message}</p>
            )}
          </div>
          {project?.intro_source_youtube_url && (
            <p className="text-xs text-fg-muted">
              Saved — using {project.intro_source_youtube_url} at {formatMmSs(project.intro_source_start_seconds)} for {project.intro_duration_seconds ?? 6}s.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

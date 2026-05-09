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
    </div>
  );
}

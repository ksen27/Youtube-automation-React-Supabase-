"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

interface ScriptDocResponse {
  project: ProjectResp["project"];
  introCards: Array<{ text: string; startSeconds?: number; endSeconds?: number }>;
  titleCards: Array<{ text: string }>;
  lowerThirds: Array<{ text: string }>;
}

function IntakeForm({
  projectId,
  project,
}: {
  projectId: string;
  project: ProjectResp["project"] | undefined;
}) {
  const qc = useQueryClient();

  // Voiceover upload --------------------------------------------------------
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

  // Script doc ingest -------------------------------------------------------
  const [docUrl, setDocUrl] = useState("");
  const [lastIngest, setLastIngest] = useState<ScriptDocResponse | null>(null);
  const ingestDoc = useMutation({
    mutationFn: async (url: string): Promise<ScriptDocResponse> => {
      const r = await fetch(`/api/projects/${projectId}/script-doc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: url }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `failed ${r.status}`);
      return json as ScriptDocResponse;
    },
    onSuccess: (data) => {
      setLastIngest(data);
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const transcribing = uploadVoiceover.isPending;
  const parsingDoc = ingestDoc.isPending;
  const hasVoiceover = !!project?.voiceover_url;
  const hasTranscript = !!project?.transcript?.trim();

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <p className="text-sm text-fg-muted text-center">
        Upload your voiceover and paste a Google Docs link to your script. The doc&apos;s intro block, title cards, and red lower-third callouts drive the final edit.
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card aria-disabled={parsingDoc} className={parsingDoc ? "opacity-60" : undefined}>
          <CardHeader>
            <CardTitle>Upload voiceover</CardTitle>
            <CardDescription>
              We&apos;ll transcribe the audio with per-word timing. The audio is also included in the final render.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="vo">Audio file</Label>
              <Input
                id="vo"
                type="file"
                accept="audio/*"
                disabled={transcribing || parsingDoc}
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
            {hasVoiceover && !transcribing && (
              <audio
                controls
                src={project!.voiceover_url!}
                className="w-full rounded-md border border-border bg-bg-elevated"
              />
            )}
          </CardContent>
        </Card>

        <Card aria-disabled={transcribing} className={transcribing ? "opacity-60" : undefined}>
          <CardHeader>
            <CardTitle>Script document</CardTitle>
            <CardDescription>
              Paste the Google Docs link. The doc must be shared as &ldquo;Anyone with the link can view&rdquo;. We read the blue-bold intro block, blue-bold title cards (with their timestamps), and red text inline as lower-thirds.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="doc-url">Google Docs URL</Label>
              <Input
                id="doc-url"
                type="url"
                placeholder="https://docs.google.com/document/d/…/edit"
                value={docUrl}
                onChange={(e) => setDocUrl(e.target.value)}
                disabled={parsingDoc || transcribing}
              />
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="gradient"
                onClick={() => ingestDoc.mutate(docUrl)}
                disabled={!docUrl.trim() || parsingDoc || transcribing}
              >
                {parsingDoc ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Reading doc…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" /> Ingest script
                  </>
                )}
              </Button>
              {ingestDoc.error && (
                <p className="text-xs text-danger">{(ingestDoc.error as Error).message}</p>
              )}
            </div>
            {lastIngest && (
              <div className="rounded-md border border-border bg-bg-elevated p-3 text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-medium">
                  <FileText className="h-3.5 w-3.5" /> Doc parsed
                </div>
                {lastIngest.introCards.length > 0 ? (
                  <p className="text-fg-muted">
                    Intro clips: <span className="text-fg">{lastIngest.introCards.length}</span>
                    {" — "}
                    {lastIngest.introCards
                      .map((c) =>
                        c.startSeconds != null && c.endSeconds != null
                          ? `${c.startSeconds}s–${c.endSeconds}s`
                          : "?")
                      .join(", ")}
                  </p>
                ) : (
                  <p className="text-fg-muted">Intro clips: none detected at the top of the doc.</p>
                )}
                <p className="text-fg-muted">Title cards: <span className="text-fg">{lastIngest.titleCards.length}</span></p>
                <p className="text-fg-muted">Lower-thirds: <span className="text-fg">{lastIngest.lowerThirds.length}</span></p>
              </div>
            )}
            {hasTranscript && !lastIngest && (
              <p className="text-xs text-fg-muted">
                Transcript saved — re-ingest the doc if you&apos;ve changed the source.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProjectResp } from "../_shared";
import { uploadVoiceoverDirect } from "@/lib/client/upload-voiceover";
import { ScriptMarkersPanel } from "./script-markers-panel";

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
  // The response is intentionally discarded: ScriptMarkersPanel polls
  // /api/projects/[id]/script-markers for live status, and the project
  // query refresh below picks up the new transcript. Invalidating the
  // markers query forces the panel to refetch on the very next tick so
  // the user sees the new clip list immediately after the doc parses.
  const [docUrl, setDocUrl] = useState("");
  const ingestDoc = useMutation({
    mutationFn: async (url: string): Promise<void> => {
      const r = await fetch(`/api/projects/${projectId}/script-doc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: url }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `failed ${r.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["script-markers", projectId] });
    },
  });

  const transcribing = uploadVoiceover.isPending;
  const parsingDoc = ingestDoc.isPending;
  const hasVoiceover = !!project?.voiceover_url;

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
            {/* Live status panel — polls the markers endpoint so the user
                sees clips transition through pending → downloading → ready
                without reloading the page. Re-ingests replace the row set,
                which the panel picks up on the next poll. */}
            <ScriptMarkersPanel projectId={projectId} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

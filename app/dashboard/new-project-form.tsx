"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileAudio, FileText, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { uploadVoiceoverDirect } from "@/lib/client/upload-voiceover";

type InputMode = "transcript" | "voiceover";

export function NewProjectForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [voiceoverFile, setVoiceoverFile] = useState<File | null>(null);
  const [mode, setMode] = useState<InputMode>("transcript");
  const [submitting, setSubmitting] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    title.trim().length > 0 &&
    !submitting &&
    (mode === "transcript" ? transcript.trim().length > 0 : voiceoverFile != null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const createBody: Record<string, string> = { title: title.trim() };
      if (mode === "transcript") createBody.transcript = transcript;
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `Failed (${r.status})`);
      const { project } = await r.json();

      if (mode === "voiceover" && voiceoverFile) {
        await uploadVoiceoverDirect(project.id, voiceoverFile, (loaded, total) => {
          setUploadPct(total > 0 ? Math.round((loaded / total) * 100) : null);
        });
      }

      router.push(`/projects/${project.id}?analyze=1`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
      setSubmitting(false);
    }
  }

  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
  const estimatedMinutes = Math.max(1, Math.round(wordCount / 150));

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="title">Project title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Inside Margot Robbie's Career"
        />
      </div>

      <div className="space-y-2">
        <Label>Content source</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ModeButton
            active={mode === "transcript"}
            onClick={() => setMode("transcript")}
            icon={<FileText className="h-4 w-4" />}
            label="Paste transcript"
            hint="Best for finished scripts"
          />
          <ModeButton
            active={mode === "voiceover"}
            onClick={() => setMode("voiceover")}
            icon={<FileAudio className="h-4 w-4" />}
            label="Upload voiceover"
            hint="MP3 or WAV"
          />
        </div>
      </div>

      {mode === "transcript" ? (
        <div className="space-y-1.5">
          <Label htmlFor="transcript">Transcript</Label>
          <Textarea
            id="transcript"
            rows={9}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Paste your full script here. Long scripts (20–30 min) are fine — we'll split them into 5-minute parts automatically."
          />
          <p className="text-xs text-fg-subtle">
            About <span className="text-fg-muted">{estimatedMinutes} min</span> of narration at 150 wpm.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="vo">Voiceover file</Label>
          <Input
            id="vo"
            type="file"
            accept="audio/*"
            onChange={(e) => setVoiceoverFile(e.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-fg-subtle">
            We&apos;ll attach this audio to your project. Transcription is done in the next step.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          type="submit"
          variant="gradient"
          size="lg"
          disabled={!canSubmit}
        >
          <Sparkles className="h-4 w-4" />
          {submitting
            ? uploadPct != null && uploadPct < 100
              ? `Uploading ${uploadPct}%`
              : "Starting…"
            : "Analyze & Search"}
        </Button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </form>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-col items-start gap-1 rounded-[10px] border p-4 text-left transition-all",
        active
          ? "border-brand-500 bg-brand-500/8 shadow-glow"
          : "border-border bg-surface hover:bg-surface-hover hover:border-border-strong",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 text-sm font-medium",
          active ? "text-fg" : "text-fg",
        )}
      >
        <span className={cn(active ? "text-brand-300" : "text-fg-muted")}>{icon}</span>
        {label}
      </div>
      <div className="text-xs text-fg-subtle">{hint}</div>
    </button>
  );
}

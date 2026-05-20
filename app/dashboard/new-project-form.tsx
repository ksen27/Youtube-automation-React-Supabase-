"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Title-only project creation. Audio upload and Google Doc ingest live on
// the intake screen (/projects/[id]) because both are async with their own
// progress UIs (presigned upload + Deepgram transcription, doc parse +
// per-clip pre-download). Cramming them into the dashboard turned a fast
// "create" click into a slow upload-and-parse wait, and there's no place
// to surface clip-download status on the dashboard.

export function NewProjectForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && !submitting;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `Failed (${r.status})`);
      const { project } = await r.json();
      // Land directly on the intake screen — that's where the voiceover
      // upload and Google Doc inputs live.
      router.push(`/projects/${project.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="title">Project title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Inside Margot Robbie's Career"
          autoFocus
        />
        <p className="text-xs text-fg-subtle">
          You&apos;ll add the voiceover audio and Google Docs script on the next screen.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button type="submit" variant="gradient" size="lg" disabled={!canSubmit}>
          <Sparkles className="h-4 w-4" />
          {submitting ? "Creating…" : "Create project"}
        </Button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </form>
  );
}

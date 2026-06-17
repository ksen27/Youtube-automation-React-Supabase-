"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Title-only creation for an AI Avatar (synthetic) project. Script, voiceover,
// and avatar image are gathered on the synthetic intake screen (/projects/[id]),
// which renders because the project's engine is 'synthetic'.
export function NewAvatarForm() {
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
        body: JSON.stringify({ title: title.trim(), engine: "synthetic" }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `Failed (${r.status})`);
      const { project } = await r.json();
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
          placeholder="e.g. My AI Avatar Explainer"
          autoFocus
        />
        <p className="text-xs text-fg-subtle">
          You&apos;ll add the script/voiceover and avatar image on the next screen.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button type="submit" variant="gradient" size="lg" disabled={!canSubmit}>
          <Bot className="h-4 w-4" />
          {submitting ? "Creating…" : "Create AI avatar video"}
        </Button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </form>
  );
}

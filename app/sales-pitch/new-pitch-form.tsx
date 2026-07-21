"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Megaphone, Upload, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Generate-a-pitch form for the standalone Sales Pitch tool. Inputs: website URL,
// avatar photo (uploaded to R2 → URL), script, and optional 69labs voice id +
// HeyGen avatar name. On submit it POSTs /api/pitch-videos (creates the row +
// enqueues the build), then refreshes so the new "Generating…" card appears.
export function NewPitchForm() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [website, setWebsite] = useState("");
  const [script, setScript] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [avatarName, setAvatarName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPickImage(file: File) {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/pitch-videos/upload", { method: "POST", body: fd });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `Upload failed (${r.status})`);
      setAvatarUrl(json.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const canSubmit =
    website.trim().length > 0 && !!avatarUrl && script.trim().length > 0 && !submitting && !uploading;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/pitch-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          websiteUrl: website.trim(),
          avatarImageUrl: avatarUrl,
          script: script.trim(),
          ttsVoiceId: voiceId.trim() || undefined,
          avatarName: avatarName.trim() || undefined,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `Failed (${r.status})`);
      // Reset the form and reveal the new generating card.
      setTitle(""); setWebsite(""); setScript(""); setVoiceId(""); setAvatarName(""); setAvatarUrl(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 max-w-2xl">
      <div className="space-y-1.5">
        <Label htmlFor="pv-title">Label <span className="text-fg-subtle">(optional)</span></Label>
        <Input id="pv-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Mechanic Bible pitch" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pv-website">Website URL</Label>
        <Input id="pv-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://themechanicbible.com/" />
        <p className="text-[11px] text-fg-subtle">The real site is loaded and screen-recorded — the exact UI, no AI guessing.</p>
      </div>

      <div className="space-y-1.5">
        <Label>Avatar image</Label>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickImage(f); }}
        />
        <div className="flex items-center gap-4">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="avatar" className="h-16 w-16 rounded-[10px] object-cover border border-border" />
          ) : (
            <div className="h-16 w-16 rounded-[10px] border border-dashed border-border grid place-items-center text-fg-subtle text-xs">none</div>
          )}
          <Button type="button" variant="soft" size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {avatarUrl ? "Replace image" : "Upload image"}
          </Button>
          {avatarUrl && !uploading && <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><Check className="h-3.5 w-3.5" /> Ready</span>}
        </div>
        <p className="text-[11px] text-fg-subtle">A clear, front-facing portrait works best.</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pv-script">Script</Label>
        <textarea
          id="pv-script"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={4}
          placeholder="What the avatar says while introducing the website…"
          className="w-full rounded-[10px] border border-border bg-bg-elevated p-3 text-sm outline-none focus:border-fg-subtle"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pv-voice">69labs voice ID <span className="text-fg-subtle">(optional)</span></Label>
          <Input id="pv-voice" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} placeholder="match your video's voice" />
          <p className="text-[11px] text-fg-subtle">Leave blank for the default voice.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pv-avatar-name">HeyGen avatar name <span className="text-fg-subtle">(optional)</span></Label>
          <Input id="pv-avatar-name" value={avatarName} onChange={(e) => setAvatarName(e.target.value)} placeholder="usually blank" />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="gradient" disabled={!canSubmit}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />}
          {submitting ? "Starting…" : "Generate pitch"}
        </Button>
        {!avatarUrl && <span className="text-xs text-fg-subtle">Upload an avatar image</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </form>
  );
}

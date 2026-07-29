"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Megaphone, Upload, Check, Loader2, Globe, User, FileText, AudioLines, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

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
  const [dragging, setDragging] = useState(false);
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
    website.trim().length > 0 && !!avatarUrl && script.trim().length > 0 &&
    voiceId.trim().length > 0 && !submitting && !uploading;

  // What's still missing, surfaced next to the submit button so the disabled
  // state is never a mystery (previously two ad-hoc spans covered only two cases).
  const missing: string[] = [];
  if (website.trim().length === 0) missing.push("website URL");
  if (!avatarUrl) missing.push("avatar image");
  if (script.trim().length === 0) missing.push("script");
  if (voiceId.trim().length === 0) missing.push("voice ID");

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
    <form onSubmit={onSubmit} className="max-w-3xl space-y-4">
      {/* Label — small, above the sections; optional and unobtrusive. */}
      <div className="space-y-1.5">
        <Label htmlFor="pv-title" className="text-fg-muted">
          Label <span className="font-normal text-fg-subtle">· optional, just for your own reference</span>
        </Label>
        <Input id="pv-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Mechanic Bible pitch" />
      </div>

      {/* Step 1 — Website */}
      <Section step={1} icon={<Globe className="h-4 w-4" />} title="Website" desc="The real site is loaded and screen-recorded — the exact UI, no AI guessing.">
        <Input
          id="pv-website"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://themechanicbible.com/"
          inputMode="url"
        />
      </Section>

      {/* Step 2 — Avatar photo (proper dropzone) */}
      <Section step={2} icon={<User className="h-4 w-4" />} title="Avatar photo" desc="A clear, front-facing portrait works best.">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickImage(f); }}
        />
        {avatarUrl ? (
          <div className="flex items-center gap-4 rounded-[10px] border border-border bg-bg-elevated p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={avatarUrl} alt="avatar" className="h-16 w-16 shrink-0 rounded-[10px] border border-border object-cover" />
            <div className="min-w-0 flex-1">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400">
                <Check className="h-4 w-4" /> Photo ready
              </span>
              <p className="mt-0.5 text-xs text-fg-subtle">This face drives the talking-head half of the pitch.</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Replace
              </Button>
              <Button type="button" variant="ghost" size="icon" onClick={() => setAvatarUrl(null)} aria-label="Remove image">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) onPickImage(f);
            }}
            disabled={uploading}
            className={cn(
              "flex w-full flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed px-4 py-7 text-center transition-colors",
              "border-border bg-bg-elevated/50 hover:border-border-strong hover:bg-bg-elevated",
              dragging && "border-brand-500 bg-brand-500/5",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {uploading ? (
              <Loader2 className="h-6 w-6 animate-spin text-fg-subtle" />
            ) : (
              <div className="grid h-10 w-10 place-items-center rounded-full bg-brand-500/10 text-brand-300">
                <Upload className="h-5 w-5" />
              </div>
            )}
            <span className="text-sm font-medium text-fg">
              {uploading ? "Uploading…" : "Upload a photo"}
            </span>
            <span className="text-xs text-fg-subtle">Click to browse or drag an image here</span>
          </button>
        )}
      </Section>

      {/* Step 3 — Script */}
      <Section step={3} icon={<FileText className="h-4 w-4" />} title="Script" desc="What the avatar says while introducing the website.">
        <div className="space-y-1.5">
          <textarea
            id="pv-script"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={5}
            placeholder="Hey, I want to show you something that's going to change how you…"
            className="w-full resize-y rounded-[10px] border border-border bg-bg-elevated p-3 text-sm leading-relaxed text-fg outline-none transition-colors placeholder:text-fg-subtle focus-visible:border-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500/20"
          />
          <p className="text-right text-[11px] tabular-nums text-fg-subtle">
            {script.trim().length} characters
          </p>
        </div>
      </Section>

      {/* Step 4 — Voice */}
      <Section step={4} icon={<AudioLines className="h-4 w-4" />} title="Voice" desc="The pitch is narrated in this voice — use the same one as your video.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pv-voice" className="text-xs text-fg-muted">69labs voice ID</Label>
            <Input id="pv-voice" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} placeholder="e.g. ngiiW8FFLIdMew1cqwSB" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pv-avatar-name" className="text-xs text-fg-muted">
              HeyGen avatar name <span className="font-normal text-fg-subtle">· optional</span>
            </Label>
            <Input id="pv-avatar-name" value={avatarName} onChange={(e) => setAvatarName(e.target.value)} placeholder="usually blank" />
          </div>
        </div>
      </Section>

      {/* Submit */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <Button type="submit" variant="gradient" size="lg" disabled={!canSubmit}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />}
          {submitting ? "Starting…" : "Generate pitch"}
        </Button>
        {error ? (
          <span className="text-xs text-danger">{error}</span>
        ) : !canSubmit && !submitting && missing.length > 0 ? (
          <span className="text-xs text-fg-subtle">Still needed: {missing.join(", ")}</span>
        ) : null}
      </div>
    </form>
  );
}

// One labeled step in the form: a numbered marker + icon + title + helper text,
// with the field(s) beside it. Keeps related inputs visually grouped instead of
// one flat undifferentiated column.
function Section({
  step,
  icon,
  title,
  desc,
  children,
}: {
  step: number;
  icon: React.ReactNode;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[12px] border border-border bg-surface/40 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-500/10 text-brand-300">
          {icon}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Step {step}</span>
              <span className="text-sm font-semibold text-fg">{title}</span>
            </div>
            <p className="text-xs text-fg-muted">{desc}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

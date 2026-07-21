"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Download, Loader2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface PitchVideoRow {
  id: string;
  title: string;
  website_url: string;
  output_url: string | null;
  duration_seconds: number | null;
  status: "generating" | "ready" | "failed";
  error: string | null;
  created_at: string;
}

// One entry in the pitch gallery: the generated video (or a status placeholder),
// its label + website, a download link, and delete. While a pitch is still
// generating the card polls (router.refresh) so it flips to the video on its own.
export function PitchCard({ pitch: p }: { pitch: PitchVideoRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-refresh while this pitch is still generating so the gallery updates
  // without a manual reload (the build runs minutes on the worker).
  useEffect(() => {
    if (p.status !== "generating") return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [p.status, router]);

  async function onDelete() {
    if (busy) return;
    if (!window.confirm("Delete this pitch video? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/pitch-videos/${p.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error ?? `Delete failed (${r.status})`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  }

  const done = p.status === "ready" && p.output_url;
  const label = p.title || hostOf(p.website_url);

  return (
    <div className="group rounded-[14px] border border-border bg-bg-elevated overflow-hidden">
      <div className="relative aspect-video bg-surface-hover">
        {done ? (
          <video src={p.output_url!} controls className="h-full w-full object-contain bg-black" preload="metadata" />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            {p.status === "failed" ? (
              <Badge variant="destructive">Failed</Badge>
            ) : (
              <span className="inline-flex items-center gap-2 text-xs text-fg-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…
              </span>
            )}
          </div>
        )}
      </div>

      <div className="p-3 space-y-1.5">
        <p className="text-sm text-fg line-clamp-1" title={label}>{label}</p>
        <p className="text-[11px] text-fg-subtle line-clamp-1" title={p.website_url}>{p.website_url}</p>
        {p.status === "failed" && p.error && (
          <p className="text-xs text-danger line-clamp-2" title={p.error}>{p.error}</p>
        )}
        {error && <p className="text-xs text-danger line-clamp-2">{error}</p>}

        <div className="flex items-center justify-between pt-0.5">
          <span className="text-[11px] text-fg-subtle tabular-nums">
            {new Date(p.created_at).toLocaleDateString()}
            {done && p.duration_seconds ? ` · ${Math.round(p.duration_seconds)}s` : ""}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-fg-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
              title="Delete"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
            {done && (
              <a
                href={p.output_url!}
                download
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand-300 hover:underline ml-1"
              >
                <Download className="h-3 w-3" /> Download
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Show the website's host as a fallback label when no title was given.
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

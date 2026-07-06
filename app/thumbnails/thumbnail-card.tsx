import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface ThumbnailRow {
  id: string;
  title: string;
  prompt: string;
  reference_urls: string[];
  output_url: string | null;
  status: "pending" | "completed" | "failed";
  error: string | null;
  created_at: string;
}

// One entry in the thumbnail gallery: the generated image (or a status
// placeholder), the title/prompt, and a download link.
export function ThumbnailCard({ thumbnail: t }: { thumbnail: ThumbnailRow }) {
  return (
    <div className="group rounded-[14px] border border-border bg-bg-elevated overflow-hidden">
      <div className="relative aspect-video bg-surface-hover">
        {t.status === "completed" && t.output_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={t.output_url}
            alt={t.prompt}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            {t.status === "failed" ? (
              <Badge variant="destructive">Failed</Badge>
            ) : (
              <Badge variant="warning">Generating…</Badge>
            )}
          </div>
        )}
      </div>
      <div className="p-3 space-y-1.5">
        <p className="text-sm text-fg line-clamp-2" title={t.prompt}>
          {t.title || t.prompt}
        </p>
        {t.status === "failed" && t.error && (
          <p className="text-xs text-danger line-clamp-2" title={t.error}>
            {t.error}
          </p>
        )}
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-[11px] text-fg-subtle tabular-nums">
            {new Date(t.created_at).toLocaleDateString()}
          </span>
          {t.status === "completed" && t.output_url && (
            <a
              href={t.output_url}
              download
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-brand-300 hover:underline"
            >
              <Download className="h-3 w-3" /> Download
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "secondary" | "success" | "warning" | "destructive" | "info" | "outline";

export interface ProjectCardData {
  id: string;
  title: string;
  status: string;
  created_at: string;
  badgeVariant: BadgeVariant;
  videoUrl: string | null;
}

export function ProjectCard({ project }: { project: ProjectCardData }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCompleted = project.status === "completed" && !!project.videoUrl;

  async function onDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (deleting) return;
    if (!confirm(`Delete "${project.title}"? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed (${r.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setDeleting(false);
    }
  }

  return (
    <Card interactive className={cn("h-full overflow-hidden relative group", deleting && "opacity-50 pointer-events-none")}>
      {isCompleted && (
        <video
          src={project.videoUrl!}
          controls
          preload="metadata"
          className="w-full aspect-video bg-black"
        />
      )}
      <Link href={`/projects/${project.id}`} className="block">
        <CardHeader>
          <CardTitle className="truncate text-fg group-hover:text-brand-300 transition-colors pr-8">
            {project.title}
          </CardTitle>
          <CardDescription className="text-xs">
            {new Date(project.created_at).toLocaleString()}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Badge variant={project.badgeVariant}>{project.status.replace(/_/g, " ")}</Badge>
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </CardContent>
      </Link>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete project"
        title="Delete project"
        disabled={deleting}
        className={cn(
          "absolute top-3 right-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md",
          "border border-border bg-surface/80 backdrop-blur-sm text-fg-muted",
          "transition-colors hover:bg-danger/10 hover:text-danger hover:border-danger/40",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </Card>
  );
}

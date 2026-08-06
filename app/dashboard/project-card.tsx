"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "secondary" | "success" | "warning" | "destructive" | "info" | "outline";

export interface ProjectCardData {
  id: string;
  title: string;
  status: string;
  created_at: string;
  badgeVariant: BadgeVariant;
}

export function ProjectCard({ project, deletable = false }: { project: ProjectCardData; deletable?: boolean }) {
  return (
    <Card interactive className={cn("h-full overflow-hidden relative group")}>
      {deletable && <DeleteButton id={project.id} title={project.title} />}
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
        </CardContent>
      </Link>
    </Card>
  );
}

function DeleteButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed (${res.status})`);
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !deleting && setOpen(o)}>
      <button
        type="button"
        aria-label="Delete project"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          "absolute top-2 right-2 z-10 grid h-8 w-8 place-items-center rounded-md",
          "text-fg-muted opacity-0 group-hover:opacity-100 transition-opacity",
          "hover:bg-danger/10 hover:text-danger",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:opacity-100",
        )}
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <DialogContent className="w-[min(96vw,420px)] p-5">
        <DialogTitle>Delete this project?</DialogTitle>
        <DialogDescription className="mt-1.5">
          &ldquo;{title}&rdquo; and all of its generated assets, segments, and jobs will be permanently
          removed. This can&apos;t be undone.
        </DialogDescription>
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline" size="sm" disabled={deleting}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

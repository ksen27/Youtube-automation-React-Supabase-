"use client";

import Link from "next/link";
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
  const isCompleted = project.status === "completed" && !!project.videoUrl;

  return (
    <Card interactive className={cn("h-full overflow-hidden relative group")}>
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
        </CardContent>
      </Link>
    </Card>
  );
}

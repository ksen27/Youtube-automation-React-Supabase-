import Link from "next/link";
import { FolderClosed, Sparkles } from "lucide-react";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { NewProjectForm } from "./new-project-form";
import { statusToTone } from "@/app/projects/[id]/_shared";
import { ProjectCard, type ProjectCardData } from "./project-card";

export const dynamic = "force-dynamic";

interface ProjectRow {
  id: string;
  title: string;
  status: string;
  engine: string | null;
  created_at: string;
  updated_at: string;
}

async function loadProjects(): Promise<ProjectCardData[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("projects")
    .select("id, title, status, engine, created_at, updated_at")
    .or("engine.eq.sourced,engine.is.null") // Celebrity Videos only — synthetic lives under /avatar
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return [];
  const rows = (data ?? []) as ProjectRow[];

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    created_at: r.created_at,
    badgeVariant: badgeVariantFor(r.status),
  }));
}

function badgeVariantFor(s: string): "default" | "secondary" | "success" | "warning" | "destructive" | "info" | "outline" {
  const tone = statusToTone(s);
  if (tone === "success") return "success";
  if (tone === "warning") return "warning";
  if (tone === "danger") return "destructive";
  if (tone === "info") return "info";
  if (tone === "muted") return "secondary";
  return "default";
}

export default async function DashboardPage() {
  const projects = await loadProjects();

  return (
    <div className="px-6 lg:px-8 py-8 max-w-7xl mx-auto space-y-10">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[18px] border border-border bg-bg-elevated p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-0"
          style={{
            background:
              "radial-gradient(600px 220px at 80% 0%, rgba(139,92,246,0.18), transparent 60%), radial-gradient(500px 200px at 0% 100%, rgba(99,102,241,0.18), transparent 60%)",
          }}
        />
        <div className="relative max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-500/10 border border-brand-500/30 px-2.5 h-6 text-[11px] font-medium text-brand-300">
            <Sparkles className="h-3 w-3" /> AI workflow
          </span>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-fg">
            Turn a script into a <span className="gradient-text">finished video</span>.
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            Upload a voiceover and paste your Google Docs script. We analyze, pull sources, and assemble it into scenes you can edit.
          </p>
        </div>
      </section>

      {/* New project */}
      <Card>
        <CardHeader>
          <CardTitle>New project</CardTitle>
          <CardDescription>Name it now — you&apos;ll attach the voiceover and Google Docs script next.</CardDescription>
        </CardHeader>
        <CardContent>
          <NewProjectForm />
        </CardContent>
      </Card>

      {!isSupabaseConfigured() && (
        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="text-danger">Supabase not configured</CardTitle>
            <CardDescription>
              Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY in <code>.env.local</code>. See{" "}
              <Link className="underline text-brand-300" href="/settings">
                settings
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Recent projects */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-fg-muted">Recent projects</h2>
          <span className="text-xs text-fg-subtle tabular-nums">{projects.length} total</span>
        </div>
        {projects.length === 0 ? (
          <EmptyState
            icon={<FolderClosed className="h-5 w-5" />}
            title="No projects yet"
            description="Start one above — your first video takes about 2 minutes."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} deletable />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

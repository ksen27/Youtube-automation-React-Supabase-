import Link from "next/link";
import { Bot } from "lucide-react";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { statusToTone } from "@/app/projects/[id]/_shared";
import { ProjectCard, type ProjectCardData } from "@/app/dashboard/project-card";
import { NewAvatarForm } from "./new-avatar-form";

export const dynamic = "force-dynamic";

// AI Avatar dashboard — the SYNTHETIC engine's home. Separate top-level feature
// from Celebrity Videos (/dashboard). Lists only synthetic projects; creating
// here always sets engine = 'synthetic'.

interface ProjectRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

async function loadProjects(): Promise<ProjectCardData[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("projects")
    .select("id, title, status, engine, created_at, updated_at")
    .eq("engine", "synthetic")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return [];
  const rows = (data ?? []) as ProjectRow[];

  const completedIds = rows.filter((r) => r.status === "completed").map((r) => r.id);
  const videoByProject = new Map<string, string>();
  if (completedIds.length > 0) {
    const { data: renders } = await sb
      .from("render_jobs")
      .select("project_id, output_url, created_at")
      .in("project_id", completedIds)
      .eq("status", "completed")
      .not("output_url", "is", null)
      .order("created_at", { ascending: false });
    for (const r of renders ?? []) {
      if (!videoByProject.has(r.project_id)) videoByProject.set(r.project_id, r.output_url);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    created_at: r.created_at,
    badgeVariant: badgeVariantFor(r.status),
    videoUrl: videoByProject.get(r.id) ?? null,
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

export default async function AvatarDashboardPage() {
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
              "radial-gradient(600px 220px at 80% 0%, rgba(56,189,248,0.18), transparent 60%), radial-gradient(500px 200px at 0% 100%, rgba(99,102,241,0.18), transparent 60%)",
          }}
        />
        <div className="relative max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 border border-sky-500/30 px-2.5 h-6 text-[11px] font-medium text-sky-300">
            <Bot className="h-3 w-3" /> AI Avatar
          </span>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-fg">
            Generate a video from a <span className="gradient-text">script and a photo</span>.
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            Upload a transcript or voiceover and an avatar image. We generate the voiceover, images, animated clips, and avatar videos, then render the final cut.
          </p>
        </div>
      </section>

      {/* New project */}
      <Card>
        <CardHeader>
          <CardTitle>New AI avatar video</CardTitle>
          <CardDescription>Name it now — you&apos;ll attach the script, voiceover, and avatar image on the next screen.</CardDescription>
        </CardHeader>
        <CardContent>
          <NewAvatarForm />
        </CardContent>
      </Card>

      {!isSupabaseConfigured() && (
        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="text-danger">Supabase not configured</CardTitle>
            <CardDescription>
              Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY in <code>.env.local</code>. See{" "}
              <Link className="underline text-brand-300" href="/settings">settings</Link>.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Recent projects */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-fg-muted">Recent AI avatar videos</h2>
          <span className="text-xs text-fg-subtle tabular-nums">{projects.length} total</span>
        </div>
        {projects.length === 0 ? (
          <EmptyState
            icon={<Bot className="h-5 w-5" />}
            title="No AI avatar videos yet"
            description="Start one above — paste a script and upload an avatar photo."
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

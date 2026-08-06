import Link from "next/link";
import { Bot, AlertTriangle } from "lucide-react";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";
import { getGeminiImageBudgetStatus } from "@/lib/synthetic/gemini-image";
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

export default async function AvatarDashboardPage() {
  const [projects, geminiBudget] = await Promise.all([
    loadProjects(),
    getGeminiImageBudgetStatus(),
  ]);

  return (
    <div className="px-6 lg:px-8 py-8 max-w-7xl mx-auto space-y-10">
      {/* Gemini image fallback budget — the paid safety net behind 69labs.
          Amber from 80% of the monthly cap, red at the cap (fallback refusing,
          so image failures surface instead of billing Google). Hidden below
          the warning threshold and when Redis is unreachable. */}
      {geminiBudget && (geminiBudget.warning || geminiBudget.exhausted) && (
        <div
          className={`flex items-start gap-3 rounded-[14px] border p-4 text-sm ${
            geminiBudget.exhausted
              ? "border-danger/50 bg-danger/10 text-danger"
              : "border-amber-500/40 bg-amber-500/10 text-amber-300"
          }`}
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              {geminiBudget.exhausted
                ? `Gemini image budget exhausted (${geminiBudget.used}/${geminiBudget.cap} this month)`
                : `Gemini image budget warning: ${geminiBudget.used}/${geminiBudget.cap} images used this month`}
            </p>
            <p className="mt-0.5 opacity-80">
              These are paid Gemini generations used only when the 69labs image pool fails
              (usually out of credits).{" "}
              {geminiBudget.exhausted
                ? "New fallback generations are now blocked — top up 69labs credits, or raise GEMINI_IMAGE_MONTHLY_CAP if the extra Gemini spend is intended."
                : "Check the 69labs account credits — heavy fallback use means the primary pool is failing."}
            </p>
          </div>
        </div>
      )}

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

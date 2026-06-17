import { ProjectWorkspace } from "./workspace";
import { SyntheticWorkspace } from "./synthetic-workspace";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";

// Next.js 16 — params and searchParams are async on pages.
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const autoAnalyze = sp.analyze === "1";

  // Route synthetic projects to their own workspace. The sourced ProjectWorkspace
  // is left COMPLETELY untouched — a synthetic project never enters it.
  let engine: string | null = null;
  if (isSupabaseConfigured()) {
    const sb = getServerSupabase();
    const { data } = await sb.from("projects").select("engine").eq("id", id).single();
    engine = (data?.engine as string | null) ?? null;
  }

  if (engine === "synthetic") {
    return <SyntheticWorkspace projectId={id} />;
  }
  return <ProjectWorkspace projectId={id} autoAnalyze={autoAnalyze} />;
}

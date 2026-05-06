import { getServerSupabase } from "@/lib/supabase/server";
import type { MediaJobStatus, MediaJobType, ProjectStatus } from "@/lib/types";

export async function createMediaJob(input: {
  projectId: string;
  type: MediaJobType;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("media_jobs")
    .insert({
      project_id: input.projectId,
      type: input.type,
      status: "queued",
      metadata: input.metadata ?? {},
    })
    .select("id")
    .single();
  if (error) throw new Error(`createMediaJob: ${error.message}`);
  return data.id as string;
}

export async function setMediaJob(
  id: string,
  patch: { status?: MediaJobStatus; progress?: number; error?: string | null; metadata?: Record<string, unknown> }
): Promise<void> {
  const sb = getServerSupabase();
  // Bump attempts on transition to "running" to mirror BullMQ retries.
  // Also merge metadata instead of replacing it: callers commonly write a
  // partial patch (e.g. just { currentClip }) and used to silently wipe
  // earlier fields like videoSourceId, title, youtube_video_id — which is
  // why the UI was rendering "Unknown video" rows after the first progress
  // update on a download.
  const needsRead = patch.status === "running" || patch.metadata != null;
  const update: Record<string, unknown> = { ...patch };
  if (needsRead) {
    const { data: cur } = await sb
      .from("media_jobs")
      .select("attempts, metadata")
      .eq("id", id)
      .single();
    if (patch.status === "running") {
      update.attempts = (cur?.attempts ?? 0) + 1;
    }
    if (patch.metadata != null) {
      const prior = (cur?.metadata as Record<string, unknown> | null) ?? {};
      update.metadata = { ...prior, ...patch.metadata };
    }
  }
  const { error } = await sb.from("media_jobs").update(update).eq("id", id);
  if (error) throw new Error(`setMediaJob: ${error.message}`);
}

export async function setProjectStatus(projectId: string, status: ProjectStatus): Promise<void> {
  const sb = getServerSupabase();
  const { error } = await sb.from("projects").update({ status }).eq("id", projectId);
  if (error) throw new Error(`setProjectStatus: ${error.message}`);
}

export async function logJob(
  scope: { projectId?: string; jobId?: string; sourceId?: string },
  msg: string,
  extra?: Record<string, unknown>
): Promise<void> {
  // Lightweight structured logger. Stays in stdout for the worker process.
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts, ...scope, msg, ...extra }));
}

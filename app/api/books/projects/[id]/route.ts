import { ProjectId } from '@ebook/core';
import { container, json, error, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

// GET /api/projects/:id — project status + progress.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const project = await container().repositories.projects.findById(ProjectId.from(id));
  if (!project) return error('Not found', 404);
  if (project.ownerId !== userId) return error('Forbidden', 403);

  return json({
    id: id,
    status: project.status.value,
    pending: project.pendingCounts,
    error: project.error ?? null,
    options: {
      targetPages: project.options.targetPages,
      tone: project.options.tone,
    },
  });
}

// DELETE /api/projects/:id — cancel: drain queued jobs and mark the project cancelled.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const c = container();
  const project = await c.repositories.projects.findById(ProjectId.from(id));
  if (!project) return error('Not found', 404);
  if (project.ownerId !== userId) return error('Forbidden', 403);

  const removed = await c.queue.drain(id); // best-effort: remove not-yet-running jobs
  const cancelled = project.cancel(c.clock.now());
  if (cancelled.isFail()) return error(cancelled.error, 409);
  await c.repositories.projects.save(project);

  // Cancelling frees a concurrency slot — start the user's next queued book.
  const started = await c.useCases.startQueuedProjects.promoteForOwner(userId);

  return json({ cancelled: true, drainedJobs: removed, status: project.status.value, startedQueued: started });
}

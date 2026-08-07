import { ProjectId } from '@ebook/core';
import { container, json, error, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

// POST /api/projects/:id/retry — re-enqueue failed stages of a FAILED project.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const c = container();
  const project = await c.repositories.projects.findById(ProjectId.from(id));
  if (!project) return error('Not found', 404);
  if (project.ownerId !== userId) return error('Forbidden', 403);

  const { retried, stage } = await c.orchestrator.resume(id);
  if (retried === 0) return error('Nothing to retry (project is not in a retryable failed state)', 409);

  return json({ retried, stage: stage ?? null }, 202);
}

import { z } from 'zod';
import { ProjectId } from '@ebook/core';
import { container, json, error, parseBody, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

const Body = z.object({ projectId: z.string().uuid(), content: z.string().max(200_000) });

// PATCH /api/book-sections/:id — manual edit of a front/back matter section
// (preface, acknowledgments, introduction, conclusion, …).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;

  const c = container();
  const project = await c.repositories.projects.findById(ProjectId.from(body.data.projectId));
  if (!project || project.ownerId !== userId) return error('Forbidden', 403);

  const result = await c.useCases.editBookSection.execute({
    projectId: body.data.projectId,
    sectionId: id,
    content: body.data.content,
  });
  if (result.isFail()) return error(result.error, 422);
  return json({ saved: true, wordCount: result.value.wordCount });
}

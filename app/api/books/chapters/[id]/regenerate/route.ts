import { z } from 'zod';
import { container, json, error, parseBody } from '@/lib/ebook/server';

export const runtime = 'nodejs';

const Body = z.object({ projectId: z.string().uuid(), instructions: z.string().max(2000).optional() });

// POST /api/chapters/:id/regenerate — enqueue a regeneration job for one chapter.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password. This
  // handler needs no ownerId: the use case resolves the target from the
  // body's own ids, and there is only ever one owner.

  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;

  const result = await container().useCases.regenerateChapter.execute({
    projectId: body.data.projectId,
    chapterId: id,
    ...(body.data.instructions ? { instructions: body.data.instructions } : {}),
  });
  if (result.isFail()) return error(result.error, 422);
  return json({ accepted: true, inputHash: result.value.inputHash }, 202);
}

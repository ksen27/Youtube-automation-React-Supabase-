import { z } from 'zod';
import { container, json, error, parseBody } from '@/lib/ebook/server';

export const runtime = 'nodejs';

const Body = z.object({
  projectId: z.string().uuid(),
  chapterId: z.string().uuid(),
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(2000),
  position: z.number().int().min(0),
});

// POST /api/sections — add a new section to an existing chapter after generation.
export async function POST(req: Request) {
  // proxy.ts already gated this request behind the shared password. This
  // handler needs no ownerId: the use case resolves the target from the
  // body's own ids, and there is only ever one owner.

  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;

  const result = await container().useCases.addSection.execute(body.data);
  if (result.isFail()) return error(result.error, 422);
  return json({ sectionId: result.value.sectionId }, 201);
}

import { z } from 'zod';
import { container, json, error, parseBody } from '@/lib/ebook/server';

export const runtime = 'nodejs';

const Body = z.object({
  projectId: z.string().uuid(),
  kind: z.enum([
    'dedication',
    'introduction',
    'foreword',
    'conclusion',
    'acknowledgments',
    'faq',
    'bonus_chapter',
    'resources',
    'checklist',
    'glossary',
  ]),
  title: z.string().min(1).max(200),
  prompt: z.string().max(2000).optional(),
});

// POST /api/extras — add Phase 13 extra content (front/back matter).
// Short types generate inline; a bonus_chapter is queued and returns { queued: true }.
export async function POST(req: Request) {
  // proxy.ts already gated this request behind the shared password. This
  // handler needs no ownerId: the use case resolves the target from the
  // body's own ids, and there is only ever one owner.

  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;

  const result = await container().useCases.addExtraContent.execute(body.data);
  if (result.isFail()) return error(result.error, 422);
  return json({ sectionId: result.value.sectionId, queued: result.value.queued }, 201);
}

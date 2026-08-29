import { SubmitBookDto } from '@ebook/core';
import { container, json, error, parseBody, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

// POST /api/projects — submit a book for generation.
//
// A title and one or more reference books, which is what replaced the YouTube
// channel this route used to take. The title is the book's subject; the first
// reference is its voice.
export const POST = handle(async (req: Request) => {
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const body = await parseBody(req, SubmitBookDto);
  if (!body.ok) return body.res;

  const result = await container().useCases.submitBook.execute(userId, body.data);
  if (result.isFail()) return error(result.error, 422);
  // 202: accepted and queued, not finished — the book takes minutes. The
  // referenceTypeMismatch note rides along so the UI can warn without a second
  // request; it is advisory, and the book is already running.
  return json(result.value, 202);
});

// GET /api/projects — list the caller's projects (newest first) plus the
// concurrency budget, so the UI can show "2 of 3 running" without guessing the
// server-side cap.
export const GET = handle(async () => {
  const userId = ownerId();
  const c = container();
  const projects = await c.repositories.projects.listByOwner(userId);
  return json({ projects, limits: { maxActiveProjects: c.env.MAX_ACTIVE_PROJECTS_PER_USER } });
});

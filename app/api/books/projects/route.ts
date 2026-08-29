import { container, json, error, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

// POST /api/projects — book creation.
//
// GONE, deliberately: this used to submit a YouTube CHANNEL, and the whole
// ingest pipeline behind it (channel scan, transcripts, Whisper, per-video
// summaries, comment analysis) has been removed. Book creation is being rebuilt
// on REFERENCE BOOKS — the caller will supply a title and one or more reference
// books instead — and this endpoint returns 501 until that lands.
//
// A 501 rather than a deleted route: the form still posts here, and an explicit
// 'not built yet' is a better answer than a 404 that reads like a broken deploy.
export const POST = handle(async () => {
  return error('Book creation is being rebuilt on reference books and is temporarily unavailable.', 501);
});

// GET /api/projects — list the caller's projects (newest first) plus the
// concurrency budget, so the UI can show "2 of 3 running" without guessing the
// server-side cap.
export const GET = handle(async () => {
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();
  const c = container();
  const projects = await c.repositories.projects.listByOwner(userId);
  return json({ projects, limits: { maxActiveProjects: c.env.MAX_ACTIVE_PROJECTS_PER_USER } });
});

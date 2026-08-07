import { ProjectId } from '@ebook/core';
import { container, json, error, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

// GET /api/projects/:id/book — outline + chapters + sections (read model for the editor).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const c = container();
  const projectId = ProjectId.from(id);
  const project = await c.repositories.projects.findById(projectId);
  if (!project) return error('Not found', 404);
  if (project.ownerId !== userId) return error('Forbidden', 403);

  const book = await c.repositories.books.findByProject(projectId);
  if (!book) return json({ book: null });

  return json({
    book: {
      title: book.title,
      estimatedPages: book.estimatedPages(),
      outline: book.outline ? { version: book.outline.version, entries: book.outline.entries } : null,
      chapters: book.chapters.map((ch) => ({
        id: ch.id.value,
        position: ch.position,
        title: ch.title,
        topic: ch.topic,
        promise: ch.promise,
        keyPoints: ch.keyPoints,
        wordTarget: ch.wordTarget,
        wordCount: ch.totalWords(),
        status: ch.status,
        version: ch.version,
        content: ch.content,
        sections: ch.sections.map((s) => ({
          id: s.id.value,
          position: s.position,
          title: s.title,
          status: s.status,
          content: s.content,
        })),
      })),
      frontMatter: book.frontMatter().map((s) => ({ id: s.id.value, kind: s.kind, title: s.title, status: s.status, content: s.content })),
      backMatter: book.backMatter().map((s) => ({ id: s.id.value, kind: s.kind, title: s.title, status: s.status, content: s.content })),
    },
  });
}

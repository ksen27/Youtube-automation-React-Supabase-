import { ProjectId } from '@ebook/core';
import { container, json, error, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

/**
 * GET /api/projects/:id/landing-page/candidates
 *
 * The user's other finished books, for the three-book page's picker. Scoped to
 * the signed-in owner in the query itself — the caller never gets to say whose
 * books to list.
 */
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const c = container();
  const projectId = ProjectId.from(id);
  const project = await c.repositories.projects.findById(projectId);
  if (!project) return error('Not found', 404);
  if (project.ownerId !== userId) return error('Forbidden', 403);

  const candidates = await c.repositories.projects.listLandingCandidates(userId, projectId);

  return json({
    candidates: candidates.map((candidate) => ({
      projectId: candidate.projectId,
      title: candidate.bookTitle,      // Same channel as this project's — the picker defaults to these, since a
      // page carries one creator's avatar and one author bio.      createdAt: candidate.createdAt,
      // What this book already sells for, so choosing it fills the form in
      // rather than asking the seller to remember. `hasProduct` is the one the
      // UI acts on: it separates "ready to sell" from "still needs a Payhip
      // product", which is the difference between showing a link and showing a
      // Create button.
      priceCents: candidate.priceCents,
      compareAtCents: candidate.compareAtCents,
      checkoutUrl: candidate.checkoutUrl,
      hasProduct: Boolean(candidate.checkoutProductKey && candidate.checkoutUrl),
    })),
  });
});

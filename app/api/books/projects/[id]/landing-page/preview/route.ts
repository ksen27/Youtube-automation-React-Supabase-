import { ProjectId } from '@ebook/core';
import { container, error, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

/**
 * GET /api/projects/:id/landing-page/preview — the draft page itself, so the
 * user reads the real thing (in an iframe or a new tab) before publishing it.
 *
 * Served with a sandboxing CSP: the draft is generated HTML, and although the
 * renderer escapes everything, the preview runs on the app's own origin — where
 * the user's session cookie lives. The published page has no such neighbour.
 *
 * Inline script is permitted because the page's scroll reveals need it, and
 * because every script on the page is written by our own renderer — model prose
 * and the user's checkout URL are escaped into text and attribute context and
 * can never reach a script. The sandbox still withholds `allow-same-origin`, so
 * even if that reasoning were wrong the page runs in an opaque origin with no
 * access to the session cookie it sits beside.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const c = container();
  const project = await c.repositories.projects.findById(ProjectId.from(id));
  if (!project) return error('Not found', 404);
  if (project.ownerId !== userId) return error('Forbidden', 403);

  const page = await c.repositories.landingPages.findByProject(ProjectId.from(id));
  if (!page?.html) return error('No draft yet', 404);

  // Images are allowed from THIS origin, named explicitly rather than as
  // `'self'`. A cloned draft does not inline them — it references
  // `assets/cover.webp` beside it, which the sibling assets route serves — and
  // `'self'` would not match: the sandbox below deliberately withholds
  // allow-same-origin, so the document runs in an OPAQUE origin and `'self'`
  // resolves to that, not to the server. Naming the origin keeps the sandbox
  // intact and still reaches nothing but our own owner-checked route.
  const origin = new URL(req.url).origin;

  return new Response(page.html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        `default-src 'none'; img-src ${origin} data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; ` +
        "form-action 'none'; sandbox allow-scripts allow-popups",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

import { ProjectId } from '@ebook/core';
import { container, error, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

/** Where both a page's own images and a cloned template's assets live. */
const LANDING_BUCKET = 'ebook-landing-assets';

/**
 * GET /api/projects/:id/landing-page/assets/* — one file the draft references.
 *
 * The preview served HTML and nothing else, under `img-src data:`. A cloned
 * page does not inline its images: it references `assets/cover.webp` and
 * `assets/author.webp` as files deployed beside it, so every image in the
 * preview was both unserved and blocked, and the only way to see whether a page
 * looked right was to publish it and open the live site. Publishing to find out
 * what you are publishing is how a wrong cover, an empty FAQ grid and an
 * invented bundle each reached a public URL before anyone saw them.
 *
 * The path is resolved RELATIVE to the preview route, so `assets/cover.webp` in
 * the draft lands here without rewriting a single URL in the stored html — the
 * bytes previewed are the bytes that deploy.
 *
 * Two sources, in the order the deploy uses: the page's own images (cover,
 * portrait, brand mark) and then the template's rehosted assets. Both are read
 * with the service role from a private bucket, which is why this cannot be a
 * public storage URL and has to be an owner-checked route.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path } = await params;
  const userId = ownerId();
  if (!userId) return error('Ebook owner is not configured', 500);

  const c = container();
  const project = await c.repositories.projects.findById(ProjectId.from(id));
  if (!project) return error('Not found', 404);
  if (project.ownerId !== userId) return error('Forbidden', 403);

  const page = await c.repositories.landingPages.findByProject(ProjectId.from(id));
  if (!page) return error('No draft yet', 404);

  // The draft's own paths are all `assets/…`; anything else is not something
  // this page references, and a traversal attempt resolves to no match rather
  // than to a file, because the lookup is an equality test against a stored
  // list and never a filesystem join.
  const sitePath = `assets/${path.join('/')}`;

  const own = page.assets.find((a) => a.sitePath === sitePath);
  let storagePath = own?.storagePath ?? null;

  if (!storagePath && page.templateId) {
    const templateAssets = await c.repositories.landingTemplates.listAssets(page.templateId);
    storagePath = templateAssets.find((a) => a.sitePath === sitePath)?.storagePath ?? null;
  }
  if (!storagePath) return error('Not found', 404);

  const loaded = await c.storage.getBytes(LANDING_BUCKET, storagePath);
  if (loaded.isFail()) return error('Not found', 404);

  return new Response(Buffer.from(loaded.value.bytes), {
    headers: {
      'Content-Type': loaded.value.contentType || 'application/octet-stream',
      // A draft is rewritten in place on every regeneration, and a stale cover
      // in a preview is exactly the thing the preview exists to catch.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

import { ProjectId } from '@ebook/core';
import { container, json, error, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

/**
 * The bucket the covers and exports already live in.
 *
 * Prefixed `ebook-` like every other bucket this product uses: storage.buckets
 * is GLOBAL, not schema-scoped, so a bare `exports` would share a namespace with
 * anything the video engines add later (see migration 0031).
 */
const BUCKET = 'ebook-exports';

/** A portrait for a web page, not a camera original. */
const MAX_BYTES = 5_000_000;

/**
 * Only formats a browser will render inline. Checked against the decoded bytes
 * rather than the filename or the client-supplied type, both of which the
 * caller controls.
 */
const SIGNATURES: Array<{ type: string; ext: string; match: (b: Uint8Array) => boolean }> = [
  { type: 'image/png', ext: 'png', match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/jpeg', ext: 'jpg', match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/webp',
    ext: 'webp',
    match: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

/**
 * POST /api/projects/:id/landing-page/avatar — upload the author's photograph.
 *
 * Optional throughout: a page without one simply shows no portrait. The photo
 * is stored, not embedded here, because it has to survive regeneration.
 */
export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const c = container();
  const projectId = ProjectId.from(id);
  const project = await c.repositories.projects.findById(projectId);
  if (!project) return error('Not found', 404);
  if (project.ownerId !== userId) return error('Forbidden', 403);

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return error('Attach the photo as a "file" field', 400);
  if (file.size > MAX_BYTES) return error('That image is larger than 5MB — please upload a smaller one', 413);
  if (file.size === 0) return error('That file is empty', 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Sniffed from the bytes: a caller can name anything .png and can send any
  // content-type, and this file is later inlined into a published page.
  const kind = SIGNATURES.find((s) => s.match(bytes));
  if (!kind) return error('Upload a PNG, JPEG or WebP image', 415);

  // Overwrites the previous photo by design — a project has one author portrait,
  // and keeping every superseded upload would leak storage forever.
  const path = `${id}/landing/author.${kind.ext}`;
  const stored = await c.storage.put(BUCKET, path, bytes, kind.type);
  if (stored.isFail()) return error(stored.error, 502);

  project.updateLandingSettings({ landingAuthorPhotoPath: stored.value.path }, c.clock.now());
  await c.repositories.projects.save(project);

  return json({ path: stored.value.path });
});

/** DELETE — remove the photo, returning the page to no portrait. */
export const DELETE = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const c = container();
  const project = await c.repositories.projects.findById(ProjectId.from(id));
  if (!project) return error('Not found', 404);
  if (project.ownerId !== userId) return error('Forbidden', 403);

  const path = project.options.landingAuthorPhotoPath;
  if (path) {
    // Best-effort: the setting is what the page reads, so clearing it is what
    // actually removes the portrait. A stranded object is not worth failing on.
    await c.storage.remove(BUCKET, path);
  }
  project.updateLandingSettings({ landingAuthorPhotoPath: '' }, c.clock.now());
  await c.repositories.projects.save(project);

  return json({ removed: true });
});

import { z } from 'zod';
import { container, json, error, parseBody, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

// GET /api/books/references — the reference-book library, for the picker.
//
// Metadata only: a listing that embedded each reference's text would ship a
// hundred chapters of prose per row to render a title. See the repository port.
export const GET = handle(async () => {
  const books = await container().repositories.references.list(ownerId());
  return json({ references: books });
});

/**
 * Importing a book this system already generated.
 *
 * The only way into the library today. Uploads need a PDF/DOCX text extractor,
 * which does not exist yet — when it does it becomes a second branch here (or
 * its own presigned-upload route), not a change to this one.
 */
const ImportDto = z.object({
  projectId: z.string().uuid(),
  /** Printed on the new book's landing page when this reference supplies the voice. */
  author: z.string().trim().max(200).optional(),
});

// POST /api/books/references — add a finished project's book to the library.
export const POST = handle(async (req: Request) => {
  const body = await parseBody(req, ImportDto);
  if (!body.ok) return body.res;

  const result = await container().useCases.importGeneratedBook.execute({
    ownerId: ownerId(),
    projectId: body.data.projectId,
    author: body.data.author ?? null,
  });
  if (result.isFail()) return error(result.error, 422);
  // 202, not 201: the row exists, but its style profile is still being
  // extracted in the background, so the reference is not yet fully usable.
  return json(result.value, 202);
});

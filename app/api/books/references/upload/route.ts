import { z } from 'zod';
import { SUPPORTED_REFERENCE_TYPES, MAX_REFERENCE_BYTES } from '@ebook/core';
import { container, json, error, parseBody, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

const StartUploadDto = z.object({
  title: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(255),
  contentType: z.enum(SUPPORTED_REFERENCE_TYPES),
  size: z.number().int().positive().max(MAX_REFERENCE_BYTES),
});

// POST /api/books/references/upload — begin an upload.
//
// Returns a signed URL the BROWSER uploads the file to. The bytes never pass
// through this app: a reference book is a whole book, routinely past the
// ~4.5MB body limit a serverless route accepts, so proxying the file would fail
// for exactly the files this exists to take. The browser then calls
// POST .../upload/complete to start parsing.
export const POST = handle(async (req: Request) => {
  const body = await parseBody(req, StartUploadDto);
  if (!body.ok) return body.res;

  const result = await container().useCases.startReferenceUpload.execute({
    ownerId: ownerId(),
    ...body.data,
    byteSize: body.data.size,
  });
  if (result.isFail()) return error(result.error, 422);
  return json(result.value, 201);
});

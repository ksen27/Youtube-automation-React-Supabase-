import { z } from 'zod';
import { ReferenceBookId } from '@ebook/core';
import { container, json, error, parseBody, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

const CompleteDto = z.object({ referenceBookId: z.string().uuid() });

// POST /api/books/references/upload/complete — the browser finished uploading.
//
// Enqueues parsing rather than doing it here: a 300-page PDF is seconds of CPU,
// long enough to time out a serverless handler. The reference stays PENDING and
// the library shows it as still being read.
export const POST = handle(async (req: Request) => {
  const body = await parseBody(req, CompleteDto);
  if (!body.ok) return body.res;

  const c = container();
  // Ownership is checked here, not in the job: the job runs with no caller, and
  // by then the only thing to do with a foreign id would be to refuse silently.
  const reference = await c.repositories.references.findById(ReferenceBookId.from(body.data.referenceBookId));
  if (!reference || reference.ownerId !== ownerId()) return error('Reference book not found', 404);

  await c.queue.enqueue(
    'reference-ingest',
    { referenceBookId: body.data.referenceBookId },
    { jobId: `reference-ingest:${body.data.referenceBookId}` },
  );
  // 202: the file is stored, but it is not a usable reference until it has been
  // parsed and its style read.
  return json({ referenceBookId: body.data.referenceBookId, status: 'PENDING' }, 202);
});

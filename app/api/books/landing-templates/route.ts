import { z } from 'zod';
import { LANDING_PIPELINE_VERSION } from '@ebook/core';
import { container, json, error, parseBody, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

const ExtractDto = z.object({
  sourceUrl: z.string().url().max(2000),
  /**
   * The user's assertion that they may copy this template.
   *
   * Required and recorded. The system makes a COMPLETE copy of the page, which
   * is a different act from taking inspiration from it, and that is not a call
   * the system is entitled to make on the seller's behalf.
   */
  attestOwnership: z.literal(true),
  force: z.boolean().default(false),
});

// GET /api/landing-templates — every template this account has cloned.
export const GET = handle(async () => {
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const templates = await container().repositories.landingTemplates.listByOwner(userId);
  return json({
    templates: templates.map((t) => ({
      id: t.id,
      sourceUrl: t.sourceUrl,
      name: t.name,
      state: t.state,
      revision: t.revision,
      capturedAt: t.capturedAt?.toISOString() ?? null,
      failureReason: t.failureReason,
      placeholderCount: t.placeholders.length,
      repeaterCount: t.repeaters.length,
      sectionCount: t.report?.sectionCount ?? 0,
      // The two numbers that decide whether a template is worth building on.
      cleaningLoss: t.report?.cleaningLoss.find((c) => c.width === 1280)?.mismatchRatio ?? null,
      fontFidelity: t.report?.fontFidelity ?? null,
      warnings: (t.report?.findings ?? []).filter((f) => f.severity !== 'INFO').length,
      // A template captured at an older pipeline version re-extracts on next
      // use; surfaced so that is expected rather than surprising.
      stale: t.pipelineVersion !== LANDING_PIPELINE_VERSION,
    })),
  });
});

// POST /api/landing-templates — clone a template site.
export const POST = handle(async (req: Request) => {
  // proxy.ts already gated this request behind the shared password; the
  // sentinel owner is what the ported use cases expect.
  const userId = ownerId();

  const body = await parseBody(req, ExtractDto);
  if (!body.ok) return body.res;
  const c = container();

  const existing = await c.repositories.landingTemplates.findCurrent(
    userId,
    body.data.sourceUrl,
    LANDING_PIPELINE_VERSION,
  );
  if (existing?.state === 'EXTRACTING') {
    // Extraction holds a Chromium instance with six full-height screenshots in
    // memory; two at once on the same URL is wasted work either way.
    return error('This template is already being extracted — wait for it to finish', 409);
  }
  if (existing?.state === 'READY' && !body.data.force) {
    return json({ templateId: existing.id, alreadyExtracted: true });
  }

  // Queued rather than run inline: a browser session, six screenshots, an asset
  // sweep and a model call are well past a request's lifetime.
  const templateId = c.ids.uuid();
  await c.queue.enqueue(
    'landing-template',
    { templateId, ownerId: userId, sourceUrl: body.data.sourceUrl, force: body.data.force },
    { jobId: `landing-template:${userId}:${Date.now()}` },
  );
  return json({ queued: true, templateId }, 202);
});

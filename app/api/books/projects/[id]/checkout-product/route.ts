import type { NextResponse } from 'next/server';
import { ProjectId } from '@ebook/core';
import { container, json, error, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

/**
 * Listing a finished book on the store (Payhip), so its landing page has a real
 * buy link instead of one the seller created by hand and pasted in.
 *
 * The result is written to the SAME `landingCheckoutUrl` the settings form
 * writes, which is why the page renderers and the publish gate needed no
 * changes: as far as they are concerned the link simply got filled in.
 */

// PORT NOTE: the same discriminated-union shape the landing-page route uses —
// see the note there on why `exactOptionalPropertyTypes` makes this necessary.
type ProjectAuth =
  | { ok: false; res: NextResponse }
  | {
      ok: true;
      c: ReturnType<typeof container>;
      project: NonNullable<
        Awaited<ReturnType<ReturnType<typeof container>['repositories']['projects']['findById']>>
      >;
    };

async function authorize(id: string): Promise<ProjectAuth> {
  const userId = ownerId();
  if (!userId) return { ok: false, res: error('Ebook owner is not configured', 500) };
  const c = container();
  const project = await c.repositories.projects.findById(ProjectId.from(id));
  if (!project) return { ok: false, res: error('Not found', 404) };
  if (project.ownerId !== userId) return { ok: false, res: error('Forbidden', 403) };
  return { ok: true, c, project };
}

/**
 * GET — what the UI needs to decide whether to offer the button, and what to
 * show once a product exists.
 */
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;
  const { c, project } = auth;

  const productKey = project.options.landingCheckoutProductKey ?? null;
  return json({
    // Whether a Payhip session has been connected. Surfaced so the UI can say
    // "run `npm run payhip:connect`" instead of offering a button that always
    // fails.
    configured: c.checkoutPublisher.isConfigured(),
    // Set only when WE created the product; a hand-pasted link leaves it null,
    // which is exactly what makes "create" and "already created" distinguishable.
    productKey,
    buyUrl: project.options.landingCheckoutUrl ?? null,
    /** True when the checkout link came from us rather than from the form. */
    generated: Boolean(productKey && project.options.landingCheckoutUrl),
    // Named so a disabled button can explain itself rather than just sitting there.
    blockers: listBlockers(project),
  });
});

/**
 * POST — queue the listing.
 *
 * Queued rather than done inline: uploading a multi-megabyte PDF through a real
 * browser is minutes of work, far past a request's lifetime.
 */
export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;
  const { c, project } = auth;

  const force = new URL(req.url).searchParams.get('force') === 'true';

  // Already listed → hand back the stored link rather than queueing a job whose
  // only outcome would be to return the same thing. Also the last line of
  // defence against a double-click creating two products.
  if (!force && project.options.landingCheckoutProductKey && project.options.landingCheckoutUrl) {
    return json({
      queued: false,
      reused: true,
      productKey: project.options.landingCheckoutProductKey,
      buyUrl: project.options.landingCheckoutUrl,
    });
  }

  // Checked here so the seller is told what to fix while looking at the form,
  // rather than minutes later in a failed job. The use case re-checks all of
  // this — a queue can be posted to directly — but a 422 now beats a failure then.
  const blockers = listBlockers(project);
  if (blockers.length > 0) return error(blockers[0] as string, 422);
  if (!c.checkoutPublisher.isConfigured()) {
    return error(
      'No Payhip session is connected. Run `npm run payhip:connect` on a machine with a display to log in once.',
      422,
    );
  }

  // The job id is per-project and NOT timestamped, unlike the landing-page
  // queue's. That is the point: BullMQ de-duplicates on it, so a second click
  // while the first run is still working joins the existing job instead of
  // starting a rival browser that would list the book a second time.
  await c.queue.enqueue(
    'checkout-product',
    { projectId: id, force },
    { jobId: `checkout-product:${id}` },
  );
  return json({ queued: true }, 202);
});

/** Why this book cannot be listed yet, in the order the seller should fix them. */
function listBlockers(project: { status: { value: string }; options: { landingPriceCents?: number | undefined } }): string[] {
  const blockers: string[] = [];
  if (project.status.value !== 'COMPLETED') {
    blockers.push('The book must finish generating before it can be listed for sale');
  }
  if (project.options.landingPriceCents === undefined) {
    blockers.push('Set the price before creating the product — the store needs one');
  }
  return blockers;
}

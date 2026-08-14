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
  // Re-read rather than trusting the boot-time cache. `isConfigured()` is
  // synchronous by the port's contract, so the publisher answers from a value
  // resolved when the container was built — which means a session connected
  // just now would not be noticed until the server restarted, and the operator
  // would be staring at a disabled button they had already done the work to
  // enable. One indexed lookup per card load is a fair price for that.
  const configured = await c.checkoutPublisher.warmUp().catch(() => false);
  return json({
    // Whether a Payhip session has been connected. Surfaced so the UI can say
    // "run `npm run payhip:connect`" instead of offering a button that always
    // fails.
    configured,
    // Set only when WE created the product; a hand-pasted link leaves it null,
    // which is exactly what makes "create" and "already created" distinguishable.
    productKey,
    buyUrl: project.options.landingCheckoutUrl ?? null,
    /** True when the checkout link came from us rather than from the form. */
    generated: Boolean(productKey && project.options.landingCheckoutUrl),
    // Only the blockers the FORM CANNOT FIX.
    //
    // The price is deliberately not among them, even though creating without
    // one fails. These blockers disable the Create button, and the price the
    // server knows about is the SAVED one — while the button is what saves the
    // form. Reporting an unsaved price as a blocker therefore disabled the only
    // control that could clear it: type a price, watch the button stay grey
    // forever. The form validates the price itself, from what is on screen,
    // which is both accurate and instant. POST still rejects a missing one, so
    // a caller going straight to the API is not let through.
    blockers: unfixableBlockers(project),
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
  //
  // But de-duplication does not expire, and failed jobs are kept for
  // inspection — so the first failure owned this id permanently and every later
  // click was silently dropped, with no job, no log, and a button that appeared
  // to do nothing. Clearing a FINISHED job first restores retries while keeping
  // the guarantee that matters: a run still in flight is never duplicated.
  const jobId = `checkout-product:${id}`;
  const prior = await c.queue.settleState('checkout-product', jobId);
  if (prior === 'pending') {
    return json({ queued: true, alreadyRunning: true }, 202);
  }

  await c.queue.enqueue('checkout-product', { projectId: id, force }, { jobId });
  return json({ queued: true }, 202);
});

type BlockerCheck = { status: { value: string }; options: { landingPriceCents?: number | undefined } };

/**
 * Reasons no amount of form-filling will help — the ones worth disabling the
 * Create button over. Today that is just an unfinished book: the seller has to
 * wait, and no keystroke changes that.
 */
function unfixableBlockers(project: BlockerCheck): string[] {
  const blockers: string[] = [];
  if (project.status.value !== 'COMPLETED') {
    blockers.push('The book must finish generating before it can be listed for sale');
  }
  return blockers;
}

/**
 * Everything that must be true before a listing is queued, checked against the
 * SAVED project. Used only by POST — see the note on `blockers` above for why
 * the price must not reach the button's disabled state.
 */
function listBlockers(project: BlockerCheck): string[] {
  const blockers = unfixableBlockers(project);
  if (project.options.landingPriceCents === undefined) {
    blockers.push('Set the price before creating the product — the store needs one');
  }
  return blockers;
}

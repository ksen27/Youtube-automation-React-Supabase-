import type { NextResponse } from 'next/server';
import { LandingSettingsDto, ProjectId } from '@ebook/core';
import { container, json, error, parseBody, handle, ownerId } from '@/lib/ebook/server';

export const runtime = 'nodejs';

// PORT NOTE: explicit DISCRIMINATED union (the `ok` flag) rather than upstream's
// `{ res } | { c, project }` shape, which relies on `exactOptionalPropertyTypes`
// — set in upstream's tsconfig, absent here. Without it `'res' in auth` leaves
// `auth.res` possibly-undefined and widens every handler's return type.
type ProjectAuth =
  | { ok: false; res: NextResponse }
  | { ok: true; c: ReturnType<typeof container>; project: NonNullable<Awaited<ReturnType<ReturnType<typeof container>['repositories']['projects']['findById']>>> };

/** Load the project and confirm the caller owns it. */
async function authorize(id: string): Promise<ProjectAuth> {
  const userId = ownerId();
  if (!userId) return { ok: false, res: error('Ebook owner is not configured', 500) };
  const c = container();
  const project = await c.repositories.projects.findById(ProjectId.from(id));
  if (!project) return { ok: false, res: error('Not found', 404) };
  if (project.ownerId !== userId) return { ok: false, res: error('Forbidden', 403) };
  return { ok: true, c, project };
}

// GET /api/projects/:id/landing-page — settings + current draft/published state.
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;
  const { c, project } = auth;

  const page = await c.repositories.landingPages.findByProject(ProjectId.from(id));
  return json({
    settings: {
      enabled: project.options.landingPage,
      checkoutUrl: project.options.landingCheckoutUrl ?? '',
      templateUrl: project.options.landingTemplateUrl ?? '',
      templateId: project.options.landingTemplateId ?? '',
      // Which renderer will run. Surfaced so the UI can say so BEFORE the user
      // presses Generate — v1 decided this silently and told nobody.
      engine: project.options.landingEngine,
      priceCents: project.options.landingPriceCents ?? null,
      compareAtCents: project.options.landingCompareAtCents ?? null,
      currency: project.options.landingCurrency,
      guaranteeDays: project.options.landingGuaranteeDays,
      mode: project.options.landingMode,
      siblings: project.options.landingSiblings.map((s) => ({
        projectId: s.projectId,
        priceCents: s.priceCents ?? null,
        compareAtCents: s.compareAtCents ?? null,
        checkoutUrl: s.checkoutUrl ?? '',
      })),
      bundlePriceCents: project.options.landingBundlePriceCents ?? null,
      bundleCheckoutUrl: project.options.landingBundleCheckoutUrl ?? '',
      authorPhotoPath: project.options.landingAuthorPhotoPath ?? '',
    },
    page: page
      ? {
          state: page.state,
          url: page.url,
          error: page.error,
          hasDraft: page.html !== null,
          updatedAt: page.updatedAt.toISOString(),
          engine: page.engine,
          templateId: page.templateId,
          // The verification report. `blockers` is what stops a publish, and
          // naming them is the difference between a greyed-out button and a
          // user who can act.
          fidelity: page.fidelity,
          isPublishable: page.isPublishable,
          blockers: page.blockers,
        }
      : null,
    // Surfaced so the UI can explain a disabled Publish button instead of
    // failing the request after the user clicks it.
    // Verification findings are reported (`blockers` above) but no longer part
    // of this: the seller reviews the rendered page and decides.
    canPublish:
      c.sitePublisher.isConfigured() && project.options.missingCheckoutPositions().length === 0,
    // Which books still need a buy link, so the UI can name them rather than
    // just greying the button out.
    missingCheckoutPositions: project.options.missingCheckoutPositions(),
    publisherConfigured: c.sitePublisher.isConfigured(),
  });
});

// PATCH /api/projects/:id/landing-page — update price / checkout link / guarantee.
export const PATCH = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;
  const { c, project } = auth;

  const body = await parseBody(req, LandingSettingsDto);
  if (!body.ok) return body.res;

  project.updateLandingSettings(body.data, c.clock.now());
  await c.repositories.projects.save(project);
  return json({ saved: true });
});

// POST /api/projects/:id/landing-page — (re)generate the draft, optionally publishing.
export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;
  const { c, project } = auth;

  if (project.status.value !== 'COMPLETED') {
    return error('The book must finish generating before its landing page can be written', 409);
  }

  const params_ = new URL(req.url).searchParams;
  const publish = params_.get('publish') === 'true';
  // Opt-in: without it the stored layout is reused, which is what keeps every
  // page on a template identical.
  const rebuildLayout = params_.get('rebuildLayout') === 'true';
  const missingCheckout = project.options.missingCheckoutPositions();
  if (publish && missingCheckout.length > 0) {
    return error(
      project.options.isTripleLanding
        ? `Add a checkout link for ${missingCheckout.length === 1 ? 'book' : 'books'} ${missingCheckout.join(', ')} before publishing`
        : 'Add your checkout link before publishing',
      422,
    );
  }

  // One generation at a time per project. The job id carries a timestamp, so
  // every click enqueues a distinct job and the queue runs three at once —
  // duplicates for the same project then contend on the same landing_pages row
  // and burn a full Opus layout call each.
  const existing = await c.repositories.landingPages.findByProject(ProjectId.from(id));
  if (existing?.state === 'GENERATING') {
    // Stale guard: a worker that died mid-run would otherwise lock the project
    // out for good.
    const startedMsAgo = Date.now() - existing.updatedAt.getTime();
    if (startedMsAgo < 10 * 60_000) {
      return error('This page is already being generated — wait for it to finish before starting another', 409);
    }
  }

  // Queued rather than run inline: an Opus call plus a Netlify deploy is well
  // past a request's lifetime, and this way it retries like everything else.
  await c.queue.enqueue(
    'landing-page',
    { projectId: id, mode: 'generate', publish, rebuildLayout },
    { jobId: `landing-page:${id}:manual:${Date.now()}` },
  );
  return json({ queued: true, willPublish: publish, rebuildLayout }, 202);
});

// PUT /api/projects/:id/landing-page — publish the existing draft as-is.
export const PUT = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const auth = await authorize(id);
  if (!auth.ok) return auth.res;
  const { c, project } = auth;

  if (!project.options.hasCheckoutUrl) return error('Add your checkout link before publishing', 422);

  const page = await c.repositories.landingPages.findByProject(ProjectId.from(id));
  if (!page?.html) return error('Generate the page before publishing it', 409);

  await c.queue.enqueue(
    'landing-page',
    { projectId: id, mode: 'publish', publish: true },
    { jobId: `landing-page:${id}:publish:${Date.now()}` },
  );
  return json({ queued: true }, 202);
});

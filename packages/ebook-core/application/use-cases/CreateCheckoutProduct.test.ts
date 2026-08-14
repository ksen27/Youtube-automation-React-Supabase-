import { describe, it, expect, vi } from 'vitest';
import { CreateCheckoutProductUseCase } from './CreateCheckoutProductUseCase';
import { Project } from '../../domain/project/Project';
import { ProjectId } from '../../domain/project/ProjectId';
import { GenerationOptions } from '../../domain/project/GenerationOptions';
import { ChannelUrl } from '../../domain/channel/ChannelUrl';
import { ExportArtifact } from '../../domain/export/ExportArtifact';
import { BookStrategy } from '../../domain/book/BookStrategy';
import { Result } from '../../domain/shared/Result';
import type {
  CheckoutProductDraft,
  CheckoutProductPublisher,
} from '../ports/services/CheckoutProductPublisher';

/**
 * The use case that turns a finished book into a store product.
 *
 * Everything here runs against a FAKE publisher — no browser, no network, no
 * Payhip. That boundary is the point of the port: the rules worth testing (when
 * we refuse to create, when we refuse to create AGAIN, what the seller is told
 * when it fails) are all on this side of it, and none of them need a browser to
 * exercise.
 */

const now = new Date('2026-08-14T00:00:00Z');
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function makeProject(options: Partial<Parameters<typeof GenerationOptions.create>[0]> = {}): Project {
  const project = Project.create({
    id: ProjectId.from(PROJECT_ID),
    ownerId: 'owner',
    channelUrl: ChannelUrl.create('https://www.youtube.com/@example').value,
    options: GenerationOptions.create({
      bookTitle: 'The Mechanic Bible',
      landingPage: true,
      landingPriceCents: 1900,
      ...options,
    }),
    now,
  }).value;
  // The book has to be finished before it can be sold; tests that care about
  // the unfinished case override this.
  forceStatus(project, 'COMPLETED');
  return project;
}

/**
 * Drop a project straight into a terminal state.
 *
 * The real pipeline walks fifteen transitions to get here and none of them are
 * what these tests are about, so the status is set directly rather than
 * simulated.
 */
function forceStatus(project: Project, status: string): void {
  (project as unknown as { props: { status: { value: string } } }).props.status = {
    value: status,
  } as never;
}

/** A publisher that succeeds, and records what it was asked to publish. */
function fakePublisher(
  overrides: Partial<CheckoutProductPublisher> = {},
): CheckoutProductPublisher & { drafts: CheckoutProductDraft[] } {
  const drafts: CheckoutProductDraft[] = [];
  return {
    drafts,
    isConfigured: () => true,
    createProduct: async (draft) => {
      drafts.push(draft);
      return Result.ok({ productKey: 'AbC12', buyUrl: 'https://payhip.com/b/AbC12', createdAt: now });
    },
    ...overrides,
  };
}

function build(input: {
  project?: Project;
  publisher?: CheckoutProductPublisher;
  artifacts?: ExportArtifact[];
  bookTitle?: string | null;
  coverPath?: string | null;
  storageFails?: boolean;
}) {
  const project = input.project ?? makeProject();
  const saved: Project[] = [];

  const projects = {
    findById: async () => project,
    save: async (p: Project) => {
      saved.push(p);
    },
  } as never;

  const books = {
    findSummaryByProject: async () => ({
      title: input.bookTitle === undefined ? 'The Mechanic Bible' : input.bookTitle,
      coverImagePath: input.coverPath === undefined ? 'covers/book-1.png' : input.coverPath,
      chapterTitles: ['Reading the dashboard', 'Brakes'],
      outline: [],
      hasChapters: true,
    }),
  } as never;

  const knowledge = {
    getBookStrategy: async () =>
      BookStrategy.create({
        title: 'The Mechanic Bible',
        subtitle: 'Fix it yourself',
        targetAudience: 'owners',
        corePromise: 'Stop paying for what you can do in an hour',
        transformation: 'From helpless to handy',
        authorVoice: 'plain',
        tone: 'practical',
        chapterCount: 2,
        targetWordCount: 20000,
        uniqueSellingProposition: 'usp',
        keyPrinciples: [],
        inputHash: 'h',
      }),
  } as never;

  const artifacts = {
    listByProject: async () =>
      input.artifacts ?? [
        ExportArtifact.create({
          projectId: PROJECT_ID,
          format: 'pdf',
          storagePath: 'exports/book-v1.pdf',
          byteSize: 1024,
          pageCount: 120,
          bookVersion: 1,
        }),
      ],
  } as never;

  const storage = {
    getBytes: async () =>
      input.storageFails
        ? Result.fail('object not found')
        : Result.ok({ bytes: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' }),
  } as never;

  const publisher = input.publisher ?? fakePublisher();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  } as never;

  const useCase = new CreateCheckoutProductUseCase(
    projects,
    books,
    knowledge,
    artifacts,
    storage,
    publisher,
    { now: () => now },
    logger,
  );
  return { useCase, project, saved, publisher };
}

describe('creating the store product', () => {
  it('publishes the book and writes the buy link back onto the project', async () => {
    const { useCase, saved } = build({});

    const result = await useCase.execute({ projectId: PROJECT_ID });

    if (result.isFail()) throw new Error(result.error.message);
    expect(result.value).toEqual({
      productKey: 'AbC12',
      buyUrl: 'https://payhip.com/b/AbC12',
      reused: false,
    });
    // The whole point of the feature: the link lands in the SAME field the
    // settings form writes, so both page renderers pick it up unchanged.
    expect(saved).toHaveLength(1);
    expect(saved[0]?.options.landingCheckoutUrl).toBe('https://payhip.com/b/AbC12');
    expect(saved[0]?.options.landingCheckoutProductKey).toBe('AbC12');
  });

  it('sends the newest export, not the first one it finds', async () => {
    const publisher = fakePublisher();
    const { useCase } = build({
      publisher,
      artifacts: [
        ExportArtifact.create({ projectId: PROJECT_ID, format: 'pdf', storagePath: 'exports/v1.pdf', byteSize: 1, pageCount: 100, bookVersion: 1 }),
        ExportArtifact.create({ projectId: PROJECT_ID, format: 'pdf', storagePath: 'exports/v3.pdf', byteSize: 1, pageCount: 130, bookVersion: 3 }),
        ExportArtifact.create({ projectId: PROJECT_ID, format: 'pdf', storagePath: 'exports/v2.pdf', byteSize: 1, pageCount: 120, bookVersion: 2 }),
      ],
    });

    await useCase.execute({ projectId: PROJECT_ID });

    // Selling an older build than the one the seller is looking at is worse
    // than failing, so the highest bookVersion has to win.
    expect(publisher.drafts).toHaveLength(1);
    expect(publisher.drafts[0]?.pdf.filename).toBe('The-Mechanic-Bible.pdf');
  });

  it('prices the product from the project settings', async () => {
    const publisher = fakePublisher();
    const { useCase } = build({ publisher, project: makeProject({ landingPriceCents: 3700, landingCurrency: 'gbp' }) });

    await useCase.execute({ projectId: PROJECT_ID });

    expect(publisher.drafts[0]?.priceCents).toBe(3700);
    expect(publisher.drafts[0]?.currency).toBe('GBP');
  });

  it('carries our project id so a lost product can be recognised later', async () => {
    const publisher = fakePublisher();
    const { useCase } = build({ publisher });

    await useCase.execute({ projectId: PROJECT_ID });

    expect(publisher.drafts[0]?.externalId).toBe(PROJECT_ID);
  });
});

describe('the idempotency guard', () => {
  /**
   * The failure this whole feature is one click away from: pressing the button
   * twice and listing the same book on the store twice, which costs the seller
   * a duplicate product and any buyer who lands on the wrong one.
   */
  it('returns the stored link instead of creating a second product', async () => {
    const publisher = fakePublisher();
    const { useCase, saved } = build({
      publisher,
      project: makeProject({
        landingCheckoutUrl: 'https://payhip.com/b/EXIST',
        landingCheckoutProductKey: 'EXIST',
      }),
    });

    const result = await useCase.execute({ projectId: PROJECT_ID });

    if (result.isFail()) throw new Error(result.error.message);
    expect(result.value).toEqual({ productKey: 'EXIST', buyUrl: 'https://payhip.com/b/EXIST', reused: true });
    // Short-circuited BEFORE the browser: nothing published, nothing written.
    expect(publisher.drafts).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('does not short-circuit on a hand-pasted link, which has no product key', async () => {
    const publisher = fakePublisher();
    const { useCase } = build({
      publisher,
      // A link the seller typed in themselves. We never created that product,
      // so "already created" is not something we can claim.
      project: makeProject({ landingCheckoutUrl: 'https://gumroad.com/l/thing' }),
    });

    const result = await useCase.execute({ projectId: PROJECT_ID });

    if (result.isFail()) throw new Error(result.error.message);
    expect(result.value.reused).toBe(false);
    expect(publisher.drafts).toHaveLength(1);
  });

  it('creates a new product when the caller explicitly forces it', async () => {
    const publisher = fakePublisher();
    const { useCase } = build({
      publisher,
      project: makeProject({
        landingCheckoutUrl: 'https://payhip.com/b/DEAD',
        landingCheckoutProductKey: 'DEAD',
      }),
    });

    // The escape hatch for a product the seller deleted on the store.
    const result = await useCase.execute({ projectId: PROJECT_ID, force: true });

    if (result.isFail()) throw new Error(result.error.message);
    expect(result.value.productKey).toBe('AbC12');
    expect(publisher.drafts).toHaveLength(1);
  });
});

describe('refusing to publish', () => {
  it('refuses an unfinished book', async () => {
    const project = makeProject();
    forceStatus(project, 'GENERATING_CHAPTERS');
    const publisher = fakePublisher();
    const { useCase } = build({ project, publisher });

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.kind).toBe('rejected');
    expect(publisher.drafts).toHaveLength(0);
  });

  it('refuses a book with no price — the store needs one', async () => {
    const publisher = fakePublisher();
    const { useCase } = build({ publisher, project: makeProject({ landingPriceCents: undefined }) });

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.message).toMatch(/price/i);
  });

  it('refuses when the book has never been exported — there is nothing to sell', async () => {
    const publisher = fakePublisher();
    const { useCase } = build({ publisher, artifacts: [], project: makeProject() });

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.message).toMatch(/export/i);
    expect(publisher.drafts).toHaveLength(0);
  });

  it('reports an unreadable PDF as transient, not as a rejection', async () => {
    // Storage being briefly unhappy is worth another go; a book with no price
    // is not. The distinction is what decides whether a retry is pointless.
    const { useCase } = build({ storageFails: true });

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.kind).toBe('transient');
  });

  it('tells the operator to connect a session when none is stored', async () => {
    const publisher = fakePublisher({ isConfigured: () => false });
    const { useCase } = build({ publisher });

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.kind).toBe('not-configured');
    // The message has to name the command, because the operator reading it is
    // the only thing that can fix it.
    expect(result.error.message).toMatch(/payhip:connect/);
  });
});

describe('when the store refuses', () => {
  it('passes the failure through untouched and writes nothing', async () => {
    const publisher = fakePublisher({
      createProduct: async () =>
        Result.fail({
          kind: 'session-expired' as const,
          message: 'Payhip session expired — re-run `npm run payhip:connect`',
          debugPaths: ['/tmp/payhip-debug/p_attempt1.png'],
        }),
    });
    const { useCase, saved } = build({ publisher });

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.isFail()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.kind).toBe('session-expired');
    // The screenshot path survives all the way to the operator — a bare
    // "it failed" is not something anyone can act on.
    expect(result.error.debugPaths).toEqual(['/tmp/payhip-debug/p_attempt1.png']);
    // Nothing half-written: no link, no key.
    expect(saved).toHaveLength(0);
  });
});

describe('the cover image', () => {
  it('lists the product without one rather than failing the run', async () => {
    // A listing with no image sells worse than one with an image, but it is
    // still a listing — and by this point the PDF may already have uploaded.
    const publisher = fakePublisher();
    const { useCase } = build({ publisher, coverPath: null });

    const result = await useCase.execute({ projectId: PROJECT_ID });

    expect(result.isOk()).toBe(true);
    expect(publisher.drafts[0]?.cover).toBeUndefined();
  });
});

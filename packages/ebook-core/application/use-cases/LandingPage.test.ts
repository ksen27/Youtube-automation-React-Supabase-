import { describe, it, expect } from 'vitest';
import { GenerateLandingPageUseCase } from './GenerateLandingPageUseCase';
import { LandingLayoutPrompt, LANDING_LAYOUT_VERSION } from '../prompts/LandingLayoutPrompt';
import { PublishLandingPageUseCase } from './PublishLandingPageUseCase';
import { Project } from '../../domain/project/Project';
import { ProjectId } from '../../domain/project/ProjectId';
import { GenerationOptions } from '../../domain/project/GenerationOptions';
import { ChannelUrl } from '../../domain/channel/ChannelUrl';
import { Book } from '../../domain/book/Book';
import { Chapter } from '../../domain/book/Chapter';
import { BookId, ChapterId } from '../../domain/book/ids';
import { BookStrategy } from '../../domain/book/BookStrategy';
import { Channel } from '../../domain/channel/Channel';
import { LandingPage } from '../../domain/landing/LandingPage';
import { Result } from '../../domain/shared/Result';
import type { LandingPageRepository } from '../ports/repositories/LandingPageRepository';
import type { PublishInput, PublishOutput, SitePublisher } from '../ports/services/SitePublisher';
import type { LandingPageModel, LandingPageRenderer } from '../ports/services/LandingPageRenderer';

const now = new Date('2026-08-03T00:00:00Z');

// ── fakes ────────────────────────────────────────────────────────────────────

/** What the fake processor returns, so tests can assert an image was shrunk. */
const SHRUNK_URI = 'data:image/webp;base64,SHRUNK';

const FAKE_IMAGE_PROCESSOR = {
  downscaleToDataUri: async () => Result.ok(SHRUNK_URI),
  downscaleToJpeg: async () => Result.fail('not used here'),
} as never;

function makeProject(landing: Partial<Parameters<typeof GenerationOptions.create>[0]> = {}): Project {
  return Project.create({
    id: ProjectId.from('11111111-1111-4111-8111-111111111111'),
    ownerId: 'owner',
    channelUrl: ChannelUrl.create('https://www.youtube.com/@example').value,
    options: GenerationOptions.create({ bookTitle: 'The Mechanic Bible', landingPage: true, ...landing }),
    now,
  }).value;
}

function makeBook(): Book {
  const book = Book.create({ id: BookId.from('book-1'), projectId: 'p1', targetPages: 100 });
  book.setTitle('The Mechanic Bible');
  book.setCoverImagePath('covers/book-1.png');
  book.addChapter(
    Chapter.create({
      id: ChapterId.from('c1'),
      bookId: 'book-1',
      position: 1,
      title: 'Reading the dashboard',
      topic: 't',
      promise: 'p',
      keyPoints: [],
      wordTarget: 3000,
    }),
  );
  return book;
}


/** The landing page reads a summary, not the whole book aggregate. */
function makeBookSummary(over: { title?: string; hasChapters?: boolean } = {}) {
  return {
    title: over.title ?? 'The Mechanic Bible',
    coverImagePath: 'covers/book-1.png',
    chapterTitles: over.hasChapters === false ? [] : ['Reading the dashboard'],
    outline: [],
    hasChapters: over.hasChapters ?? true,
  };
}

class FakeLandingRepo implements LandingPageRepository {
  saves = 0;
  stateSaves = 0;
  constructor(private page: LandingPage | null = null) {}
  async findByProject(): Promise<LandingPage | null> {
    return this.page;
  }
  async save(page: LandingPage): Promise<void> {
    this.saves++;
    this.page = page;
  }
  /** State-only writes land in the same place for the fakes' purposes. */
  async saveState(page: LandingPage): Promise<void> {
    this.stateSaves++;
    this.page = page;
  }
  current(): LandingPage | null {
    return this.page;
  }
}

const COPY_JSON = JSON.stringify({
  eyebrow: 'For weekend mechanics',
  headline: 'Stop paying for repairs you could do yourself',
  subheadline: 'The workshop manual for people who own a car, not a garage.',
  ctaLabel: 'Get the manual',
  painPoints: ['Shops charge for diagnosis you can do in ten minutes.'],
  whatsInsideHeading: "What's inside",
  bullets: [{ title: 'Read the dashboard', body: 'Know which warnings mean stop now.' }],
  whoIsItForHeading: 'Who this is for',
  whoIsItFor: ['You keep a car past its warranty.'],
  authorHeading: 'About the author',
  authorBio: 'Adrian has spent nineteen years under other people’s cars.',
  faqs: [{ question: 'What format?', answer: 'PDF and DOCX.' }],
  closingHeading: 'Fix it yourself',
  closingBody: 'One repair pays for the book.',
  fontFamily: 'sans',
});

/** Everything GenerateLandingPageUseCase needs, with sensible defaults. */
function buildGenerate(options: {
  project?: Project;
  existingPage?: LandingPage | null;
  aiText?: string;
  renderer?: LandingPageRenderer;
  /** Simulate the completion hitting the output ceiling. */
  truncated?: boolean;
  /** A previously captured layout for this template, as the cache would hold it. */
  storedLayout?: { inputHash: string | null };
}) {
  const project = options.project ?? makeProject();
  const book = makeBook();
  const pages = new FakeLandingRepo(options.existingPage ?? null);
  let aiCalls = 0;
  const rendered: LandingPageModel[] = [];

  const useCase = new GenerateLandingPageUseCase(
    { findById: async () => project } as never,
    { findByProject: async () => book, findSummaryByProject: async () => makeBookSummary() } as never,
    {
      getBookStrategy: async () =>
        BookStrategy.create({
          title: 'The Mechanic Bible',
          subtitle: 'Fix it yourself',
          targetAudience: 'car owners',
          corePromise: 'save money',
          transformation: 'confidence',
          authorVoice: 'blunt',
          author: 'Adrian',
          tone: 'professional',
          chapterCount: 1,
          targetWordCount: 45000,
          uniqueSellingProposition: 'usp',
          keyPrinciples: [],
          inputHash: 'strategy-hash',
        }),
    } as never,
    {
      getChannel: async () =>
        Channel.create({
          youtubeId: 'y',
          title: 'Car Care Garage',
          description: null,
          subscriberCount: 280_000,
          videoCount: 100,
          thumbnailUrl: null,
        }),
    } as never,
    { listByProject: async () => [] } as never,
    pages,
    {
      find: async () =>
        options.storedLayout
          ? { referenceUrl: 'https://example.com/reference', mode: 'single', css: '', bodyHtml: '<section></section>', slots: [], ...options.storedLayout }
          : null,
      save: async () => Result.ok(),
    } as never,
    {
      generate: async () => {
        aiCalls++;
        return Result.ok({
          text: options.aiText ?? COPY_JSON,
          model: 'claude-opus-4-8',
          inputTokens: 1,
          outputTokens: 1,
          stopReason: options.truncated ? 'max_tokens' : 'end_turn',
        });
      },
    } as never,
    options.renderer ?? {
      render: (m: LandingPageModel) => {
        rendered.push(m);
        return '<html>page</html>';
      },
    },
    { assemble: () => '<html>generated</html>' },
    // No reference URL is set on the default fixture, so this is never called.
    { fetch: async () => Result.fail('no reference') },
    { capture: async () => Result.fail("no screenshots in tests"), captureHtml: async () => Result.fail("no browser in tests") } as never,
    { embedFrom: async () => Result.ok([]) } as never,
    { dominantColor: async () => Result.ok({ r: 30, g: 60, b: 120 }) },
    { fetchBytes: async () => Result.fail("no logo in tests") } as never,
    FAKE_IMAGE_PROCESSOR,
    {
      getBytes: async () => Result.ok({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }),
      getDataUri: async () => Result.ok('data:image/png;base64,AQID'),
    } as never,
    { uuid: () => 'lp-1' },
    { now: () => now },
    // Order-insensitive stable hash — enough to prove "same inputs, same hash".
    { hash: (input: unknown) => JSON.stringify(input) },
  );

  return { useCase, pages, rendered, aiCalls: () => aiCalls, project };
}

const SIBLING_A = '22222222-2222-4222-8222-222222222222';
const SIBLING_B = '33333333-3333-4333-8333-333333333333';

/**
 * A three-book page, with a lookup keyed by project id so each sibling can be
 * made to exist, belong to someone else, or be unfinished independently.
 */
function buildTriple(opts: {
  siblings?: Array<{ projectId: string; priceCents?: number; checkoutUrl?: string }>;
  bundlePriceCents?: number;
  bundleCheckoutUrl?: string;
  /** Project ids that resolve to a project owned by somebody else. */
  foreignIds?: string[];
  /** Project ids whose book has no chapters yet. */
  unfinishedIds?: string[];
  /** Project ids that do not resolve at all. */
  missingIds?: string[];
} = {}) {
  const siblings = opts.siblings ?? [
    { projectId: SIBLING_A, priceCents: 3900, checkoutUrl: 'https://payhip.com/b/TWO' },
    { projectId: SIBLING_B, priceCents: 2900, checkoutUrl: 'https://payhip.com/b/THREE' },
  ];
  const root = makeProject({
    landingMode: 'triple',
    landingCheckoutUrl: 'https://payhip.com/b/ONE',
    landingPriceCents: 4700,
    landingSiblings: siblings,
    ...(opts.bundlePriceCents !== undefined ? { landingBundlePriceCents: opts.bundlePriceCents } : {}),
    ...(opts.bundleCheckoutUrl ? { landingBundleCheckoutUrl: opts.bundleCheckoutUrl } : {}),
  });
  const pages = new FakeLandingRepo(null);
  const rendered: LandingPageModel[] = [];

  const projects = {
    findById: async (id: ProjectId) => {
      const raw = id.toString();
      if (opts.missingIds?.includes(raw)) return null;
      if (raw === root.id.toString()) return root;
      const foreign = opts.foreignIds?.includes(raw);
      return Project.create({
        id: ProjectId.from(raw),
        ownerId: foreign ? 'someone-else' : 'owner',
        channelUrl: ChannelUrl.create('https://www.youtube.com/@example').value,
        options: GenerationOptions.create({ bookTitle: `Sibling ${raw.slice(0, 1)}`, landingPage: true }),
        now,
      }).value;
    },
  };

  const books = {
    findSummaryByProject: async (id: ProjectId) => {
      const raw = id.toString();
      if (opts.unfinishedIds?.includes(raw)) return makeBookSummary({ hasChapters: false });
      return makeBookSummary(
        raw === root.id.toString() ? {} : { title: `Sibling Book ${raw.slice(0, 1)}` },
      );
    },
  };

  const useCase = new GenerateLandingPageUseCase(
    projects as never,
    books as never,
    { getBookStrategy: async () => null } as never,
    { getChannel: async () => null } as never,
    { listByProject: async () => [] } as never,
    pages,
    { find: async () => null, save: async () => Result.ok() } as never,
    {
      generate: async () =>
        Result.ok({ text: COPY_JSON, model: 'm', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' }),
    } as never,
    {
      render: (m: LandingPageModel) => {
        rendered.push(m);
        return '<html>page</html>';
      },
    },
    { assemble: () => '<html>generated</html>' },
    { fetch: async () => Result.fail('no reference') },
    { capture: async () => Result.fail("no screenshots in tests"), captureHtml: async () => Result.fail("no browser in tests") } as never,
    { embedFrom: async () => Result.ok([]) } as never,
    { dominantColor: async () => Result.ok({ r: 30, g: 60, b: 120 }) },
    { fetchBytes: async () => Result.fail('no logo in tests') } as never,
    FAKE_IMAGE_PROCESSOR,
    {
      getBytes: async () => Result.ok({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }),
      getDataUri: async () => Result.ok('data:image/png;base64,AQID'),
    } as never,
    { uuid: () => 'lp-1' },
    { now: () => now },
    { hash: (input: unknown) => JSON.stringify(input) },
  );

  return { useCase, pages, rendered, root };
}

// ── three-book pages ─────────────────────────────────────────────────────────

describe('GenerateLandingPageUseCase — three-book pages', () => {
  const run = (b: ReturnType<typeof buildTriple>) =>
    b.useCase.execute({ projectId: '11111111-1111-4111-8111-111111111111' });

  it('sells all three books, each with its own price and link', async () => {
    const b = buildTriple();
    const result = await run(b);

    expect(result.isOk()).toBe(true);
    const products = b.rendered[0]!.products;
    expect(products).toHaveLength(3);
    expect(products.map((p) => p.checkoutUrl)).toEqual([
      'https://payhip.com/b/ONE',
      'https://payhip.com/b/TWO',
      'https://payhip.com/b/THREE',
    ]);
    expect(products.map((p) => p.priceCents)).toEqual([4700, 3900, 2900]);
  });

  it('adds the bundle as a fourth product when the seller set one up', async () => {
    const b = buildTriple({ bundlePriceCents: 6900, bundleCheckoutUrl: 'https://payhip.com/b/SET' });
    await run(b);

    const products = b.rendered[0]!.products;
    expect(products).toHaveLength(4);
    expect(products[3]?.kind).toBe('bundle');
    expect(products[3]?.checkoutUrl).toBe('https://payhip.com/b/SET');
  });

  it('leaves the bundle out entirely when no bundle link or price was given', async () => {
    const b = buildTriple();
    await run(b);
    expect(b.rendered[0]!.products.some((p) => p.kind === 'bundle')).toBe(false);
  });

  it('never lets the bundle become the hero — it has no cover of its own', async () => {
    const b = buildTriple({ bundlePriceCents: 6900, bundleCheckoutUrl: 'https://payhip.com/b/SET' });
    await run(b);

    const featured = b.rendered[0]!.products.filter((p) => p.featured);
    expect(featured).toHaveLength(1);
    expect(featured[0]?.kind).toBe('book');
  });

  // The client's requirement is absolute: choosing 3 ebooks must produce a
  // 3-ebook page or an error. Never a quietly-smaller page.
  it('fails rather than dropping a book that no longer exists', async () => {
    const b = buildTriple({ missingIds: [SIBLING_B] });
    const result = await run(b);

    if (result.isOk()) throw new Error('expected generation to fail');
    expect(result.error).toContain('no longer exists');
    expect(b.rendered).toHaveLength(0);
    expect(b.pages.current()?.state).toBe('FAILED');
  });

  it('fails rather than dropping a book that is still generating', async () => {
    const b = buildTriple({ unfinishedIds: [SIBLING_A] });
    const result = await run(b);

    if (result.isOk()) throw new Error('expected generation to fail');
    expect(result.error).toContain('not finished');
    expect(b.rendered).toHaveLength(0);
  });

  // Sibling ids arrive from the client; without this check anyone could put
  // another account's book on their own sales page.
  it('refuses a book belonging to a different account', async () => {
    const b = buildTriple({ foreignIds: [SIBLING_B] });
    const result = await run(b);

    if (result.isOk()) throw new Error('expected generation to fail');
    expect(result.error).toContain('different account');
    expect(b.rendered).toHaveLength(0);
  });

  it('refuses to generate when the wrong number of books is selected', async () => {
    const b = buildTriple({ siblings: [{ projectId: SIBLING_A, checkoutUrl: 'https://payhip.com/b/TWO' }] });
    const result = await run(b);

    if (result.isOk()) throw new Error('expected generation to fail');
    expect(result.error).toContain('exactly 2');
  });
});

// ── generation ───────────────────────────────────────────────────────────────

describe('GenerateLandingPageUseCase', () => {
  it('writes a draft and stores the rendered page', async () => {
    const { useCase, pages, rendered } = buildGenerate({});

    const result = await useCase.execute({ projectId: 'p1' });

    expect(result.isOk()).toBe(true);
    const page = pages.current()!;
    expect(page.state).toBe('DRAFT');
    expect(page.html).toBe('<html>page</html>');
    expect(page.copy?.headline).toContain('Stop paying');
    // The palette comes from the cover, not from a default.
    expect(page.palette?.toJSON().seed).toBe('#1e3c78');
    expect(rendered[0]?.products[0]?.title).toBe('The Mechanic Bible');
  });

  // Without this the layout has no image but the cover, which is why generated
  // heroes showed the book where the reference shows a face.
  it('puts an uploaded author photo into the page model', async () => {
    const { useCase, rendered } = buildGenerate({
      project: makeProject({ landingAuthorPhotoPath: 'p1/landing/author.jpg' }),
    });
    await useCase.execute({ projectId: 'p1' });
    // Shrunk on the way in — the page model never carries the source bytes.
    expect(rendered[0]?.authorPhotoDataUri).toBe(SHRUNK_URI);
  });

  // The layout cache was keyed on the reference URL alone, so a layout captured
  // for a one-book page was handed to a three-book page unchanged. The rules
  // that would have caught it ({{COVER}} capped at 2, {{COVER_STACK}} required)
  // only run when a layout is derived — so the page shipped the featured book's
  // cover three times, and no edit to the prompt or the contract could reach it.
  const TEMPLATE = 'https://example.com/reference';
  const templated = () => makeProject({ landingTemplateUrl: TEMPLATE });
  const layoutHash = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ url: TEMPLATE, mode: 'single', products: 1, photo: false, logo: false, ...over });

  // The reuse-on-match half is covered by the reference-driven suite below,
  // which has a layout fixture complete enough to actually render.
  it('refuses a layout captured for a different book count', async () => {
    const { useCase, pages } = buildGenerate({
      project: templated(),
      storedLayout: { inputHash: layoutHash({ products: 3 }) },
    });
    await useCase.execute({ projectId: 'p1' });
    // Falls through to the built-in template, which is correct at any count.
    expect(pages.current()?.html).toBe('<html>page</html>');
  });

  it('refuses a layout captured when no author photo existed', async () => {
    const { useCase, pages } = buildGenerate({
      project: makeProject({ landingTemplateUrl: TEMPLATE, landingAuthorPhotoPath: 'p1/landing/author.jpg' }),
      storedLayout: { inputHash: layoutHash() },
    });
    await useCase.execute({ projectId: 'p1' });
    expect(pages.current()?.html).toBe('<html>page</html>');
  });

  // Everything cached before the hash was checked is exactly the population that
  // may carry these defects, so it must not be trusted.
  it('treats a layout stored without a hash as stale', async () => {
    const { useCase, pages } = buildGenerate({ project: templated(), storedLayout: { inputHash: null } });
    await useCase.execute({ projectId: 'p1' });
    expect(pages.current()?.html).toBe('<html>page</html>');
  });

  // The page carries its images inside its own HTML, and that HTML is one
  // Postgres column written in one request. Inlining cover art at its source
  // size (1024×1536 PNG ≈ 4MB base64) is what made the save fail as a 57014 and
  // then a Cloudflare 502, so nothing reaches the model un-shrunk.
  it('shrinks the cover before it reaches the page model', async () => {
    const { useCase, rendered } = buildGenerate({});
    await useCase.execute({ projectId: 'p1' });
    expect(rendered[0]?.products[0]?.coverDataUri).toBe(SHRUNK_URI);
  });

  it('leaves the portrait absent when nothing was uploaded', async () => {
    const { useCase, rendered } = buildGenerate({});
    await useCase.execute({ projectId: 'p1' });
    expect(rendered[0]?.authorPhotoDataUri).toBeNull();
  });

  // A cut-off copy call surfaces as "Invalid JSON: Expected ',' or ']'", which
  // reads like a model defect and sends the job into a retry loop repeating it.
  it('reports a truncated copy response as truncation, not as bad JSON', async () => {
    const { useCase, pages } = buildGenerate({ truncated: true });

    const result = await useCase.execute({ projectId: 'p1' });

    if (result.isOk()) throw new Error('expected generation to fail');
    expect(result.error).toContain('cut off at the output limit');
    expect(result.error).not.toContain('Invalid JSON');
    expect(pages.current()?.state).toBe('FAILED');
  });

  // The two fields the copy model most often leaves out — a page that already
  // closes with a price and a button. Left required, that judgement call failed
  // the whole generation on a schema error, and the retry put the same question
  // to the same model.
  it('still writes a page when the closing copy comes back missing', async () => {
    const partial = JSON.parse(COPY_JSON) as Record<string, unknown>;
    delete partial['closingHeading'];
    delete partial['closingBody'];
    const { useCase, pages, rendered } = buildGenerate({ aiText: JSON.stringify(partial) });

    const result = await useCase.execute({ projectId: 'p1' });

    if (result.isFail()) throw new Error(result.error);
    expect(pages.current()?.state).toBe('DRAFT');
    // Empty, not absent: the renderer omits the section rather than painting an
    // empty heading above the final buy button.
    expect(rendered[0]?.copy.closingHeading).toBe('');
    expect(rendered[0]?.copy.closingBody).toBe('');
  });

  // `save` writes every column including `html` — a self-contained page with
  // its covers embedded as base64. Rewriting that to flip an enum is what put
  // landing_pages.save past the database's statement timeout.
  it('writes only the state when marking a page as generating', async () => {
    const { useCase, pages } = buildGenerate({});

    await useCase.execute({ projectId: 'p1' });

    expect(pages.stateSaves).toBeGreaterThan(0);
    // Exactly one full save: the finished draft, which genuinely has new html.
    expect(pages.saves).toBe(1);
  });

  it('writes only the state when a generation fails', async () => {
    const { useCase, pages } = buildGenerate({ truncated: true });

    await useCase.execute({ projectId: 'p1' });

    expect(pages.stateSaves).toBeGreaterThan(0);
    expect(pages.saves).toBe(0); // nothing was ever worth persisting in full
  });

  it('never invents testimonials', async () => {
    const { useCase, rendered } = buildGenerate({});
    await useCase.execute({ projectId: 'p1' });
    expect(rendered[0]?.testimonials).toEqual([]);
  });

  it('passes the checkout URL through untouched', async () => {
    const url = 'https://payhip.com/b/AbC9?ref=x&y=1';
    const { useCase, rendered } = buildGenerate({ project: makeProject({ landingCheckoutUrl: url }) });

    await useCase.execute({ projectId: 'p1' });

    expect(rendered[0]?.products[0]?.checkoutUrl).toBe(url);
  });

  it('is idempotent — unchanged inputs do not re-run the model', async () => {
    const first = buildGenerate({});
    await first.useCase.execute({ projectId: 'p1' });
    expect(first.aiCalls()).toBe(1);

    // Same project, same book, carrying forward the page the first run stored.
    const second = buildGenerate({ existingPage: first.pages.current() });
    const result = await second.useCase.execute({ projectId: 'p1' });

    expect(result.isOk()).toBe(true);
    expect((result as { value: { regenerated: boolean } }).value.regenerated).toBe(false);
    expect(second.aiCalls()).toBe(0);
  });

  it('rebuilds when the price changes, so the buttons never advertise a stale one', async () => {
    const first = buildGenerate({ project: makeProject({ landingPriceCents: 4700 }) });
    await first.useCase.execute({ projectId: 'p1' });

    const second = buildGenerate({
      project: makeProject({ landingPriceCents: 2700 }),
      existingPage: first.pages.current(),
    });
    await second.useCase.execute({ projectId: 'p1' });

    expect(second.aiCalls()).toBe(1);
    expect(second.rendered[0]?.products[0]?.priceCents).toBe(2700);
  });

  it('force rebuilds even when nothing changed', async () => {
    const first = buildGenerate({});
    await first.useCase.execute({ projectId: 'p1' });

    const second = buildGenerate({ existingPage: first.pages.current() });
    await second.useCase.execute({ projectId: 'p1', force: true });

    expect(second.aiCalls()).toBe(1);
  });

  it('refuses when the landing page was never enabled', async () => {
    const { useCase } = buildGenerate({ project: makeProject({ landingPage: false }) });
    const result = await useCase.execute({ projectId: 'p1' });
    expect(result.isFail()).toBe(true);
  });

  it('records the failure on the page when the model returns unusable output', async () => {
    const { useCase, pages } = buildGenerate({ aiText: 'sorry, I cannot do that' });

    const result = await useCase.execute({ projectId: 'p1' });

    expect(result.isFail()).toBe(true);
    expect(pages.current()?.state).toBe('FAILED');
    expect(pages.current()?.error).toBeTruthy();
  });
});

// ── generated layouts from a reference page ──────────────────────────────────

const REFERENCE = {
  url: 'https://eliasyoder.com/',
  title: 'The Manual',
  headings: [{ level: 2, text: 'I. The Manual' }],
  text: 'A reference sales page.',
  markup: '<section class="hero"><h1>x</h1></section>',
  styleCss: '',
  style: { serifHeadings: true, serifBody: false, headingFont: 'Playfair Display', bodyFont: null, grounds: ['#faf7f0'], accent: '#b8860b', numberedSections: true, imageDensity: 0.3, measurePx: 720 },
};

/**
 * A reusable layout that satisfies the contract: no book's prose, only slots.
 * `extraSlots` lets a test add or omit slots to trip the manifest checks.
 */
function goodLayout(): string {
  const slots = [
    { key: 'hero.headline', purpose: 'Problem-led hero headline', maxChars: 120 },
    { key: 'hero.subheadline', purpose: 'What the book does about it', maxChars: 220 },
    { key: 'cta.label', purpose: 'Action-first button label', maxChars: 28 },
    { key: 'inside.heading', purpose: "What's inside heading", maxChars: 60 },
    { key: 'faq.q1', purpose: 'First question', maxChars: 80 },
    { key: 'faq.a1', purpose: 'Its answer', maxChars: 300 },
    { key: 'order.heading', purpose: 'Order section heading', maxChars: 60 },
    { key: 'closing.heading', purpose: 'Closing heading', maxChars: 70 },
  ];
  return JSON.stringify({
    css: 'body { background: var(--bg); color: var(--text); }',
    slots,
    bodyHtml:
      '<section data-section="hero"><h1>{{COPY:hero.headline}}</h1><p>{{COPY:hero.subheadline}}</p>' +
      '{{COVER}}{{PRICE}}{{CTA_BUTTON}}</section>' +
      '<section data-section="inside"><h2>{{COPY:inside.heading}}</h2>{{CONTENTS}}</section>' +
      '<section data-section="order"><h2>{{COPY:order.heading}}</h2>{{PRICE}}{{CTA_BUTTON}}</section>' +
      '<section data-section="faq"><h3>{{COPY:faq.q1}}</h3><p>{{COPY:faq.a1}}</p>' +
      '<p>{{COPY:closing.heading}}</p></section>' +
      '<footer>{{FOOTER_LEGAL}}</footer>',
  });
}

/** What the slot-filling copy call returns for the layout above. */
const SLOT_COPY_JSON = JSON.stringify({
  'hero.headline': 'Stop paying for repairs you could do yourself',
  'hero.subheadline': 'The workshop manual for people who own a car.',
  'cta.label': 'Get the manual',
  'inside.heading': "What's inside",
  'faq.q1': 'What format?',
  'faq.a1': 'PDF and DOCX.',
  'order.heading': 'Order the book',
  'closing.heading': 'Fix it yourself',
});

/** Builds the use case with a reference URL set and a scripted AI. */
function buildWithReference(
  layoutResponses: string[],
  opts: {
    stored?: import('../ports/repositories/LandingLayoutRepository').StoredLandingLayout;
    /** What the copy call returns — slot map by default, fixed schema when the
     *  test expects the built-in fallback path. */
    copyText?: string;
    /** Simulate a browser: screenshots of the candidate become available. */
    canScreenshot?: boolean;
    /** Verdicts returned by the visual reviewer, in order. */
    reviews?: string[];
    /** Every page model handed to the assembler, review renders included. */
    onAssemble?: (model: LandingPageModel) => void;
  } = {},
) {
  const project = makeProject({ landingTemplateUrl: 'https://eliasyoder.com/' });
  const pages = new FakeLandingRepo(null);
  const calls: string[] = [];
  let assembled = 0;
  let builtin = 0;

  const useCase = new GenerateLandingPageUseCase(
    { findById: async () => project } as never,
    { findByProject: async () => makeBook(), findSummaryByProject: async () => makeBookSummary() } as never,
    { getBookStrategy: async () => null } as never,
    { getChannel: async () => null } as never,
    { listByProject: async () => [] } as never,
    pages,
    { find: async () => opts.stored ?? null, save: async () => Result.ok() } as never,
    {
      generate: async (req: { metadata?: { stage: string } }) => {
        const stage = req.metadata?.stage ?? '';
        calls.push(stage);
        if (stage === 'landing-layout-review') {
          return Result.ok({
            text: opts.reviews?.shift() ?? '{"ok":true,"problems":[]}',
            model: 'm',
            inputTokens: 1,
            outputTokens: 1,
            stopReason: 'end_turn',
          });
        }
        const text =
          stage === 'landing-page'
            ? (opts.copyText ?? SLOT_COPY_JSON)
            : (layoutResponses.shift() ?? '{"bad":true}');
        return Result.ok({ text, model: 'm', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' });
      },
    } as never,
    {
      render: () => {
        builtin++;
        return '<html>builtin</html>';
      },
    },
    {
      assemble: ({ model }: { model: LandingPageModel }) => {
        assembled++;
        opts.onAssemble?.(model);
        return '<html>generated</html>';
      },
    },
    { fetch: async () => Result.ok(REFERENCE) },
    {
      capture: async () => Result.fail('no screenshots in tests'),
      captureHtml: async () =>
        opts.canScreenshot
          ? Result.ok([{ mediaType: 'image/png', dataBase64: 'AAA' }])
          : Result.fail('no browser in tests'),
    } as never,
    { embedFrom: async () => Result.ok([]) } as never,
    { dominantColor: async () => Result.ok({ r: 30, g: 60, b: 120 }) },
    { fetchBytes: async () => Result.fail("no logo in tests") } as never,
    FAKE_IMAGE_PROCESSOR,
    {
      getBytes: async () => Result.fail('none'),
      getDataUri: async () => Result.fail('none'),
    } as never,
    { uuid: () => 'lp-1' },
    { now: () => now },
    { hash: (i: unknown) => JSON.stringify(i) },
  );

  return { useCase, pages, calls, counts: () => ({ assembled, builtin }) };
}

const HEADLINE = 'Stop paying for repairs you could do yourself';
const SUB = 'The workshop manual for people who own a car, not a garage.';

describe('GenerateLandingPageUseCase — reference-driven layout', () => {
  it('captures a reusable layout and pours the book copy into it', async () => {
    const h = buildWithReference([goodLayout()]);

    const result = await h.useCase.execute({ projectId: 'p1' });

    expect(result.isOk()).toBe(true);
    if (result.isFail()) throw new Error(result.error);
    expect(result.value.layout).toBe('generated');
    // Two assemblies: one to render the candidate for visual review, one for
    // the finished page. No fallback to the built-in template.
    expect(h.counts()).toEqual({ assembled: 2, builtin: 0 });
    expect(h.calls).toEqual(['landing-layout', 'landing-page']);
  });

  it('repairs a rejected layout and uses the corrected one', async () => {
    // Valid JSON, valid sections, but no slots — so it is not reusable.
    const noSlots = JSON.stringify({
      css: '',
      bodyHtml:
        '<section data-section="hero"><h1>A headline</h1>{{COVER}}{{PRICE}}{{CTA_BUTTON}}</section>' +
        '<section data-section="inside">{{CONTENTS}}</section>' +
        '<section data-section="order"></section><section data-section="faq"></section>' +
        '<footer>{{FOOTER_LEGAL}}</footer>',
    });
    const h = buildWithReference([noSlots, goodLayout()]);

    const result = await h.useCase.execute({ projectId: 'p1' });

    if (result.isFail()) throw new Error(result.error);
    expect(result.value.layout).toBe('generated');
    // The rejected candidate never reaches the renderer; the repaired one is
    // assembled twice — once for review, once for real.
    expect(h.counts().assembled).toBe(2);
  });

  it('falls back to the built-in template after repeated failures', async () => {
    const broken = JSON.stringify({ css: '', bodyHtml: '<div>nope</div>' });
    const h = buildWithReference([broken, broken, broken], { copyText: COPY_JSON });

    const result = await h.useCase.execute({ projectId: 'p1' });

    if (result.isFail()) throw new Error(result.error);
    expect(result.value.layout).toBe('builtin');
    expect(h.counts()).toEqual({ assembled: 0, builtin: 1 });
  });

  // A layout carrying one book's words would print them on every other book
  // that reuses the template — the failure the slot contract exists to catch.
  it('rejects a layout with a book prose written into it', async () => {
    const withProse = JSON.stringify({
      css: '',
      slots: [{ key: 'hero.headline', purpose: 'Headline', maxChars: 120 }],
      bodyHtml:
        '<section data-section="hero"><h1>{{COPY:hero.headline}}</h1>' +
        '<p>Adrian has spent nineteen years under other cars.</p>{{COVER}}{{PRICE}}{{CTA_BUTTON}}</section>' +
        '<section data-section="inside">{{CONTENTS}}</section>' +
        '<section data-section="order"></section><section data-section="faq"></section>' +
        '<footer>{{FOOTER_LEGAL}}</footer>',
    });
    const h = buildWithReference([withProse, withProse, withProse], { copyText: COPY_JSON });

    const result = await h.useCase.execute({ projectId: 'p1' });

    if (result.isFail()) throw new Error(result.error);
    // Too few slots and the required ones missing — never stored, never used.
    expect(result.value.layout).toBe('builtin');
  });

  // The contract cannot see a portrait rendered over the sticky header or a
  // list squeezed into twelve-character columns — those only exist once
  // painted, and each of them shipped to the client.
  it('rejects a layout the rendered page shows to be broken', async () => {
    const h = buildWithReference([goodLayout(), goodLayout()], {
      canScreenshot: true,
      reviews: [
        JSON.stringify({ ok: false, problems: ['The author photo covers the sticky header.'] }),
        JSON.stringify({ ok: true, problems: [] }),
      ],
    });

    const result = await h.useCase.execute({ projectId: 'p1' });

    if (result.isFail()) throw new Error(result.error);
    expect(result.value.layout).toBe('generated');
    // Two derivations: the first was rendered, reviewed and sent back.
    expect(h.calls.filter((c) => c === 'landing-layout')).toHaveLength(2);
    expect(h.calls.filter((c) => c === 'landing-layout-review')).toHaveLength(2);
  });

  /**
   * The reviewer judges still images, and some of its complaints are not
   * defects. A sticky bar appears at the top of every mid-page screenshot,
   * sitting over whatever content is at that scroll offset — which is what a
   * sticky bar does, and which it reported on every layout that had one. As a
   * hard gate that burned all three attempts and dropped the page onto the
   * built-in template, which follows the reference not at all.
   */
  it('ships a contract-valid layout even when the reviewer keeps complaining', async () => {
    const h = buildWithReference([goodLayout(), goodLayout(), goodLayout()], {
      canScreenshot: true,
      reviews: [
        JSON.stringify({ ok: false, problems: ['The sticky bar covers a heading.'] }),
        JSON.stringify({ ok: false, problems: ['The sticky bar covers a heading.'] }),
        JSON.stringify({ ok: false, problems: ['The sticky bar covers a heading.'] }),
      ],
    });

    const result = await h.useCase.execute({ projectId: 'p1' });

    if (result.isFail()) throw new Error(result.error);
    // The reference-shaped page ships rather than the built-in one.
    expect(result.value.layout).toBe('generated');
    expect(h.counts().builtin).toBe(0);
    // The complaints are reported rather than swallowed, so a real defect is
    // still findable in the log.
    expect(result.value.visualNotes?.join(' ')).toContain('sticky bar');
    // It still tried to repair first — all three attempts were spent.
    expect(h.calls.filter((c) => c === 'landing-layout')).toHaveLength(3);
  });

  // Quality assurance, not a gate: a worker with no browser must still ship.
  it('accepts the layout when the page cannot be rendered for review', async () => {
    const h = buildWithReference([goodLayout()], { canScreenshot: false });

    const result = await h.useCase.execute({ projectId: 'p1' });

    if (result.isFail()) throw new Error(result.error);
    expect(result.value.layout).toBe('generated');
    expect(h.calls).not.toContain('landing-layout-review');
  });

  // The point of storing layouts: the second book pays no layout cost at all.
  // The reviewer was shown a fixture with no cover at all, so a sound layout
  // came back rejected for "a large image placeholder, mostly blank, creating an
  // unfilled region" — an empty frame that existed only in the review render.
  // Two of those and the page falls back to the built-in template, which is how
  // a page ends up ignoring the reference it was supposed to follow.
  const reviewModel = async (): Promise<LandingPageModel | undefined> => {
    const models: LandingPageModel[] = [];
    const h = buildWithReference([goodLayout()], { canScreenshot: true, onAssemble: (m) => models.push(m) });
    await h.useCase.execute({ projectId: 'p1' });
    return models.find((m) => m.siteName === 'Preview');
  };

  it('shows the reviewer a cover, so an empty slot is not read as a defect', async () => {
    const review = await reviewModel();
    expect(review, 'the reviewer never ran').toBeDefined();
    expect(review?.products[0]?.coverDataUri).toBeTruthy();
  });

  // The original intent survives: this project has no portrait, so a layout that
  // only looks right with one must still fail review.
  it('withholds the portrait when the project has none', async () => {
    const review = await reviewModel();
    expect(review?.authorPhotoDataUri).toBeNull();
  });

  it('reuses a stored layout instead of deriving it again', async () => {
    const h = buildWithReference([goodLayout()], {
      stored: {
        referenceUrl: 'https://eliasyoder.com/',
        mode: 'single',
        css: 'body{}',
        bodyHtml:
          '<section data-section="hero"><h1>{{COPY:hero.headline}}</h1>{{COVER}}{{PRICE}}{{CTA_BUTTON}}</section>' +
          '<footer>{{FOOTER_LEGAL}}</footer>',
        slots: [{ key: 'hero.headline', purpose: 'Headline', maxChars: 120 }],
        // Must be the hash of the inputs this generation runs with; a layout
        // captured under any other is rebuilt rather than reused.
        inputHash: JSON.stringify({
          url: 'https://eliasyoder.com/',
          mode: 'single',
          products: 1,
          photo: false,
          logo: false,
          // Layouts derived under an older idea of what a good layout is are
          // rebuilt, not reused — see LANDING_LAYOUT_VERSION.
          layoutVersion: LANDING_LAYOUT_VERSION,
          // ...and under older RULES. Built here the same way the use case
          // builds it, so this fixture keeps proving "same inputs, same hash"
          // rather than freezing today's prompt text into the test.
          rules: JSON.stringify(
            LandingLayoutPrompt.build({
              reference: null,
              productCount: 1,
              hasAuthorPhoto: false,
              hasLogo: false,
            }).system,
          ),
        }),
      },
    });

    const result = await h.useCase.execute({ projectId: 'p1' });

    if (result.isFail()) throw new Error(result.error);
    expect(result.value.layout).toBe('generated');
    // Only the copy call ran — no landing-layout call at all.
    expect(h.calls).toEqual(['landing-page']);
  });

  it('uses the built-in template when the reference cannot be fetched', async () => {
    // The no-reference path: nothing to copy from, so no layout is stored.
    const plain = buildGenerate({});
    const result = await plain.useCase.execute({ projectId: 'p1' });
    expect(result.isOk()).toBe(true);
    expect((result as { value: { layout: string } }).value.layout).toBe('builtin');
  });
});

// ── publishing ───────────────────────────────────────────────────────────────

class FakePublisher implements SitePublisher {
  calls: PublishInput[] = [];
  constructor(
    private readonly configured = true,
    private readonly outcome: 'ok' | 'fail' = 'ok',
  ) {}
  isConfigured(): boolean {
    return this.configured;
  }
  async publish(input: PublishInput) {
    this.calls.push(input);
    if (this.outcome === 'fail') return Result.fail<PublishOutput>('netlify exploded');
    return Result.ok<PublishOutput>({ siteId: 'site-1', deployId: 'dep-1', url: 'https://x.netlify.app' });
  }
}

function draftPage(): LandingPage {
  const page = LandingPage.create({ id: { value: 'lp-1' } as never, projectId: 'p1', now });
  page.setDraft(
    { copy: {} as never, palette: {} as never, html: '<html>draft</html>', inputHash: 'h' },
    now,
  );
  return page;
}

function buildPublish(project: Project, page: LandingPage | null, publisher: SitePublisher) {
  const pages = new FakeLandingRepo(page);
  const useCase = new PublishLandingPageUseCase(
    { findById: async () => project } as never,
    { findByProject: async () => makeBook(), findSummaryByProject: async () => makeBookSummary() } as never,
    pages,
    publisher,
    { now: () => now },
  );
  return { useCase, pages };
}

function clonedPage(): LandingPage {
  const page = LandingPage.create({ id: { value: 'lp-2' } as never, projectId: 'p1', now });
  page.setClonedDraft(
    {
      copy: {} as never,
      html: '<html><img src="assets/dish.webp"><img src="assets/cover.webp"></html>',
      inputHash: 'h',
      templateId: 'tpl-1',
      binding: { scalars: {}, repeats: {} },
      assets: [{ sitePath: 'assets/cover.webp', storagePath: 'pages/p1/cover.webp', contentType: 'image/webp' }],
      fidelity: { visual: [], findings: [], unresolvedSlots: [] },
    },
    now,
  );
  return page;
}

/**
 * A cloned page deploys as several files. The template's own photography — dish
 * photos, payment marks, the site's logo — travels on the TEMPLATE's asset list,
 * which is a different list from the page's own cover and portrait. Only the
 * second of the two was reaching Netlify, so every 'assets/<hash>' 404'd while
 * the cover came through and made the breakage look cosmetic.
 */
describe("PublishLandingPageUseCase — a cloned page's files", () => {
  const withCheckout = () => makeProject({ landingCheckoutUrl: 'https://payhip.com/b/AbC9' });

  function buildClonePublish(publisher: SitePublisher, templateAssets: Array<{ sitePath: string }>) {
    const pages = new FakeLandingRepo(clonedPage());
    const useCase = new PublishLandingPageUseCase(
      { findById: async () => withCheckout() } as never,
      { findByProject: async () => makeBook(), findSummaryByProject: async () => makeBookSummary() } as never,
      pages,
      publisher,
      { now: () => now },
      { listAssets: async () => templateAssets } as never,
      {
        loadAssets: async (assets: Array<{ sitePath: string }>) =>
          assets.map((a) => ({ sitePath: a.sitePath, bytes: new TextEncoder().encode('bytes') })),
      } as never,
      { getBytes: async () => Result.ok({ bytes: new TextEncoder().encode('cover') }) } as never,
    );
    return { useCase, pages };
  }

  it("deploys the template's assets beside the page", async () => {
    const publisher = new FakePublisher();
    const { useCase } = buildClonePublish(publisher, [
      { sitePath: 'assets/dish.webp' },
      { sitePath: 'assets/visa.svg' },
    ]);

    expect((await useCase.execute({ projectId: 'p1' })).isOk()).toBe(true);

    const paths = (publisher.calls[0]?.files ?? []).map((f) => f.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('assets/dish.webp');
    expect(paths).toContain('assets/visa.svg');
    // The page's own cover rides a different list; both must arrive.
    expect(paths).toContain('assets/cover.webp');
  });

  it('deploys only index.html and the cover when the template recorded no assets', async () => {
    // The shape of the bug: listAssets returning empty is indistinguishable, at
    // this layer, from a template that genuinely has no images.
    const publisher = new FakePublisher();
    const { useCase } = buildClonePublish(publisher, []);

    expect((await useCase.execute({ projectId: 'p1' })).isOk()).toBe(true);
    expect((publisher.calls[0]?.files ?? []).map((f) => f.path)).toEqual(['index.html', 'assets/cover.webp']);
  });
});

describe('PublishLandingPageUseCase', () => {
  const withCheckout = () => makeProject({ landingCheckoutUrl: 'https://payhip.com/b/AbC9' });

  it('publishes the stored draft verbatim', async () => {
    const publisher = new FakePublisher();
    const { useCase, pages } = buildPublish(withCheckout(), draftPage(), publisher);

    const result = await useCase.execute({ projectId: 'p1' });

    expect(result.isOk()).toBe(true);
    expect(pages.current()?.state).toBe('PUBLISHED');
    expect(pages.current()?.url).toBe('https://x.netlify.app');
    // Exactly the bytes that were reviewed, as a single self-contained file.
    expect(publisher.calls[0]?.files).toHaveLength(1);
    expect(new TextDecoder().decode(publisher.calls[0]!.files[0]!.bytes)).toBe('<html>draft</html>');
  });

  it('refuses to publish a page whose buy buttons go nowhere', async () => {
    const publisher = new FakePublisher();
    const { useCase } = buildPublish(makeProject(), draftPage(), publisher);

    const result = await useCase.execute({ projectId: 'p1' });

    expect(result.isFail()).toBe(true);
    expect(publisher.calls).toHaveLength(0);
  });

  it('refuses when there is no draft to publish', async () => {
    const { useCase } = buildPublish(withCheckout(), null, new FakePublisher());
    expect((await useCase.execute({ projectId: 'p1' })).isFail()).toBe(true);
  });

  it('refuses when Netlify is not configured', async () => {
    const publisher = new FakePublisher(false);
    const { useCase } = buildPublish(withCheckout(), draftPage(), publisher);

    expect((await useCase.execute({ projectId: 'p1' })).isFail()).toBe(true);
    expect(publisher.calls).toHaveLength(0);
  });

  it('records a deploy failure instead of leaving the page stuck publishing', async () => {
    const { useCase, pages } = buildPublish(withCheckout(), draftPage(), new FakePublisher(true, 'fail'));

    const result = await useCase.execute({ projectId: 'p1' });

    expect(result.isFail()).toBe(true);
    expect(pages.current()?.state).toBe('FAILED');
    expect(pages.current()?.error).toContain('netlify exploded');
  });

  it('redeploys to the same site once one exists, keeping the URL stable', async () => {
    const publisher = new FakePublisher();
    const { useCase, pages } = buildPublish(withCheckout(), draftPage(), publisher);
    await useCase.execute({ projectId: 'p1' });

    const second = buildPublish(withCheckout(), pages.current(), publisher);
    await second.useCase.execute({ projectId: 'p1' });

    expect(publisher.calls[1]?.siteId).toBe('site-1');
  });
});

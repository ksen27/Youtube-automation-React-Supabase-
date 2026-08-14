import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { ExportArtifactRepository } from '../ports/repositories/ExportArtifactRepository';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { Clock } from '../ports/Clock';
import type { Logger } from '../ports/Logger';
import type {
  CheckoutProductPublisher,
  CheckoutProductFile,
  CheckoutPublishError,
} from '../ports/services/CheckoutProductPublisher';

/** Where finished PDFs and cover art are stored (see ExportEbookUseCase). */
const EXPORTS_BUCKET = 'ebook-exports';

export interface CreateCheckoutProductInput {
  projectId: string;
  /**
   * Create a NEW product even though one is already recorded.
   *
   * The escape hatch for the one case the idempotency guard gets wrong: the
   * seller deleted the product on the store, so our stored link is dead. Off by
   * default, and never set by a retry — only by a human who has looked.
   */
  force?: boolean | undefined;
}

export interface CreateCheckoutProductOutput {
  productKey: string;
  buyUrl: string;
  /** True when nothing was created because the product already existed. */
  reused: boolean;
}

/**
 * Create the store product a finished book is sold through, and point the
 * landing page's buy button at it.
 *
 * Replaces the manual step the seller used to do by hand — create the product
 * on Payhip, upload the PDF, copy the link back into the settings form. The
 * result is written to the SAME `landingCheckoutUrl` that form writes, so every
 * downstream consumer (both page renderers, the publish gate) is unchanged and
 * a hand-pasted link still works exactly as before.
 *
 * The store side of this is a browser automation (Payhip has no product-creation
 * API), but nothing in here knows that: it talks to the `CheckoutProductPublisher`
 * port, which is also what makes the whole use case unit-testable without a browser.
 */
export class CreateCheckoutProductUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly books: BookRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly artifacts: ExportArtifactRepository,
    private readonly storage: ObjectStorage,
    private readonly publisher: CheckoutProductPublisher,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async execute(
    input: CreateCheckoutProductInput,
  ): Promise<Result<CreateCheckoutProductOutput, CheckoutPublishError>> {
    const projectId = ProjectId.from(input.projectId);
    const project = await this.projects.findById(projectId);
    if (!project) return fail('rejected', 'Project not found');

    // ── idempotency ──
    // Checked FIRST, before the browser, the downloads and the money: this is
    // the guard that stops a double-click, a queue retry or a re-run from
    // listing the same book on the store twice. Both fields are required —
    // a key without a URL is a half-written record we should not trust.
    const existingKey = project.options.landingCheckoutProductKey;
    const existingUrl = project.options.landingCheckoutUrl;
    if (!input.force && existingKey && existingUrl) {
      this.logger.info('checkout product already exists — returning the stored link', {
        projectId: input.projectId,
        productKey: existingKey,
      });
      return Result.ok({ productKey: existingKey, buyUrl: existingUrl, reused: true });
    }

    if (!this.publisher.isConfigured()) {
      return fail(
        'not-configured',
        'No Payhip session is stored. Run `npm run payhip:connect` once to log in by hand.',
      );
    }

    // ── the book must be finished and priced ──
    if (project.status.value !== 'COMPLETED') {
      return fail('rejected', 'The book must finish generating before it can be listed for sale');
    }
    const priceCents = project.options.landingPriceCents;
    if (priceCents === undefined) {
      return fail('rejected', 'Set the price before creating the product — the store needs one');
    }

    const book = await this.books.findSummaryByProject(projectId);
    if (!book) return fail('rejected', 'This project has no book to sell');

    // ── the file the buyer downloads ──
    const artifactList = await this.artifacts.listByProject(projectId);
    // Newest export wins: a book that was regenerated has several, and selling
    // an older build than the one the seller is looking at is worse than failing.
    const pdf = artifactList
      .filter((a) => a.format === 'pdf')
      .sort((a, b) => b.bookVersion - a.bookVersion)[0];
    if (!pdf) {
      return fail('rejected', 'Export the book as PDF before creating the product — there is nothing to sell yet');
    }
    const pdfBytes = await this.storage.getBytes(EXPORTS_BUCKET, pdf.storagePath);
    if (pdfBytes.isFail()) {
      return fail('transient', `Could not read the exported PDF: ${pdfBytes.error}`);
    }

    const strategy = await this.knowledge.getBookStrategy(projectId);
    const title = book.title ?? strategy?.title ?? project.options.bookTitle ?? 'Untitled';
    const pdfFile: CheckoutProductFile = {
      bytes: pdfBytes.value.bytes,
      // The buyer sees this filename in their downloads folder, so it is the
      // book's name rather than the storage path's UUID.
      filename: `${safeFilename(title)}.pdf`,
      contentType: 'application/pdf',
    };

    // Cover art is optional — a book can reach COMPLETED without one, and a
    // listing with no image sells worse than one with an image but is still a
    // listing. Never a reason to fail the whole run.
    const cover = await this.loadCover(book.coverImagePath, title);

    const draft = {
      externalId: input.projectId,
      title,
      description: buildDescription({
        subtitle: strategy?.subtitle,
        corePromise: strategy?.corePromise,
        transformation: strategy?.transformation,
        chapterTitles: book.chapterTitles,
        pageCount: artifactList.find((a) => a.pageCount > 0)?.pageCount ?? null,
      }),
      priceCents,
      currency: project.options.landingCurrency,
      pdf: pdfFile,
      ...(cover ? { cover } : {}),
    };

    this.logger.info('creating the store product', {
      projectId: input.projectId,
      title,
      priceCents,
      currency: draft.currency,
      pdfBytes: pdfFile.bytes.byteLength,
      hasCover: Boolean(cover),
    });

    const published = await this.publisher.createProduct(draft);
    if (published.isFail()) {
      this.logger.error('could not create the store product', {
        projectId: input.projectId,
        kind: published.error.kind,
        reason: published.error.message,
        debugPaths: published.error.debugPaths,
      });
      return published;
    }

    // ── persist, then report ──
    // Written before returning so a caller that crashes on the way back still
    // leaves us able to recognise the product next time. Re-read rather than
    // reusing the instance loaded above: the settings form may have been saved
    // while the browser was working, and clobbering that edit with a minutes-old
    // snapshot would silently undo it.
    const fresh = (await this.projects.findById(projectId)) ?? project;
    fresh.attachCheckoutProduct(
      { productKey: published.value.productKey, buyUrl: published.value.buyUrl },
      this.clock.now(),
    );
    await this.projects.save(fresh);

    this.logger.info('🛒 store product created', {
      projectId: input.projectId,
      productKey: published.value.productKey,
      buyUrl: published.value.buyUrl,
    });
    return Result.ok({
      productKey: published.value.productKey,
      buyUrl: published.value.buyUrl,
      reused: false,
    });
  }

  private async loadCover(path: string | null, title: string): Promise<CheckoutProductFile | null> {
    if (!path) return null;
    const bytes = await this.storage.getBytes(EXPORTS_BUCKET, path);
    if (bytes.isFail()) {
      this.logger.warn('cover art unreadable — listing the product without one', { path, reason: bytes.error });
      return null;
    }
    const ext = path.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
    return {
      bytes: bytes.value.bytes,
      filename: `${safeFilename(title)}-cover.${ext}`,
      contentType: bytes.value.contentType || (ext === 'png' ? 'image/png' : 'image/jpeg'),
    };
  }
}

function fail(
  kind: CheckoutPublishError['kind'],
  message: string,
): Result<CreateCheckoutProductOutput, CheckoutPublishError> {
  return Result.fail<CreateCheckoutProductOutput, CheckoutPublishError>({ kind, message });
}

/** A title that is safe as a filename on any OS the buyer might be using. */
function safeFilename(title: string): string {
  return (
    title
      .replace(/[/\\?%*:|"<>]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'ebook'
  );
}

/**
 * The product description shown on the store page.
 *
 * Assembled from the book's own strategy rather than written fresh by a model:
 * the landing page is where the selling happens, and a second, independently
 * generated pitch on the store page is a chance for the two to contradict each
 * other on price, promise or contents.
 */
function buildDescription(input: {
  subtitle?: string | undefined;
  corePromise?: string | undefined;
  transformation?: string | undefined;
  chapterTitles: string[];
  pageCount: number | null;
}): string {
  const parts: string[] = [];
  if (input.subtitle?.trim()) parts.push(input.subtitle.trim());
  if (input.corePromise?.trim()) parts.push(input.corePromise.trim());
  if (input.transformation?.trim()) parts.push(input.transformation.trim());
  if (input.chapterTitles.length > 0) {
    parts.push(["What's inside:", ...input.chapterTitles.slice(0, 20).map((t) => `• ${t}`)].join('\n'));
  }
  const facts = ['Instant download (PDF)'];
  if (input.pageCount) facts.push(`${input.pageCount} pages`);
  parts.push(facts.join(' · '));
  return parts.join('\n\n');
}

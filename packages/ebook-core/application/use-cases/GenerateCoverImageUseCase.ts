import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { ImageGenerator } from '../ports/services/ImageGenerator';
import type { ImageProcessor } from '../ports/services/ImageProcessor';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { Logger } from '../ports/Logger';
import { CoverImagePrompt } from '../prompts/CoverImagePrompt';
import { EXPORT_BUCKET } from './ExportEbookUseCase';

/**
 * The cover is inlined as base64 into the exported PDF, so its stored size is
 * paid twice over in the artifact. gpt-image-1 returns a ~4MB PNG; re-encoded as
 * JPEG it is a few hundred KB with no visible difference at the size a cover
 * renders — and the export artifact has a hard size ceiling in storage.
 *
 * Width matches the source (the model returns 1024x1536), so this is a re-encode
 * rather than a downscale — `withoutEnlargement` means nothing is upscaled.
 * Quality is a notch above the illustrations': the cover is the one image that
 * fills a whole page.
 */
const COVER_MAX_WIDTH = 1024;
const COVER_JPEG_QUALITY = 85;

/**
 * Generates one cover illustration per book and stores it in the exports bucket.
 *
 * The brief is built from THIS book's strategy (core promise, transformation,
 * key principles) rather than the whole-channel knowledge base — the latter is
 * identical for every book in a channel, which made every cover the same. The
 * channel knowledge base remains the fallback for books with no strategy.
 *
 * Runs best-effort at the ASSEMBLING stage and is idempotent — once a book has a
 * cover path, it is left untouched, so retries and re-exports neither regenerate
 * nor double-bill.
 */
export class GenerateCoverImageUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly images: ImageGenerator,
    private readonly storage: ObjectStorage,
    private readonly imageProcessor: ImageProcessor,
    private readonly logger: Logger,
  ) {}

  async execute(cmd: { projectId: string }): Promise<Result<{ generated: boolean }>> {
    const projectId = ProjectId.from(cmd.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');
    if (book.coverImagePath) return Result.ok({ generated: false }); // idempotent

    const ctx = await this.books.loadSharedContext(projectId);
    const strategy = await this.knowledge.getBookStrategy(projectId);

    const coverInput = {
      title: book.title ?? strategy?.title ?? 'Untitled',
      subtitle: strategy?.subtitle ?? '',
      // Per-book brief first; the channel knowledge base is shared across every
      // book in the channel, so it can only ever produce one cover.
      subject: strategy?.toText() ?? ctx.knowledgeBase,
      tone: ctx.tone,
      // Stable across retries: a re-run after a storage failure must reproduce
      // the same art direction, not roll a new one.
      variantKey: projectId.value,
      // Short labels for the cover's navy benefit bar, from the book's own
      // principles. Long prose renders as unreadable mush at that size, so keep
      // only genuinely short ones rather than truncating mid-word.
      featureLabels: toFeatureLabels(strategy?.keyPrinciples ?? []),
    };
    // Cooking books get an antique vintage-cookbook cover; everything else gets the
    // premium blueprint-style nonfiction cover.
    const vintage = ctx.bookType === 'cooking';
    const prompt = vintage ? CoverImagePrompt.buildVintage(coverInput) : CoverImagePrompt.build(coverInput);

    let image = await this.images.generate({ prompt, size: '1024x1536' });
    // FALL BACK TO THE STANDARD COVER. The vintage prompt is the only thing a
    // cooking book does differently here — same key, same processor, same
    // bucket as the normal books that are getting covers — so when only cooking
    // books come back without one, this call is what failed, and an image model
    // declining a period-pastiche prompt is the likely reason. A plainer cover
    // is worth far more to the seller than no cover at all, which is what the
    // failure produced: the step is best-effort, so the book simply shipped
    // with bare typography and nothing said why.
    if (vintage && image.isFail()) {
      this.logger.warn('🖼️  vintage cookbook cover failed — retrying with the standard cover', {
        projectId: projectId.value,
        error: image.error,
      });
      image = await this.images.generate({ prompt: CoverImagePrompt.build(coverInput), size: '1024x1536' });
    }
    if (image.isFail()) return Result.fail(image.error);

    // Re-encode before storing, exactly as illustrations are. If that fails we
    // still store the original — a book with a heavy cover beats a book with no
    // cover — but SAY SO, because the silent version of this fallback is what
    // makes an oversized export impossible to explain later.
    const shrunk = await this.imageProcessor.downscaleToJpeg({
      bytes: image.value.bytes,
      maxWidth: COVER_MAX_WIDTH,
      quality: COVER_JPEG_QUALITY,
    });
    if (shrunk.isFail()) {
      this.logger.warn('🖼️  cover re-encode failed — storing the original PNG', {
        projectId: projectId.value,
        bytes: image.value.bytes.byteLength,
        error: shrunk.error,
      });
    }
    const bytes = shrunk.isOk() ? shrunk.value.bytes : image.value.bytes;
    const contentType = shrunk.isOk() ? shrunk.value.contentType : image.value.contentType;

    const path = `${projectId.value}/cover.${contentType === 'image/jpeg' ? 'jpg' : 'png'}`;
    const put = await this.storage.put(EXPORT_BUCKET, path, bytes, contentType);
    if (put.isFail()) return Result.fail(put.error);

    book.setCoverImagePath(path);
    await this.books.save(book);
    return Result.ok({ generated: true });
  }
}

/**
 * Turn strategy key principles into labels short enough to read in the cover's
 * foot bar. Principles are written as guidance sentences ("decontaminate before
 * you polish"), so anything past three words is dropped rather than clipped —
 * the prompt omits the bar entirely when fewer than two survive, which looks far
 * better than a bar of truncated fragments.
 */
function toFeatureLabels(principles: string[]): string[] {
  return principles
    .map((p) => p.replace(/[.;:,]+$/, '').trim())
    .filter((p) => p.length > 0 && p.split(/\s+/).length <= 3)
    .slice(0, 5);
}

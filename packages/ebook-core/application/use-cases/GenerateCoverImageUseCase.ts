import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { KnowledgeRepository } from '../ports/repositories/KnowledgeRepository';
import type { ImageGenerator } from '../ports/services/ImageGenerator';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import { CoverImagePrompt } from '../prompts/CoverImagePrompt';
import { EXPORT_BUCKET } from './ExportEbookUseCase';

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
    const prompt =
      ctx.bookType === 'cooking' ? CoverImagePrompt.buildVintage(coverInput) : CoverImagePrompt.build(coverInput);

    const image = await this.images.generate({ prompt, size: '1024x1536' });
    if (image.isFail()) return Result.fail(image.error);

    const path = `${projectId.value}/cover.png`;
    const put = await this.storage.put(EXPORT_BUCKET, path, image.value.bytes, image.value.contentType);
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

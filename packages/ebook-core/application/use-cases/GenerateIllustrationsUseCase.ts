import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { Illustration } from '../../domain/book/Illustration';
import { IllustrationId } from '../../domain/book/ids';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { ImageGenerator } from '../ports/services/ImageGenerator';
import type { ImageProcessor } from '../ports/services/ImageProcessor';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { IdGenerator } from '../ports/IdGenerator';
import type { Logger } from '../ports/Logger';
import { IllustrationPrompt } from '../prompts/IllustrationPrompt';
import { RecipePhotoPrompt } from '../prompts/RecipePhotoPrompt';
import { parseRecipe } from '../../domain/book/Recipe';
import { EXPORT_BUCKET } from './ExportEbookUseCase';

/**
 * Generates the in-chapter illustrations and stores them in the exports bucket.
 * One illustration roughly every `illustrationEveryPages` finished pages, spread
 * across chapters in proportion to their length, and EACH generated from the
 * passage it sits beside so the art matches the surrounding content.
 *
 * Runs best-effort at the ASSEMBLING stage and is idempotent: a book that
 * already has illustrations is left untouched, so retries/re-exports neither
 * regenerate nor double-bill. Individual image failures are skipped, never fatal.
 */
export class GenerateIllustrationsUseCase {
  // Cap concurrent 69labs jobs: the API queues jobs and shared keys have a
  // concurrent-job limit, so firing a whole book's illustrations at once made the
  // excess jobs fail. A small pool keeps throughput high without flooding.
  // Overridable via IMAGE_CONCURRENCY so production can tune throughput without a
  // code change; clamped to a sane range.
  private static readonly MAX_CONCURRENT_IMAGES = clampConcurrency(process.env.IMAGE_CONCURRENCY, 4, 1, 20);

  // A cookbook generates one photo PER RECIPE (dozens), far more than a prose
  // book's handful of illustrations, so it gets its own (higher) default cap.
  // Overridable via RECIPE_PHOTO_CONCURRENCY.
  private static readonly MAX_CONCURRENT_RECIPE_PHOTOS = clampConcurrency(
    process.env.RECIPE_PHOTO_CONCURRENCY,
    8,
    1,
    24,
  );

  // Illustrations render at ~76% page width (≤125mm); ~1024px wide JPEG at q82 is
  // plenty for print and a fraction of the source PNG's size, so the inlined PDF
  // stays small and exports fast.
  private static readonly MAX_IMAGE_WIDTH = 1024;
  private static readonly JPEG_QUALITY = 82;

  constructor(
    private readonly books: BookRepository,
    private readonly projects: ProjectRepository,
    private readonly images: ImageGenerator,
    private readonly imageProcessor: ImageProcessor,
    private readonly storage: ObjectStorage,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
  ) {}

  async execute(cmd: { projectId: string }): Promise<Result<{ generated: number; attempted: number; error?: string }>> {
    const projectId = ProjectId.from(cmd.projectId);

    const project = await this.projects.findById(projectId);
    if (!project) return Result.fail('Project not found');
    // Cooking books ALWAYS get one food photo per recipe (a cookbook needs the
    // photos); the includeIllustrations toggle only gates prose-book illustrations.
    if (!project.options.isCooking && !project.options.includeIllustrations) {
      return Result.ok({ generated: 0, attempted: 0 }); // feature off
    }

    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');

    // Cooking books: one photo per recipe-chapter, driven by the recipe itself.
    // NOT gated on the "already has illustrations" guard below — a cookbook where
    // some recipes failed image-gen (e.g. 69labs rate limits) must be able to
    // BACKFILL the missing photos on re-run. generateRecipePhotos skips recipes
    // that already have a photo, so it only fills the gaps.
    if (project.options.isCooking) {
      return this.generateRecipePhotos({ projectId, book });
    }

    if (book.illustrations.length > 0) return Result.ok({ generated: 0, attempted: 0 }); // idempotent

    const ctx = await this.books.loadSharedContext(projectId);

    const everyPages = Math.max(1, project.options.illustrationEveryPages);

    // "One illustration per N pages" is anchored to the book's TARGET page count
    // (what the client chose), NOT the actual generated word count — otherwise a
    // book that the model wrote short would silently get far fewer images than the
    // client asked for. 100 target pages ÷ 5 ⇒ 20 illustrations.
    const targetCount = Math.max(1, Math.round(project.options.targetPages / everyPages));

    const chapters = [...book.chapters]
      .filter((c) => c.status === 'DONE' && (c.content ?? '').trim().length > 0)
      .sort((a, b) => a.position - b.position);
    if (chapters.length === 0) return Result.ok({ generated: 0, attempted: 0 });

    // Distribute the target count across chapters in proportion to their length
    // (largest-remainder), so longer chapters host more images and the total lands
    // exactly on targetCount regardless of how the words fell across chapters.
    const chapterWords = chapters.map((c) => (c.content ?? '').trim().split(/\s+/));
    const wordCounts = chapterWords.map((w) => w.length);
    const totalWords = wordCounts.reduce((a, b) => a + b, 0) || 1;
    const exact = wordCounts.map((w) => (w / totalWords) * targetCount);
    const counts = exact.map(Math.floor);
    let remainder = targetCount - counts.reduce((a, b) => a + b, 0);
    [...exact.keys()]
      .sort((a, b) => exact[b]! - counts[b]! - (exact[a]! - counts[a]!))
      .forEach((idx) => {
        if (remainder > 0) {
          counts[idx]!++;
          remainder--;
        }
      });

    const plan: Array<{ chapterId: string; chapterTitle: string; order: number; passage: string }> = [];
    chapters.forEach((ch, ci) => {
      const k = counts[ci]!;
      const words = chapterWords[ci]!;
      for (let i = 0; i < k; i++) {
        plan.push({
          chapterId: ch.id.value,
          chapterTitle: ch.title,
          order: i,
          // Passage = the slice of the chapter this slot sits over, so the prompt
          // (and therefore the art) matches the text it will be placed beside.
          passage: sliceWords(words, i, k, 160),
        });
      }
    });

    if (plan.length === 0) return Result.ok({ generated: 0, attempted: 0 });

    const total = plan.length;
    this.logger.info(`🖼️  illustrations: generating ${total} image(s) with 69labs`, {
      projectId: projectId.value,
      planned: total,
      targetCount,
      everyPages,
      eligibleChapters: chapters.length,
    });

    // Generate concurrently; a failed image is skipped, not fatal — but its reason
    // is captured so the caller can log WHY the bucket ended up short. `done`/`failed`
    // are bumped as each image settles (JS is single-threaded, so the ++ is safe) to
    // give a live "N/total" progress trail in the logs.
    let done = 0;
    let failed = 0;
    const outcomes = await mapWithConcurrency(
      plan,
      GenerateIllustrationsUseCase.MAX_CONCURRENT_IMAGES,
      async (slot): Promise<{ illustration?: Illustration; error?: string }> => {
        const prompt = IllustrationPrompt.build({
          chapterTitle: slot.chapterTitle,
          passage: slot.passage,
          bookSubject: ctx.knowledgeBase,
          tone: ctx.tone,
        });
        this.logger.debug('🖼️  illustration: requesting image', { projectId: projectId.value, chapter: slot.chapterTitle, order: slot.order });
        const image = await this.images.generate({ prompt, size: '1536x1024' });
        if (image.isFail()) {
          this.logger.warn(`🖼️  illustration failed (${++failed} failed, ${done} done / ${total})`, {
            projectId: projectId.value,
            chapter: slot.chapterTitle,
            order: slot.order,
            error: image.error,
          });
          return { error: `generate: ${image.error}` };
        }

        // Downscale + re-encode to JPEG before storing so the inlined PDF stays
        // small (gpt-image-1 PNGs are ~3MB). Best-effort: if processing fails we
        // store the original bytes rather than dropping the illustration.
        const shrunk = await this.imageProcessor.downscaleToJpeg({
          bytes: image.value.bytes,
          maxWidth: GenerateIllustrationsUseCase.MAX_IMAGE_WIDTH,
          quality: GenerateIllustrationsUseCase.JPEG_QUALITY,
        });
        const bytes = shrunk.isOk() ? shrunk.value.bytes : image.value.bytes;
        const contentType = shrunk.isOk() ? shrunk.value.contentType : image.value.contentType;
        const ext = contentType === 'image/jpeg' ? 'jpg' : 'png';

        const path = `${projectId.value}/illustrations/${slot.chapterId}-${slot.order}.${ext}`;
        const put = await this.storage.put(EXPORT_BUCKET, path, bytes, contentType);
        if (put.isFail()) {
          this.logger.warn(`🖼️  illustration store failed (${++failed} failed, ${done} done / ${total})`, {
            projectId: projectId.value,
            chapter: slot.chapterTitle,
            order: slot.order,
            error: put.error,
          });
          return { error: `store: ${put.error}` };
        }
        this.logger.info(`🖼️  illustration ${++done}/${total} done`, { projectId: projectId.value, chapter: slot.chapterTitle });
        return {
          illustration: Illustration.create({
            id: IllustrationId.from(this.ids.uuid()),
            chapterId: slot.chapterId,
            orderInChapter: slot.order,
            storagePath: path,
            prompt,
          }),
        };
      },
    );

    const made = outcomes.map((o) => o.illustration).filter((i): i is Illustration => i !== undefined);
    for (const ill of made) book.addIllustration(ill);
    if (made.length > 0) await this.books.save(book);

    this.logger.info(`🖼️  illustrations: finished — ${made.length}/${total} generated`, {
      projectId: projectId.value,
      generated: made.length,
      attempted: total,
    });

    const firstError = outcomes.find((o) => o.error)?.error;
    return Result.ok({
      generated: made.length,
      attempted: plan.length,
      ...(firstError ? { error: firstError } : {}),
    });
  }

  /**
   * Cooking books: one photorealistic hero photo per recipe. Each recipe-chapter
   * stores its recipe as JSON in `content`; we parse it to drive the photo prompt
   * from the actual dish, store it as illustration order 0 for that chapter, and
   * reuse the same downscale/store/concurrency path as prose illustrations.
   */
  private async generateRecipePhotos(input: {
    projectId: ProjectId;
    book: import('../../domain/book/Book').Book;
  }): Promise<Result<{ generated: number; attempted: number; error?: string }>> {
    const { projectId, book } = input;
    // Chapters that already have a photo — skip them so a re-run only backfills the
    // recipes whose image-gen failed the first time, never regenerating good ones.
    const withPhoto = new Set(book.illustrations.map((ill) => ill.chapterId));
    const recipes = [...book.chapters]
      .filter((c) => c.status === 'DONE' && !withPhoto.has(c.id.value))
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ chapterId: c.id.value, recipe: parseRecipe(c.content) }))
      .filter((r): r is { chapterId: string; recipe: NonNullable<ReturnType<typeof parseRecipe>> } => r.recipe !== null);

    if (recipes.length === 0) return Result.ok({ generated: 0, attempted: 0 });

    const total = recipes.length;
    const concurrency = GenerateIllustrationsUseCase.MAX_CONCURRENT_RECIPE_PHOTOS;
    this.logger.info(`🍽️  recipe photos: generating ${total} food photo(s), ${concurrency} at a time`, {
      projectId: projectId.value,
      planned: total,
      concurrency,
    });

    let done = 0;
    let failed = 0;
    const stageStart = Date.now();
    let sumImageMs = 0;
    const outcomes = await mapWithConcurrency(
      recipes,
      GenerateIllustrationsUseCase.MAX_CONCURRENT_RECIPE_PHOTOS,
      async (slot): Promise<{ illustration?: Illustration; error?: string }> => {
        const prompt = RecipePhotoPrompt.build({
          title: slot.recipe.title,
          description: slot.recipe.description,
        });
        const imgStart = Date.now();
        const image = await this.images.generate({ prompt, size: '1536x1024' });
        const imgMs = Date.now() - imgStart;
        if (image.isFail()) {
          this.logger.warn(`🍽️  recipe photo failed (${++failed} failed, ${done} done / ${total})`, {
            projectId: projectId.value,
            recipe: slot.recipe.title,
            error: image.error,
          });
          return { error: `generate: ${image.error}` };
        }
        const shrunk = await this.imageProcessor.downscaleToJpeg({
          bytes: image.value.bytes,
          maxWidth: GenerateIllustrationsUseCase.MAX_IMAGE_WIDTH,
          quality: GenerateIllustrationsUseCase.JPEG_QUALITY,
        });
        const bytes = shrunk.isOk() ? shrunk.value.bytes : image.value.bytes;
        const contentType = shrunk.isOk() ? shrunk.value.contentType : image.value.contentType;
        const ext = contentType === 'image/jpeg' ? 'jpg' : 'png';
        const path = `${projectId.value}/illustrations/${slot.chapterId}-0.${ext}`;
        const put = await this.storage.put(EXPORT_BUCKET, path, bytes, contentType);
        if (put.isFail()) {
          this.logger.warn(`🍽️  recipe photo store failed (${++failed} failed, ${done} done / ${total})`, {
            projectId: projectId.value,
            recipe: slot.recipe.title,
            error: put.error,
          });
          return { error: `store: ${put.error}` };
        }
        sumImageMs += imgMs;
        this.logger.info(`🍽️  recipe photo ${++done}/${total} done in ${(imgMs / 1000).toFixed(1)}s`, {
          projectId: projectId.value,
          recipe: slot.recipe.title,
          ms: imgMs,
        });
        return {
          illustration: Illustration.create({
            id: IllustrationId.from(this.ids.uuid()),
            chapterId: slot.chapterId,
            orderInChapter: 0,
            storagePath: path,
            prompt,
          }),
        };
      },
    );

    const made = outcomes.map((o) => o.illustration).filter((i): i is Illustration => i !== undefined);
    for (const ill of made) book.addIllustration(ill);
    if (made.length > 0) await this.books.save(book);

    // Wall-clock vs. summed per-image time reveals the real bottleneck:
    //   wallMs ≈ sumImageMs / concurrency  → concurrency is working; limit is per-image render time.
    //   wallMs ≈ sumImageMs (no speedup)   → jobs are serializing (proxy/agent/69labs queue).
    const wallMs = Date.now() - stageStart;
    const avgImageMs = made.length ? Math.round(sumImageMs / made.length) : 0;
    const effectiveParallelism = wallMs > 0 ? (sumImageMs / wallMs).toFixed(1) : '0';
    this.logger.info(
      `🍽️  recipe photos: finished — ${made.length}/${total} in ${(wallMs / 1000).toFixed(0)}s ` +
        `(avg ${(avgImageMs / 1000).toFixed(1)}s/image, effective parallelism ×${effectiveParallelism} of ${concurrency})`,
      {
        projectId: projectId.value,
        generated: made.length,
        attempted: total,
        wallMs,
        avgImageMs,
        effectiveParallelism,
        configuredConcurrency: concurrency,
      },
    );

    const firstError = outcomes.find((o) => o.error)?.error;
    return Result.ok({ generated: made.length, attempted: total, ...(firstError ? { error: firstError } : {}) });
  }
}

/** Parse an env override for a concurrency cap, clamped to [min, max]; fall back to `fallback`. */
function clampConcurrency(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Run `fn` over every item with at most `limit` in flight at once, preserving
 * input order in the result. A bounded pool (vs. Promise.all) keeps us from
 * flooding the image API while still overlapping the slow per-image polling.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The `index`-th of `count` equal word-slices of a chapter, trimmed to `maxWords`. */
function sliceWords(words: string[], index: number, count: number, maxWords: number): string {
  const per = Math.max(1, Math.floor(words.length / count));
  const start = index * per;
  return words
    .slice(start, start + maxWords)
    .join(' ')
    .replace(/[#*_`>]/g, '');
}

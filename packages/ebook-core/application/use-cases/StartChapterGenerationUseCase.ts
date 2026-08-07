import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import type { ProjectRepository } from '../ports/repositories/ProjectRepository';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { JobQueue } from '../ports/services/JobQueue';
import type { Clock } from '../ports/Clock';
import type { Hasher } from '../ports/Hasher';
import type { ProjectJob } from '../dto/jobs.dto';

/**
 * Delay applied to every chapter job except the first, so the first warms the
 * shared cached system prefix before the rest read it. Comfortably inside the
 * 5-minute ephemeral cache TTL.
 */
const CACHE_WARMUP_DELAY_MS = 20_000;

/**
 * Bridges GENERATING_CHAPTER_RESEARCH → GENERATING_CHAPTERS: advances the status,
 * sets the chapter fan-in barrier, and enqueues one chapter-generate job per chapter.
 * The first chapter is released immediately and the rest are briefly delayed to
 * warm the shared prompt cache (see CACHE_WARMUP_DELAY_MS).
 */
export class StartChapterGenerationUseCase {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly books: BookRepository,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly hasher: Hasher,
  ) {}

  async execute(cmd: ProjectJob): Promise<Result<void>> {
    const projectId = ProjectId.from(cmd.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book || !book.outline) return Result.fail('Book/outline missing');
    const project = await this.projects.findById(projectId);
    if (!project) return Result.fail('Project not found');

    project.setPending('GENERATING_CHAPTERS', book.chapters.length);
    project.advanceTo('GENERATING_CHAPTERS', this.clock.now());
    await this.projects.save(project);

    // Warm the cache before fanning out. Every chapter shares the same cached
    // system prefix (book strategy + knowledge base). If all jobs fire at once
    // none has written the cache yet, so each pays a full cache-write on that
    // large prefix. Release the first chapter immediately and delay the rest by
    // a short window so the first call writes the cache and the others read it.
    for (let index = 0; index < book.chapters.length; index += 1) {
      const chapter = book.chapters[index]!;
      const inputHash = this.hasher.hash({
        title: chapter.title,
        promise: chapter.promise,
        wordTarget: chapter.wordTarget,
        outline: book.outline.inputHash,
      });
      await this.queue.enqueue(
        'chapter-generate',
        { projectId: projectId.value, chapterId: chapter.id.value, inputHash, mode: 'generate' },
        {
          jobId: `chapter:${projectId.value}:${chapter.id.value}:${inputHash}`,
          ...(index === 0 ? {} : { delayMs: CACHE_WARMUP_DELAY_MS }),
        },
      );
    }
    return Result.ok();
  }
}

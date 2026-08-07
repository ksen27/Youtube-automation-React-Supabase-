import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { ChapterId } from '../../domain/book/ids';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { JobQueue } from '../ports/services/JobQueue';
import type { Hasher } from '../ports/Hasher';

/** Post-generation editing: enqueues a regenerate job with a fresh input hash. */
export class RegenerateChapterUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly queue: JobQueue,
    private readonly hasher: Hasher,
  ) {}

  async execute(input: {
    projectId: string;
    chapterId: string;
    instructions?: string;
  }): Promise<Result<{ inputHash: string }>> {
    const projectId = ProjectId.from(input.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');
    const chapter = book.chapter(ChapterId.from(input.chapterId));
    if (!chapter) return Result.fail('Chapter not found');

    const ctx = await this.books.loadSharedContext(projectId);
    // New hash → the generate worker will NOT treat it as already-done.
    const inputHash = this.hasher.hash({
      topic: chapter.topic,
      instructions: input.instructions ?? '',
      ctx: ctx.contextVersion,
      ts: chapter.version, // ensures monotonic distinctness across repeated regenerations
    });

    await this.queue.enqueue(
      'chapter-generate',
      {
        projectId: input.projectId,
        chapterId: input.chapterId,
        inputHash,
        mode: 'regenerate',
        ...(input.instructions ? { instructions: input.instructions } : {}),
      },
      { jobId: `chapter:${input.projectId}:${input.chapterId}:${inputHash}` },
    );
    return Result.ok({ inputHash });
  }
}

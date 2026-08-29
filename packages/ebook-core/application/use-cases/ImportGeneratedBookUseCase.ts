import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { ReferenceBook } from '../../domain/reference/ReferenceBook';
import { ReferenceBookId } from '../../domain/reference/ReferenceBookId';
import { ReferenceSection } from '../../domain/reference/ReferenceSection';
import type { BookRepository } from '../ports/repositories/BookRepository';
import type { ReferenceBookRepository } from '../ports/repositories/ReferenceBookRepository';
import type { JobQueue } from '../ports/services/JobQueue';
import type { IdGenerator } from '../ports/IdGenerator';
import type { Clock } from '../ports/Clock';

/**
 * Adds a book this system already generated to the reference library.
 *
 * This is how the existing catalogue enters the library: those books are
 * already structured text in `chapters`, so there is no file to upload, nothing
 * to parse, and no extraction step that can fail. One chapter becomes one
 * retrievable section.
 *
 * A note on what this means for output: a book generated FROM a book this
 * system generated is a copy of a copy, and style tends to flatten across such
 * a chain. That is a decision for whoever picks the reference, not something
 * this use case can prevent — but it is the reason `source` is recorded, so the
 * library can show which references are homegrown.
 */
export class ImportGeneratedBookUseCase {
  constructor(
    private readonly books: BookRepository,
    private readonly references: ReferenceBookRepository,
    private readonly queue: JobQueue,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: { ownerId: string; projectId: string; author?: string | null }): Promise<Result<{ referenceBookId: string }>> {
    const projectId = ProjectId.from(input.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('No book found for that project');

    // Chapters with no prose are chapters the pipeline never finished. Importing
    // them would put empty sections in the corpus, which retrieval would then
    // rank and return as material.
    const written = book.chapters
      .filter((c) => (c.content ?? '').trim().length > 0)
      .sort((a, b) => a.position - b.position);
    if (written.length === 0) return Result.fail('That book has no written chapters yet');

    const sections = written.map((chapter, index) =>
      ReferenceSection.create({
        position: index,
        title: chapter.title,
        content: chapter.content ?? '',
      }),
    );

    const reference = ReferenceBook.fromGeneratedBook({
      id: ReferenceBookId.from(this.ids.uuid()),
      ownerId: input.ownerId,
      title: book.title ?? 'Untitled book',
      author: input.author ?? null,
      originProjectId: input.projectId,
      sections,
      now: this.clock.now(),
    });
    if (reference.isFail()) return Result.fail(reference.error);

    await this.references.save(reference.value);
    // Style extraction is what makes a reference usable as a VOICE, and it is a
    // model call — so it runs as a job rather than inline in a request. The
    // reference is already selectable for material; the profile arrives shortly.
    await this.queue.enqueue(
      'reference-extract',
      { referenceBookId: reference.value.id.value },
      { jobId: `reference-extract:${reference.value.id.value}` },
    );
    return Result.ok({ referenceBookId: reference.value.id.value });
  }
}

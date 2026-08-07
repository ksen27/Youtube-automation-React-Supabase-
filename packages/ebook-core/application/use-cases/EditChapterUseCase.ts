import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { ChapterId } from '../../domain/book/ids';
import type { BookRepository } from '../ports/repositories/BookRepository';

/**
 * Manual chapter edit (PATCH /api/chapters/:id). Snapshots the current content
 * into chapter_versions, then replaces it — no AI call, no queue. Bumps the
 * chapter version so the edit is undoable and so a later regeneration is distinct.
 */
export class EditChapterUseCase {
  constructor(private readonly books: BookRepository) {}

  async execute(input: {
    projectId: string;
    chapterId: string;
    content: string;
  }): Promise<Result<{ version: number; wordCount: number }>> {
    const projectId = ProjectId.from(input.projectId);
    const book = await this.books.findByProject(projectId);
    if (!book) return Result.fail('Book not found');

    const chapterId = ChapterId.from(input.chapterId);
    const chapter = book.chapter(chapterId);
    if (!chapter) return Result.fail('Chapter not found');

    // Preserve history before overwriting (no-op if the chapter has no content yet).
    await this.books.snapshotChapterVersion(book.id, input.chapterId);

    chapter.editContent(input.content);
    await this.books.save(book);
    return Result.ok({ version: chapter.version, wordCount: chapter.totalWords() });
  }
}

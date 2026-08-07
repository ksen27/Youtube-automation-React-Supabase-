import { Result } from '../../domain/shared/Result';
import { ProjectId } from '../../domain/project/ProjectId';
import { BookSectionId } from '../../domain/book/ids';
import type { BookRepository } from '../ports/repositories/BookRepository';

/**
 * Manual edit of a book-level section — the front/back matter (preface,
 * acknowledgments, introduction, conclusion, …). Mirrors EditChapterUseCase but
 * for BookSection: no AI call, no queue. Book sections aren't versioned, so this
 * simply overwrites the content and persists the book.
 */
export class EditBookSectionUseCase {
  constructor(private readonly books: BookRepository) {}

  async execute(input: {
    projectId: string;
    sectionId: string;
    content: string;
  }): Promise<Result<{ wordCount: number }>> {
    const book = await this.books.findByProject(ProjectId.from(input.projectId));
    if (!book) return Result.fail('Book not found');

    const section = book.bookSection(BookSectionId.from(input.sectionId));
    if (!section) return Result.fail('Section not found');

    section.fill(input.content);
    await this.books.save(book);

    const wordCount = input.content.trim() ? input.content.trim().split(/\s+/).length : 0;
    return Result.ok({ wordCount });
  }
}

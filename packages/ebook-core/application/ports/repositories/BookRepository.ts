import type { Book } from '../../../domain/book/Book';
import type { Chapter } from '../../../domain/book/Chapter';
import type { BookId } from '../../../domain/book/ids';
import type { ProjectId } from '../../../domain/project/ProjectId';

export interface SharedChapterContext {
  bookStrategy: string;
  knowledgeBase: string;
  tone: string;
  authorVoice: string;
  contextVersion: string;
  /** The kind of book being written; drives recipe vs. prose generation. */
  bookType: 'normal' | 'cooking';
  /** User-supplied book title; when set it governs each chapter's subject matter. */
  bookTitle?: string | undefined;
}

/**
 * Just enough of a book to sell it: what a landing page card shows.
 *
 * Exists because `findByProject` loads the whole aggregate — every chapter's
 * full prose, its sections and its illustrations, tens of megabytes for a
 * finished book. The landing page reads four fields and none of the text, and
 * a three-book page multiplied that waste by three until the database killed
 * the query.
 */
export interface BookSummary {
  title: string | null;
  coverImagePath: string | null;
  /** Chapter titles in reading order. */
  chapterTitles: string[];
  /** Outline entries, for the "what's inside" breakdown. */
  outline: Array<{ title: string; keyPoints: string[] }>;
  /** True when the book has chapters — i.e. it is finished enough to sell. */
  hasChapters: boolean;
}

export interface BookRepository {
  findByProject(projectId: ProjectId): Promise<Book | null>;
  /** The selling-relevant fields only, without loading any chapter prose. */
  findSummaryByProject(projectId: ProjectId): Promise<BookSummary | null>;
  findById(id: BookId): Promise<Book | null>;
  save(book: Book): Promise<void>;
  /**
   * Persist a single chapter (and its sections) without rewriting the rest of the
   * book. Required for parallel per-chapter writes (e.g. polishing): a full
   * `save(book)` re-upserts every chapter, so concurrent savers would clobber
   * each other's in-flight changes with their own stale snapshot.
   */
  saveChapter(bookId: BookId, chapter: Chapter): Promise<void>;
  /** Snapshot current chapter content into chapter_versions before a regenerate. */
  snapshotChapterVersion(bookId: BookId, chapterId: string): Promise<void>;
  /** The cached prompt prefix shared across all chapter generations. */
  loadSharedContext(projectId: ProjectId): Promise<SharedChapterContext>;
}

import type { ChannelKnowledgeBase } from '../../../domain/channel/ChannelKnowledgeBase';
import type { BookStrategy } from '../../../domain/book/BookStrategy';
import type { ChapterResearch } from '../../../domain/book/ChapterResearch';
import type { ProjectId } from '../../../domain/project/ProjectId';
import type { ChapterId } from '../../../domain/book/ids';

/**
 * Persistence for the artifacts a book is written from: the knowledge base, the
 * strategy derived from it, and per-chapter research.
 *
 * The per-video comment-insight methods that used to live here went with the
 * channel-ingest pipeline — there are no videos left to attach insights to.
 */
export interface KnowledgeRepository {
  /** The project's knowledge base — what the book is written from. */
  saveKnowledgeBase(projectId: ProjectId, kb: ChannelKnowledgeBase): Promise<void>;
  getKnowledgeBase(projectId: ProjectId): Promise<ChannelKnowledgeBase | null>;

  // Book strategy (per project)
  saveBookStrategy(projectId: ProjectId, strategy: BookStrategy): Promise<void>;
  getBookStrategy(projectId: ProjectId): Promise<BookStrategy | null>;

  // Chapter research (per chapter)
  saveChapterResearch(projectId: ProjectId, research: ChapterResearch): Promise<void>;
  getChapterResearch(chapterId: ChapterId): Promise<ChapterResearch | null>;
}

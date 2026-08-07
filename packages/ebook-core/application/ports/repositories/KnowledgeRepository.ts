import type { CommentInsights } from '../../../domain/video/CommentInsights';
import type { ChannelKnowledgeBase } from '../../../domain/channel/ChannelKnowledgeBase';
import type { BookStrategy } from '../../../domain/book/BookStrategy';
import type { ChapterResearch } from '../../../domain/book/ChapterResearch';
import type { ProjectId } from '../../../domain/project/ProjectId';
import type { VideoId } from '../../../domain/video/VideoId';
import type { ChapterId } from '../../../domain/book/ids';

/** Persistence for the deeper AI artifacts of the full pipeline (phases 6–10). */
export interface KnowledgeRepository {
  // Phase 6 — comment insights (per video)
  saveCommentInsights(videoId: VideoId, insights: CommentInsights): Promise<void>;
  getCommentInsights(videoId: VideoId): Promise<CommentInsights | null>;
  listCommentInsights(projectId: ProjectId): Promise<CommentInsights[]>;
  /** Cheap count of videos in a project that already have comment insights. */
  countCommentInsights(projectId: ProjectId): Promise<number>;

  // Phase 7 — channel knowledge base (per project)
  saveKnowledgeBase(projectId: ProjectId, kb: ChannelKnowledgeBase): Promise<void>;
  getKnowledgeBase(projectId: ProjectId): Promise<ChannelKnowledgeBase | null>;

  // Phase 8 — book strategy (per project)
  saveBookStrategy(projectId: ProjectId, strategy: BookStrategy): Promise<void>;
  getBookStrategy(projectId: ProjectId): Promise<BookStrategy | null>;

  // Phase 10 — chapter research (per chapter)
  saveChapterResearch(projectId: ProjectId, research: ChapterResearch): Promise<void>;
  getChapterResearch(chapterId: ChapterId): Promise<ChapterResearch | null>;
}

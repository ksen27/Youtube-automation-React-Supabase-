import type { SupabaseClient } from '@supabase/supabase-js';
import {  ChannelKnowledgeBase,
  BookStrategy,
  ChapterResearch,
  ProjectId,  ChapterId,
  type KnowledgeRepository,
} from '@ebook/core';

/**
 * Persists the artifacts a book is written from (knowledge base, strategy,
 * chapter research). Each is stored as a `data`
 * JSONB blob (the VO's toJSON) plus an `input_hash` for idempotency and the
 * owning key (project/video/chapter).
 */
export class SupabaseKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly db: SupabaseClient) {}

  // ── Phase 7 — channel knowledge base ──────────────────────────────────────
  async saveKnowledgeBase(projectId: ProjectId, kb: ChannelKnowledgeBase): Promise<void> {
    const { error } = await this.db.from('channel_knowledge_bases').upsert(
      { project_id: projectId.value, data: kb.toJSON(), input_hash: kb.inputHash },
      { onConflict: 'project_id' },
    );
    if (error) throw new Error(error.message);
  }

  async getKnowledgeBase(projectId: ProjectId): Promise<ChannelKnowledgeBase | null> {
    const { data } = await this.db.from('channel_knowledge_bases').select('data').eq('project_id', projectId.value).maybeSingle();
    return data ? ChannelKnowledgeBase.create(data.data) : null;
  }

  // ── Phase 8 — book strategy ───────────────────────────────────────────────
  async saveBookStrategy(projectId: ProjectId, strategy: BookStrategy): Promise<void> {
    const { error } = await this.db.from('book_strategies').upsert(
      { project_id: projectId.value, data: strategy.toJSON(), input_hash: strategy.inputHash },
      { onConflict: 'project_id' },
    );
    if (error) throw new Error(error.message);
  }

  async getBookStrategy(projectId: ProjectId): Promise<BookStrategy | null> {
    const { data } = await this.db.from('book_strategies').select('data').eq('project_id', projectId.value).maybeSingle();
    return data ? BookStrategy.create(data.data) : null;
  }

  // ── Phase 10 — chapter research ───────────────────────────────────────────
  async saveChapterResearch(projectId: ProjectId, research: ChapterResearch): Promise<void> {
    const { error } = await this.db.from('chapter_research').upsert(
      { chapter_id: research.chapterId, project_id: projectId.value, data: research.toJSON(), input_hash: research.inputHash },
      { onConflict: 'chapter_id' },
    );
    if (error) throw new Error(error.message);
  }

  async getChapterResearch(chapterId: ChapterId): Promise<ChapterResearch | null> {
    const { data } = await this.db.from('chapter_research').select('data').eq('chapter_id', chapterId.value).maybeSingle();
    return data ? ChapterResearch.create(data.data) : null;
  }
}

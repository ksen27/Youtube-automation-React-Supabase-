import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Book,
  BookId,
  Chapter,
  ChapterId,
  Section,
  SectionId,
  BookSection,
  BookSectionId,
  Illustration,
  IllustrationId,
  Outline,
  ProjectId,
  type BookRepository,
  type BookSummary,
  type SharedChapterContext,
} from '@ebook/core';
import { queryError } from './queryError';

export class SupabaseBookRepository implements BookRepository {
  constructor(private readonly db: SupabaseClient) {}

  async findByProject(projectId: ProjectId): Promise<Book | null> {
    const { data, error } = await this.db
      .from('books')
      .select('*, outlines(*), chapters(*, sections(*)), book_sections(*), book_illustrations(*)')
      .eq('project_id', projectId.value)
      .maybeSingle();
    // Surface real query failures (e.g. a missing table before its migration is
    // applied) instead of returning null and masquerading as "not found".
    if (error) throw queryError('books', 'findByProject', error);
    if (!data) return null;
    return this.toDomain(data);
  }

  /**
   * The landing page's view of a book: no chapter content, no sections, no
   * illustrations. Selecting `chapters(*)` here would drag every chapter's
   * prose across the wire — which is what timed out the statement once a
   * three-book page started loading three of them.
   */
  async findSummaryByProject(projectId: ProjectId): Promise<BookSummary | null> {
    const { data, error } = await this.db
      .from('books')
      .select('title, cover_image_path, outlines(structure), chapters(position, title)')
      .eq('project_id', projectId.value)
      .maybeSingle();
    if (error) throw queryError('books', 'findSummaryByProject', error);
    if (!data) return null;

    const row = data as {
      title: string | null;
      cover_image_path: string | null;
      outlines: Array<{ structure: Array<{ title: string; keyPoints?: string[] }> }> | null;
      chapters: Array<{ position: number; title: string }> | null;
    };
    // Postgres returns embedded rows unordered; reading order is the position.
    const chapters = [...(row.chapters ?? [])].sort((a, b) => a.position - b.position);

    return {
      title: row.title,
      coverImagePath: row.cover_image_path,
      chapterTitles: chapters.map((c) => c.title),
      outline: (row.outlines?.[0]?.structure ?? []).map((e) => ({
        title: e.title,
        keyPoints: e.keyPoints ?? [],
      })),
      hasChapters: chapters.length > 0,
    };
  }

  async findById(id: BookId): Promise<Book | null> {
    const { data, error } = await this.db
      .from('books')
      .select('*, outlines(*), chapters(*, sections(*)), book_sections(*), book_illustrations(*)')
      .eq('id', id.value)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? this.toDomain(data) : null;
  }

  async save(book: Book): Promise<void> {
    // Omit cover_image_path when this instance doesn't have one. The cover is
    // generated concurrently with front/back matter (both load the book, both
    // full-save). A copy loaded before the cover existed carries a null path, and
    // including it here would overwrite the cover the other job just wrote. On a
    // conflict-update an omitted column keeps its existing DB value, so only the
    // job that actually has the path ever sets it — no lost update.
    const { error: bookErr } = await this.db.from('books').upsert(
      {
        id: book.id.value,
        project_id: book.projectId,
        title: book.title,
        status: 'GENERATING',
        ...(book.coverImagePath ? { cover_image_path: book.coverImagePath } : {}),
      },
      { onConflict: 'project_id' },
    );
    if (bookErr) throw new Error(bookErr.message);

    if (book.outline) {
      await this.db.from('outlines').upsert(
        { book_id: book.id.value, version: book.outline.version, structure: book.outline.entries, input_hash: book.outline.inputHash },
        { onConflict: 'book_id,version' },
      );
    }
    for (const ch of book.chapters) {
      await this.persistChapter(book.id, ch);
    }

    // Phase 13 — book-level extra content (front/back matter).
    for (const bs of book.bookSections) {
      await this.db.from('book_sections').upsert(
        {
          id: bs.id.value,
          book_id: book.id.value,
          kind: bs.kind,
          placement: bs.placement,
          position: bs.position,
          title: bs.title,
          prompt: bs.prompt,
          content: bs.content,
          status: bs.status,
        },
        { onConflict: 'id' },
      );
    }

    // In-chapter illustrations (generated at the assembling stage). Keyed by
    // (chapter_id, order_in_chapter) so a re-run overwrites in place, never duplicates.
    for (const ill of book.illustrations) {
      await this.db.from('book_illustrations').upsert(
        {
          id: ill.id.value,
          book_id: book.id.value,
          chapter_id: ill.chapterId,
          order_in_chapter: ill.orderInChapter,
          storage_path: ill.storagePath,
          prompt: ill.prompt,
        },
        { onConflict: 'chapter_id,order_in_chapter' },
      );
    }
  }

  async saveChapter(bookId: BookId, chapter: Chapter): Promise<void> {
    await this.persistChapter(bookId, chapter);
  }

  /** Upsert one chapter row plus its sections (shared by save and saveChapter). */
  private async persistChapter(bookId: BookId, ch: Chapter): Promise<void> {
    const { error } = await this.db.from('chapters').upsert(
      {
        id: ch.id.value,
        book_id: bookId.value,
        position: ch.position,
        title: ch.title,
        topic: ch.topic,
        promise: ch.promise,
        key_points: ch.keyPoints,
        word_target: ch.wordTarget,
        content: ch.content,
        word_count: ch.totalWords(),
        status: ch.status,
        version: ch.version,
        input_hash: ch.inputHash,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'book_id,position' },
    );
    if (error) throw new Error(error.message);
    for (const sec of ch.sections) {
      await this.db.from('sections').upsert(
        { id: sec.id.value, chapter_id: ch.id.value, position: sec.position, title: sec.title, content: sec.content, status: sec.status },
        { onConflict: 'chapter_id,position' },
      );
    }
  }

  async snapshotChapterVersion(_bookId: BookId, chapterId: string): Promise<void> {
    const { data } = await this.db.from('chapters').select('content, version').eq('id', chapterId).maybeSingle();
    if (!data?.content) return;
    await this.db.from('chapter_versions').upsert(
      { chapter_id: chapterId, version: data.version, content: data.content },
      { onConflict: 'chapter_id,version' },
    );
  }

  async loadSharedContext(projectId: ProjectId): Promise<SharedChapterContext> {
    // The cacheable shared prefix for chapter writing: book strategy + knowledge base.
    const [{ data: strategy }, { data: kb }, { data: project }] = await Promise.all([
      this.db
        .from('book_strategies')
        .select('data, input_hash')
        .eq('project_id', projectId.value)
        .maybeSingle(),
      this.db
        .from('channel_knowledge_bases')
        .select('data, input_hash')
        .eq('project_id', projectId.value)
        .maybeSingle(),
      this.db.from('projects').select('options').eq('id', projectId.value).maybeSingle(),
    ]);
    const s = (strategy?.data ?? {}) as Record<string, unknown>;
    const options = (project?.options ?? {}) as Record<string, unknown>;
    return {
      bookStrategy: renderRecord(s),
      knowledgeBase: renderRecord((kb?.data ?? {}) as Record<string, unknown>),
      tone: typeof s.tone === 'string' ? s.tone : 'professional',
      authorVoice: typeof s.authorVoice === 'string' ? s.authorVoice : 'authoritative and clear',
      contextVersion: `${strategy?.input_hash ?? ''}:${kb?.input_hash ?? ''}`,
      bookType: options.bookType === 'cooking' ? 'cooking' : 'normal',
      ...(typeof options.bookTitle === 'string' && options.bookTitle.trim()
        ? { bookTitle: options.bookTitle.trim() }
        : {}),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toDomain(row: any): Book {
    const book = Book.rehydrate(
      {
        projectId: row.project_id,
        title: row.title ?? null,
        targetPages: row.target_pages ?? 100,
        status: row.status ?? 'PENDING',
        coverImagePath: row.cover_image_path ?? null,
        chapters: (row.chapters ?? [])
          .sort((a: { position: number }, b: { position: number }) => a.position - b.position)
          .map((c: any) =>
            Chapter.rehydrate(
              {
                bookId: row.id,
                position: c.position,
                title: c.title,
                topic: c.topic,
                promise: c.promise ?? '',
                keyPoints: c.key_points ?? [],
                wordTarget: c.word_target,
                content: c.content ?? null,
                wordCount: c.word_count ?? 0,
                status: c.status ?? 'PENDING',
                version: c.version ?? 1,
                inputHash: c.input_hash ?? null,
                sections: (c.sections ?? []).map((s: any) =>
                  Section.rehydrate(
                    { chapterId: c.id, position: s.position, title: s.title, prompt: s.prompt ?? null, content: s.content ?? null, status: s.status ?? 'PENDING' },
                    SectionId.from(s.id),
                  ),
                ),
              },
              ChapterId.from(c.id),
            ),
          ),
        illustrations: (row.book_illustrations ?? []).map((i: any) =>
          Illustration.rehydrate(
            {
              chapterId: i.chapter_id,
              orderInChapter: i.order_in_chapter,
              storagePath: i.storage_path,
              prompt: i.prompt ?? null,
            },
            IllustrationId.from(i.id),
          ),
        ),
        bookSections: (row.book_sections ?? []).map((s: any) =>
          BookSection.rehydrate(
            {
              bookId: row.id,
              kind: s.kind,
              placement: s.placement,
              position: s.position,
              title: s.title,
              prompt: s.prompt ?? null,
              content: s.content ?? null,
              status: s.status ?? 'PENDING',
            },
            BookSectionId.from(s.id),
          ),
        ),
        ...(row.outlines?.[0]
          ? { outline: Outline.create({ version: row.outlines[0].version, entries: row.outlines[0].structure, inputHash: row.outlines[0].input_hash }) }
          : {}),
      },
      BookId.from(row.id),
    );
    return book;
  }
}

/** Render a stored JSON artifact (strategy/knowledge base) into a prompt-friendly block. */
function renderRecord(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([key]) => key !== 'inputHash')
    .map(([key, value]) => `${humanize(key)}: ${Array.isArray(value) ? value.join('; ') : String(value)}`)
    .join('\n');
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

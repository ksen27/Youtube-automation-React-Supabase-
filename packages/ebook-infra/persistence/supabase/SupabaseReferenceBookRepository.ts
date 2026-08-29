import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ReferenceBook,
  ReferenceBookId,
  ReferenceSection,
  ProjectId,
  type ReferenceBookRepository,
  type ReferenceBookSummary,
} from '@ebook/core';
import { queryError } from './queryError';

interface SectionRow {
  position: number;
  title: string | null;
  content: string;
}

interface BookRow {
  id: string;
  owner_id: string;
  title: string;
  author: string | null;
  source: 'upload' | 'generated';
  origin_project_id: string | null;
  storage_path: string | null;
  content_type: string | null;
  byte_size: number | null;
  status: 'PENDING' | 'GENERATING' | 'DONE' | 'FAILED';
  error: string | null;
  created_at: string;
  updated_at: string;
  reference_sections?: SectionRow[] | null;
}

/** Persists the reference-book library (migration 0041). */
export class SupabaseReferenceBookRepository implements ReferenceBookRepository {
  constructor(private readonly db: SupabaseClient) {}

  async save(book: ReferenceBook): Promise<void> {
    const { error } = await this.db.from('reference_books').upsert({
      id: book.id.value,
      owner_id: book.ownerId,
      title: book.title,
      author: book.author,
      source: book.source,
      origin_project_id: book.originProjectId,
      storage_path: book.storagePath,
      content_type: book.contentType,
      byte_size: book.byteSize,
      status: book.status,
      error: book.error,
      word_count: book.wordCount,
      updated_at: book.updatedAt.toISOString(),
    });
    if (error) throw queryError('reference_books', 'save', error);

    if (book.sections.length === 0) return;
    // Replace rather than upsert: re-extraction can produce a DIFFERENT number
    // of sections, and upserting by position would leave the tail of the
    // previous extraction behind — a reference that is half one parse and half
    // another, with no way to tell from the row.
    const { error: clearError } = await this.db
      .from('reference_sections')
      .delete()
      .eq('reference_book_id', book.id.value);
    if (clearError) throw queryError('reference_sections', 'save/clear', clearError);

    const { error: sectionError } = await this.db.from('reference_sections').insert(
      book.sections.map((s) => ({
        reference_book_id: book.id.value,
        position: s.position,
        title: s.title,
        content: s.content,
        word_count: s.wordCount,
      })),
    );
    if (sectionError) throw queryError('reference_sections', 'save/insert', sectionError);
  }

  async findById(id: ReferenceBookId): Promise<ReferenceBook | null> {
    const { data, error } = await this.db
      .from('reference_books')
      .select('*, reference_sections(position, title, content)')
      .eq('id', id.value)
      .maybeSingle();
    if (error) throw queryError('reference_books', 'findById', error);
    if (!data) return null;
    return this.toDomain(data as BookRow);
  }

  async list(ownerId: string): Promise<ReferenceBookSummary[]> {
    // No `content` in the projection, deliberately — see the port's note. The
    // counts come from the denormalized column and an aggregate, not from
    // pulling the sections back.
    const { data, error } = await this.db
      .from('reference_books')
      .select('id, title, author, source, status, word_count, error, created_at, reference_sections(count)')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false });
    if (error) throw queryError('reference_books', 'list', error);
    const rows = (data ?? []) as Array<{
      id: string;
      title: string;
      author: string | null;
      source: 'upload' | 'generated';
      status: ReferenceBookSummary['status'];
      word_count: number | null;
      error: string | null;
      created_at: string;
      reference_sections?: Array<{ count: number }> | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      source: r.source,
      status: r.status,
      wordCount: r.word_count ?? 0,
      sectionCount: r.reference_sections?.[0]?.count ?? 0,
      error: r.error,
      createdAt: r.created_at,
    }));
  }

  async remove(id: ReferenceBookId): Promise<void> {
    const { error } = await this.db.from('reference_books').delete().eq('id', id.value);
    // The RESTRICT foreign key in 0041 is what fails here when a project was
    // generated from this reference. Translate it, rather than surfacing a raw
    // constraint name to whoever clicked delete.
    if (error) {
      if (error.code === '23503') {
        throw new Error('This reference book was used to generate a book and cannot be deleted.');
      }
      throw queryError('reference_books', 'remove', error);
    }
  }

  async attachToProject(projectId: ProjectId, referenceBookIds: ReferenceBookId[]): Promise<void> {
    if (referenceBookIds.length === 0) return;
    const { error } = await this.db.from('project_reference_books').upsert(
      referenceBookIds.map((id, position) => ({
        project_id: projectId.value,
        reference_book_id: id.value,
        position,
      })),
      { onConflict: 'project_id,reference_book_id' },
    );
    if (error) throw queryError('project_reference_books', 'attachToProject', error);
  }

  async findByProject(projectId: ProjectId): Promise<ReferenceBook[]> {
    const { data, error } = await this.db
      .from('project_reference_books')
      .select('position, reference_books(*, reference_sections(position, title, content))')
      .eq('project_id', projectId.value)
      .order('position', { ascending: true });
    if (error) throw queryError('project_reference_books', 'findByProject', error);
    const rows = (data ?? []) as unknown as Array<{ position: number; reference_books: BookRow | null }>;
    return rows
      .map((r) => r.reference_books)
      .filter((b): b is BookRow => b !== null)
      .map((b) => this.toDomain(b));
  }

  async listSectionsForProject(projectId: ProjectId): Promise<ReferenceSection[]> {
    const books = await this.findByProject(projectId);
    // Renumbered across the whole corpus: two references both starting at
    // position 0 would otherwise collide, and retrieval ranks over the flat
    // list without caring which book a passage came from.
    let position = 0;
    return books.flatMap((book) =>
      book.sections.map((s) =>
        ReferenceSection.create({
          position: position++,
          title: s.title,
          content: s.content,
        }),
      ),
    );
  }

  private toDomain(row: BookRow): ReferenceBook {
    const sections = (row.reference_sections ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => ReferenceSection.create({ position: s.position, title: s.title, content: s.content }));
    return ReferenceBook.rehydrate(
      {
        ownerId: row.owner_id,
        title: row.title,
        author: row.author,
        source: row.source,
        originProjectId: row.origin_project_id,
        storagePath: row.storage_path,
        contentType: row.content_type,
        byteSize: row.byte_size,
        status: row.status,
        error: row.error,
        sections,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      },
      ReferenceBookId.from(row.id),
    );
  }
}

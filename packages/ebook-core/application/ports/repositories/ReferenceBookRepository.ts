import type { ReferenceBook } from '../../../domain/reference/ReferenceBook';
import type { ReferenceBookId } from '../../../domain/reference/ReferenceBookId';
import type { ReferenceSection } from '../../../domain/reference/ReferenceSection';
import type { ProjectId } from '../../../domain/project/ProjectId';

/** A library row: everything the picker shows, without loading any text. */
export interface ReferenceBookSummary {
  id: string;
  title: string;
  author: string | null;
  source: 'upload' | 'generated';
  status: 'PENDING' | 'GENERATING' | 'DONE' | 'FAILED';
  wordCount: number;
  sectionCount: number;
  error: string | null;
  createdAt: string;
}

/**
 * The reference-book library.
 *
 * Note the split between `list` and `findById`: the library picker renders
 * dozens of references and needs none of their text, while research needs one
 * reference's every section. Serving the listing from the aggregate would drag
 * a hundred chapters of prose per row into a page that displays a title — the
 * same mistake `findSummarizedByProject` existed to avoid on the video side.
 */
export interface ReferenceBookRepository {
  save(book: ReferenceBook): Promise<void>;
  findById(id: ReferenceBookId): Promise<ReferenceBook | null>;
  /** Library listing for the picker — metadata only, newest first. */
  list(ownerId: string): Promise<ReferenceBookSummary[]>;
  /** Deletes a reference. Fails if a project was generated from it. */
  remove(id: ReferenceBookId): Promise<void>;

  /** Record which references a project is being generated from, in order. */
  attachToProject(projectId: ProjectId, referenceBookIds: ReferenceBookId[]): Promise<void>;
  /** The references a project was generated from, in order. */
  findByProject(projectId: ProjectId): Promise<ReferenceBook[]>;
  /**
   * Every section of a project's references, flattened and in order — the
   * corpus chapter research retrieves from.
   */
  listSectionsForProject(projectId: ProjectId): Promise<ReferenceSection[]>;
}

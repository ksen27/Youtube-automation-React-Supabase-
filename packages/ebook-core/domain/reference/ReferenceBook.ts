import { AggregateRoot } from '../shared/AggregateRoot';
import { Result } from '../shared/Result';
import { ReferenceBookId } from './ReferenceBookId';
import { ReferenceSection } from './ReferenceSection';

/** Where a reference came from. See migration 0041 for why one table holds both. */
export type ReferenceSource = 'upload' | 'generated';

/** Extraction lifecycle. A reference is only usable once it reaches DONE. */
export type ReferenceStatus = 'PENDING' | 'GENERATING' | 'DONE' | 'FAILED';

/**
 * A book the pipeline writes FROM: either a file the user uploaded, or one this
 * system generated earlier.
 *
 * The durable artifact is the extracted TEXT, not the file. An upload keeps its
 * storage path so extraction can be re-run if the parser improves, but nothing
 * downstream ever reads the original bytes — which is what lets a generated
 * book, with no file at all, sit in the same library on equal terms.
 */
interface ReferenceBookProps {
  ownerId: string;
  title: string;
  author: string | null;
  source: ReferenceSource;
  /** source === 'generated': the project whose finished book this is. */
  originProjectId: string | null;
  /** source === 'upload': the stored original. */
  storagePath: string | null;
  contentType: string | null;
  byteSize: number | null;
  status: ReferenceStatus;
  error: string | null;
  sections: ReferenceSection[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Below this, a "reference" cannot teach a voice. A two-page PDF or a failed
 * parse that yielded a page of navigation chrome would otherwise be selectable
 * and produce a book with nothing behind it — a failure that shows up only in
 * the finished manuscript, which is the most expensive place to find it.
 */
const MIN_USABLE_WORDS = 2000;

export class ReferenceBook extends AggregateRoot<ReferenceBookProps, ReferenceBookId> {
  static uploaded(input: {
    id: ReferenceBookId;
    ownerId: string;
    title: string;
    storagePath: string;
    contentType: string;
    byteSize: number;
    now: Date;
  }): Result<ReferenceBook> {
    if (input.title.trim().length === 0) return Result.fail('A reference book needs a title');
    if (input.ownerId.trim().length === 0) return Result.fail('ownerId is required');
    return Result.ok(
      new ReferenceBook(
        {
          ownerId: input.ownerId,
          title: input.title.trim(),
          author: null,
          source: 'upload',
          originProjectId: null,
          storagePath: input.storagePath,
          contentType: input.contentType,
          byteSize: input.byteSize,
          // An upload arrives as bytes and nothing else; text extraction is a
          // separate step, so it starts PENDING rather than usable.
          status: 'PENDING',
          error: null,
          sections: [],
          createdAt: input.now,
          updatedAt: input.now,
        },
        input.id,
      ),
    );
  }

  /**
   * A book this system already produced. Its chapters are structured text
   * already, so it is born DONE — there is nothing to parse and no file to
   * store.
   */
  static fromGeneratedBook(input: {
    id: ReferenceBookId;
    ownerId: string;
    title: string;
    author?: string | null;
    originProjectId: string;
    sections: ReferenceSection[];
    now: Date;
  }): Result<ReferenceBook> {
    if (input.sections.length === 0) return Result.fail('A generated reference needs at least one chapter');
    return Result.ok(
      new ReferenceBook(
        {
          ownerId: input.ownerId,
          title: input.title.trim(),
          author: input.author?.trim() || null,
          source: 'generated',
          originProjectId: input.originProjectId,
          storagePath: null,
          contentType: null,
          byteSize: null,
          status: 'DONE',
          error: null,
          sections: [...input.sections].sort((a, b) => a.position - b.position),
          createdAt: input.now,
          updatedAt: input.now,
        },
        input.id,
      ),
    );
  }

  static rehydrate(props: ReferenceBookProps, id: ReferenceBookId): ReferenceBook {
    return new ReferenceBook(props, id);
  }

  get ownerId(): string {
    return this.props.ownerId;
  }
  get title(): string {
    return this.props.title;
  }
  get author(): string | null {
    return this.props.author;
  }
  get source(): ReferenceSource {
    return this.props.source;
  }
  get originProjectId(): string | null {
    return this.props.originProjectId;
  }
  get storagePath(): string | null {
    return this.props.storagePath;
  }
  get contentType(): string | null {
    return this.props.contentType;
  }
  get byteSize(): number | null {
    return this.props.byteSize;
  }
  get status(): ReferenceStatus {
    return this.props.status;
  }
  get error(): string | null {
    return this.props.error;
  }
  get sections(): readonly ReferenceSection[] {
    return this.props.sections;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get wordCount(): number {
    return this.props.sections.reduce((sum, s) => sum + s.wordCount, 0);
  }

  /** Whether a new book may be generated from this one. */
  isUsable(): boolean {
    return this.props.status === 'DONE' && this.wordCount >= MIN_USABLE_WORDS;
  }

  markExtracting(now: Date): void {
    this.props.status = 'GENERATING';
    this.props.error = null;
    this.props.updatedAt = now;
  }

  /**
   * Attach extracted text. Rejects a result too thin to be a reference rather
   * than storing it and letting it be picked later — see MIN_USABLE_WORDS.
   */
  attachSections(sections: ReferenceSection[], now: Date): Result<void> {
    const total = sections.reduce((sum, s) => sum + s.wordCount, 0);
    if (total < MIN_USABLE_WORDS) {
      this.markFailed(
        `Extracted only ${total} words (need ${MIN_USABLE_WORDS}). The file may be scanned images, ` +
          'protected, or not a book.',
        now,
      );
      return Result.fail(`Reference book text too short: ${total} words`);
    }
    this.props.sections = [...sections].sort((a, b) => a.position - b.position);
    this.props.status = 'DONE';
    this.props.error = null;
    this.props.updatedAt = now;
    return Result.ok();
  }

  markFailed(error: string, now: Date): void {
    this.props.status = 'FAILED';
    this.props.error = error;
    this.props.updatedAt = now;
  }

  rename(title: string, now: Date): Result<void> {
    if (title.trim().length === 0) return Result.fail('A reference book needs a title');
    this.props.title = title.trim();
    this.props.updatedAt = now;
    return Result.ok();
  }
}

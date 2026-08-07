import { AggregateRoot } from '../shared/AggregateRoot';
import { Result } from '../shared/Result';
import { BookId, ChapterId } from './ids';
import { Chapter, type ChapterContent } from './Chapter';
import { Section } from './Section';
import { Outline } from './Outline';
import { PageBudget } from './PageBudget';
import { BookSection } from './BookSection';
import { BookSectionId } from './ids';
import { Illustration } from './Illustration';
import { ChapterGenerated } from './events/ChapterGenerated';

interface BookProps {
  projectId: string;
  title: string | null;
  targetPages: number;
  status: 'PENDING' | 'GENERATING' | 'DONE' | 'FAILED';
  outline?: Outline;
  chapters: Chapter[];
  bookSections: BookSection[];
  /** In-chapter illustrations (empty until generated at the assembling stage). */
  illustrations: Illustration[];
  /** Storage path of the AI-generated cover illustration (null until generated). */
  coverImagePath: string | null;
}

export class Book extends AggregateRoot<BookProps, BookId> {
  static create(input: { id: BookId; projectId: string; targetPages: number }): Book {
    return new Book(
      {
        projectId: input.projectId,
        title: null,
        targetPages: input.targetPages,
        status: 'PENDING',
        chapters: [],
        bookSections: [],
        illustrations: [],
        coverImagePath: null,
      },
      input.id,
    );
  }
  static rehydrate(props: BookProps, id: BookId): Book {
    return new Book(props, id);
  }

  get projectId() {
    return this.props.projectId;
  }
  get title(): string | null {
    return this.props.title;
  }
  get outline(): Outline | undefined {
    return this.props.outline;
  }
  get chapters(): readonly Chapter[] {
    return this.props.chapters;
  }
  get pageBudget(): PageBudget {
    return PageBudget.of(this.props.targetPages);
  }

  get coverImagePath(): string | null {
    return this.props.coverImagePath;
  }

  setTitle(title: string): void {
    this.props.title = title;
  }

  setCoverImagePath(path: string): void {
    this.props.coverImagePath = path;
  }

  // ── In-chapter illustrations ───────────────────────────────────────────────
  get illustrations(): readonly Illustration[] {
    return this.props.illustrations;
  }
  /** Illustrations for one chapter, ordered by their slot. */
  illustrationsForChapter(chapterId: string): Illustration[] {
    return this.props.illustrations
      .filter((i) => i.chapterId === chapterId)
      .sort((a, b) => a.orderInChapter - b.orderInChapter);
  }
  addIllustration(illustration: Illustration): void {
    // Replace any existing illustration in the same slot so re-runs don't duplicate.
    this.props.illustrations = this.props.illustrations.filter(
      (i) => !(i.chapterId === illustration.chapterId && i.orderInChapter === illustration.orderInChapter),
    );
    this.props.illustrations.push(illustration);
  }

  /** Assign the outline and derive per-chapter word targets from the page budget. */
  setOutline(outline: Outline): void {
    this.props.outline = outline;
    this.props.status = 'GENERATING';
  }

  addChapter(chapter: Chapter): Result<void> {
    if (this.props.chapters.some((c) => c.position === chapter.position)) {
      return Result.fail(`Chapter position ${chapter.position} already exists`);
    }
    this.props.chapters.push(chapter);
    this.props.chapters.sort((a, b) => a.position - b.position);
    return Result.ok();
  }

  chapter(id: ChapterId): Chapter | undefined {
    return this.props.chapters.find((c) => c.id.equals(id));
  }

  regenerateChapter(id: ChapterId, content: ChapterContent, now: Date): Result<void> {
    const chapter = this.chapter(id);
    if (!chapter) return Result.fail('Chapter not found');
    chapter.replaceContent(content);
    this.addEvent(new ChapterGenerated(this.id.value, id.value, chapter.version, now));
    this.refreshStatus();
    return Result.ok();
  }

  insertSection(chapterId: ChapterId, section: Section): Result<void> {
    const chapter = this.chapter(chapterId);
    if (!chapter) return Result.fail('Chapter not found');
    return chapter.addSection(section);
  }

  // ── Phase 13 — extra content (book-level front/back matter) ────────────────
  get bookSections(): readonly BookSection[] {
    return this.props.bookSections;
  }
  frontMatter(): BookSection[] {
    return this.props.bookSections.filter((s) => s.placement === 'front').sort((a, b) => a.position - b.position);
  }
  backMatter(): BookSection[] {
    return this.props.bookSections.filter((s) => s.placement === 'back').sort((a, b) => a.position - b.position);
  }
  /** Next position within a placement lane (front/back are numbered independently). */
  nextSectionPosition(placement: 'front' | 'back'): number {
    const inLane = this.props.bookSections.filter((s) => s.placement === placement);
    return inLane.length === 0 ? 0 : Math.max(...inLane.map((s) => s.position)) + 1;
  }
  addBookSection(section: BookSection): void {
    this.props.bookSections.push(section);
  }
  bookSection(id: BookSectionId): BookSection | undefined {
    return this.props.bookSections.find((s) => s.id.equals(id));
  }

  estimatedPages(): number {
    const words = this.props.chapters.reduce((sum, c) => sum + c.totalWords(), 0);
    return PageBudget.pagesFromWords(words);
  }

  private refreshStatus(): void {
    const allDone = this.props.chapters.length > 0 && this.props.chapters.every((c) => c.status === 'DONE');
    if (allDone) this.props.status = 'DONE';
  }
}

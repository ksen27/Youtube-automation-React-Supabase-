import { Entity } from '../shared/Entity';
import { Result } from '../shared/Result';
import { ChapterId } from './ids';
import { Section } from './Section';
import type { ContentStatus } from './Section';

export interface ChapterContent {
  content: string;
  inputHash: string;
}

interface ChapterProps {
  bookId: string;
  position: number;
  title: string;
  /** Short topic/purpose of the chapter. */
  topic: string;
  /** The reader payoff (logic.md Phase 9). */
  promise: string;
  keyPoints: string[];
  wordTarget: number;
  content: string | null;
  wordCount: number;
  status: ContentStatus;
  version: number;
  inputHash: string | null;
  sections: Section[];
}

export class Chapter extends Entity<ChapterProps, ChapterId> {
  static create(input: {
    id: ChapterId;
    bookId: string;
    position: number;
    title: string;
    topic: string;
    promise: string;
    keyPoints: string[];
    wordTarget: number;
  }): Chapter {
    return new Chapter(
      {
        bookId: input.bookId,
        position: input.position,
        title: input.title,
        topic: input.topic,
        promise: input.promise,
        keyPoints: input.keyPoints,
        wordTarget: input.wordTarget,
        content: null,
        wordCount: 0,
        status: 'PENDING',
        version: 1,
        inputHash: null,
        sections: [],
      },
      input.id,
    );
  }
  static rehydrate(props: ChapterProps, id: ChapterId): Chapter {
    return new Chapter(props, id);
  }

  get position() {
    return this.props.position;
  }
  get title() {
    return this.props.title;
  }
  get topic() {
    return this.props.topic;
  }
  get promise() {
    return this.props.promise;
  }
  get keyPoints() {
    return this.props.keyPoints;
  }
  get wordTarget() {
    return this.props.wordTarget;
  }
  get content() {
    return this.props.content;
  }
  get status() {
    return this.props.status;
  }
  get version() {
    return this.props.version;
  }
  get inputHash(): string | null {
    return this.props.inputHash;
  }
  get sections(): readonly Section[] {
    return this.props.sections;
  }

  /** Idempotency guard: already produced for these exact inputs? */
  isGeneratedFor(inputHash: string): boolean {
    return this.props.status === 'DONE' && this.props.inputHash === inputHash;
  }

  replaceContent(content: ChapterContent): void {
    this.props.content = content.content;
    this.props.wordCount = content.content.trim().split(/\s+/).length;
    this.props.inputHash = content.inputHash;
    this.props.status = 'DONE';
    this.props.version += 1; // history is snapshotted by the repository before replace
  }

  markGenerating(): void {
    this.props.status = 'GENERATING';
  }

  /**
   * Manual content edit (PATCH). Bumps the version (the repository snapshots the
   * previous version first) and tags the input hash as manual so a later
   * regeneration with a real hash is never short-circuited as "already done".
   */
  editContent(content: string): void {
    this.props.content = content;
    this.props.wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;
    this.props.version += 1;
    this.props.inputHash = `manual:v${this.props.version}`;
    this.props.status = 'DONE';
  }

  addSection(section: Section): Result<void> {
    if (this.props.sections.some((s) => s.position === section.position)) {
      return Result.fail(`Section position ${section.position} already exists in chapter`);
    }
    this.props.sections.push(section);
    this.props.sections.sort((a, b) => a.position - b.position);
    return Result.ok();
  }

  totalWords(): number {
    return this.props.wordCount + this.props.sections.reduce((sum, s) => sum + s.wordCount(), 0);
  }
}

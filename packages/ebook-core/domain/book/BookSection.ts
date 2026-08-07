import { Entity } from '../shared/Entity';
import { BookSectionId } from './ids';
import type { ContentStatus } from './Section';

/** The extra-content types — front/back matter generated around the chapters. */
export const ExtraContentKind = {
  DEDICATION: 'dedication',
  INTRODUCTION: 'introduction',
  FOREWORD: 'foreword',
  CONCLUSION: 'conclusion',
  ACKNOWLEDGMENTS: 'acknowledgments',
  FAQ: 'faq',
  BONUS_CHAPTER: 'bonus_chapter',
  RESOURCES: 'resources',
  CHECKLIST: 'checklist',
  GLOSSARY: 'glossary',
} as const;
export type ExtraContentKind = (typeof ExtraContentKind)[keyof typeof ExtraContentKind];

export type Placement = 'front' | 'back';

/** Front matter (dedication, foreword, introduction) precedes the chapters; everything else is back matter. */
const FRONT_MATTER_KINDS: ExtraContentKind[] = [
  ExtraContentKind.DEDICATION,
  ExtraContentKind.FOREWORD,
  ExtraContentKind.INTRODUCTION,
];
export function placementOf(kind: ExtraContentKind): Placement {
  return FRONT_MATTER_KINDS.includes(kind) ? 'front' : 'back';
}

/** Bonus chapters are full-length and generated asynchronously via the queue. */
export function isLongForm(kind: ExtraContentKind): boolean {
  return kind === ExtraContentKind.BONUS_CHAPTER;
}

interface BookSectionProps {
  bookId: string;
  kind: ExtraContentKind;
  placement: Placement;
  position: number;
  title: string;
  prompt: string | null;
  content: string | null;
  status: ContentStatus;
}

/** A book-level extra-content unit (front/back matter), distinct from a chapter Section. */
export class BookSection extends Entity<BookSectionProps, BookSectionId> {
  static create(input: {
    id: BookSectionId;
    bookId: string;
    kind: ExtraContentKind;
    position: number;
    title: string;
    prompt: string | null;
    status?: ContentStatus;
  }): BookSection {
    return new BookSection(
      {
        bookId: input.bookId,
        kind: input.kind,
        placement: placementOf(input.kind),
        position: input.position,
        title: input.title,
        prompt: input.prompt,
        content: null,
        status: input.status ?? 'PENDING',
      },
      input.id,
    );
  }
  static rehydrate(props: BookSectionProps, id: BookSectionId): BookSection {
    return new BookSection(props, id);
  }

  get kind() {
    return this.props.kind;
  }
  get placement() {
    return this.props.placement;
  }
  get position() {
    return this.props.position;
  }
  get title() {
    return this.props.title;
  }
  get prompt() {
    return this.props.prompt;
  }
  get content() {
    return this.props.content;
  }
  get status() {
    return this.props.status;
  }

  fill(content: string): void {
    this.props.content = content;
    this.props.status = 'DONE';
  }
}

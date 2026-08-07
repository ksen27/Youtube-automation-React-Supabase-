import { Entity } from '../shared/Entity';
import { SectionId } from './ids';

export type ContentStatus = 'PENDING' | 'GENERATING' | 'DONE' | 'FAILED';

interface SectionProps {
  chapterId: string;
  position: number;
  title: string;
  prompt: string | null;
  content: string | null;
  status: ContentStatus;
}

/** Sections are added after generation; each carries its own generation status. */
export class Section extends Entity<SectionProps, SectionId> {
  static create(input: SectionProps & { id: SectionId }): Section {
    const { id, ...props } = input;
    return new Section(props, id);
  }
  static rehydrate(props: SectionProps, id: SectionId): Section {
    return new Section(props, id);
  }

  get position() {
    return this.props.position;
  }
  get title() {
    return this.props.title;
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

  wordCount(): number {
    return this.props.content ? this.props.content.trim().split(/\s+/).length : 0;
  }
}

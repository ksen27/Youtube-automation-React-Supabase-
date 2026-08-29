import { ValueObject } from '../shared/ValueObject';

interface ReferenceSectionProps {
  position: number;
  title: string | null;
  content: string;
  wordCount: number;
}

/**
 * One retrievable passage of a reference book — a chapter, or a chunk of one.
 *
 * Sections exist because chapter research RETRIEVES: it ranks candidate
 * material by overlap with the chapter it is writing and takes the best few. A
 * reference stored as a single blob can only be used whole, which for a
 * hundred-page book means either sending all of it on every call or sending an
 * arbitrary slice. Neither is retrieval.
 */
export class ReferenceSection extends ValueObject<ReferenceSectionProps> {
  static create(input: { position: number; title?: string | null; content: string }): ReferenceSection {
    const content = input.content.trim();
    return new ReferenceSection({
      position: input.position,
      title: input.title?.trim() || null,
      content,
      // Counted once here rather than at every read: it drives both the library
      // listing and the "is this reference substantial enough" check, and
      // recomputing it per request over a hundred sections is wasted work.
      wordCount: content ? content.split(/\s+/).length : 0,
    });
  }

  get position(): number {
    return this.props.position;
  }
  get title(): string | null {
    return this.props.title;
  }
  get content(): string {
    return this.props.content;
  }
  get wordCount(): number {
    return this.props.wordCount;
  }

  /** Title plus body, for keyword ranking and for the research prompt. */
  toText(): string {
    return this.props.title ? `${this.props.title}\n${this.props.content}` : this.props.content;
  }
}

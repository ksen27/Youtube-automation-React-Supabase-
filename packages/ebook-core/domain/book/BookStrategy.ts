import { ValueObject } from '../shared/ValueObject';

interface BookStrategyProps {
  title: string;
  subtitle: string;
  targetAudience: string;
  corePromise: string;
  transformation: string;
  authorVoice: string;
  /** Cover byline (e.g. "Adrian from Car Care Garage"); optional for older records. */
  author?: string | undefined;
  tone: string;
  chapterCount: number;
  targetWordCount: number;
  uniqueSellingProposition: string;
  keyPrinciples: string[];
  inputHash: string;
}

/** Phase 8 output (Claude Sonnet): the commercial positioning that steers the book. */
export class BookStrategy extends ValueObject<BookStrategyProps> {
  static create(props: BookStrategyProps): BookStrategy {
    return new BookStrategy(props);
  }
  get title() {
    return this.props.title;
  }
  get subtitle() {
    return this.props.subtitle;
  }
  get corePromise() {
    return this.props.corePromise;
  }
  get transformation() {
    return this.props.transformation;
  }
  get tone() {
    return this.props.tone;
  }
  get authorVoice() {
    return this.props.authorVoice;
  }
  get author() {
    return this.props.author;
  }
  get chapterCount() {
    return this.props.chapterCount;
  }
  get targetWordCount() {
    return this.props.targetWordCount;
  }
  get keyPrinciples() {
    return this.props.keyPrinciples;
  }
  get inputHash() {
    return this.props.inputHash;
  }
  toJSON(): BookStrategyProps {
    return { ...this.props };
  }
  toText(): string {
    return [
      `Title: ${this.props.title}`,
      `Subtitle: ${this.props.subtitle}`,
      `Target audience: ${this.props.targetAudience}`,
      `Core promise: ${this.props.corePromise}`,
      `Transformation: ${this.props.transformation}`,
      `Author voice: ${this.props.authorVoice}`,
      `Tone: ${this.props.tone}`,
      `Unique selling proposition: ${this.props.uniqueSellingProposition}`,
      `Key principles: ${this.props.keyPrinciples.join('; ')}`,
    ].join('\n');
  }
}

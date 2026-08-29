import { ValueObject } from '../shared/ValueObject';

/**
 * What kind of book the extractor judged the reference to be.
 *
 * Recorded rather than assumed because a reference has an inherent shape: a
 * cookbook's structure is recipes with headnotes, a normal book's is narrative
 * chapters. When the project's selected book type disagrees with this, most of
 * the profile's structural half has to be discarded — and the picker can warn
 * instead of quietly producing a thin book.
 */
export type DetectedBookKind = 'normal' | 'cooking' | 'other';

interface ReferenceStyleProfileProps {
  /** How the author sounds — register, warmth, authority, person. */
  voice: string;
  /** How the author treats the reader: instructed, accompanied, challenged. */
  readerAddress: string;
  /** How a unit of this book is built, start to finish. */
  chapterShape: string;
  /** What the author does in the first paragraphs of a chapter. */
  openingMove: string;
  /** What the author does to close one. */
  closingMove: string;
  /** Sentence and paragraph rhythm, and how dense the information is. */
  pacing: string;
  /** Devices that recur often enough to be part of the book's identity. */
  recurringDevices: string[];
  /** Vocabulary and jargon level, including terms the author leans on. */
  vocabulary: string;
  /** Things this author conspicuously never does — as binding as what they do. */
  avoid: string[];
  detectedKind: DetectedBookKind;
  /** Hash of the sampled source text, so extraction is idempotent. */
  inputHash: string;
}

/**
 * The reusable half of a reference book: HOW it is written, extracted once and
 * cached on the reference.
 *
 * Deliberately carries nothing about subject matter. The subject comes from the
 * book's title (see GenerateBookBriefUseCase); mixing the two here would make a
 * profile usable only for books about the reference's own topic, which defeats
 * the point of a reusable library.
 */
export class ReferenceStyleProfile extends ValueObject<ReferenceStyleProfileProps> {
  static create(props: ReferenceStyleProfileProps): ReferenceStyleProfile {
    return new ReferenceStyleProfile(props);
  }

  get detectedKind(): DetectedBookKind {
    return this.props.detectedKind;
  }
  get inputHash(): string {
    return this.props.inputHash;
  }

  toJSON(): ReferenceStyleProfileProps {
    return { ...this.props };
  }

  /**
   * The profile as prompt input. Labelled prose rather than JSON: this is read
   * by the model as instructions about how to write, and a JSON blob invites it
   * to treat the fields as data to echo rather than a style to adopt.
   */
  toPromptText(): string {
    const lines = [
      `Voice: ${this.props.voice}`,
      `How the reader is addressed: ${this.props.readerAddress}`,
      `Shape of a chapter: ${this.props.chapterShape}`,
      `How chapters open: ${this.props.openingMove}`,
      `How chapters close: ${this.props.closingMove}`,
      `Pacing and density: ${this.props.pacing}`,
      `Vocabulary: ${this.props.vocabulary}`,
    ];
    if (this.props.recurringDevices.length > 0) {
      lines.push(`Recurring devices: ${this.props.recurringDevices.join('; ')}`);
    }
    if (this.props.avoid.length > 0) {
      lines.push(`Never does: ${this.props.avoid.join('; ')}`);
    }
    return lines.join('\n');
  }

  /** True when this reference's own shape matches the book being generated. */
  matches(bookType: 'normal' | 'cooking'): boolean {
    return this.props.detectedKind === bookType;
  }
}

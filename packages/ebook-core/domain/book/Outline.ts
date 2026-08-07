import { ValueObject } from '../shared/ValueObject';

export interface OutlineEntry {
  title: string;
  /** One-line purpose of the chapter (logic.md Phase 9). */
  purpose: string;
  /** The promise/payoff to the reader. */
  promise: string;
  keyPoints: string[];
  wordTarget: number;
}

interface OutlineProps {
  version: number;
  entries: OutlineEntry[];
  inputHash: string;
}

export class Outline extends ValueObject<OutlineProps> {
  static create(props: OutlineProps): Outline {
    return new Outline(props);
  }
  get entries(): readonly OutlineEntry[] {
    return this.props.entries;
  }
  get version() {
    return this.props.version;
  }
  get inputHash() {
    return this.props.inputHash;
  }
}

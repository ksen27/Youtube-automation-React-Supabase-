import { Identifier } from '../shared/Identifier';

export class ReferenceBookId extends Identifier {
  static from(value: string): ReferenceBookId {
    return new ReferenceBookId(value);
  }
}

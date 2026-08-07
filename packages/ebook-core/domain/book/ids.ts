import { Identifier } from '../shared/Identifier';

export class BookId extends Identifier {
  static from(value: string): BookId {
    return new BookId(value);
  }
}
export class ChapterId extends Identifier {
  static from(value: string): ChapterId {
    return new ChapterId(value);
  }
}
export class SectionId extends Identifier {
  static from(value: string): SectionId {
    return new SectionId(value);
  }
}
export class BookSectionId extends Identifier {
  static from(value: string): BookSectionId {
    return new BookSectionId(value);
  }
}
export class IllustrationId extends Identifier {
  static from(value: string): IllustrationId {
    return new IllustrationId(value);
  }
}

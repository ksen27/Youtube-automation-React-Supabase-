import { BaseDomainEvent } from '../../shared/DomainEvent';

export class ChapterGenerated extends BaseDomainEvent {
  readonly name = 'book.chapter.generated';
  constructor(
    aggregateId: string,
    public readonly chapterId: string,
    public readonly version: number,
    occurredAt: Date,
  ) {
    super(aggregateId, occurredAt);
  }
}

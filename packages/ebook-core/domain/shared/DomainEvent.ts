/** A fact that happened in the domain. Collected on aggregates, dispatched after persistence. */
export interface DomainEvent {
  readonly name: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
}

export abstract class BaseDomainEvent implements DomainEvent {
  abstract readonly name: string;
  constructor(
    public readonly aggregateId: string,
    public readonly occurredAt: Date,
  ) {}
}

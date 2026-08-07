import type { DomainEvent } from '../../../domain/shared/DomainEvent';

/**
 * Transactional boundary. The work function runs inside a DB transaction;
 * domain events collected during the transaction are dispatched only on commit.
 */
export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
  collectEvents(events: DomainEvent[]): void;
}

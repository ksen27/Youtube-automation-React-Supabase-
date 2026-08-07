import type { DomainEvent, UnitOfWork, Logger } from '@ebook/core';

export type EventDispatcher = (event: DomainEvent) => Promise<void> | void;

/**
 * Pragmatic UoW. The Supabase JS client does not expose interactive
 * transactions, so multi-row atomicity is achieved via Postgres RPC functions
 * for the few places that need it (e.g. decrement_pending). This UoW guarantees
 * domain events are dispatched only after the work block resolves successfully.
 */
export class SupabaseUnitOfWork implements UnitOfWork {
  private events: DomainEvent[] = [];

  constructor(
    private readonly dispatch: EventDispatcher,
    private readonly logger: Logger,
  ) {}

  collectEvents(events: DomainEvent[]): void {
    this.events.push(...events);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const result = await work();
    const pending = this.events;
    this.events = [];
    for (const event of pending) {
      try {
        await this.dispatch(event);
      } catch (e) {
        this.logger.error('event dispatch failed', { event: event.name, error: String(e) });
      }
    }
    return result;
  }
}

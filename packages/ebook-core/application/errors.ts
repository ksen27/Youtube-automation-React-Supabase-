/** Thrown by use cases/processors when a job must NOT be retried (poison message). */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** Thrown for transient failures so BullMQ applies backoff and retries. */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

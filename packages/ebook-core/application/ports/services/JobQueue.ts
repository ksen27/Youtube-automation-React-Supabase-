export type QueueName =
  // Reads a reference book and caches HOW it is written. Once per reference,
  // not once per book, and outside the project pipeline entirely.
  // Parses an uploaded reference file into sections. Separate from
  // reference-extract because parsing is CPU and extraction is a model call —
  // they fail for different reasons and retry on different budgets.
  | 'reference-ingest'
  | 'reference-extract'
  // Turns a title into the knowledge base the book is written from.
  | 'book-brief'
  | 'book-strategy'
  | 'outline-generate'
  | 'chapter-research'
  | 'chapter-generate'
  | 'polish-book'
  | 'polish-chapter'
  | 'extra-content'
  | 'ebook-assemble'
  | 'export'
  | 'landing-page'
  // Cloning a template site. Once per template, not once per book — and its own
  // queue so a template that cannot be captured fails on its own row rather
  // than taking a book's page down with it.
  | 'landing-template'
  // Listing a finished book on the store (Payhip) so its landing page has a buy
  // link. Its own queue because it drives a real browser against a third party:
  // it is slow, it is rate-sensitive, and a failure here must not take a page
  // generation down with it.
  | 'checkout-product';

export interface EnqueueOptions {
  /** Deterministic id → BullMQ de-duplicates identical jobs. */
  jobId: string;
  attempts?: number;
  delayMs?: number;
}

/** Abstraction over BullMQ so use cases stay infrastructure-free. */
export interface JobQueue {
  enqueue<T extends Record<string, unknown>>(
    queue: QueueName,
    payload: T,
    options: EnqueueOptions,
  ): Promise<void>;

  /**
   * Make a deterministic job id reusable after the run that claimed it finished.
   *
   * Deterministic ids are what stop a double-click from doing a thing twice —
   * BullMQ ignores an `add` whose id already exists. The catch is that failed
   * jobs are KEPT for inspection, so that same protection quietly becomes a
   * permanent block: the first failure owns the id forever and every later
   * attempt is swallowed without a trace, which looks exactly like the button
   * doing nothing.
   *
   * Returns:
   *   'none'    — no job holds this id; enqueue normally.
   *   'pending' — a run is queued or in flight; do NOT enqueue a rival.
   *   'cleared' — a finished job held the id and has been removed; enqueue now.
   */
  settleState(queue: QueueName, jobId: string): Promise<'none' | 'pending' | 'cleared'>;

  /** Queues that currently hold failed jobs for a project (for retry diagnosis). */
  failedStages(projectId: string): Promise<QueueName[]>;

  /** Re-run every failed job belonging to a project; returns how many were retried. */
  retryFailed(projectId: string): Promise<number>;

  /** Remove a project's not-yet-running jobs (waiting/delayed). Returns how many were removed. */
  drain(projectId: string): Promise<number>;
}

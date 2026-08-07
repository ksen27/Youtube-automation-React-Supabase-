/** Backs the job_runs ledger: the DB-level idempotency guard for every worker. */
export interface IdempotencyGuard {
  alreadyCompleted: boolean;
  result?: unknown;
}

export interface IdempotencyStore {
  begin(input: {
    jobKey: string;
    queue: string;
    projectId: string;
    inputHash: string;
    attempt: number;
  }): Promise<IdempotencyGuard>;
  complete(jobKey: string, result: unknown): Promise<void>;
  fail(jobKey: string, error: string): Promise<void>;
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IdempotencyStore, IdempotencyGuard } from '@ebook/core';

/**
 * Backs the job_runs ledger — the DB-level idempotency guard (layer 2).
 * begin() upserts the run row; if it is already COMPLETED with the same input
 * hash, the worker short-circuits and returns the cached result.
 */
export class SupabaseIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: SupabaseClient) {}

  async begin(input: {
    jobKey: string;
    queue: string;
    projectId: string;
    inputHash: string;
    attempt: number;
  }): Promise<IdempotencyGuard> {
    const { data: existing } = await this.db
      .from('job_runs')
      .select('state, input_hash, result_ref')
      .eq('job_key', input.jobKey)
      .maybeSingle();

    if (existing?.state === 'COMPLETED' && existing.input_hash === input.inputHash) {
      return { alreadyCompleted: true, result: existing.result_ref };
    }

    await this.db.from('job_runs').upsert(
      {
        job_key: input.jobKey,
        queue: input.queue,
        project_id: input.projectId,
        state: 'RUNNING',
        attempt: input.attempt,
        input_hash: input.inputHash,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'job_key' },
    );
    return { alreadyCompleted: false };
  }

  async complete(jobKey: string, result: unknown): Promise<void> {
    await this.db
      .from('job_runs')
      .update({ state: 'COMPLETED', result_ref: result == null ? null : JSON.stringify(result), updated_at: new Date().toISOString() })
      .eq('job_key', jobKey);
  }

  async fail(jobKey: string, error: string): Promise<void> {
    await this.db
      .from('job_runs')
      .update({ state: 'FAILED', error, updated_at: new Date().toISOString() })
      .eq('job_key', jobKey);
  }
}

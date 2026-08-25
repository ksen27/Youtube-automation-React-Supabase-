import type { PostgrestError } from "@supabase/supabase-js";

// PostgREST caps every unbounded select at its `max-rows` setting (1000 on
// Supabase's hosted default) and returns the truncated slice WITHOUT any error
// — the caller cannot tell a complete result from a clipped one.
//
// THE BUG THIS EXISTS TO PREVENT: the synthetic review screen fetched a
// project's media_jobs with `.order("created_at", { ascending: true })` and no
// range. On a 452-block project with 3,116 jobs that returned the OLDEST 1,000
// rows, so "the latest job per segment" resolved to a months-dead `failed` row
// while a freshly queued one — invisible past the cap — was live. Every one of
// those blocks rendered as "Stuck — its render stopped without finishing", and
// the matching server-side scope re-queued work that was already in flight.
//
// Ascending order makes the truncation maximally harmful (you lose exactly the
// recent rows every liveness check depends on), but descending is not a fix
// either — it just moves the loss onto the early pipeline jobs the progress
// screen aggregates. The only correct answer is to read every page.
export const SUPABASE_PAGE_SIZE = 1000;

// Drain a paginated PostgREST select. `page` is called with an inclusive
// [from, to] row range and must apply `.range(from, to)` plus a TOTAL order
// (add a tiebreaker column — two rows sharing a created_at can otherwise swap
// pages and be returned twice or skipped). Pass `{ count: "exact" }` on the
// select so the loop can stop on the real total instead of guessing from the
// page size, which would truncate again on any instance whose max-rows is
// lower than SUPABASE_PAGE_SIZE.
//
// Errors are returned rather than thrown so callers can keep folding them into
// an existing "first error wins" check alongside their other queries.
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: PostgrestError | null;
    count: number | null;
  }>,
): Promise<{ data: T[]; error: PostgrestError | null }> {
  const out: T[] = [];
  for (;;) {
    const { data, error, count } = await page(out.length, out.length + SUPABASE_PAGE_SIZE - 1);
    if (error) return { data: out, error };
    const rows = data ?? [];
    out.push(...rows);
    // An empty page always terminates. `count` (when the caller asked for it)
    // ends the loop one request earlier; without it we pay one extra empty
    // read to learn we are done.
    if (rows.length === 0) break;
    if (count != null && out.length >= count) break;
  }
  return { data: out, error: null };
}

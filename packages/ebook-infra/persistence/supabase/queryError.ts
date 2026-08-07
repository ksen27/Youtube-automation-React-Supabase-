/**
 * Names the query that failed.
 *
 * Supabase errors carry only a message, so `canceling statement due to
 * statement timeout` reaches the log with no indication of which table it came
 * from — which cost two rounds of guesswork on a landing-page job that touches
 * eight tables. Wrapping the error at the call site is the cheapest way to make
 * the next one self-diagnosing.
 */
export function queryError(table: string, op: string, error: { message: string; code?: string }): Error {
  const code = error.code ? ` [${error.code}]` : '';
  // 57014 is Postgres' statement_timeout cancellation. Calling it out by name
  // saves the reader looking it up, and it is the failure most likely to
  // reappear as data grows.
  const hint = error.code === '57014' ? ' — the query exceeded the database statement timeout' : '';
  return new Error(`${table}.${op} failed${code}: ${error.message}${hint}`);
}

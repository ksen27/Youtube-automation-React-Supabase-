// One error vocabulary for the whole board feature, so route handlers never
// have to invent status codes and every failure reaches the client in the same
// `{ error }` shape the rest of this app's API already uses.

export class BoardError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "BoardError";
    this.status = status;
    this.code = code;
  }
}

export class BoardNotFoundError extends BoardError {
  constructor(what = "Board") {
    super(`${what} not found.`, 404, "not_found");
    this.name = "BoardNotFoundError";
  }
}

export class BoardValidationError extends BoardError {
  constructor(message: string) {
    super(message, 400, "invalid_input");
    this.name = "BoardValidationError";
  }
}

/** A Supabase/PostgREST failure we could not attribute to the caller. */
export class BoardDatabaseError extends BoardError {
  constructor(message: string) {
    super(message, 500, "database_error");
    this.name = "BoardDatabaseError";
  }
}

/**
 * Unwrap a supabase-js `{ data, error }` result.
 *
 * Every query in the service layer goes through this so a forgotten
 * `if (error)` cannot turn a database failure into a silent `null` that the UI
 * then renders as "empty board".
 */
export function unwrap<T = unknown>(
  // `data` is deliberately `unknown`: supabase-js returns untyped rows, and
  // letting the generic be inferred FROM the argument would silently infer
  // `null` at every call site. Callers name the row type explicitly instead.
  result: { data: unknown; error: { message: string; code?: string } | null },
  context: string,
): T {
  if (result.error) {
    throw new BoardDatabaseError(`${context}: ${result.error.message}`);
  }
  if (result.data == null) {
    throw new BoardNotFoundError(context);
  }
  return result.data as T;
}

/** Same, for statements whose success is signalled only by the absence of an error. */
export function unwrapVoid(
  result: { error: { message: string } | null },
  context: string,
): void {
  if (result.error) throw new BoardDatabaseError(`${context}: ${result.error.message}`);
}

/**
 * Result<T, E> — explicit success/failure without throwing.
 * The domain never throws; it returns Results so the application layer
 * can decide whether a failure is retryable, terminal, or user-facing.
 */
export type Result<T, E = string> = Ok<T, E> | Fail<T, E>;

export class Ok<T, E> {
  readonly _tag = 'ok' as const;
  constructor(public readonly value: T) {}
  isOk(): this is Ok<T, E> {
    return true;
  }
  isFail(): this is Fail<T, E> {
    return false;
  }
}

export class Fail<T, E> {
  readonly _tag = 'fail' as const;
  constructor(public readonly error: E) {}
  isOk(): this is Ok<T, E> {
    return false;
  }
  isFail(): this is Fail<T, E> {
    return true;
  }
  get value(): never {
    throw new Error(`Attempted to read value of a Fail Result: ${String(this.error)}`);
  }
}

export const Result = {
  ok<T, E = string>(value?: T): Result<T, E> {
    return new Ok<T, E>(value as T);
  },
  fail<T = never, E = string>(error: E): Result<T, E> {
    return new Fail<T, E>(error);
  },
  /** Collapse an array of Results; first failure wins. */
  combine<E>(results: Array<Result<unknown, E>>): Result<void, E> {
    for (const r of results) {
      if (r.isFail()) return Result.fail<void, E>(r.error);
    }
    return Result.ok<void, E>(undefined);
  },
};
